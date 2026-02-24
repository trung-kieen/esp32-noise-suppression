// src/features/spectrogram/SpectrogramHeatmap.tsx
// Scrolling spectrogram heatmap using canvas drawImage for performance

import React, { useEffect, useRef, useCallback } from 'react';

interface SpectrogramHeatmapProps {
  spectrumData: number[];
  width?: number;
  height?: number;
  colorMap?: 'viridis' | 'inferno' | 'magma';
}

const SpectrogramHeatmap: React.FC<SpectrogramHeatmapProps> = ({
  spectrumData,
  width = 800,
  height = 300,
  colorMap = 'viridis'
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [displayWidth, setDisplayWidth] = React.useState(width);

  // Color mapping functions
  const getColor = useCallback((value: number): [number, number, number] => {
    // Normalize value 0-1
    const t = Math.max(0, Math.min(1, value));

    switch (colorMap) {
      case 'inferno':
        // Inferno colormap approximation
        return [
          Math.min(255, t * 3 * 255),
          Math.min(255, Math.max(0, (t - 0.3) * 2) * 255),
          Math.min(255, Math.max(0, (t - 0.6) * 2.5) * 255)
        ];
      case 'magma':
        return [
          Math.min(255, (t * 0.5 + 0.1) * 255),
          Math.min(255, Math.max(0, (t - 0.2) * 1.2) * 255),
          Math.min(255, (t * 0.8 + 0.2) * 255)
        ];
      case 'viridis':
      default:
        // Viridis-like: purple -> blue -> green -> yellow
        if (t < 0.25) return [68 + t * 4 * 50, 1 + t * 4 * 84, 84 + t * 4 * 50];
        if (t < 0.5) return [118 + (t - 0.25) * 4 * 40, 85 + (t - 0.25) * 4 * 85, 134 - (t - 0.25) * 4 * 50];
        if (t < 0.75) return [158 + (t - 0.5) * 4 * 57, 170 + (t - 0.5) * 4 * 46, 84 - (t - 0.5) * 4 * 84];
        return [215 + (t - 0.75) * 4 * 40, 216 + (t - 0.75) * 4 * 39, 0 + (t - 0.75) * 4 * 60];
    }
  }, [colorMap]);

  // Handle responsive width
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setDisplayWidth(containerRef.current.clientWidth);
      }
    };
    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Initialize offscreen canvas for scrolling buffer
    if (!offscreenCanvasRef.current) {
      offscreenCanvasRef.current = document.createElement('canvas');
      offscreenCanvasRef.current.width = displayWidth;
      offscreenCanvasRef.current.height = height;
      const offCtx = offscreenCanvasRef.current.getContext('2d');
      if (offCtx) {
        offCtx.fillStyle = '#0a0a0f';
        offCtx.fillRect(0, 0, displayWidth, height);
      }
    }

    const offCanvas = offscreenCanvasRef.current;
    const offCtx = offCanvas.getContext('2d');
    if (!offCtx) return;

    // Shift existing content left by 1 pixel (scrolling effect)
    offCtx.drawImage(offCanvas, 1, 0, displayWidth - 1, height, 0, 0, displayWidth - 1, height);

    // Draw new column of spectrum data on the right
    const columnWidth = 1;
    const x = displayWidth - columnWidth;
    const binHeight = height / spectrumData.length;

    for (let i = 0; i < spectrumData.length; i++) {
      const value = spectrumData[i];
      const [r, g, b] = getColor(value);
      offCtx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      offCtx.fillRect(x, height - (i + 1) * binHeight, columnWidth, binHeight);
    }

    // Copy offscreen canvas to visible canvas
    ctx.drawImage(offCanvas, 0, 0);

    // Draw frequency labels
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px monospace';
    ctx.fillText(`${spectrumData.length} bins`, 10, 15);
    ctx.fillText('0 Hz', 10, height - 5);
    ctx.fillText('24kHz', displayWidth - 40, height - 5);

  }, [spectrumData, displayWidth, height, getColor]);

  useEffect(() => {
    draw();
  }, [draw]);

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <canvas
        ref={canvasRef}
        width={displayWidth}
        height={height}
        style={{
          width: '100%',
          height: `${height}px`,
          borderRadius: '8px',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.3)',
          imageRendering: 'pixelated'
        }}
      />
    </div>
  );
};

export default SpectrogramHeatmap;
