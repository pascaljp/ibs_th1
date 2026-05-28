import { parseRealtimeData } from './parser';
import type { ProbeType } from './parser';
type NobleEvent = 'discover' | 'stateChange';
interface Peripheral {
    uuid: string;
    address: string | null;
    advertisement: {
        localName?: string;
        manufacturerData?: Buffer;
    };
    connectAsync(): Promise<void>;
    disconnectAsync(): Promise<void>;
    discoverSomeServicesAndCharacteristicsAsync(serviceUUIDs: string[], characteristicUUIDs: string[]): Promise<{
        characteristics: Array<{
            uuid: string;
            readAsync(): Promise<Buffer>;
        }>;
    }>;
}
interface NobleAdapter {
    state: string;
    on(event: 'discover', listener: (peripheral: Peripheral) => void): void;
    on(event: 'stateChange', listener: (state: string) => void): void;
    removeListener(event: NobleEvent, listener: (...args: any[]) => void): void;
    startScanning(serviceUUIDs: string[], allowDuplicates: boolean): void;
    stopScanning(): void;
}
interface DeviceIdCache {
    load(): Map<string, string>;
    save(data: Map<string, string>): void;
}
interface IbsTh1ScannerOptions {
    noble?: NobleAdapter;
    deviceIdCache?: DeviceIdCache;
}
interface Subscription {
    unsubscribe(): void;
}
declare class IbsTh1Scanner {
    private static activeScanCounts_;
    private device_id_fetch_status_;
    private device_id_fetch_retry_at_;
    private device_id_fetch_failure_count_;
    private uuid_to_device_id_;
    private noble_;
    private deviceIdCache_;
    private discoverListener_;
    private stateChangeListener_;
    private subscriptionId_;
    constructor(options?: IbsTh1ScannerOptions);
    subscribe(callback: (data: RealtimeData) => void): Subscription;
    private stop_;
    private isTargetDevice_;
    private prepareDeviceId_;
    private getRealtimeData_;
    private getDeviceId_;
    /**
     * @deprecated Use the exported crc16 function instead.
     * @param {Buffer} buffer
     */
    static getCrc16(buffer: Buffer): number;
    private static incrementActiveScanCount_;
    private static decrementActiveScanCount_;
    private restart_;
    private static deviceIdRetryDelayMs_;
    private static normalizeDeviceId_;
    private static systemIdToDeviceId_;
}
interface RealtimeData {
    deviceId: string | null;
    date: Date;
    probeType: ProbeType;
    temperatureCelsius: number;
    humidityPercent: number;
    batteryPercent: number;
}
declare class FileDeviceIdCache implements DeviceIdCache {
    private homeDir_;
    private configDir_;
    private configPath_;
    constructor(configName: string, homeDir?: string);
    load(): Map<string, string>;
    save(data: Map<string, string>): void;
}
declare function crc16(buffer: Buffer): number;
/**
 * @deprecated Use IbsTh1Scanner instead.
 */
declare const IBS_TH1: typeof IbsTh1Scanner;
export { IBS_TH1, FileDeviceIdCache, IbsTh1Scanner, crc16, parseRealtimeData };
export type { DeviceIdCache, IbsTh1ScannerOptions, NobleAdapter, Peripheral, RealtimeData, Subscription, ProbeType };
