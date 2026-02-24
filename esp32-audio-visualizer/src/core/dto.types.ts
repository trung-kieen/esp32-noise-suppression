export interface WaveformDTO {
  raw: number[];
  clean: number[];
  sampleRate: number;   // 48000
  durationMs: number;   // 40
}

export interface SpectrumDTO {
  raw: number[];
  clean: number[];
  frequencies: number[];
  fftSize: number;
  hopLength: number;
}

export interface BarkBandsDTO {
  raw: number[];
  clean: number[];
  bandEdges: number[];
}

export interface SystemDTO {
  frameSeq: number;
  serverProcessingMs: number;
  queueDepth: number;
}

export interface VisualizationDTO {
  batchSeq: number;
  timestampMs: number;
  latencyMs: number;
  snr: number;
  vad: number;
  rmsRaw: number;
  packetLoss: number;
  totalPacketLoss?: number;
  connectionStatus: 'online' | 'offline' | 'error';

  waveform: WaveformDTO;
  spectrum: SpectrumDTO;
  barkBands: BarkBandsDTO;
  system: SystemDTO;
}
