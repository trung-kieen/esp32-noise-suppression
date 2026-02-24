// src/core/dto.types.ts
export interface VisualizationDTO {
  batchSeq: number;
  latencyMs: number;
  snr: number;
  vad: number;
  packetLoss: number;
  rawSpectrum: number[];
  cleanSpectrum: number[];
  rawWaveform: number[];
  cleanWaveform: number[];
  timestamp: number;
  peak_raw: number;
  rms_db: number;
  voice_detected: boolean;
}
