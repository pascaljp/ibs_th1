import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import * as Log4js from 'log4js';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileDeviceIdCache, IbsTh1Scanner } from '../src/ibs_th1';
import type { DeviceIdCache, NobleAdapter, Peripheral } from '../src/ibs_th1';

interface MockPeripheral extends Peripheral {
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

class MockNoble extends EventEmitter implements NobleAdapter {
  state = 'poweredOn';
  startScanningCalls = 0;
  stopScanningCalls = 0;

  override on(event: 'discover', listener: (peripheral: Peripheral) => void): this;
  override on(event: 'stateChange', listener: (state: string) => void): this;
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override removeListener(event: string, listener: (...args: any[]) => void): this {
    return super.removeListener(event, listener);
  }

  startScanning(_serviceUUIDs: string[], _allowDuplicates: boolean): void {
    this.startScanningCalls++;
  }

  stopScanning(): void {
    this.stopScanningCalls++;
  }

  discover(peripheral: Peripheral): void {
    this.emit('discover', peripheral);
  }
}

class MemoryDeviceIdCache implements DeviceIdCache {
  saveCalls = 0;

  constructor(private data: Map<string, string> = new Map()) {}

  load(): Map<string, string> {
    return new Map(this.data);
  }

  save(data: Map<string, string>): void {
    this.saveCalls++;
    this.data = new Map(data);
  }

  get(uuid: string): string | undefined {
    return this.data.get(uuid);
  }
}

function peripheral(options: {
  uuid: string;
  address?: string | null;
  systemId?: Buffer | null;
  connectError?: Error;
  discoverError?: Error;
  localName?: string;
  manufacturerData?: Buffer;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onDiscoverCharacteristics?: () => void;
}): MockPeripheral {
  return {
    uuid: options.uuid,
    address: 'address' in options ? options.address ?? null : 'aa:bb:cc:dd:ee:ff',
    advertisement: {
      localName: options.localName ?? 'sps',
      manufacturerData: options.manufacturerData ?? Buffer.from([
        0xd2, 0x04,
        0x7a, 0x17,
        0x00,
        0x00, 0x00,
        0x63,
        0x00,
      ]),
    },
    async connectAsync() {
      options.onConnect?.();
      if (options.connectError) {
        throw options.connectError;
      }
    },
    async disconnectAsync() {
      options.onDisconnect?.();
    },
    async discoverSomeServicesAndCharacteristicsAsync(serviceUUIDs: string[], characteristicUUIDs: string[]) {
      options.onDiscoverCharacteristics?.();
      if (options.discoverError) {
        throw options.discoverError;
      }
      assert.deepEqual(serviceUUIDs, ['180a']);
      assert.deepEqual(characteristicUUIDs, ['2a23']);
      if (options.systemId == null) {
        return { characteristics: [] };
      }
      return {
        characteristics: [
          {
            uuid: '2a23',
            async readAsync() {
              return options.systemId as Buffer;
            },
          },
        ],
      };
    },
  };
}

test('unsubscribe removes only this scanner listener and stops after all scanners unsubscribe', () => {
  const noble = new MockNoble();
  const first = new IbsTh1Scanner({ noble, deviceIdCache: new MemoryDeviceIdCache(new Map([['first', '11']])) });
  const second = new IbsTh1Scanner({ noble, deviceIdCache: new MemoryDeviceIdCache(new Map([['second', '22']])) });
  const externalListener = () => {};

  noble.on('discover', externalListener);
  const firstSubscription = first.subscribe(() => {});
  const secondSubscription = second.subscribe(() => {});

  assert.equal(noble.listenerCount('discover'), 3);
  firstSubscription.unsubscribe();
  assert.equal(noble.listenerCount('discover'), 2);
  assert.equal(noble.stopScanningCalls, 0);
  assert.equal(noble.listeners('discover').includes(externalListener), true);

  secondSubscription.unsubscribe();
  assert.equal(noble.listenerCount('discover'), 1);
  assert.equal(noble.stopScanningCalls, 1);
  assert.equal(noble.listeners('discover').includes(externalListener), true);
});

test('system id fetch failure is retryable and successful fetch is cached', async () => {
  const noble = new MockNoble();
  const cache = new MemoryDeviceIdCache();
  const scanner = new IbsTh1Scanner({ noble, deviceIdCache: cache });
  const received: unknown[] = [];

  const subscription = scanner.subscribe(data => received.push(data));
  noble.discover(peripheral({ uuid: 'device-1', connectError: new Error('connect failed') }));
  await new Promise(resolve => setImmediate(resolve));
  noble.discover(peripheral({
    uuid: 'device-1',
    address: '',
    systemId: Buffer.from('982f000000064249', 'hex'),
  }));
  await new Promise(resolve => setImmediate(resolve));
  noble.discover(peripheral({ uuid: 'device-1', address: '' }));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(cache.get('device-1'), 'ibs-th1-system-id:982f000000064249');
  assert.equal(cache.saveCalls, 1);
  assert.equal(received.length, 2);
  assert.equal((received[0] as any).deviceId, 'ibs-th1-system-id:982f000000064249');
  assert.equal('address' in (received[0] as any), false);
  subscription.unsubscribe();
});

test('invalid system id fetch is retryable and is not cached', async () => {
  const noble = new MockNoble();
  const cache = new MemoryDeviceIdCache();
  let now = 0;
  const originalDateNow = Date.now;
  Date.now = () => now;
  Log4js.configure({
    appenders: { recorded: { type: 'recording' } },
    categories: { default: { appenders: ['recorded'], level: 'warn' } },
  });
  const recording = Log4js.recording();
  recording.reset();
  const scanner = new IbsTh1Scanner({ noble, deviceIdCache: cache });
  const received: any[] = [];
  let connectCalls = 0;

  const subscription = scanner.subscribe(data => received.push(data));
  try {
    for (const systemId of [null, Buffer.alloc(0), Buffer.alloc(8)]) {
      noble.discover(peripheral({
        uuid: 'device-1',
        address: '',
        systemId,
        onConnect: () => {
          connectCalls++;
        },
      }));
      await new Promise(resolve => setImmediate(resolve));
    }
    noble.discover(peripheral({
      uuid: 'device-1',
      address: '',
      systemId: Buffer.from('982f000000064249', 'hex'),
      onConnect: () => {
        connectCalls++;
      },
    }));
    await new Promise(resolve => setImmediate(resolve));
    noble.discover(peripheral({ uuid: 'device-1', address: '' }));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(connectCalls, 1);
    assert.equal(cache.get('device-1'), undefined);
    assert.equal(cache.saveCalls, 0);
    assert.equal(received.length, 0);
    assert.equal(recording.replay().length, 1);
    assert.match(recording.replay()[0]?.data.join(' '), /Unable to get stable device id/);

    now = 30_000;
    noble.discover(peripheral({
      uuid: 'device-1',
      address: '',
      systemId: Buffer.alloc(8),
      onConnect: () => {
        connectCalls++;
      },
    }));
    await new Promise(resolve => setImmediate(resolve));

    now = 149_999;
    noble.discover(peripheral({
      uuid: 'device-1',
      address: '',
      systemId: Buffer.from('982f000000064249', 'hex'),
      onConnect: () => {
        connectCalls++;
      },
    }));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(connectCalls, 2);
    assert.equal(cache.get('device-1'), undefined);
    assert.equal(cache.saveCalls, 0);
    assert.equal(received.length, 0);
    assert.equal(recording.replay().length, 2);

    now = 150_000;
    noble.discover(peripheral({
      uuid: 'device-1',
      address: '',
      systemId: Buffer.from('982f000000064249', 'hex'),
      onConnect: () => {
        connectCalls++;
      },
    }));
    await new Promise(resolve => setImmediate(resolve));
    noble.discover(peripheral({ uuid: 'device-1', address: '' }));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(connectCalls, 3);
    assert.equal(cache.get('device-1'), 'ibs-th1-system-id:982f000000064249');
    assert.equal(cache.saveCalls, 1);
    assert.equal(received.length, 2);
    assert.equal(received[0].deviceId, 'ibs-th1-system-id:982f000000064249');
    assert.equal(received[1].deviceId, 'ibs-th1-system-id:982f000000064249');
  } finally {
    Date.now = originalDateNow;
    subscription.unsubscribe();
  }
});

test('cached device ids avoid connection and cache writes', async () => {
  const noble = new MockNoble();
  const cache = new MemoryDeviceIdCache(new Map([['device-1', 'ibs-th1-system-id:982f000000064249']]));
  const scanner = new IbsTh1Scanner({ noble, deviceIdCache: cache });
  const received: any[] = [];
  let connectCalls = 0;

  const subscription = scanner.subscribe(data => received.push(data));
  noble.discover(peripheral({
    uuid: 'device-1',
    onConnect: () => {
      connectCalls++;
    },
  }));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(connectCalls, 0);
  assert.equal(cache.saveCalls, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].deviceId, 'ibs-th1-system-id:982f000000064249');
  assert.equal('address' in received[0], false);
  assert.equal(received[0].temperatureCelsius, 12.34);
  assert.equal(received[0].humidityPercent, 60.1);
  assert.equal(received[0].batteryPercent, 99);
  assert.equal(received[0].probeType, 'built-in');
  subscription.unsubscribe();
});

test('stateChange starts scanning when Bluetooth powers on', () => {
  const noble = new MockNoble();
  noble.state = 'poweredOff';
  const scanner = new IbsTh1Scanner({ noble, deviceIdCache: new MemoryDeviceIdCache() });

  const subscription = scanner.subscribe(() => {});
  assert.equal(noble.startScanningCalls, 0);
  assert.equal(noble.listenerCount('stateChange'), 1);

  noble.state = 'poweredOn';
  noble.emit('stateChange', 'poweredOn');

  assert.equal(noble.startScanningCalls, 1);
  assert.equal(noble.listenerCount('discover'), 1);
  subscription.unsubscribe();
});

test('old subscription does not unsubscribe a newer subscription on the same scanner', () => {
  const noble = new MockNoble();
  const scanner = new IbsTh1Scanner({
    noble,
    deviceIdCache: new MemoryDeviceIdCache(new Map([['device-1', '11:22:33:44:55:66']])),
  });

  const oldSubscription = scanner.subscribe(() => {});
  const currentSubscription = scanner.subscribe(() => {});

  oldSubscription.unsubscribe();
  assert.equal(noble.listenerCount('discover'), 1);
  assert.equal(noble.stopScanningCalls, 0);

  currentSubscription.unsubscribe();
  assert.equal(noble.listenerCount('discover'), 0);
  assert.equal(noble.stopScanningCalls, 1);
});

test('non-target advertisements are ignored without connecting', async () => {
  const noble = new MockNoble();
  const cache = new MemoryDeviceIdCache();
  const scanner = new IbsTh1Scanner({ noble, deviceIdCache: cache });
  const received: unknown[] = [];
  let connectCalls = 0;

  const subscription = scanner.subscribe(data => received.push(data));
  noble.discover(peripheral({
    uuid: 'wrong-name',
    localName: 'not-sps',
    onConnect: () => {
      connectCalls++;
    },
  }));
  noble.discover(peripheral({
    uuid: 'wrong-length',
    manufacturerData: Buffer.from([0x00, 0x00, 0x00]),
    onConnect: () => {
      connectCalls++;
    },
  }));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(connectCalls, 0);
  assert.equal(cache.saveCalls, 0);
  assert.equal(received.length, 0);
  subscription.unsubscribe();
});

test('successful system id fetch disconnects before emitting data', async () => {
  const noble = new MockNoble();
  const cache = new MemoryDeviceIdCache();
  const scanner = new IbsTh1Scanner({ noble, deviceIdCache: cache });
  const events: string[] = [];

  const subscription = scanner.subscribe(() => events.push('callback'));
  noble.discover(peripheral({
    uuid: 'device-1',
    systemId: Buffer.from('982f000000064249', 'hex'),
    onConnect: () => events.push('connect'),
    onDisconnect: () => events.push('disconnect'),
  }));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(events, ['connect', 'disconnect', 'callback']);
  subscription.unsubscribe();
});

test('FileDeviceIdCache does not overwrite corrupt cache files', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibs-th1-'));
  const configDir = path.join(homeDir, '.ibs_th1');
  const configPath = path.join(configDir, 'uuid_to_device_id');
  fs.mkdirSync(configDir);
  fs.writeFileSync(configPath, '{broken json', 'utf8');

  const cache = new FileDeviceIdCache('uuid_to_device_id', homeDir);
  const loaded = cache.load();

  assert.equal(loaded.size, 0);
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{broken json');
});

test('FileDeviceIdCache creates missing cache files with private permissions', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibs-th1-'));
  const configPath = path.join(homeDir, '.ibs_th1', 'uuid_to_device_id');

  const cache = new FileDeviceIdCache('uuid_to_device_id', homeDir);
  const loaded = cache.load();
  const mode = fs.statSync(configPath).mode & 0o777;

  assert.equal(loaded.size, 0);
  assert.equal(mode, 0o600);
});

test('default scanner explains how to install Noble when it is missing', () => {
  assert.throws(
    () => new IbsTh1Scanner({ deviceIdCache: new MemoryDeviceIdCache() }),
    /Bluetooth scanning requires @abandonware\/noble.*npm install ibs_th1 @abandonware\/noble/s);
});
