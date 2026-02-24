// src/features/waveform/waveform.renderer.ts
export class WaveformRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private gain: number = 1.0;
  private autoScale: boolean = true;
  private currentScale: number = 1.0;
  private lastPeak: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.width = rect.width;
    this.height = rect.height;
  }

  setGain(gain: number): void {
    this.gain = Math.max(0.1, Math.min(50.0, gain));
  }

  setAutoScale(enabled: boolean): void {
    this.autoScale = enabled;
  }

  render(rawWaveform: number[], cleanWaveform: number[]): void {
    this.ctx.clearRect(0, 0, this.width, this.height);

    // Calculate peak amplitude from both waveforms
    const allSamples = [...rawWaveform, ...cleanWaveform];
    const peak = Math.max(...allSamples.map(Math.abs), 1);
    this.lastPeak = peak;

    if (this.autoScale) {
      // Target: make peak use 75% of available height
      // Available height is 45% of canvas (from drawWaveformLine)
      // So we want peak * scale = 0.75 * 32768
      const targetAmplitude = 24576; // 75% of int16 max
      this.currentScale = targetAmplitude / peak;
      // Clamp to reasonable limits (1x to 50x)
      this.currentScale = Math.max(1, Math.min(50, this.currentScale));
    } else {
      this.currentScale = this.gain;
    }

    this.drawGrid();
    this.drawCenterLine();

    // Draw raw waveform (red, semi-transparent, behind)
    this.drawWaveformLine(rawWaveform, '#ff4444', 0.5, 2, this.currentScale);

    // Draw clean waveform (green, solid, on top)
    this.drawWaveformLine(cleanWaveform, '#00ff88', 1.0, 2.5, this.currentScale);

    this.drawLegend();
    this.drawScaleInfo(peak, this.currentScale);
    this.drawAxisLabels();
  }

  private drawGrid(): void {
    this.ctx.strokeStyle = '#1a1a1a';
    this.ctx.lineWidth = 1;

    // Vertical time lines (every 10ms = 1/4 of width)
    for (let i = 1; i < 4; i++) {
      const x = (this.width / 4) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.height);
      this.ctx.stroke();
    }

    // Horizontal amplitude lines (25%, 75% of height)
    [0.25, 0.75].forEach(pct => {
      const y = this.height * pct;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.width, y);
      this.ctx.stroke();
    });
  }

  private drawCenterLine(): void {
    this.ctx.strokeStyle = '#444';
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([5, 5]);
    this.ctx.beginPath();
    this.ctx.moveTo(0, this.height / 2);
    this.ctx.lineTo(this.width, this.height / 2);
    this.ctx.stroke();
    this.ctx.setLineDash([]);
  }

  private drawWaveformLine(
    data: number[],
    color: string,
    alpha: number,
    lineWidth: number,
    scale: number
  ): void {
    if (!data || data.length === 0) return;

    this.ctx.strokeStyle = color;
    this.ctx.globalAlpha = alpha;
    this.ctx.lineWidth = lineWidth;
    this.ctx.lineJoin = 'round';
    this.ctx.lineCap = 'round';
    this.ctx.beginPath();

    const step = this.width / data.length;
    const centerY = this.height / 2;
    // Use 45% of half-height to leave padding at top/bottom
    const amplitudeScale = (this.height / 2) * 0.45;

    let lastX = 0;
    let lastY = centerY;

    for (let i = 0; i < data.length; i++) {
      const x = i * step;
      // Normalize int16 to -1..1, apply scale, clamp to prevent overflow
      const normalized = (data[i] / 32768) * scale;
      const clamped = Math.max(-1, Math.min(1, normalized));
      const y = centerY - (clamped * amplitudeScale);

      if (i === 0) {
        this.ctx.moveTo(x, y);
      } else {
        // Use quadratic curves for smoother lines
        const midX = (lastX + x) / 2;
        const midY = (lastY + y) / 2;
        this.ctx.quadraticCurveTo(lastX, lastY, midX, midY);
      }

      lastX = x;
      lastY = y;
    }

    this.ctx.lineTo(lastX, lastY);
    this.ctx.stroke();
    this.ctx.globalAlpha = 1.0;
  }

  private drawLegend(): void {
    const legendY = 25;
    const fontSize = 12;
    this.ctx.font = `${fontSize}px monospace`;

    // Background for legend
    this.ctx.fillStyle = 'rgba(0,0,0,0.7)';
    this.ctx.fillRect(this.width - 160, 10, 150, 50);

    // Raw legend
    this.ctx.fillStyle = '#ff4444';
    this.ctx.fillRect(this.width - 150, legendY - 8, 12, 12);
    this.ctx.fillStyle = '#fff';
    this.ctx.fillText('Raw (Input)', this.width - 135, legendY + 3);

    // Clean legend
    this.ctx.fillStyle = '#00ff88';
    this.ctx.fillRect(this.width - 150, legendY + 15, 12, 12);
    this.ctx.fillStyle = '#fff';
    this.ctx.fillText('Clean (RNNoise)', this.width - 135, legendY + 26);
  }

  private drawScaleInfo(peakValue: number, scale: number): void {
    const mode = this.autoScale ? 'AUTO' : 'MANUAL';
    const peakPercent = ((peakValue / 32768) * 100).toFixed(1);

    // Background
    this.ctx.fillStyle = 'rgba(0,0,0,0.7)';
    this.ctx.fillRect(10, 10, 180, 55);

    this.ctx.fillStyle = '#888';
    this.ctx.font = '11px monospace';
    this.ctx.fillText(`Scale: ${mode} ${scale.toFixed(1)}x`, 15, 25);
    this.ctx.fillText(`Peak: ${peakValue.toLocaleString()} (${peakPercent}%)`, 15, 40);
    this.ctx.fillText(`Range: ±${(32768/scale).toFixed(0)}`, 15, 55);
  }

  private drawAxisLabels(): void {
    this.ctx.fillStyle = '#666';
    this.ctx.font = '10px monospace';

    // Time axis (bottom)
    this.ctx.fillText('0ms', 5, this.height - 5);
    this.ctx.fillText('10', this.width * 0.25 - 10, this.height - 5);
    this.ctx.fillText('20', this.width * 0.5 - 10, this.height - 5);
    this.ctx.fillText('30', this.width * 0.75 - 10, this.height - 5);
    this.ctx.fillText('40ms', this.width - 35, this.height - 5);

    // Amplitude axis (left)
    const maxShown = Math.round(32768 / this.currentScale);
    this.ctx.fillText(`+${maxShown}`, 5, 15);
    this.ctx.fillText('0', 5, this.height / 2 + 3);
    this.ctx.fillText(`-${maxShown}`, 5, this.height - 5);
  }
}
