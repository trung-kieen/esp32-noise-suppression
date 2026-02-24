
import React, { useEffect, useRef, useCallback } from 'react';

interface WaveformDisplayProps {
  data: number[];
  color: string;
  label: string;
  height?: number;
  sampleRate?: number;
}

const WaveformDisplay: React.FC<WaveformDisplayProps> = ({
  data,
  color,
  label,
  height = 150,
  sampleRate = 48000
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(800);

  // Handle responsive width
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setWidth(containerRef.current.clientWidth);
      }
    };
    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, width, height);

    // Draw grid
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 1;
    const gridSize = 40;

    // Vertical grid lines
    for (let x = 0; x < width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // Horizontal grid lines
    for (let y = 0; y < height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Center line
    ctx.strokeStyle = '#2a2a3e';
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Draw waveform
    if (data.length > 0) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();

      const sliceWidth = width / data.length;
      let x = 0;

      // int16 range is -32768 to 32767, normalize to canvas height
      const normalize = (sample: number) => {
        const normalized = sample / 32768; // -1 to 1
        return height / 2 + (normalized * (height / 2 - 10)); // Leave padding
      };

      ctx.moveTo(0, normalize(data[0]));

      for (let i = 1; i < data.length; i++) {
        const y = normalize(data[i]);
        ctx.lineTo(x, y);
        x += sliceWidth;
      }

      ctx.stroke();

      // Fill area under curve with gradient
      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, color + '40'); // 25% opacity
      gradient.addColorStop(0.5, color + '10'); // 6% opacity
      gradient.addColorStop(1, color + '00'); // 0% opacity

      ctx.fillStyle = gradient;
      ctx.lineTo(width, height / 2);
      ctx.lineTo(0, height / 2);
      ctx.closePath();
      ctx.fill();
    }

    // Draw label
    ctx.fillStyle = '#ffffff';
    ctx.font = '12px monospace';
    ctx.fillText(label, 10, 20);
    ctx.fillStyle = '#888888';
    ctx.font = '10px monospace';
    ctx.fillText(`${data.length} samples @ ${sampleRate/1000}kHz`, 10, 35);

  }, [data, color, label, width, height, sampleRate]);

  useEffect(() => {
    draw();
  }, [draw]);

  return (
    <div ref={containerRef} style={{ width: '100%', marginBottom: '10px' }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{
          width: '100%',
          height: `${height}px`,
          borderRadius: '8px',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.3)'
        }}
      />
    </div>
  );
};

export default WaveformDisplay;
