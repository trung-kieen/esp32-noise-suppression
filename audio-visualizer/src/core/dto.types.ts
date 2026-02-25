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




/** Time-domain waveform data — 4 RNNoise frames (480 samples each) per batch. */
export interface WaveformData {
  /** 1920 int16 samples (4 × 480) — raw input from ESP32. */
  raw: number[];
  /** 1920 int16 samples after RNNoise denoising. */
  clean: number[];
  /** Always 48000 Hz — fixed by RNNoise requirement. */
  sampleRate: number;
  /** Always 40ms — 4 frames × 10ms. */
  durationMs: number;
}

/** Frequency-domain spectrum — FFT-512 applied to each batch. */
export interface SpectrumData {
  /** 257 float magnitudes (rfft output, 0 → Nyquist) — raw input. */
  raw: number[];
  /** 257 float magnitudes after RNNoise denoising. */
  clean: number[];
  /** 257 frequency bin center values in Hz (0 → 24000). */
  frequencies: number[];
  /** FFT window size — always 512. */
  fftSize: number;
  /** Hop length — always 256. */
  hopLength: number;
}

/** Psychoacoustic Bark-scale band energies. */
export interface BarkBandsData {
  /** 24 band energy values — raw input. */
  raw: number[];
  /** 24 band energy values after RNNoise denoising. */
  clean: number[];
  /** 25 frequency boundaries in Hz defining the 24 band edges. */
  bandEdges: number[];
}

/**
 * Log-mel spectrogram bands.
 * Values are already log-scaled (dB) by the server — no conversion needed in the frontend.
 * Expected range: −80 to 0 dB (librosa default top_db=80).
 * If your server uses a different range, update DB_FLOOR / DB_CEIL
 * in mel-spectrogram.renderer.ts accordingly.
 */
export interface MelSpectrogramData {
  /** 40 log-mel band energy values in dB — raw input. */
  raw: number[];
  /** 40 log-mel band energy values in dB after RNNoise denoising. */
  clean: number[];
  /** Number of mel bins — always 40. */
  melBins: number;
  /** Lowest frequency of the mel filterbank in Hz — e.g. 20. */
  fMin: number;
  /** Highest frequency of the mel filterbank in Hz — e.g. 8000. */
  fMax: number;
}

/** Server-side system / diagnostic metrics. */
export interface SystemMetrics {
  /** Sequence number of the last processed RNNoise frame. */
  frameSeq: number;
  /** Time taken by the Python server to process this batch in ms. */
  serverProcessingMs: number;
  /** Always 4 — batch size (frames per packet) is fixed. */
  queueDepth: number;
}

// ---------------------------------------------------------------------------
// Root DTO
// ---------------------------------------------------------------------------

/**
 * Top-level visualization data transfer object.
 * Sent by the Python server over WebSocket (/visualizer endpoint) at 25 Hz (every 40ms).
 */
export interface VisualizationDTO {
  // ── Batch metadata ──────────────────────────────────────────────────────

  /** Monotonically increasing batch counter (increments by 1 each packet). */
  batchSeq: number;

  /** ESP32 hardware timestamp in milliseconds. */
  timestampMs: number;

  /** Estimated end-to-end latency in ms (~50–70ms typical). */
  latencyMs: number;

  /** Signal-to-Noise Ratio in dB. */
  snr: number;

  /**
   * Voice Activity Detection confidence score from RNNoise.
   * Range: 0.0 (silence) → 1.0 (confident voice).
   */
  vad: number;

  /** RMS level of the raw input signal (pre-denoising). */
  rmsRaw: number;

  /** Number of batches lost / dropped in this packet. */
  packetLoss: number;

  /** Cumulative lost batches since connection start. Optional field. */
  totalPacketLoss?: number;

  /** Connection state reported by the server. */
  connectionStatus: 'online' | 'offline' | 'error';

  // ── Audio data ───────────────────────────────────────────────────────────

  /** Time-domain waveform — raw and RNNoise-cleaned. */
  waveform: WaveformData;

  /** FFT-512 frequency spectrum — raw and RNNoise-cleaned. */
  spectrum: SpectrumData;

  /** 24 Bark-scale psychoacoustic band energies — raw and RNNoise-cleaned. */
  barkBands: BarkBandsData;

  /**
   * 40-bin log-mel spectrogram — raw and RNNoise-cleaned.
   * Added in v1.2. Values are dB (log-scaled server-side).
   */
  melSpectrogram?: MelSpectrogramData;

  // ── System metrics ───────────────────────────────────────────────────────

  /** Server processing diagnostics for this batch. */
  system: SystemMetrics;
}
