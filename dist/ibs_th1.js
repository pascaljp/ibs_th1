'use strict';
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRealtimeData = exports.IbsTh1Scanner = exports.FileAddressCache = exports.IBS_TH1 = void 0;
exports.crc16 = crc16;
const fs = __importStar(require("fs"));
const Log4js = __importStar(require("log4js"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const parser_1 = require("./parser");
Object.defineProperty(exports, "parseRealtimeData", { enumerable: true, get: function () { return parser_1.parseRealtimeData; } });
const logger = Log4js.getLogger('ibs_th1');
// Device name for IBS-TH1, IBS-TH1 mini and IBS_TH1 Plus.
const DEVICE_NAME = 'sps';
class IbsTh1Scanner {
    constructor(options = {}) {
        this.discoverListener_ = null;
        this.stateChangeListener_ = null;
        this.subscriptionId_ = 0;
        this.address_fetch_status_ = new Map();
        this.noble_ = options.noble || loadDefaultNoble();
        this.addressCache_ = options.addressCache || new FileAddressCache('uuid_to_address');
        this.uuid_to_address_ = this.addressCache_.load();
    }
    //
    // Public functions.
    //
    subscribe(callback) {
        const subscriptionId = ++this.subscriptionId_;
        const scanStart = (callback) => {
            const wasScanning = this.discoverListener_ != null;
            if (this.discoverListener_ != null) {
                this.noble_.removeListener('discover', this.discoverListener_);
            }
            this.discoverListener_ = async (peripheral) => {
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
            };
            this.noble_.on('discover', this.discoverListener_);
            if (!wasScanning) {
                IbsTh1Scanner.incrementActiveScanCount_(this.noble_);
            }
            this.noble_.startScanning([ /*SERVICE_UUID*/], true /*allowDuplicates*/);
            logger.info('Started to scan Bluetooth signals');
        };
        if (this.noble_.state === 'poweredOn') {
            scanStart(callback);
        }
        else {
            if (this.stateChangeListener_ != null) {
                this.noble_.removeListener('stateChange', this.stateChangeListener_);
            }
            this.stateChangeListener_ = (state) => {
                if (state == 'poweredOn') {
                    scanStart(callback);
                }
                else {
                    this.stop_();
                }
            };
            this.noble_.on('stateChange', this.stateChangeListener_);
        }
        return {
            unsubscribe: () => {
                this.stop_(subscriptionId);
            },
        };
    }
    stop_(subscriptionId) {
        if (subscriptionId != null && subscriptionId !== this.subscriptionId_) {
            return;
        }
        if (this.discoverListener_ != null) {
            this.noble_.removeListener('discover', this.discoverListener_);
            this.discoverListener_ = null;
            if (IbsTh1Scanner.decrementActiveScanCount_(this.noble_) === 0) {
                this.noble_.stopScanning();
            }
        }
        if (this.stateChangeListener_ != null) {
            this.noble_.removeListener('stateChange', this.stateChangeListener_);
            this.stateChangeListener_ = null;
        }
        logger.info('Stopped to scan Bluetooth signals');
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
        // if (expectedCrc16 != IbsTh1Scanner.getCrc16(buffer.slice(0, 5))) {
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
            try {
                const address = await this.getAddress_(peripheral);
                this.address_fetch_status_.set(peripheral.uuid, 'FETCHED');
                this.uuid_to_address_.set(peripheral.uuid, address);
                this.addressCache_.save(this.uuid_to_address_);
            }
            catch (err) {
                this.address_fetch_status_.delete(peripheral.uuid);
                throw err;
            }
            // Without this line, noble stops receiving broadcasted data.
            this.restart_(callback);
        }
    }
    getRealtimeData_(peripheral) {
        const buffer = peripheral.advertisement.manufacturerData;
        if (!buffer) {
            return null;
        }
        const parsedData = (0, parser_1.parseRealtimeData)(buffer);
        if (parsedData == null) {
            return null;
        }
        const realtimeData = {
            date: new Date,
            address: this.uuid_to_address_.get(peripheral.uuid) || null,
            temperatureCelsius: parsedData.temperatureCelsius,
            humidityPercent: parsedData.humidityPercent,
            probeType: parsedData.probeType,
            batteryPercent: parsedData.batteryPercent,
        };
        return realtimeData;
    }
    async getAddress_(peripheral) {
        logger.debug('Getting address of peripheral device with uuid =', peripheral.uuid);
        let connected = false;
        try {
            await peripheral.connectAsync();
            connected = true;
            if (!peripheral.uuid) {
                throw new Error('No UUID');
            }
            logger.debug('Connected', { 'uuid': peripheral.uuid, 'address': peripheral.address });
            return peripheral.address;
        }
        finally {
            if (connected) {
                try {
                    await peripheral.disconnectAsync();
                }
                catch (err) {
                    logger.warn('Failed to disconnect from peripheral device', err);
                }
            }
        }
    }
    /**
     * @deprecated Use the exported crc16 function instead.
     * @param {Buffer} buffer
     */
    static getCrc16(buffer) {
        return crc16(buffer);
    }
    static incrementActiveScanCount_(noble) {
        const count = IbsTh1Scanner.activeScanCounts_.get(noble) || 0;
        IbsTh1Scanner.activeScanCounts_.set(noble, count + 1);
    }
    static decrementActiveScanCount_(noble) {
        const count = Math.max((IbsTh1Scanner.activeScanCounts_.get(noble) || 0) - 1, 0);
        if (count === 0) {
            IbsTh1Scanner.activeScanCounts_.delete(noble);
        }
        else {
            IbsTh1Scanner.activeScanCounts_.set(noble, count);
        }
        return count;
    }
    restart_(callback) {
        logger.info('Restarting');
        this.stop_();
        this.subscribe(callback);
    }
}
exports.IbsTh1Scanner = IbsTh1Scanner;
IbsTh1Scanner.activeScanCounts_ = new Map();
class FileAddressCache {
    constructor(configName, homeDir = os.homedir()) {
        this.homeDir_ = homeDir;
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
            if (err.code === 'ENOENT') {
                this.save(map);
            }
            else {
                logger.warn('Failed to load config. Keeping existing file untouched.', err);
            }
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
        fs.writeFileSync(this.configPath_, JSON.stringify(obj), { 'encoding': 'utf8', 'mode': 0o600 });
    }
}
exports.FileAddressCache = FileAddressCache;
function loadDefaultNoble() {
    try {
        return require('@abandonware/noble');
    }
    catch (err) {
        const nodeError = err;
        if (nodeError.code === 'MODULE_NOT_FOUND') {
            throw new Error('Bluetooth scanning requires @abandonware/noble. ' +
                'Install it with `npm install ibs_th1 @abandonware/noble`, ' +
                'or pass a custom NobleAdapter to new IbsTh1Scanner({ noble }). ' +
                'The parser entry point `ibs_th1/parser` does not require Noble.');
        }
        throw err;
    }
}
function crc16(buffer) {
    let crc = 0xffff;
    const iter = buffer.values();
    let item = iter.next();
    while (!item.done) {
        const byte = item.value;
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            const tmp = crc & 0x1;
            crc >>= 1;
            if (tmp) {
                crc ^= 0xa001;
            }
        }
        item = iter.next();
    }
    return crc;
}
/**
 * @deprecated Use IbsTh1Scanner instead.
 */
const IBS_TH1 = IbsTh1Scanner;
exports.IBS_TH1 = IBS_TH1;
