import Log4js from 'log4js';
import {IBS_TH1, RealtimeData} from '../src/ibs_th1';

Log4js.getLogger('ibs_th1').level = 'trace';

const callback = (data: RealtimeData) => {
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
