'use strict';

const noble = require('noble');

class IBS_TH1 {
  /**
   * @param {function} opt_obsolete_subscribe_callback A callback function that is
   *   called when a realtime data is received.
   */
  constructor(opt_obsolete_callback) {
    console.log(opt_obsolete_callback);
    if (opt_obsolete_callback) {
      console.error('constructor of IBS_TH1 does not take an argument anymore.');
    }
    // Variable to support deprecated functions start() and stop().
    this.subscribe_realtime_data_callback_ = opt_obsolete_callback;
  }

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

  discovered_(peripheral, callback) {
    if (peripheral.advertisement.localName != IBS_TH1.DEVICE_NAME) {
      return;
    }
    const buffer = peripheral.advertisement.manufacturerData;
    if (!buffer || buffer.byteLength != 9) {
      return;
    }

    const expectedCrc16 = buffer[6] * 256 + buffer[5];
    if (expectedCrc16 != IBS_TH1.getCrc16(buffer.slice(0, 5))) {
      callback({
	'uuid': peripheral.uuid,
	'date': new Date(),
	'error': 'CRC error',
      });
      return;
    }

    const temperature_raw_value = buffer[1] * 256 + buffer[0];
    const temperature = temperature_raw_value >= 0x8000 ? (temperature_raw_value - 0x10000) / 100 : temperature_raw_value / 100;
    const humidity = (buffer[3] * 256 + buffer[2]) / 100;
    const probeType =
	  buffer[4] == 0 ? IBS_TH1.ProbeTypeEnum.BUILT_IN :
	  buffer[4] == 1 ? IBS_TH1.ProbeTypeEnum.EXTERNAL :
	  IBS_TH1.ProbeTypeEnum.UNKNOWN;
    const battery = buffer[7];
    const productionTestData = buffer[8];
    callback({
      'uuid': peripheral.uuid,
      'date': new Date(),
      'temperature': temperature,
      'humidity': humidity,
      'probeType': probeType,
      'battery': battery,
      'error': null,
    });
  }

  scanStart_(callback) {
    noble.on('discover', (peripheral) => {
      this.discovered_(peripheral, callback);
    });
    noble.startScanning([IBS_TH1.SERVICE_UUID], true /*allowDuplicates*/);
  }

  // To start receiving realtime data.
  start() {
    console.error('This function is replaced by subscribeRealtimeData(), and will be deleted after 2018/12/01.');
    this.subscribeRealtimeData(this.subscribe_realtime_data_callback_);
  }

  // To stop receiving realtime data.
  stop() {
    console.error('This function is replaced by unsubscribeRealtimeData(), and will be deleted after 2018/12/01.');
    this.unsubscribeRealtimeData();
  }

  subscribeRealtimeData(callback) {
    if (noble.state === 'poweredOn') {
      this.scanStart_(callback);
    } else {
      noble.on('stateChange', () => {
	this.scanStart_(callback);
      });
    }
  }

  unsubscribeRealtimeData() {
    noble.stopScanning();
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
