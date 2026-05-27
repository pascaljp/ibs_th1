'use strict';

import * as fs from 'fs';
import * as Log4js from 'log4js';
import * as os from 'os';
import * as path from 'path';
import { parseRealtimeData } from './parser';
import type { ProbeType } from './parser';

const logger = Log4js.getLogger('ibs_th1');

// Device name for IBS-TH1, IBS-TH1 mini and IBS_TH1 Plus.
const DEVICE_NAME: string = 'sps';
//const SERVICE_UUID: string = 'fff0';

type AddressFetchStatus = 'FETCHING' | 'FETCHED';

type NobleEvent = 'discover' | 'stateChange';

interface Peripheral {
  uuid: string;
  address: string;
  advertisement: {
    localName?: string;
    manufacturerData?: Buffer;
  };
  connectAsync(): Promise<void>;
  disconnectAsync(): Promise<void>;
}

interface NobleAdapter {
  state: string;
  on(event: 'discover', listener: (peripheral: Peripheral) => void): void;
  on(event: 'stateChange', listener: (state: string) => void): void;
  removeListener(event: NobleEvent, listener: (...args: any[]) => void): void;
  startScanning(serviceUUIDs: string[], allowDuplicates: boolean): void;
  stopScanning(): void;
}

interface AddressCache {
  load(): Map<string, string>;
  save(data: Map<string, string>): void;
}

interface IbsTh1ScannerOptions {
  noble?: NobleAdapter;
  addressCache?: AddressCache;
}

interface Subscription {
  unsubscribe(): void;
}

class IbsTh1Scanner {
  private static activeScanCounts_: Map<NobleAdapter, number> = new Map();

  private address_fetch_status_: Map<string, AddressFetchStatus>;
  private uuid_to_address_: Map<string, string>;
  private noble_: NobleAdapter;
  private addressCache_: AddressCache;
  private discoverListener_: ((peripheral: Peripheral) => void) | null = null;
  private stateChangeListener_: ((state: string) => void) | null = null;
  private subscriptionId_ = 0;

  constructor(options: IbsTh1ScannerOptions = {}) {
    this.address_fetch_status_ = new Map<string, AddressFetchStatus>();
    this.noble_ = options.noble || loadDefaultNoble();
    this.addressCache_ = options.addressCache || new FileAddressCache('uuid_to_address');
    this.uuid_to_address_ = this.addressCache_.load();
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
          await this.prepareAddress_(peripheral, callback);
        } catch (err) {
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
    //   console.error('CRC error', this.uuid_to_address_.get(peripheral.uuid));
    //   return false;
    // }

    return true;
  }

  private async prepareAddress_(peripheral: Peripheral, callback: (data: RealtimeData) => void): Promise<void> {
    const fetchStatus = this.address_fetch_status_.get(peripheral.uuid);
    if (fetchStatus == 'FETCHING') {
      // Another thread is checking the address now.
      throw new Error('Discovered => Address fetch on flight. Ignoring.');
    }

    const address = this.uuid_to_address_.get(peripheral.uuid);
    if (!address) {
      // Check the address from now.
      this.address_fetch_status_.set(peripheral.uuid, 'FETCHING');
      try {
        const address: string = await this.getAddress_(peripheral);

        this.address_fetch_status_.set(peripheral.uuid, 'FETCHED');
        this.uuid_to_address_.set(peripheral.uuid, address);
        this.addressCache_.save(this.uuid_to_address_);
      } catch (err) {
      this.address_fetch_status_.delete(peripheral.uuid);
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
      address: this.uuid_to_address_.get(peripheral.uuid) || null,
      temperatureCelsius: parsedData.temperatureCelsius,
      humidityPercent: parsedData.humidityPercent,
      probeType: parsedData.probeType,
      batteryPercent: parsedData.batteryPercent,
    };
    return realtimeData;
  }

  private async getAddress_(peripheral: Peripheral): Promise<string> {
    logger.debug('Getting address of peripheral device with uuid =', peripheral.uuid);
    let connected = false;
    try {
      await peripheral.connectAsync();
      connected = true;
      if (!peripheral.uuid) {
        throw new Error('No UUID');
      }
      logger.debug('Connected', { 'uuid': peripheral.uuid, 'address': peripheral.address });
      return peripheral.address;
    } finally {
      if (connected) {
        try {
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
}

interface RealtimeData {
  address: string | null,
  date: Date,
  probeType: ProbeType,
  temperatureCelsius: number,
  humidityPercent: number,
  batteryPercent: number,
}

class FileAddressCache implements AddressCache {
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

export { IBS_TH1, FileAddressCache, IbsTh1Scanner, crc16, parseRealtimeData };
export type { AddressCache, IbsTh1ScannerOptions, NobleAdapter, Peripheral, RealtimeData, Subscription, ProbeType };
