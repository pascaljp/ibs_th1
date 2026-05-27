import Log4js from 'log4js';
import {IbsTh1Scanner, RealtimeData} from '../src/ibs_th1';

Log4js.getLogger('ibs_th1').level = 'trace';

const callback = (data: RealtimeData) => {
  console.log(data);
};

const device = new IbsTh1Scanner();
const subscription = device.subscribe(callback);
console.log('Subscribed');

setTimeout(() => {
  subscription.unsubscribe();
  console.log('Unsubscribed');
  process.exit();
}, 1000000);
