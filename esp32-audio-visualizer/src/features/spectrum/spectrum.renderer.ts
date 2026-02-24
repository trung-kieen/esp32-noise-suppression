export class SpectrumRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private sampleRate: number = 48000;

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
    frequencies: number[],
    sampleRate: number = 48000,
    fftSize: number = 512
  ): void {
    this.sampleRate = sampleRate;
    this.ctx.clearRect(0, 0, this.width, this.height);

    const nyquist = sampleRate / 2;
    this.drawGrid(frequencies, nyquist);
    this.drawSpectrumBars(rawSpectrum, frequencies, nyquist, '#ff4444', 0.35, true);
    this.drawSpectrumBars(cleanSpectrum, frequencies, nyquist, '#00ff88', 0.9, false);
    this.drawLegend(sampleRate, fftSize, nyquist);
  }

  private drawGrid(frequencies: number[], nyquist: number): void {
    this.ctx.strokeStyle = '#222';
    this.ctx.lineWidth = 1;

    // Vertical grid lines + frequency labels
    const freqMarkers = [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000, 22000, 24000]
      .filter(f => f <= nyquist);

    this.ctx.font = 'bold 12px monospace';  // Larger + bold
    this.ctx.fillStyle = '#ffffff';         // Bright white
    this.ctx.shadowColor = 'rgba(0,0,0,0.9)'; // Strong dark shadow/glow
    this.ctx.shadowBlur = 5;
    this.ctx.shadowOffsetX = 1;
    this.ctx.shadowOffsetY = 1;

    freqMarkers.forEach(freq => {
      const x = (freq / nyquist) * this.width;
      // Grid line
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.height);
      this.ctx.stroke();

      // Label
      const label = `${(freq / 1000).toFixed(0)}k`;
      const textWidth = this.ctx.measureText(label).width;

      // Uncomment next 3 lines if you want a small bg behind each label for max readability
      // this.ctx.fillStyle = 'rgba(0,0,0,0.5)';
      // this.ctx.fillRect(x + 2, this.height - 22, textWidth + 6, 18);
      // this.ctx.fillStyle = '#ffffff';

      this.ctx.fillText(label, x + 6, this.height - 8); // Shifted right & up for clearance
    });

    // Reset shadow to avoid affecting other elements
    this.ctx.shadowColor = 'transparent';
    this.ctx.shadowBlur = 0;

    // Horizontal grid lines (rough dB reference)
    for (let i = 1; i < 6; i++) {
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
    nyquist: number,
    color: string,
    alpha: number,
    isLine: boolean
  ): void {
    if (!spectrum || spectrum.length === 0) return;

    // Better dB normalization (shared range feel, floor at -100 dB-ish)
    const dbs = spectrum.map(m => 20 * Math.log10(Math.max(m, 1e-10)));
    const minDb = Math.min(...dbs, -100) - 5; // slight buffer
    const maxDb = Math.max(...dbs, 0);
    const dbRange = maxDb - minDb || 100;

    this.ctx.globalAlpha = alpha;
    this.ctx.strokeStyle = color;
    this.ctx.fillStyle = color;
    this.ctx.lineWidth = isLine ? 1.8 : 1; // Thicker line for raw to stand out

    if (isLine) {
      // Raw as smooth line (better visibility over clean bars)
      this.ctx.beginPath();
      let started = false;
      for (let i = 0; i < spectrum.length; i++) {
        const mag = spectrum[i];
        const freq = frequencies[i];
        const x = (freq / nyquist) * this.width;
        const db = 20 * Math.log10(Math.max(mag, 1e-10));
        const norm = (db - minDb) / dbRange;
        const h = Math.max(0, Math.min(1, norm)) * this.height * 0.96;
        const y = this.height - h;
        if (!started) {
          this.ctx.moveTo(x, y);
          started = true;
        } else {
          this.ctx.lineTo(x, y);
        }
      }
      this.ctx.stroke();
    } else {
      // Clean as filled bars
      for (let i = 0; i < spectrum.length; i++) {
        const mag = spectrum[i];
        const freq = frequencies[i];
        const x = (freq / nyquist) * this.width;
        const nextX = i < spectrum.length - 1
          ? (frequencies[i + 1] / nyquist) * this.width
          : this.width;
        const barWidth = Math.max(1, nextX - x);
        const db = 20 * Math.log10(Math.max(mag, 1e-10));
        const norm = (db - minDb) / dbRange;
        const h = Math.max(0, Math.min(1, norm)) * this.height * 0.96;
        const y = this.height - h;
        this.ctx.fillRect(x, y, barWidth - 0.5, h);
      }
    }

    this.ctx.globalAlpha = 1.0;
  }

  private drawLegend(sampleRate: number, fftSize: number, nyquist: number): void {
    const freqResolution = sampleRate / fftSize;

    // Semi-transparent bg for whole legend area
    this.ctx.fillStyle = 'rgba(0,0,0,0.75)';
    this.ctx.fillRect(12, 12, 240, 80);

    this.ctx.shadowColor = 'rgba(0,0,0,0.8)';
    this.ctx.shadowBlur = 4;
    this.ctx.shadowOffsetX = 1;
    this.ctx.shadowOffsetY = 1;

    // Sample rate highlighted
    this.ctx.fillStyle = '#00ff88';
    this.ctx.font = 'bold 14px monospace';
    this.ctx.fillText(`fs = ${sampleRate.toLocaleString()} Hz`, 20, 32);

    // Extra info
    this.ctx.fillStyle = '#e0e0e0';
    this.ctx.font = '11px monospace';
    this.ctx.fillText(`FFT: ${fftSize} pts  •  Δf ≈ ${freqResolution.toFixed(1)} Hz`, 20, 52);
    this.ctx.fillText(`Nyquist: ${(nyquist / 1000).toFixed(1)} kHz`, 20, 70);

    // Spectrum color legend (top-right)
    this.ctx.fillStyle = 'rgba(0,0,0,0.75)';
    this.ctx.fillRect(this.width - 170, 12, 158, 60);

    this.ctx.shadowBlur = 3;
    const ly = 28;
    this.ctx.fillStyle = '#ff4444';
    this.ctx.fillRect(this.width - 158, ly - 10, 16, 16);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = 'bold 12px monospace';
    this.ctx.fillText('Raw Spectrum', this.width - 138, ly + 4);

    this.ctx.fillStyle = '#00ff88';
    this.ctx.fillRect(this.width - 158, ly + 12, 16, 16);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillText('Clean Spectrum', this.width - 138, ly + 26);

    // Reset shadow
    this.ctx.shadowColor = 'transparent';
    this.ctx.shadowBlur = 0;
  }
}
