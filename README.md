# IBS-TH1

> A library to handle broadcasted message from bluetooth device [IBS-TH1](http://www.ink-bird.com/products-smart-sensor-ibsth1.html), [IBS-TH1 mini](http://www.ink-bird.com/products-smart-sensor-ibsth1mini.html) and [IBS-TH1 Plus](https://www.ink-bird.com/products-smart-sensor-ibsth1plus.html). Not tested with other devices.

[![NPM Version][npm-image]][npm-url]

## Install

```bash
npm i -S ibs_th1
```

Bluetooth scanning uses `@abandonware/noble` as an optional peer dependency.
Install it when you use `IbsTh1Scanner` to scan real devices.

```bash
npm i -S ibs_th1 @abandonware/noble
```

The parser entry point does not require Noble.

## Usage

```javascript
const {IbsTh1Scanner} = require('ibs_th1');

const callback = data => {
  console.log(data.deviceId, data.date, data.temperatureCelsius,
              data.humidityPercent, data.probeType, data.batteryPercent);
};

const device = new IbsTh1Scanner();
const subscription = device.subscribe(callback);

process.on('SIGINT', () => {
  subscription.unsubscribe();
  process.exit();
});
```

```typescript
import {IbsTh1Scanner, RealtimeData} from 'ibs_th1';

const callback = (data: RealtimeData) => {
  console.log(data);
};

const device = new IbsTh1Scanner();
const subscription = device.subscribe(callback);

process.on('SIGINT', () => {
  subscription.unsubscribe();
  process.exit();
});
```

Each `IbsTh1Scanner` instance has one active subscription. Calling `subscribe`
again replaces the previous callback. Use `subscription.unsubscribe()` to stop
the active subscription.

`data.deviceId` is a stable identifier derived from the Device Information
Service System ID characteristic (`180a` / `2a23`) and is returned as
`ibs-th1-system-id:<hex>`.

If you already have an IBS-TH1 manufacturer data buffer and only need to decode
it, use the parser entry point. This does not start Bluetooth scanning.

```typescript
import {parseRealtimeData} from 'ibs_th1/parser';

const data = parseRealtimeData(manufacturerData);
```

## License

[MIT](http://vjpr.mit-license.org)

[npm-image]: https://img.shields.io/npm/v/ibs_th1.svg
[npm-url]: https://npmjs.org/package/ibs_th1
