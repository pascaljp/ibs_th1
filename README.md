# IBS-TH1

> A library to handle broadcasted message from bluetooth device [IBS-TH1](http://www.ink-bird.com/products-smart-sensor-ibsth1.html), [IBS-TH1 mini](http://www.ink-bird.com/products-smart-sensor-ibsth1mini.html) and [IBS-TH1 Plus](https://www.ink-bird.com/products-smart-sensor-ibsth1plus.html). Not tested with other devices.

[![NPM Version][npm-image]][npm-url]

## Install

```bash
npm i -S ibs_th1
```

## Usage

```javascript
const {IBS_TH1} = require('ibs_th1');

const callback = data => {
  console.log(data.address, data.date, data.temperature, data.humidity,
              data.probeType, data.battery);
};

const device = new IBS_TH1();
device.subscribeRealtimeData(callback);
```

```typescript
import {IBS_TH1, RealtimeData} from '../src/ibs_th1';

const callback = (data: RealtimeData) => {
  console.log(data);
};

const device = new IBS_TH1();
device.subscribeRealtimeData(callback);
```

## License

[MIT](http://vjpr.mit-license.org)

[npm-image]: https://img.shields.io/npm/v/ibs_th1.svg
[npm-url]: https://npmjs.org/package/ibs_th1
