'use strict';

import * as fs from 'fs';
import * as Log4js from 'log4js';
import * as os from 'os';
import * as path from 'path';
import { parseRealtimeData } from './parser';
import type { ProbeType } from './parser';

const logger = Log4js.getLogger('ibs_th1');
const diagnosticsSetting = process.env['IBS_TH1_DIAGNOSTICS'];
const diagnosticsEnabled = diagnosticsSetting === '1' ||
  diagnosticsSetting?.toLowerCase() === 'true';

const diagnosticsLog = (...args: unknown[]) => {
  if (diagnosticsEnabled) {
    // eslint-disable-next-line no-console
    console.log('[ibs_th1:diag]', ...args);
  }
};

const diagnosticsWarn = (...args: unknown[]) => {
  if (diagnosticsEnabled) {
    // eslint-disable-next-line no-console
    console.warn('[ibs_th1:diag]', ...args);
  }
};

// Device name for IBS-TH1, IBS-TH1 mini and IBS_TH1 Plus.
const DEVICE_NAME: string = 'sps';
const DEVICE_INFORMATION_SERVICE_UUID = '180a';
const SYSTEM_ID_CHARACTERISTIC_UUID = '2a23';
const SYSTEM_ID_DEVICE_ID_PREFIX = 'ibs-th1-system-id:';
//const SERVICE_UUID: string = 'fff0';
const MIN_DEVICE_ID_RETRY_DELAY_MS = 30_000;
const MAX_DEVICE_ID_RETRY_DELAY_MS = 24 * 60 * 60_000;
const DEVICE_ID_RETRY_BACKOFF_MULTIPLIER = 4;

type DeviceIdFetchStatus = 'FETCHING' | 'FETCHED';

type NobleEvent = 'discover' | 'stateChange';

interface Peripheral {
  uuid: string;
  address: string | null;
  advertisement: {
    localName?: string;
    manufacturerData?: Buffer;
  };
  connectAsync(): Promise<void>;
  disconnectAsync(): Promise<void>;
  discoverSomeServicesAndCharacteristicsAsync(
    serviceUUIDs: string[],
    characteristicUUIDs: string[],
  ): Promise<{
    characteristics: Array<{
      uuid: string;
      readAsync(): Promise<Buffer>;
    }>;
  }>;
}

interface NobleAdapter {
  state: string;
  on(event: 'discover', listener: (peripheral: Peripheral) => void): void;
  on(event: 'stateChange', listener: (state: string) => void): void;
  removeListener(event: NobleEvent, listener: (...args: any[]) => void): void;
  startScanning(serviceUUIDs: string[], allowDuplicates: boolean): void;
  stopScanning(): void;
}

interface DeviceIdCache {
  load(): Map<string, string>;
  save(data: Map<string, string>): void;
}

interface IbsTh1ScannerOptions {
  noble?: NobleAdapter;
  deviceIdCache?: DeviceIdCache;
}

interface Subscription {
  unsubscribe(): void;
}

class IbsTh1Scanner {
  private static activeScanCounts_: Map<NobleAdapter, number> = new Map();

  private device_id_fetch_status_: Map<string, DeviceIdFetchStatus>;
  private device_id_fetch_retry_at_: Map<string, number>;
  private device_id_fetch_failure_count_: Map<string, number>;
  private uuid_to_device_id_: Map<string, string>;
  private noble_: NobleAdapter;
  private deviceIdCache_: DeviceIdCache;
  private discoverListener_: ((peripheral: Peripheral) => void) | null = null;
  private stateChangeListener_: ((state: string) => void) | null = null;
  private subscriptionId_ = 0;

  constructor(options: IbsTh1ScannerOptions = {}) {
    this.device_id_fetch_status_ = new Map<string, DeviceIdFetchStatus>();
    this.device_id_fetch_retry_at_ = new Map<string, number>();
    this.device_id_fetch_failure_count_ = new Map<string, number>();
    this.noble_ = options.noble || loadDefaultNoble();
    this.deviceIdCache_ = options.deviceIdCache || new FileDeviceIdCache('uuid_to_device_id');
    this.uuid_to_device_id_ = this.deviceIdCache_.load();
  }

  //
  // Public functions.
  //

  subscribe(callback: (data: RealtimeData) => void): Subscription {
    const subscriptionId = ++this.subscriptionId_;
    const scanStart = (callback: (data: RealtimeData) => void) => {
      const wasScanning = this.discoverListener_ != null;
      if (this.discoverListener_ != null) {
        this.noble_.removeListener('discover', this.discoverListener_);
      }

      this.discoverListener_ = async (peripheral: Peripheral) => {
        if (!this.isTargetDevice_(peripheral)) {
          return;
        }
        try {
          await this.prepareDeviceId_(peripheral, callback);
        } catch (err) {
          diagnosticsWarn('prepareDeviceId_ skipped', {
            uuid: peripheral.uuid,
            localName: peripheral.advertisement.localName,
            mfgLen: peripheral.advertisement.manufacturerData?.byteLength,
            reason: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        try {
          const realtimeData: RealtimeData | null = this.getRealtimeData_(peripheral);
          if (realtimeData != null) {
            callback(realtimeData);
          }
        } catch (err) {
          logger.error(err);
        }
      };
      this.noble_.on('discover', this.discoverListener_);
      if (!wasScanning) {
        IbsTh1Scanner.incrementActiveScanCount_(this.noble_);
      }
      this.noble_.startScanning([/*SERVICE_UUID*/], true /*allowDuplicates*/);
      logger.info('Started to scan Bluetooth signals');
    };

    if (this.noble_.state === 'poweredOn') {
      scanStart(callback);
    } else {
      if (this.stateChangeListener_ != null) {
        this.noble_.removeListener('stateChange', this.stateChangeListener_);
      }

      this.stateChangeListener_ = (state) => {
        if (state == 'poweredOn') {
          scanStart(callback);
        } else {
          this.stop_();
        }
      };
      this.noble_.on('stateChange', this.stateChangeListener_);
    }

    return {
      unsubscribe: () => {
        this.stop_(subscriptionId);
      },
    };
  }

  private stop_(subscriptionId?: number): void {
    if (subscriptionId != null && subscriptionId !== this.subscriptionId_) {
      return;
    }

    if (this.discoverListener_ != null) {
      this.noble_.removeListener('discover', this.discoverListener_);
      this.discoverListener_ = null;
      if (IbsTh1Scanner.decrementActiveScanCount_(this.noble_) === 0) {
        this.noble_.stopScanning();
      }
    }
    if (this.stateChangeListener_ != null) {
      this.noble_.removeListener('stateChange', this.stateChangeListener_);
      this.stateChangeListener_ = null;
    }
    logger.info('Stopped to scan Bluetooth signals');
  }

  //
  // Private functions.
  //

  private isTargetDevice_(peripheral: Peripheral): boolean {
    if (peripheral.advertisement.localName != DEVICE_NAME) {
      return false;
    }
    const buffer = peripheral.advertisement.manufacturerData;
    if (!buffer || buffer.byteLength != 9) {
      return false;
    }
    // Disable CRC check logic because IBS-TH1 plus seems to have non-CRC data
    // in the buffer. "buffer[6]<<8 & buffer[6]" is increasing one by one, so
    // I'm assuming the value is the index of data stored inside the device.
    // The device can store up to 30000 data points in it, so maybe the value
    // corresponds to that index. This idea needs to be verified.
    // const expectedCrc16 = buffer[6] * 256 + buffer[5];
    // if (expectedCrc16 != IbsTh1Scanner.getCrc16(buffer.slice(0, 5))) {
    //   console.error('CRC error', this.uuid_to_device_id_.get(peripheral.uuid));
    //   return false;
    // }

    return true;
  }

  private async prepareDeviceId_(peripheral: Peripheral, callback: (data: RealtimeData) => void): Promise<void> {
    const fetchStatus = this.device_id_fetch_status_.get(peripheral.uuid);
    diagnosticsLog('prepareDeviceId_ start', {
      uuid: peripheral.uuid,
      fetchStatus,
      cachedDeviceId: this.uuid_to_device_id_.get(peripheral.uuid),
      retryAt: this.device_id_fetch_retry_at_.get(peripheral.uuid),
    });
    if (fetchStatus == 'FETCHING') {
      // Another thread is checking the device id now.
      throw new Error('Discovered => Device id fetch in flight. Ignoring.');
    }

    const deviceId = IbsTh1Scanner.normalizeDeviceId_(this.uuid_to_device_id_.get(peripheral.uuid));
    if (!deviceId) {
      const retryAt = this.device_id_fetch_retry_at_.get(peripheral.uuid);
      if (retryAt != null && Date.now() < retryAt) {
        throw new Error('Discovered => Device id fetch cooling down. Ignoring.');
      }

      // Check the device id from now.
      this.device_id_fetch_status_.set(peripheral.uuid, 'FETCHING');
      try {
        const deviceId: string = await this.getDeviceId_(peripheral);

        this.device_id_fetch_retry_at_.delete(peripheral.uuid);
        this.device_id_fetch_failure_count_.delete(peripheral.uuid);
        this.device_id_fetch_status_.set(peripheral.uuid, 'FETCHED');
        this.uuid_to_device_id_.set(peripheral.uuid, deviceId);
        this.deviceIdCache_.save(this.uuid_to_device_id_);
        diagnosticsLog('Stable device id resolved', {
          uuid: peripheral.uuid,
          deviceId,
          totalKnown: this.uuid_to_device_id_.size,
        });
      } catch (err) {
        if (err instanceof InvalidDeviceIdError) {
          const failureCount = (this.device_id_fetch_failure_count_.get(peripheral.uuid) || 0) + 1;
          const retryDelayMs = IbsTh1Scanner.deviceIdRetryDelayMs_(failureCount);
          this.device_id_fetch_failure_count_.set(peripheral.uuid, failureCount);
          this.device_id_fetch_retry_at_.set(
            peripheral.uuid,
            Date.now() + retryDelayMs);
          logger.warn(
            'Unable to get stable device id for peripheral device',
            {
              uuid: peripheral.uuid,
              failureCount,
              retryDelayMs,
            });
          diagnosticsWarn('Unable to get stable device id for peripheral device', {
            uuid: peripheral.uuid,
            failureCount,
            retryDelayMs,
            error: err.message,
          });
        } else {
          diagnosticsWarn('prepareDeviceId_ unexpected error', {
            uuid: peripheral.uuid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        this.device_id_fetch_status_.delete(peripheral.uuid);
        throw err;
      }

      // Without this line, noble stops receiving broadcasted data.
      this.restart_(callback);
    }
  }

  private getRealtimeData_(peripheral: Peripheral): RealtimeData | null {
    const buffer = peripheral.advertisement.manufacturerData;
    if (!buffer) {
      return null;
    }
    const parsedData = parseRealtimeData(buffer);
    if (parsedData == null) {
      return null;
    }

    const realtimeData: RealtimeData = {
      date: new Date,
      deviceId: IbsTh1Scanner.normalizeDeviceId_(this.uuid_to_device_id_.get(peripheral.uuid)),
      temperatureCelsius: parsedData.temperatureCelsius,
      humidityPercent: parsedData.humidityPercent,
      probeType: parsedData.probeType,
      batteryPercent: parsedData.batteryPercent,
    };
    return realtimeData;
  }

  private async getDeviceId_(peripheral: Peripheral): Promise<string> {
    diagnosticsLog('Device id resolution start', { uuid: peripheral.uuid });
    logger.debug('Getting device id of peripheral device with uuid =', peripheral.uuid);
    let connected = false;
    try {
      diagnosticsLog('Connecting for device id resolution', { uuid: peripheral.uuid });
      await peripheral.connectAsync();
      connected = true;
      if (!peripheral.uuid) {
        throw new Error('No UUID');
      }
      diagnosticsLog('Connected', { uuid: peripheral.uuid });
      logger.debug('Connected', { uuid: peripheral.uuid });
      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [DEVICE_INFORMATION_SERVICE_UUID],
        [SYSTEM_ID_CHARACTERISTIC_UUID],
      );
      const systemIdCharacteristic = characteristics.find(
        characteristic => characteristic.uuid.toLowerCase() === SYSTEM_ID_CHARACTERISTIC_UUID,
      );
      if (!systemIdCharacteristic) {
        throw new InvalidDeviceIdError(`No System ID characteristic for peripheral device with uuid = ${peripheral.uuid}`);
      }

      const systemId = await systemIdCharacteristic.readAsync();
      const deviceId = IbsTh1Scanner.systemIdToDeviceId_(systemId);
      if (deviceId == null) {
        throw new InvalidDeviceIdError(`No stable device id for peripheral device with uuid = ${peripheral.uuid}`);
      }
      diagnosticsLog('Device id resolved', { uuid: peripheral.uuid, deviceId });
      return deviceId;
    } catch (err) {
      diagnosticsWarn('Device id resolution failed', {
        uuid: peripheral.uuid,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      if (connected) {
        try {
          diagnosticsLog('Disconnecting peripheral', { uuid: peripheral.uuid });
          await peripheral.disconnectAsync();
        } catch (err) {
          logger.warn('Failed to disconnect from peripheral device', err);
        }
      }
    }
  }

  /**
   * @deprecated Use the exported crc16 function instead.
   * @param {Buffer} buffer
   */
  static getCrc16(buffer: Buffer): number {
    return crc16(buffer);
  }

  private static incrementActiveScanCount_(noble: NobleAdapter): void {
    const count = IbsTh1Scanner.activeScanCounts_.get(noble) || 0;
    IbsTh1Scanner.activeScanCounts_.set(noble, count + 1);
  }

  private static decrementActiveScanCount_(noble: NobleAdapter): number {
    const count = Math.max((IbsTh1Scanner.activeScanCounts_.get(noble) || 0) - 1, 0);
    if (count === 0) {
      IbsTh1Scanner.activeScanCounts_.delete(noble);
    } else {
      IbsTh1Scanner.activeScanCounts_.set(noble, count);
    }
    return count;
  }

  private restart_(callback: (data: RealtimeData) => void): void {
    logger.info('Restarting');
    this.stop_();
    this.subscribe(callback);
  }

  private static deviceIdRetryDelayMs_(failureCount: number): number {
    return Math.min(
      MIN_DEVICE_ID_RETRY_DELAY_MS * Math.pow(DEVICE_ID_RETRY_BACKOFF_MULTIPLIER, failureCount - 1),
      MAX_DEVICE_ID_RETRY_DELAY_MS);
  }

  private static normalizeDeviceId_(deviceId: string | null | undefined): string | null {
    if (deviceId == null) {
      return null;
    }
    const normalizedDeviceId = deviceId.trim();
    if (!normalizedDeviceId) {
      return null;
    }
    return normalizedDeviceId;
  }

  private static systemIdToDeviceId_(systemId: Buffer): string | null {
    if (systemId.byteLength === 0) {
      return null;
    }
    const hex = systemId.toString('hex').toLowerCase();
    if (/^0+$/.test(hex)) {
      return null;
    }
    return `${SYSTEM_ID_DEVICE_ID_PREFIX}${hex}`;
  }
}

class InvalidDeviceIdError extends Error {
}

interface RealtimeData {
  deviceId: string | null,
  date: Date,
  probeType: ProbeType,
  temperatureCelsius: number,
  humidityPercent: number,
  batteryPercent: number,
}

class FileDeviceIdCache implements DeviceIdCache {
  private homeDir_: string;
  private configDir_: string;
  private configPath_: string;

  constructor(configName: string, homeDir: string = os.homedir()) {
    this.homeDir_ = homeDir;
    this.configDir_ = path.join(this.homeDir_, '.ibs_th1/');
    this.configPath_ = path.join(this.configDir_, configName);
  }

  load(): Map<string, string> {
    const map = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(this.configPath_, 'utf8'));
      for (const uuid in data) {
        map.set(uuid, data[uuid]);
      }
      return map;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.save(map);
      } else {
        logger.warn('Failed to load config. Keeping existing file untouched.', err);
      }
      return map;
    }
  }

  save(data: Map<string, string>): void {
    if (!fs.existsSync(this.configDir_)) {
      fs.mkdirSync(this.configDir_, { 'mode': 0o700, 'recursive': true });
    }

    const obj: any = {};
    data.forEach((value, key) => {
      obj[key] = value;
    });
    fs.writeFileSync(
      this.configPath_,
      JSON.stringify(obj),
      { 'encoding': 'utf8', 'mode': 0o600 });
  }
}

function loadDefaultNoble(): NobleAdapter {
  try {
    return require('@abandonware/noble') as NobleAdapter;
  } catch (err) {
    const nodeError = err as NodeJS.ErrnoException;
    if (nodeError.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        'Bluetooth scanning requires @abandonware/noble. ' +
        'Install it with `npm install ibs_th1 @abandonware/noble`, ' +
        'or pass a custom NobleAdapter to new IbsTh1Scanner({ noble }). ' +
        'The parser entry point `ibs_th1/parser` does not require Noble.');
    }
    throw err;
  }
}

function crc16(buffer: Buffer): number {
  let crc = 0xffff;
  const iter = buffer.values();
  let item = iter.next();
  while (!item.done) {
    const byte = item.value;
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      const tmp = crc & 0x1;
      crc >>= 1;
      if (tmp) {
        crc ^= 0xa001;
      }
    }
    item = iter.next();
  }
  return crc;
}

/**
 * @deprecated Use IbsTh1Scanner instead.
 */
const IBS_TH1 = IbsTh1Scanner;

export { IBS_TH1, FileDeviceIdCache, IbsTh1Scanner, crc16, parseRealtimeData };
export type { DeviceIdCache, IbsTh1ScannerOptions, NobleAdapter, Peripheral, RealtimeData, Subscription, ProbeType };
