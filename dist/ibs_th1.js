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
exports.parseRealtimeData = exports.IbsTh1Scanner = exports.FileDeviceIdCache = exports.IBS_TH1 = void 0;
exports.crc16 = crc16;
const fs = __importStar(require("fs"));
const Log4js = __importStar(require("log4js"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const parser_1 = require("./parser");
Object.defineProperty(exports, "parseRealtimeData", { enumerable: true, get: function () { return parser_1.parseRealtimeData; } });
const logger = Log4js.getLogger('ibs_th1');
const diagnosticsSetting = process.env['IBS_TH1_DIAGNOSTICS'];
const diagnosticsEnabled = diagnosticsSetting === '1' ||
    diagnosticsSetting?.toLowerCase() === 'true';
const diagnosticsLog = (...args) => {
    if (diagnosticsEnabled) {
        // eslint-disable-next-line no-console
        console.log('[ibs_th1:diag]', ...args);
    }
};
const diagnosticsWarn = (...args) => {
    if (diagnosticsEnabled) {
        // eslint-disable-next-line no-console
        console.warn('[ibs_th1:diag]', ...args);
    }
};
// Device name for IBS-TH1, IBS-TH1 mini and IBS_TH1 Plus.
const DEVICE_NAME = 'sps';
const DEVICE_INFORMATION_SERVICE_UUID = '180a';
const SYSTEM_ID_CHARACTERISTIC_UUID = '2a23';
const SYSTEM_ID_DEVICE_ID_PREFIX = 'ibs-th1-system-id:';
//const SERVICE_UUID: string = 'fff0';
const MIN_DEVICE_ID_RETRY_DELAY_MS = 30000;
const MAX_DEVICE_ID_RETRY_DELAY_MS = 60 * 60000;
const DEVICE_ID_RETRY_BACKOFF_MULTIPLIER = 2;
class IbsTh1Scanner {
    constructor(options = {}) {
        this.discoverListener_ = null;
        this.stateChangeListener_ = null;
        this.subscriptionId_ = 0;
        this.device_id_fetch_status_ = new Map();
        this.device_id_fetch_retry_at_ = new Map();
        this.device_id_fetch_failure_count_ = new Map();
        this.noble_ = options.noble || loadDefaultNoble();
        this.deviceIdCache_ = options.deviceIdCache || new FileDeviceIdCache('uuid_to_device_id');
        this.uuid_to_device_id_ = this.deviceIdCache_.load();
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
                    await this.prepareDeviceId_(peripheral, callback);
                }
                catch (err) {
                    diagnosticsWarn('prepareDeviceId_ skipped', {
                        uuid: peripheral.uuid,
                        localName: peripheral.advertisement.localName,
                        mfgLen: peripheral.advertisement.manufacturerData?.byteLength,
                        reason: err instanceof Error ? err.message : String(err),
                    });
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
        //   console.error('CRC error', this.uuid_to_device_id_.get(peripheral.uuid));
        //   return false;
        // }
        return true;
    }
    async prepareDeviceId_(peripheral, callback) {
        const fetchStatus = this.device_id_fetch_status_.get(peripheral.uuid);
        diagnosticsLog('prepareDeviceId_ start', {
            uuid: peripheral.uuid,
            fetchStatus,
            cachedDeviceId: this.uuid_to_device_id_.get(peripheral.uuid),
            retryAt: this.device_id_fetch_retry_at_.get(peripheral.uuid),
        });
        if (fetchStatus == 'FETCHING') {
            // Another thread is checking the device id now.
            throw new Error('Discovered => Device id fetch in flight. Ignoring.');
        }
        const deviceId = IbsTh1Scanner.normalizeDeviceId_(this.uuid_to_device_id_.get(peripheral.uuid));
        if (!deviceId) {
            const retryAt = this.device_id_fetch_retry_at_.get(peripheral.uuid);
            if (retryAt != null && Date.now() < retryAt) {
                throw new Error('Discovered => Device id fetch cooling down. Ignoring.');
            }
            // Check the device id from now.
            this.device_id_fetch_status_.set(peripheral.uuid, 'FETCHING');
            try {
                const deviceId = await this.getDeviceId_(peripheral);
                this.device_id_fetch_retry_at_.delete(peripheral.uuid);
                this.device_id_fetch_failure_count_.delete(peripheral.uuid);
                this.device_id_fetch_status_.set(peripheral.uuid, 'FETCHED');
                this.uuid_to_device_id_.set(peripheral.uuid, deviceId);
                this.deviceIdCache_.save(this.uuid_to_device_id_);
                diagnosticsLog('Stable device id resolved', {
                    uuid: peripheral.uuid,
                    deviceId,
                    totalKnown: this.uuid_to_device_id_.size,
                });
            }
            catch (err) {
                if (err instanceof InvalidDeviceIdError) {
                    const failureCount = (this.device_id_fetch_failure_count_.get(peripheral.uuid) || 0) + 1;
                    const retryDelayMs = IbsTh1Scanner.deviceIdRetryDelayMs_(failureCount);
                    this.device_id_fetch_failure_count_.set(peripheral.uuid, failureCount);
                    this.device_id_fetch_retry_at_.set(peripheral.uuid, Date.now() + retryDelayMs);
                    logger.warn('Unable to get stable device id for peripheral device', {
                        uuid: peripheral.uuid,
                        failureCount,
                        retryDelayMs,
                    });
                    diagnosticsWarn('Unable to get stable device id for peripheral device', {
                        uuid: peripheral.uuid,
                        failureCount,
                        retryDelayMs,
                        error: err.message,
                    });
                }
                else {
                    diagnosticsWarn('prepareDeviceId_ unexpected error', {
                        uuid: peripheral.uuid,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                this.device_id_fetch_status_.delete(peripheral.uuid);
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
            deviceId: IbsTh1Scanner.normalizeDeviceId_(this.uuid_to_device_id_.get(peripheral.uuid)),
            temperatureCelsius: parsedData.temperatureCelsius,
            humidityPercent: parsedData.humidityPercent,
            probeType: parsedData.probeType,
            batteryPercent: parsedData.batteryPercent,
        };
        return realtimeData;
    }
    async getDeviceId_(peripheral) {
        diagnosticsLog('Device id resolution start', { uuid: peripheral.uuid });
        logger.debug('Getting device id of peripheral device with uuid =', peripheral.uuid);
        let connected = false;
        try {
            logger.info('Connecting to peripheral device to resolve stable device id', { uuid: peripheral.uuid });
            diagnosticsLog('Connecting for device id resolution', { uuid: peripheral.uuid });
            await peripheral.connectAsync();
            connected = true;
            if (!peripheral.uuid) {
                throw new Error('No UUID');
            }
            diagnosticsLog('Connected', { uuid: peripheral.uuid });
            logger.debug('Connected', { uuid: peripheral.uuid });
            const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync([DEVICE_INFORMATION_SERVICE_UUID], [SYSTEM_ID_CHARACTERISTIC_UUID]);
            const systemIdCharacteristic = characteristics.find(characteristic => characteristic.uuid.toLowerCase() === SYSTEM_ID_CHARACTERISTIC_UUID);
            if (!systemIdCharacteristic) {
                throw new InvalidDeviceIdError(`No System ID characteristic for peripheral device with uuid = ${peripheral.uuid}`);
            }
            const systemId = await systemIdCharacteristic.readAsync();
            const deviceId = IbsTh1Scanner.systemIdToDeviceId_(systemId);
            if (deviceId == null) {
                throw new InvalidDeviceIdError(`No stable device id for peripheral device with uuid = ${peripheral.uuid}`);
            }
            diagnosticsLog('Device id resolved', { uuid: peripheral.uuid, deviceId });
            return deviceId;
        }
        catch (err) {
            diagnosticsWarn('Device id resolution failed', {
                uuid: peripheral.uuid,
                error: err instanceof Error ? err.message : String(err),
            });
            throw err;
        }
        finally {
            if (connected) {
                try {
                    diagnosticsLog('Disconnecting peripheral', { uuid: peripheral.uuid });
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
    static deviceIdRetryDelayMs_(failureCount) {
        return Math.min(MIN_DEVICE_ID_RETRY_DELAY_MS * Math.pow(DEVICE_ID_RETRY_BACKOFF_MULTIPLIER, failureCount - 1), MAX_DEVICE_ID_RETRY_DELAY_MS);
    }
    static normalizeDeviceId_(deviceId) {
        if (deviceId == null) {
            return null;
        }
        const normalizedDeviceId = deviceId.trim();
        if (!normalizedDeviceId) {
            return null;
        }
        return normalizedDeviceId;
    }
    static systemIdToDeviceId_(systemId) {
        if (systemId.byteLength === 0) {
            return null;
        }
        const hex = systemId.toString('hex').toLowerCase();
        if (/^0+$/.test(hex)) {
            return null;
        }
        return `${SYSTEM_ID_DEVICE_ID_PREFIX}${hex}`;
    }
}
exports.IbsTh1Scanner = IbsTh1Scanner;
IbsTh1Scanner.activeScanCounts_ = new Map();
class InvalidDeviceIdError extends Error {
}
class FileDeviceIdCache {
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
exports.FileDeviceIdCache = FileDeviceIdCache;
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
