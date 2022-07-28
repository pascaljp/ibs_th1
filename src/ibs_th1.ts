'use strict';

import * as fs from 'fs';
import * as Log4js from 'log4js';
import noble from '@abandonware/noble';
import * as os from 'os';
import * as path from 'path';

const logger = Log4js.getLogger('ibs_th1');

// Device name for IBS-TH1, IBS-TH1 mini and IBS_TH1 Plus.
const DEVICE_NAME: string = 'sps';
//const SERVICE_UUID: string = 'fff0';

type ProbeType = 'UNKNOWN' | 'BUILT_IN' | 'EXTERNAL';
type AddressFetchStatus = 'FETCHING' | 'FETCHED';

class IBS_TH1 {
  private address_fetch_status_: Map<string, AddressFetchStatus>;
  private uuid_to_address_: Map<string, string>;

  constructor() {
    this.address_fetch_status_ = new Map<string, AddressFetchStatus>();
    this.uuid_to_address_ = new Config('uuid_to_address').load();
  }

  //
  // Public functions.
  //

  subscribeRealtimeData(callback: (data: RealtimeData) => void) {
    const scanStart = (callback: (data: RealtimeData) => void) => {
      noble.on('discover', async (peripheral: noble.Peripheral) => {
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
      });
      noble.startScanning([/*SERVICE_UUID*/], true /*allowDuplicates*/);
      logger.info('Started to scan Bluetooth signals');
    };

    if (noble.state === 'poweredOn') {
      scanStart(callback);
    } else {
      noble.on('stateChange', (state) => {
        if (state == 'poweredOn') {
          scanStart(callback);
        } else {
          this.unsubscribeRealtimeData();
        }
      });
    }
  }

  unsubscribeRealtimeData(): void {
    noble.removeAllListeners('discover');
    noble.removeAllListeners('stateChange');
    noble.stopScanning();
    logger.info('Stopped to scan Bluetooth signals');
  }

  restart(callback: (data: RealtimeData) => void): void {
    logger.info('Restarting');
    this.unsubscribeRealtimeData();
    this.subscribeRealtimeData(callback);
  }

  //
  // Private functions.
  //

  isTargetDevice_(peripheral: noble.Peripheral): boolean {
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
    // if (expectedCrc16 != IBS_TH1.getCrc16(buffer.slice(0, 5))) {
    //   console.error('CRC error', this.uuid_to_address_.get(peripheral.uuid));
    //   return false;
    // }

    return true;
  }

  async prepareAddress_(peripheral: noble.Peripheral, callback: (data: RealtimeData) => void): Promise<void> {
    const fetchStatus = this.address_fetch_status_.get(peripheral.uuid);
    if (fetchStatus == 'FETCHING') {
      // Another thread is checking the address now.
      throw new Error('Discovered => Address fetch on flight. Ignoring.');
    }

    const address = this.uuid_to_address_.get(peripheral.uuid);
    if (!address) {
      // Check the address from now.
      this.address_fetch_status_.set(peripheral.uuid, 'FETCHING');
      const address: string = await this.getAddress_(peripheral);

      this.address_fetch_status_.set(peripheral.uuid, 'FETCHED');
      this.uuid_to_address_.set(peripheral.uuid, address);
      new Config('uuid_to_address').save(this.uuid_to_address_);

      // Without this line, noble stops receiving broadcasted data.
      this.restart(callback);
    }
  }

  getRealtimeData_(peripheral: noble.Peripheral): RealtimeData | null {
    const buffer = peripheral.advertisement.manufacturerData;
    if (buffer.length < 8) {
      return null;
    }
    const temperature_raw_value: number = buffer[1]! * 256 + buffer[0]!;
    const temperature: number = temperature_raw_value >= 0x8000 ?
      (temperature_raw_value - 0x10000) / 100 : temperature_raw_value / 100;
    const humidity: number = (buffer[3]! * 256 + buffer[2]!) / 100;
    const probeType: ProbeType =
      buffer[4] == 0 ? 'BUILT_IN' : buffer[4] == 1 ? 'EXTERNAL' : 'UNKNOWN';
    const battery: number = buffer[7]!;
    // const productionIBS_TH1Data = buffer[8];
    const realtimeData: RealtimeData = {
      date: new Date,
      address: this.uuid_to_address_.get(peripheral.uuid) || 'error',
      temperature: temperature,
      humidity: humidity,
      probeType: probeType,
      battery: battery,
    };
    return realtimeData;
  }

  async getAddress_(peripheral: noble.Peripheral): Promise<string> {
    logger.debug('Getting address of peripheral device with uuid =', peripheral.uuid);
    await peripheral.connectAsync();
    if (!peripheral.uuid) {
      this.uuid_to_address_.delete(peripheral.uuid);
      throw new Error('No UUID');
    }
    logger.debug('Connected', { 'uuid': peripheral.uuid, 'address': peripheral.address });
    await peripheral.disconnectAsync();
    return peripheral.address;
  }

  /**
   * @param {Buffer} buffer
   */
  static getCrc16(buffer: Buffer): number {
    let crc16 = 0xffff;
    const iter = buffer.values();
    let item = iter.next();
    while (!item.done) {
      const byte = item.value;
      crc16 ^= byte;
      for (let i = 0; i < 8; i++) {
        const tmp = crc16 & 0x1;
        crc16 >>= 1;
        if (tmp) {
          crc16 ^= 0xa001;
        }
      }
      item = iter.next();
    }
    return crc16;
  }
}

interface RealtimeData {
  address: string | null,
  date: Date | null,
  probeType: ProbeType,
  temperature: number | null,
  humidity: number | null,
  battery: number | null,
}

class Config {
  private homeDir_: string;
  private configDir_: string;
  private configPath_: string;

  constructor(configName: string) {
    this.homeDir_ = os.homedir();
    this.configDir_ = path.join(this.homeDir_, '.ibs_th1/');
    this.configPath_ = path.join(this.configDir_, configName);
  }

  load(): Map<string, any> {
    const map = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(this.configPath_, 'utf8'));
      for (const uuid in data) {
        map.set(uuid, data[uuid]);
      }
      return map;
    } catch (err) {
      this.save(map);
      return map;
    }
  }

  save(data: Map<string, any>): void {
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
      { 'encoding': 'utf8', 'mode': 0o700 });
  }
}

export { IBS_TH1, RealtimeData };
