const assert = require('node:assert/strict');

const main = require('ibs_th1');
const parser = require('ibs_th1/parser');
const deepParser = require('ibs_th1/dist/parser');
const deepParserJs = require('ibs_th1/dist/parser.js');

const payload = Buffer.from([
  0xd2, 0x04,
  0x7a, 0x17,
  0x00,
  0x00, 0x00,
  0x63,
  0x00,
]);

const expected = {
  temperatureCelsius: 12.34,
  humidityPercent: 60.1,
  probeType: 'built-in',
  batteryPercent: 99,
};

assert.equal(typeof main.IbsTh1Scanner, 'function');
assert.equal(main.IBS_TH1, main.IbsTh1Scanner);
assert.equal(typeof main.FileDeviceIdCache, 'function');
assert.equal(typeof main.crc16, 'function');
assert.deepEqual(main.parseRealtimeData(payload), expected);
assert.deepEqual(parser.parseRealtimeData(payload), expected);
assert.deepEqual(deepParser.parseRealtimeData(payload), expected);
assert.deepEqual(deepParserJs.parseRealtimeData(payload), expected);
