const IBS_TH1 = require('ibs_th1');

const callback = data => {
  if (data['error']) {
    console.error(data['error']);
    return;
  }
  console.log(data['address'], data['uuid'], data['date'], data['temperature'],
	      data['humidity'], data['probeType'], data['battery']);
};

const device = new IBS_TH1();
device.subscribeRealtimeData(callback);
console.log('Subscribed');

setTimeout(() => {
  device.unsubscribeRealtimeData();
  console.log('Unsubscribed');
  process.exit();
}, 10000);
