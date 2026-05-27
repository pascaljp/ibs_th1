export type ProbeType = 'unknown' | 'built-in' | 'external';

export interface ParsedRealtimeData {
  probeType: ProbeType;
  temperatureCelsius: number;
  humidityPercent: number;
  batteryPercent: number;
}

export function parseRealtimeData(buffer: Buffer): ParsedRealtimeData | null {
  if (buffer.length < 8) {
    return null;
  }

  const temperatureRawValue = buffer.readInt16LE(0);
  const humidityRawValue = buffer.readUInt16LE(2);
  const probeType = parseProbeType(buffer[4]!);

  return {
    temperatureCelsius: temperatureRawValue / 100,
    humidityPercent: humidityRawValue / 100,
    probeType,
    batteryPercent: buffer[7]!,
  };
}

function parseProbeType(value: number): ProbeType {
  switch (value) {
    case 0:
      return 'built-in';
    case 1:
      return 'external';
    default:
      return 'unknown';
  }
}
