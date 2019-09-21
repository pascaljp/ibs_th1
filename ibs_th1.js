'use strict';

const log4js = require('log4js')
const noble = require('@abandonware/noble');

class IBS_TH1 {

  /**
   * @param {Object} opt_params
   */
  constructor(opt_params) {
    if (opt_params && 'logger' in opt_params) {
      this.logger_ = opt_logger;
    } else {
      this.logger_ = log4js.getLogger();
      this.logger_.level = 'info';
    }
    this.uuid_to_address_ = {};
  }

  //
  // Public functions.
  //

  subscribeRealtimeData(callback) {
    const scanStart = callback => {
      noble.on('discover', peripheral => {
	this.onDiscover_(peripheral)
	  .then(realtimeData => callback(realtimeData))
	  .catch(err => { this.logger_.trace(err); });
      });
      noble.startScanning([IBS_TH1.SERVICE_UUID], true /*allowDuplicates*/);
      this.logger_.info('Started to scan Bluetooth signals');
    };

    const scanStop = () => {
      noble.stopScanning();
      this.logger_.info('Stopped to scan Bluetooth signals');
    };

    if (noble.state === 'poweredOn') {
      scanStart(callback);
    } else {
      noble.on('stateChange', (state) => {
	if (state == 'poweredOn') {
	  scanStart(callback);
	} else {
	  this.scanStop();
	}
      });
    }
  }

  unsubscribeRealtimeData() {
    noble.on('stateChange', (state) => {});
    noble.stopScanning();
    this.logger_.info('Stopped to scan Bluetooth signals');
  }

  //
  // Private functions.
  //

  async onDiscover_(peripheral) {
    return new Promise((resolve, reject) => {
      if (peripheral.advertisement.localName != IBS_TH1.DEVICE_NAME) {
	reject('Discovered => Not a target device');
	return;
      }
      const buffer = peripheral.advertisement.manufacturerData;
      if (!buffer || buffer.byteLength != 9) {
	reject('Discovered => Unexpected advertisement data');
	return;
      }
      const expectedCrc16 = buffer[6] * 256 + buffer[5];
      if (expectedCrc16 != IBS_TH1.getCrc16(buffer.slice(0, 5))) {
	reject('Discovered => CRC error');
	return;
      }

      if (!(peripheral.uuid in this.uuid_to_address_)) {
	// Check the address from now.
	this.uuid_to_address_[peripheral.uuid] = null;
	this.connect_(peripheral);
	reject('Discovered => Address fetch started. Ignoring.');
	return;
      }
      if (this.uuid_to_address_[peripheral.uuid] == null) {
	// Checking address now.
	reject('Discovered => Address fetch on flight. Ignoring.');
	return;
      }

      const temperature_raw_value = buffer[1] * 256 + buffer[0];
      const temperature = temperature_raw_value >= 0x8000 ?
	    (temperature_raw_value - 0x10000) / 100 : temperature_raw_value / 100;
      const humidity = (buffer[3] * 256 + buffer[2]) / 100;
      const probeType =
	    buffer[4] == 0 ? IBS_TH1.ProbeTypeEnum.BUILT_IN :
	    buffer[4] == 1 ? IBS_TH1.ProbeTypeEnum.EXTERNAL :
	    IBS_TH1.ProbeTypeEnum.UNKNOWN;
      const battery = buffer[7];
      const productionIBS_TH1Data = buffer[8];
      const realtimeData = {};
      realtimeData.uuid = peripheral.uuid;
      realtimeData.date = new Date;
      realtimeData.address = this.uuid_to_address_[peripheral.uuid];
      realtimeData.temperature = temperature;
      realtimeData.humidity = humidity;
      realtimeData.probeType = probeType;
      realtimeData.battery = battery;
      resolve(realtimeData);
    });
  }

  async connect_(peripheral) {
    this.logger_.debug('Getting address of peripheral device with uuid =', peripheral.uuid);
    return new Promise((resolve, reject) => {
      peripheral.connect(err => {
	if (err) {
	  reject('connect result:', err);
	  return;
	}
	peripheral.disconnect(err => reject('Failed to disconnect from', peripheral.uuid));
	if (err || !peripheral.uuid) {
	  delete this.uuid_to_address_[peripheral.uuid];
	  reject(err);
	  return;
	}

	this.uuid_to_address_[peripheral.uuid] = peripheral.address;
	this.logger_.debug(
	  'Connected', {'uuid': peripheral.uuid, 'address': peripheral.address});
	resolve(peripheral);
      });
    });
  }

  /**
   * @param {Buffer} buffer
   */
  static getCrc16(buffer) {
    let crc16 = 0xffff;
    for (let byte of buffer) {
      crc16 ^= byte;
      for (let i = 0; i < 8; i++) {
	const tmp = crc16 & 0x1;
	crc16 >>= 1;
	if (tmp) {
	  crc16 ^= 0xa001;
	}
      }
    }
    return crc16;
  }
}

// Device name for IBS-TH1 and IBS-TH1 mini.
IBS_TH1.DEVICE_NAME = 'sps';
IBS_TH1.SERVICE_UUID = 'fff0';

IBS_TH1.ProbeTypeEnum = {
    UNKNOWN: 0,
    BUILT_IN: 1,
    EXTERNAL: 2,
};

module.exports = IBS_TH1;
