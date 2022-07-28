/// <reference types="node" />
import noble from '@abandonware/noble';
declare type ProbeType = 'UNKNOWN' | 'BUILT_IN' | 'EXTERNAL';
declare class IBS_TH1 {
    private address_fetch_status_;
    private uuid_to_address_;
    constructor();
    subscribeRealtimeData(callback: (data: RealtimeData) => void): void;
    unsubscribeRealtimeData(): void;
    restart(callback: (data: RealtimeData) => void): void;
    isTargetDevice_(peripheral: noble.Peripheral): boolean;
    prepareAddress_(peripheral: noble.Peripheral, callback: (data: RealtimeData) => void): Promise<void>;
    getRealtimeData_(peripheral: noble.Peripheral): RealtimeData | null;
    getAddress_(peripheral: noble.Peripheral): Promise<string>;
    /**
     * @param {Buffer} buffer
     */
    static getCrc16(buffer: Buffer): number;
}
interface RealtimeData {
    address: string;
    date: Date;
    probeType: ProbeType;
    temperature: number;
    humidity: number;
    battery: number;
}
export { IBS_TH1, RealtimeData };
