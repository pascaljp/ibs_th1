import { parseRealtimeData } from './parser';
import type { ProbeType } from './parser';
type NobleEvent = 'discover' | 'stateChange';
interface Peripheral {
    uuid: string;
    address: string;
    advertisement: {
        localName?: string;
        manufacturerData?: Buffer;
    };
    connectAsync(): Promise<void>;
    disconnectAsync(): Promise<void>;
}
interface NobleAdapter {
    state: string;
    on(event: 'discover', listener: (peripheral: Peripheral) => void): void;
    on(event: 'stateChange', listener: (state: string) => void): void;
    removeListener(event: NobleEvent, listener: (...args: any[]) => void): void;
    startScanning(serviceUUIDs: string[], allowDuplicates: boolean): void;
    stopScanning(): void;
}
interface AddressCache {
    load(): Map<string, string>;
    save(data: Map<string, string>): void;
}
interface IbsTh1ScannerOptions {
    noble?: NobleAdapter;
    addressCache?: AddressCache;
}
interface Subscription {
    unsubscribe(): void;
}
declare class IbsTh1Scanner {
    private static activeScanCounts_;
    private address_fetch_status_;
    private uuid_to_address_;
    private noble_;
    private addressCache_;
    private discoverListener_;
    private stateChangeListener_;
    private subscriptionId_;
    constructor(options?: IbsTh1ScannerOptions);
    subscribe(callback: (data: RealtimeData) => void): Subscription;
    private stop_;
    private isTargetDevice_;
    private prepareAddress_;
    private getRealtimeData_;
    private getAddress_;
    /**
     * @deprecated Use the exported crc16 function instead.
     * @param {Buffer} buffer
     */
    static getCrc16(buffer: Buffer): number;
    private static incrementActiveScanCount_;
    private static decrementActiveScanCount_;
    private restart_;
}
interface RealtimeData {
    address: string | null;
    date: Date;
    probeType: ProbeType;
    temperatureCelsius: number;
    humidityPercent: number;
    batteryPercent: number;
}
declare class FileAddressCache implements AddressCache {
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
export { IBS_TH1, FileAddressCache, IbsTh1Scanner, crc16, parseRealtimeData };
export type { AddressCache, IbsTh1ScannerOptions, NobleAdapter, Peripheral, RealtimeData, Subscription, ProbeType };
