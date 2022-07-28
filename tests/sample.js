const {IBS_TH1} = require('../dist/ibs_th1');

const callback = data => {
  console.log(data.address, data.date, data.temperature, data.humidity,
              data.probeType, data.battery);
};

const device = new IBS_TH1();
device.subscribeRealtimeData(callback);
