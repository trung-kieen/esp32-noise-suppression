export class SpectrumRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;

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

  render(
    rawSpectrum: number[],
    cleanSpectrum: number[],
    frequencies: number[]
  ): void {
    this.ctx.clearRect(0, 0, this.width, this.height);

    this.drawGrid(frequencies);
    this.drawSpectrumBars(rawSpectrum, frequencies, '#ff4444', 0.3, true);
    this.drawSpectrumBars(cleanSpectrum, frequencies, '#00ff88', 0.9, false);
    this.drawLegend();
  }

  private drawGrid(frequencies: number[]): void {
    this.ctx.strokeStyle = '#1a1a1a';
    this.ctx.lineWidth = 1;

    // Frequency markers (kHz)
    const freqMarkers = [0, 4000, 8000, 12000, 16000, 20000, 24000];
    const maxFreq = frequencies[frequencies.length - 1] || 24000;

    freqMarkers.forEach(freq => {
      if (freq > maxFreq) return;
      const x = (freq / maxFreq) * this.width;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.height);
      this.ctx.stroke();

      this.ctx.fillStyle = '#555';
      this.ctx.font = '10px monospace';
      this.ctx.fillText(`${freq/1000}k`, x + 2, this.height - 5);
    });

    for (let i = 1; i < 5; i++) {
      const y = (this.height / 5) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.width, y);
      this.ctx.stroke();
    }
  }

  private drawSpectrumBars(
    spectrum: number[],
    frequencies: number[],
    color: string,
    alpha: number,
    fill: boolean
  ): void {
    if (!spectrum || spectrum.length === 0) return;

    const maxFreq = frequencies[frequencies.length - 1] || 24000;
    const maxVal = Math.max(...spectrum, 1);

    this.ctx.fillStyle = color;
    this.ctx.strokeStyle = color;
    this.ctx.globalAlpha = alpha;

    for (let i = 0; i < spectrum.length; i++) {
      const magnitude = spectrum[i];
      const freq = frequencies[i];

      const x = (freq / maxFreq) * this.width;
      const nextX = i < spectrum.length - 1
        ? (frequencies[i + 1] / maxFreq) * this.width
        : this.width;
      const barWidth = nextX - x;

      const db = 20 * Math.log10(magnitude + 1e-10);
      const normalizedDb = Math.max(0, (db + 100) / 100);
      const barHeight = normalizedDb * this.height * 0.95;

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
