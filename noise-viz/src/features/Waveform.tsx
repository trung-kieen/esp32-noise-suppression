// src/features/Waveform.tsx
import { useRef, useEffect } from 'react';
import { AudioBatchDTO } from '../core/dto.types';

interface Props {
  data: AudioBatchDTO | null;
  label: string;
  color: string;
}

export default function Waveform({ data, label, color }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    // Xóa nền
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);

    const waveform = data[label.toLowerCase().includes('raw') ? 'rawWaveform' : 'cleanWaveform'];
    if (!waveform?.length) return;

    const step = waveform.length / w;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.moveTo(0, h / 2);

    for (let i = 0; i < w; i++) {
      let min = 1.0;
      let max = -1.0;

      for (let j = 0; j < step; j++) {
        const val = waveform[Math.floor(i * step + j)] / 32768; // normalize int16 → [-1,1]
        if (val < min) min = val;
        if (val > max) max = val;
      }

      const y = (1 + (min + max) / 2) * (h / 2);
      ctx.lineTo(i, y);
    }

    ctx.stroke();
  }, [data]);

  return (
    <div>
      <h3 style={{ color, margin: '8px 0' }}>{label}</h3>
      <canvas ref={canvasRef} width={800} height={160} style={{ background: '#000', borderRadius: 6 }} />
    </div>
  );
}
