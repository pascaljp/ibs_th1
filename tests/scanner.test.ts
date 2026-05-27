import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import * as Log4js from 'log4js';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileAddressCache, IbsTh1Scanner } from '../src/ibs_th1';
import type { AddressCache, NobleAdapter, Peripheral } from '../src/ibs_th1';

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

class MemoryAddressCache implements AddressCache {
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
  connectError?: Error;
  localName?: string;
  manufacturerData?: Buffer;
  onConnect?: () => void;
  onDisconnect?: () => void;
}): Peripheral {
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
  };
}

test('unsubscribe removes only this scanner listener and stops after all scanners unsubscribe', () => {
  const noble = new MockNoble();
  const first = new IbsTh1Scanner({ noble, addressCache: new MemoryAddressCache(new Map([['first', '11']])) });
  const second = new IbsTh1Scanner({ noble, addressCache: new MemoryAddressCache(new Map([['second', '22']])) });
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

test('address fetch failure is retryable and successful fetch is cached', async () => {
  const noble = new MockNoble();
  const cache = new MemoryAddressCache();
  const scanner = new IbsTh1Scanner({ noble, addressCache: cache });
  const received: unknown[] = [];

  const subscription = scanner.subscribe(data => received.push(data));
  noble.discover(peripheral({ uuid: 'device-1', connectError: new Error('connect failed') }));
  await new Promise(resolve => setImmediate(resolve));
  noble.discover(peripheral({ uuid: 'device-1', address: 'aa:bb:cc:dd:ee:ff' }));
  await new Promise(resolve => setImmediate(resolve));
  noble.discover(peripheral({ uuid: 'device-1', address: 'aa:bb:cc:dd:ee:ff' }));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(cache.get('device-1'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(cache.saveCalls, 1);
  assert.equal(received.length, 2);
  subscription.unsubscribe();
});

test('invalid address fetch is retryable and is not cached', async () => {
  const noble = new MockNoble();
  const cache = new MemoryAddressCache();
  let now = 0;
  const originalDateNow = Date.now;
  Date.now = () => now;
  Log4js.configure({
    appenders: { recorded: { type: 'recording' } },
    categories: { default: { appenders: ['recorded'], level: 'warn' } },
  });
  const recording = Log4js.recording();
  recording.reset();
  const scanner = new IbsTh1Scanner({ noble, addressCache: cache });
  const received: any[] = [];
  let connectCalls = 0;

  const subscription = scanner.subscribe(data => received.push(data));
  try {
    for (const address of [null, '', '   ', ' unknown ', '00:00:00:00:00:00']) {
      noble.discover(peripheral({
        uuid: 'device-1',
        address,
        onConnect: () => {
          connectCalls++;
        },
      }));
      await new Promise(resolve => setImmediate(resolve));
    }
    noble.discover(peripheral({
      uuid: 'device-1',
      address: ' aa:bb:cc:dd:ee:ff ',
      onConnect: () => {
        connectCalls++;
      },
    }));
    await new Promise(resolve => setImmediate(resolve));
    noble.discover(peripheral({ uuid: 'device-1', address: 'ignored-after-cache' }));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(connectCalls, 1);
    assert.equal(cache.get('device-1'), undefined);
    assert.equal(cache.saveCalls, 0);
    assert.equal(received.length, 0);
    assert.equal(recording.replay().length, 1);
    assert.match(recording.replay()[0]?.data.join(' '), /Unable to get stable address/);

    now = 30_000;
    noble.discover(peripheral({
      uuid: 'device-1',
      address: '00:00:00:00:00:00',
      onConnect: () => {
        connectCalls++;
      },
    }));
    await new Promise(resolve => setImmediate(resolve));

    now = 149_999;
    noble.discover(peripheral({
      uuid: 'device-1',
      address: ' aa:bb:cc:dd:ee:ff ',
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
      address: ' aa:bb:cc:dd:ee:ff ',
      onConnect: () => {
        connectCalls++;
      },
    }));
    await new Promise(resolve => setImmediate(resolve));
    noble.discover(peripheral({ uuid: 'device-1', address: 'ignored-after-cache' }));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(connectCalls, 3);
    assert.equal(cache.get('device-1'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(cache.saveCalls, 1);
    assert.equal(received.length, 2);
    assert.equal(received[0].address, 'aa:bb:cc:dd:ee:ff');
    assert.equal(received[1].address, 'aa:bb:cc:dd:ee:ff');
  } finally {
    Date.now = originalDateNow;
    subscription.unsubscribe();
  }
});

test('cached addresses avoid connection and cache writes', async () => {
  const noble = new MockNoble();
  const cache = new MemoryAddressCache(new Map([['device-1', '11:22:33:44:55:66']]));
  const scanner = new IbsTh1Scanner({ noble, addressCache: cache });
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
  assert.equal(received[0].address, '11:22:33:44:55:66');
  assert.equal(received[0].temperatureCelsius, 12.34);
  assert.equal(received[0].humidityPercent, 60.1);
  assert.equal(received[0].batteryPercent, 99);
  assert.equal(received[0].probeType, 'built-in');
  subscription.unsubscribe();
});

test('stateChange starts scanning when Bluetooth powers on', () => {
  const noble = new MockNoble();
  noble.state = 'poweredOff';
  const scanner = new IbsTh1Scanner({ noble, addressCache: new MemoryAddressCache() });

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
    addressCache: new MemoryAddressCache(new Map([['device-1', '11:22:33:44:55:66']])),
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
  const cache = new MemoryAddressCache();
  const scanner = new IbsTh1Scanner({ noble, addressCache: cache });
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

test('successful address fetch disconnects before emitting data', async () => {
  const noble = new MockNoble();
  const cache = new MemoryAddressCache();
  const scanner = new IbsTh1Scanner({ noble, addressCache: cache });
  const events: string[] = [];

  const subscription = scanner.subscribe(() => events.push('callback'));
  noble.discover(peripheral({
    uuid: 'device-1',
    onConnect: () => events.push('connect'),
    onDisconnect: () => events.push('disconnect'),
  }));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(events, ['connect', 'disconnect', 'callback']);
  subscription.unsubscribe();
});

test('FileAddressCache does not overwrite corrupt cache files', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibs-th1-'));
  const configDir = path.join(homeDir, '.ibs_th1');
  const configPath = path.join(configDir, 'uuid_to_address');
  fs.mkdirSync(configDir);
  fs.writeFileSync(configPath, '{broken json', 'utf8');

  const cache = new FileAddressCache('uuid_to_address', homeDir);
  const loaded = cache.load();

  assert.equal(loaded.size, 0);
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{broken json');
});

test('FileAddressCache creates missing cache files with private permissions', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibs-th1-'));
  const configPath = path.join(homeDir, '.ibs_th1', 'uuid_to_address');

  const cache = new FileAddressCache('uuid_to_address', homeDir);
  const loaded = cache.load();
  const mode = fs.statSync(configPath).mode & 0o777;

  assert.equal(loaded.size, 0);
  assert.equal(mode, 0o600);
});

test('default scanner explains how to install Noble when it is missing', () => {
  assert.throws(
    () => new IbsTh1Scanner({ addressCache: new MemoryAddressCache() }),
    /Bluetooth scanning requires @abandonware\/noble.*npm install ibs_th1 @abandonware\/noble/s);
});
