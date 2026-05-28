const {IbsTh1Scanner} = require('../dist/ibs_th1');

const callback = data => {
  console.log(data.deviceId, data.date, data.temperatureCelsius,
              data.humidityPercent, data.probeType, data.batteryPercent);
};

const device = new IbsTh1Scanner();
const subscription = device.subscribe(callback);
