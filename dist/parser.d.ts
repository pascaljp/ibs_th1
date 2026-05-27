export type ProbeType = 'unknown' | 'built-in' | 'external';
export interface ParsedRealtimeData {
    probeType: ProbeType;
    temperatureCelsius: number;
    humidityPercent: number;
    batteryPercent: number;
}
export declare function parseRealtimeData(buffer: Buffer): ParsedRealtimeData | null;
