import assert from 'node:assert/strict';
import test from 'node:test';
import { crc16 } from '../src/ibs_th1';
import { parseRealtimeData } from '../src/parser';

test('parseRealtimeData decodes a built-in probe advertisement', () => {
  const data = parseRealtimeData(Buffer.from([
    0xd2, 0x04, // 12.34 C
    0x7a, 0x17, // 60.10 %
    0x00,       // built-in probe
    0x00, 0x00,
    0x63,       // 99 %
    0x00,
  ]));

  assert.deepEqual(data, {
    probeType: 'built-in',
    temperatureCelsius: 12.34,
    humidityPercent: 60.1,
    batteryPercent: 99,
  });
});

test('parseRealtimeData decodes signed negative temperatures', () => {
  const data = parseRealtimeData(Buffer.from([
    0x2e, 0xfb, // -12.34 C
    0x7a, 0x17,
    0x01,
    0x00, 0x00,
    0x50,
    0x00,
  ]));

  assert.equal(data?.temperatureCelsius, -12.34);
  assert.equal(data?.probeType, 'external');
});

test('parseRealtimeData returns null for short advertisements', () => {
  assert.equal(parseRealtimeData(Buffer.from([0x00, 0x00, 0x00])), null);
});

test('parseRealtimeData accepts exactly eight bytes', () => {
  const data = parseRealtimeData(Buffer.from([
    0x00, 0x00,
    0x00, 0x00,
    0x02,
    0x00, 0x00,
    0x00,
  ]));

  assert.deepEqual(data, {
    probeType: 'unknown',
    temperatureCelsius: 0,
    humidityPercent: 0,
    batteryPercent: 0,
  });
});

test('parseRealtimeData ignores trailing bytes from nine-byte advertisements', () => {
  const data = parseRealtimeData(Buffer.from([
    0xff, 0x7f, // 327.67 C
    0xff, 0xff, // 655.35 %
    0x01,
    0xaa, 0xbb,
    0x64,
    0xcc,
  ]));

  assert.deepEqual(data, {
    probeType: 'external',
    temperatureCelsius: 327.67,
    humidityPercent: 655.35,
    batteryPercent: 100,
  });
});

test('parseRealtimeData decodes minimum signed temperature', () => {
  const data = parseRealtimeData(Buffer.from([
    0x00, 0x80, // -327.68 C
    0x00, 0x00,
    0x00,
    0x00, 0x00,
    0x01,
  ]));

  assert.equal(data?.temperatureCelsius, -327.68);
  assert.equal(data?.batteryPercent, 1);
});

test('crc16 returns the standard MODBUS CRC for a known input', () => {
  assert.equal(crc16(Buffer.from('123456789', 'ascii')), 0x4b37);
});
