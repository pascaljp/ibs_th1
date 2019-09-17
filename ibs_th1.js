'use strict';

const noble = require('noble');

class IBS_TH1 {

  constructor() {
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
	  .catch(err => {console.log(err)});
      });
      noble.startScanning([IBS_TH1.SERVICE_UUID], true /*allowDuplicates*/);
    };

    if (noble.state === 'poweredOn') {
      scanStart(callback);
    } else {
      noble.on('stateChange', () => {
	scanStart(callback);
      });
    }
  }

  unsubscribeRealtimeData() {
    noble.stopScanning();
  }

  //
  // Private functions.
  //

  async onDiscover_(peripheral) {
    return new Promise((resolve, reject) => {
      if (peripheral.advertisement.localName != IBS_TH1.DEVICE_NAME) {
	reject('Not a target device');
	return;
      }
      const buffer = peripheral.advertisement.manufacturerData;
      if (!buffer || buffer.byteLength != 9) {
	reject('Unexpected advertisement data');
	return;
      }
      const expectedCrc16 = buffer[6] * 256 + buffer[5];
      if (expectedCrc16 != IBS_TH1.getCrc16(buffer.slice(0, 5))) {
	reject('CRC error');
	return;
      }

      if (!(peripheral.uuid in this.uuid_to_address_)) {
	// Check the address from now.
	this.uuid_to_address_[peripheral.uuid] = null;
	this.connect_(peripheral);
	reject('Fetching address now');
	return;
      }
      if (this.uuid_to_address_[peripheral.uuid] == null) {
	// Checking address now.
	reject('Fetching address now');
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
      realtimeData.address = this.uuid_to_address_[peripheral.uuid];
      realtimeData.temperature = temperature;
      realtimeData.humidity = humidity;
      realtimeData.probeType = probeType;
      realtimeData.battery = battery;
      resolve(realtimeData);
    });
  }

  async connect_(peripheral) {
    console.log('Getting address of peripheral device with uuid =', peripheral.uuid);
    return new Promise((resolve, reject) => {
      peripheral.connect(err => {
	if (err) {
	  reject('connect result:', err);
	  return;
	}
	peripheral.disconnect(err => console.log('Disconnected:', err));
	if (err || !peripheral.uuid) {
	  delete this.uuid_to_address_[peripheral.uuid];
	  reject(err);
	  return;
	}

	this.uuid_to_address_[peripheral.uuid] = peripheral.address;
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
