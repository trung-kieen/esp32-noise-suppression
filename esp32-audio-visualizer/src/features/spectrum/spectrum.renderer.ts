// src/features/spectrum/spectrum.renderer.ts
export class SpectrumRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private readonly sampleRate = 48000;
  private readonly fftSize = 512;

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

  render(rawSpectrum: number[], cleanSpectrum: number[]): void {
    this.ctx.clearRect(0, 0, this.width, this.height);

    // Draw frequency grid
    this.drawFrequencyGrid();

    // Draw raw spectrum (red bars, background)
    this.drawSpectrumBars(rawSpectrum, '#ff4444', 0.3, true);

    // Draw clean spectrum (green bars, foreground)
    this.drawSpectrumBars(cleanSpectrum, '#00ff88', 0.9, false);

    // Draw legend
    this.drawLegend();
  }

  private drawFrequencyGrid(): void {
    this.ctx.strokeStyle = '#1a1a1a';
    this.ctx.lineWidth = 1;

    // Frequency markers (kHz)
    const freqs = [0, 4, 8, 12, 16, 20, 24];
    const nyquist = this.sampleRate / 2;

    freqs.forEach(freq => {
      const x = (freq / nyquist) * this.width;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.height);
      this.ctx.stroke();

      // Label
      this.ctx.fillStyle = '#666';
      this.ctx.font = '10px monospace';
      this.ctx.fillText(`${freq}k`, x + 2, this.height - 5);
    });

    // Horizontal grid lines (dB)
    for (let i = 1; i < 5; i++) {
      const y = (this.height / 5) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.width, y);
      this.ctx.stroke();
    }
  }

  private drawSpectrumBars(spectrum: number[], color: string, alpha: number, fill: boolean): void {
    if (!spectrum || spectrum.length === 0) return;

    const barWidth = this.width / spectrum.length;
    const maxVal = Math.max(...spectrum, 1); // Avoid division by zero

    this.ctx.fillStyle = color;
    this.ctx.strokeStyle = color;
    this.ctx.globalAlpha = alpha;

    for (let i = 0; i < spectrum.length; i++) {
      const magnitude = spectrum[i];
      // Log scale for better visualization
      const db = 20 * Math.log10(magnitude + 1e-10);
      const normalizedDb = Math.max(0, (db + 100) / 100); // Normalize -100dB to 0dB range
      const barHeight = normalizedDb * this.height * 0.95;

      const x = i * barWidth;
      const y = this.height - barHeight;

      if (fill) {
        this.ctx.fillRect(x, y, barWidth - 0.5, barHeight);
      } else {
        this.ctx.fillRect(x, y, barWidth - 1, barHeight);
      }
    }

    this.ctx.globalAlpha = 1.0;
  }

  private drawLegend(): void {
    const legendY = 20;
    this.ctx.font = '12px monospace';

    this.ctx.fillStyle = '#ff4444';
    this.ctx.fillRect(10, legendY - 10, 15, 15);
    this.ctx.fillStyle = '#fff';
    this.ctx.fillText('Raw Spectrum', 30, legendY);

    this.ctx.fillStyle = '#00ff88';
    this.ctx.fillRect(10, legendY + 15, 15, 15);
    this.ctx.fillStyle = '#fff';
    this.ctx.fillText('Clean Spectrum', 30, legendY + 25);
  }
}
