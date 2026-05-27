"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRealtimeData = parseRealtimeData;
function parseRealtimeData(buffer) {
    if (buffer.length < 8) {
        return null;
    }
    const temperatureRawValue = buffer.readInt16LE(0);
    const humidityRawValue = buffer.readUInt16LE(2);
    const probeType = parseProbeType(buffer[4]);
    return {
        temperatureCelsius: temperatureRawValue / 100,
        humidityPercent: humidityRawValue / 100,
        probeType,
        batteryPercent: buffer[7],
    };
}
function parseProbeType(value) {
    switch (value) {
        case 0:
            return 'built-in';
        case 1:
            return 'external';
        default:
            return 'unknown';
    }
}
