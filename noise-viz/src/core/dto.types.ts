// src/core/dto.types.ts
export interface AudioBatchDTO {
  batchSeq: number;
  latencyMs: number;
  snr: number;
  vad: number;           // trung bình hoặc từ frame cuối
  packetLoss: number;

  rawSpectrum: number[];     // biên độ STFT (thường ~257 hoặc 513 bins)
  cleanSpectrum: number[];   // tương tự

  rawWaveform: number[];     // int16 → number[], 480 hoặc gộp 4 frame = 1920 samples
  cleanWaveform: number[];   // tương tự
}
