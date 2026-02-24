// src/core/dto.types.ts
export interface WaveformDTO {
  raw: number[];        // 1920 int16 samples (4 frames × 480)
  clean: number[];      // 1920 int16 samples
  sampleRate: number;   // 48000
  durationMs: number;   // 40
}

export interface SpectrumDTO {
  raw: number[];        // 257 float magnitudes (STFT rfft 512)
  clean: number[];      // 257 float magnitudes
  frequencies: number[]; // 257 bin centers (Hz)
  fftSize: number;      // 512
  hopLength: number;    // 256
}

export interface BarkBandsDTO {
  raw: number[];        // 24 band energies
  clean: number[];      // 24 band energies
  bandEdges: number[];  // 25 Hz boundaries
}

export interface SystemDTO {
  frameSeq: number;        // Last frame sequence number
  serverProcessingMs: number; // Server processing time
  queueDepth: number;      // Fixed at 4
}

export interface VisualizationDTO {
  // Top-level metrics
  batchSeq: number;
  timestampMs: number;
  latencyMs: number;
  snr: number;
  vad: number;
  rmsRaw: number;
  packetLoss: number;
  totalPacketLoss?: number; // Cumulative (optional)
  connectionStatus: 'online' | 'offline' | 'error';

  // Nested objects
  waveform: WaveformDTO;
  spectrum: SpectrumDTO;
  barkBands: BarkBandsDTO;
  system: SystemDTO;
}
