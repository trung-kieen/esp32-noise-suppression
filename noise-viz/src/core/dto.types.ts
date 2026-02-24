// src/core/dto.types.ts
// TypeScript types matching the server DTO structure from Design doc Section 11.1

export interface AudioDTO {
  batchSeq: number;
  latencyMs: number;
  snr: number;
  vad: number;
  packetLoss: number;
  rawSpectrum: number[];
  cleanSpectrum: number[];
  rawWaveform: number[];
  cleanWaveform: number[];
}

export interface ConnectionStatus {
  connected: boolean;
  lastBatchSeq: number | null;
  packetsReceived: number;
  packetsLost: number;
  averageLatency: number;
}
