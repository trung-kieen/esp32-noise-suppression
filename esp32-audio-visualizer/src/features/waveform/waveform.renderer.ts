export class WaveformRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private gain: number = 1.0;
  private autoScale: boolean = true;
  private currentScale: number = 1.0;
  private lastPeak: number = 0;
  private sampleRate: number = 48000; // Store fs for display

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

  render(
    rawWaveform: number[],
    cleanWaveform: number[],
    sampleRate: number = 48000,
    durationMs: number = 40
  ): void {
    this.sampleRate = sampleRate;
    this.ctx.clearRect(0, 0, this.width, this.height);

    const allSamples = [...rawWaveform, ...cleanWaveform];
    const peak = Math.max(...allSamples.map(Math.abs), 1);
    this.lastPeak = peak;

    if (this.autoScale) {
      const targetAmplitude = 24576;
      this.currentScale = targetAmplitude / peak;
      this.currentScale = Math.max(1, Math.min(50, this.currentScale));
    } else {
      this.currentScale = this.gain;
    }

    this.drawGrid(sampleRate, durationMs);
    this.drawCenterLine();
    this.drawWaveformLine(rawWaveform, '#ff4444', 0.5, 2, this.currentScale);
    this.drawWaveformLine(cleanWaveform, '#00ff88', 1.0, 2.5, this.currentScale);
    this.drawLegend();
    this.drawScaleInfo(peak, this.currentScale, sampleRate, durationMs);
    this.drawAxisLabels(sampleRate, durationMs);
  }

  private drawGrid(sampleRate: number, durationMs: number): void {
    this.ctx.strokeStyle = '#1a1a1a';
    this.ctx.lineWidth = 1;

    // Time divisions based on actual duration
    const divisions = 4;
    for (let i = 1; i < divisions; i++) {
      const x = (this.width / divisions) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.height);
      this.ctx.stroke();
    }

    // Amplitude divisions
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
    const amplitudeScale = (this.height / 2) * 0.45;

    let lastX = 0;
    let lastY = centerY;

    for (let i = 0; i < data.length; i++) {
      const x = i * step;
      const normalized = (data[i] / 32768) * scale;
      const clamped = Math.max(-1, Math.min(1, normalized));
      const y = centerY - (clamped * amplitudeScale);

      if (i === 0) {
        this.ctx.moveTo(x, y);
      } else {
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
    this.ctx.font = '12px monospace';

    this.ctx.fillStyle = 'rgba(0,0,0,0.7)';
    this.ctx.fillRect(this.width - 160, 10, 150, 50);

    this.ctx.fillStyle = '#ff4444';
    this.ctx.fillRect(this.width - 150, legendY - 8, 12, 12);
    this.ctx.fillStyle = '#fff';
    this.ctx.fillText('Raw (Input)', this.width - 135, legendY + 3);

    this.ctx.fillStyle = '#00ff88';
    this.ctx.fillRect(this.width - 150, legendY + 15, 12, 12);
    this.ctx.fillStyle = '#fff';
    this.ctx.fillText('Clean (RNNoise)', this.width - 135, legendY + 26);
  }

  private drawScaleInfo(
    peakValue: number,
    scale: number,
    sampleRate: number,
    durationMs: number
  ): void {
    const mode = this.autoScale ? 'AUTO' : 'MANUAL';
    const peakPercent = ((peakValue / 32768) * 100).toFixed(1);

    // Calculate derived values
    const fs_khz = (sampleRate / 1000).toFixed(1);
    const totalSamples = Math.round(durationMs * sampleRate / 1000);
    const nyquist = (sampleRate / 2 / 1000).toFixed(1);

    // Background box - made taller for more info
    this.ctx.fillStyle = 'rgba(0,0,0,0.8)';
    this.ctx.fillRect(10, 10, 200, 85);

    this.ctx.fillStyle = '#888';
    this.ctx.font = '11px monospace';

    // Row 1: Scale info
    this.ctx.fillText(`Scale: ${mode} ${scale.toFixed(1)}x`, 15, 25);

    // Row 2: Peak info
    this.ctx.fillText(`Peak: ${peakValue.toLocaleString()} (${peakPercent}%)`, 15, 40);

    // Row 3: SAMPLING RATE (highlighted)
    this.ctx.fillStyle = '#00ff88'; // Green highlight for fs
    this.ctx.font = 'bold 12px monospace';
    this.ctx.fillText(`fs = ${sampleRate.toLocaleString()} Hz (${fs_khz} kHz)`, 15, 58);

    // Row 4: Additional audio params
    this.ctx.fillStyle = '#aaa';
    this.ctx.font = '10px monospace';
    this.ctx.fillText(`${totalSamples} samples | Nyquist: ${nyquist} kHz`, 15, 75);

    // Row 5: Range
    this.ctx.fillText(`Range: ±${(32768/scale).toFixed(0)}`, 15, 90);
  }

  private drawAxisLabels(sampleRate: number, durationMs: number): void {
    this.ctx.fillStyle = '#666';
    this.ctx.font = '10px monospace';

    // Time axis with actual ms values
    const stepMs = durationMs / 4;
    this.ctx.fillText('0ms', 5, this.height - 5);
    this.ctx.fillText(`${stepMs}ms`, this.width * 0.25 - 10, this.height - 5);
    this.ctx.fillText(`${stepMs * 2}ms`, this.width * 0.5 - 10, this.height - 5);
    this.ctx.fillText(`${stepMs * 3}ms`, this.width * 0.75 - 10, this.height - 5);
    this.ctx.fillText(`${durationMs}ms`, this.width - 35, this.height - 5);

    // Amplitude axis
    const maxShown = Math.round(32768 / this.currentScale);
    this.ctx.fillText(`+${maxShown}`, 5, 15);
    this.ctx.fillText('0', 5, this.height / 2 + 3);
    this.ctx.fillText(`-${maxShown}`, 5, this.height - 5);

    // Add fs label on Y-axis
    this.ctx.save();
    this.ctx.translate(15, this.height / 2);
    this.ctx.rotate(-Math.PI / 2);
    this.ctx.fillStyle = '#00ff88';
    this.ctx.font = 'bold 11px monospace';
    this.ctx.fillText(`fs=${(sampleRate/1000).toFixed(1)}kHz`, 0, 0);
    this.ctx.restore();
  }
}
