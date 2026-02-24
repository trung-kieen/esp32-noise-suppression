// src/features/Spectrogram.tsx
import { useRef, useEffect } from 'react';
import { AudioBatchDTO } from '../core/dto.types';

interface Props {
  data: AudioBatchDTO | null;
  type: 'raw' | 'clean';
}

export default function Spectrogram({ data, type }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<number[][]>([]); // lưu ~100 dòng trước

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    const spectrum = type === 'raw' ? data.rawSpectrum : data.cleanSpectrum;
    if (!spectrum?.length) return;

    // Giới hạn số bins hiển thị (thường STFT cho 480 samples → ~241-257 bins)
    const bins = Math.min(spectrum.length, 257);

    // Thêm dòng mới vào history (cuộn xuống)
    const mags = spectrum.slice(0, bins).map(v => Math.log10(v + 1e-6) * 20); // dB
    const minDb = -80;
    const maxDb = -10;
    const normalized = mags.map(v => Math.max(0, Math.min(1, (v - minDb) / (maxDb - minDb))));

    historyRef.current.push(normalized);
    if (historyRef.current.length > h) historyRef.current.shift();

    // Vẽ toàn bộ
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const rowHeight = 1;
    for (let y = 0; y < historyRef.current.length; y++) {
      const row = historyRef.current[historyRef.current.length - 1 - y];
      for (let x = 0; x < bins; x++) {
        const val = row[x];
        // colormap: blue → cyan → yellow → red
        const r = Math.floor(val * 255);
        const g = Math.floor(val * 200);
        const b = Math.floor((1 - val) * 255);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x * (w / bins), y * rowHeight, (w / bins) + 1, rowHeight);
      }
    }
  }, [data]);

  return (
    <div>
      <h3>{type === 'raw' ? 'Raw' : 'Clean'} Spectrogram</h3>
      <canvas ref={canvasRef} width={800} height={300} style={{ background: '#000', imageRendering: 'pixelated' }} />
    </div>
  );
}
