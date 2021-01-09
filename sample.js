const log4js = require('log4js')
const IBS_TH1 = require('./ibs_th1');

log4js.getLogger('ibs_th1').level = 'trace';

const callback = data => {
  console.log(data);
};

const device = new IBS_TH1();
device.subscribeRealtimeData(callback);
console.log('Subscribed');

setTimeout(() => {
  device.unsubscribeRealtimeData();
  console.log('Unsubscribed');
  process.exit();
}, 1000000);
