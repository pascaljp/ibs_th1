'use strict';
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IBS_TH1 = void 0;
const fs = __importStar(require("fs"));
const Log4js = __importStar(require("log4js"));
const noble_1 = __importDefault(require("@abandonware/noble"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const logger = Log4js.getLogger('ibs_th1');
// Device name for IBS-TH1, IBS-TH1 mini and IBS_TH1 Plus.
const DEVICE_NAME = 'sps';
class IBS_TH1 {
    constructor() {
        this.address_fetch_status_ = new Map();
        this.uuid_to_address_ = new Config('uuid_to_address').load();
    }
    //
    // Public functions.
    //
    subscribeRealtimeData(callback) {
        const scanStart = (callback) => {
            noble_1.default.on('discover', async (peripheral) => {
                if (!this.isTargetDevice_(peripheral)) {
                    return;
                }
                try {
                    await this.prepareAddress_(peripheral, callback);
                }
                catch (err) {
                    return;
                }
                try {
                    const realtimeData = this.getRealtimeData_(peripheral);
                    if (realtimeData != null) {
                        callback(realtimeData);
                    }
                }
                catch (err) {
                    logger.error(err);
                }
            });
            noble_1.default.startScanning([ /*SERVICE_UUID*/], true /*allowDuplicates*/);
            logger.info('Started to scan Bluetooth signals');
        };
        if (noble_1.default.state === 'poweredOn') {
            scanStart(callback);
        }
        else {
            noble_1.default.on('stateChange', (state) => {
                if (state == 'poweredOn') {
                    scanStart(callback);
                }
                else {
                    this.unsubscribeRealtimeData();
                }
            });
        }
    }
    unsubscribeRealtimeData() {
        noble_1.default.removeAllListeners('discover');
        noble_1.default.removeAllListeners('stateChange');
        noble_1.default.stopScanning();
        logger.info('Stopped to scan Bluetooth signals');
    }
    restart(callback) {
        logger.info('Restarting');
        this.unsubscribeRealtimeData();
        this.subscribeRealtimeData(callback);
    }
    //
    // Private functions.
    //
    isTargetDevice_(peripheral) {
        if (peripheral.advertisement.localName != DEVICE_NAME) {
            return false;
        }
        const buffer = peripheral.advertisement.manufacturerData;
        if (!buffer || buffer.byteLength != 9) {
            return false;
        }
        // Disable CRC check logic because IBS-TH1 plus seems to have non-CRC data
        // in the buffer. "buffer[6]<<8 & buffer[6]" is increasing one by one, so
        // I'm assuming the value is the index of data stored inside the device.
        // The device can store up to 30000 data points in it, so maybe the value
        // corresponds to that index. This idea needs to be verified.
        // const expectedCrc16 = buffer[6] * 256 + buffer[5];
        // if (expectedCrc16 != IBS_TH1.getCrc16(buffer.slice(0, 5))) {
        //   console.error('CRC error', this.uuid_to_address_.get(peripheral.uuid));
        //   return false;
        // }
        return true;
    }
    async prepareAddress_(peripheral, callback) {
        const fetchStatus = this.address_fetch_status_.get(peripheral.uuid);
        if (fetchStatus == 'FETCHING') {
            // Another thread is checking the address now.
            throw new Error('Discovered => Address fetch on flight. Ignoring.');
        }
        const address = this.uuid_to_address_.get(peripheral.uuid);
        if (!address) {
            // Check the address from now.
            this.address_fetch_status_.set(peripheral.uuid, 'FETCHING');
            const address = await this.getAddress_(peripheral);
            this.address_fetch_status_.set(peripheral.uuid, 'FETCHED');
            this.uuid_to_address_.set(peripheral.uuid, address);
            new Config('uuid_to_address').save(this.uuid_to_address_);
            // Without this line, noble stops receiving broadcasted data.
            this.restart(callback);
        }
    }
    getRealtimeData_(peripheral) {
        const buffer = peripheral.advertisement.manufacturerData;
        if (buffer.length < 8) {
            return null;
        }
        const temperature_raw_value = buffer[1] * 256 + buffer[0];
        const temperature = temperature_raw_value >= 0x8000 ?
            (temperature_raw_value - 0x10000) / 100 : temperature_raw_value / 100;
        const humidity = (buffer[3] * 256 + buffer[2]) / 100;
        const probeType = buffer[4] == 0 ? 'BUILT_IN' : buffer[4] == 1 ? 'EXTERNAL' : 'UNKNOWN';
        const battery = buffer[7];
        // const productionIBS_TH1Data = buffer[8];
        const realtimeData = {
            date: new Date,
            address: this.uuid_to_address_.get(peripheral.uuid) || 'error',
            temperature: temperature,
            humidity: humidity,
            probeType: probeType,
            battery: battery,
        };
        return realtimeData;
    }
    async getAddress_(peripheral) {
        logger.debug('Getting address of peripheral device with uuid =', peripheral.uuid);
        await peripheral.connectAsync();
        if (!peripheral.uuid) {
            this.uuid_to_address_.delete(peripheral.uuid);
            throw new Error('No UUID');
        }
        logger.debug('Connected', { 'uuid': peripheral.uuid, 'address': peripheral.address });
        await peripheral.disconnectAsync();
        return peripheral.address;
    }
    /**
     * @param {Buffer} buffer
     */
    static getCrc16(buffer) {
        let crc16 = 0xffff;
        const iter = buffer.values();
        let item = iter.next();
        while (!item.done) {
            const byte = item.value;
            crc16 ^= byte;
            for (let i = 0; i < 8; i++) {
                const tmp = crc16 & 0x1;
                crc16 >>= 1;
                if (tmp) {
                    crc16 ^= 0xa001;
                }
            }
            item = iter.next();
        }
        return crc16;
    }
}
exports.IBS_TH1 = IBS_TH1;
class Config {
    constructor(configName) {
        this.homeDir_ = os.homedir();
        this.configDir_ = path.join(this.homeDir_, '.ibs_th1/');
        this.configPath_ = path.join(this.configDir_, configName);
    }
    load() {
        const map = new Map();
        try {
            const data = JSON.parse(fs.readFileSync(this.configPath_, 'utf8'));
            for (const uuid in data) {
                map.set(uuid, data[uuid]);
            }
            return map;
        }
        catch (err) {
            this.save(map);
            return map;
        }
    }
    save(data) {
        if (!fs.existsSync(this.configDir_)) {
            fs.mkdirSync(this.configDir_, { 'mode': 0o700, 'recursive': true });
        }
        const obj = {};
        data.forEach((value, key) => {
            obj[key] = value;
        });
        fs.writeFileSync(this.configPath_, JSON.stringify(obj), { 'encoding': 'utf8', 'mode': 0o700 });
    }
}
