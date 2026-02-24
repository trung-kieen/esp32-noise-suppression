export class BarkBandsRenderer {
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
    rawBands: number[],
    cleanBands: number[],
    bandEdges: number[]
  ): void {
    this.ctx.clearRect(0, 0, this.width, this.height);

    this.drawGrid(bandEdges);
    this.drawBars(rawBands, '#ff4444', 0.4);
    this.drawBars(cleanBands, '#00ff88', 0.8);
    this.drawLegend();
  }

  private drawGrid(bandEdges: number[]): void {
    this.ctx.strokeStyle = '#1a1a1a';
    this.ctx.lineWidth = 1;

    // Vertical lines for band boundaries (show every 5th)
    for (let i = 0; i < bandEdges.length; i += 5) {
      const x = (i / (bandEdges.length - 1)) * this.width;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.height);
      this.ctx.stroke();

      if (i < bandEdges.length - 1) {
        this.ctx.fillStyle = '#555';
        this.ctx.font = '9px monospace';
        this.ctx.fillText(`${Math.round(bandEdges[i]/1000)}k`, x + 2, this.height - 5);
      }
    }
  }

  private drawBars(bands: number[], color: string, alpha: number): void {
    if (!bands || bands.length === 0) return;

    const barWidth = this.width / bands.length;
    const maxVal = Math.max(...bands, 1);

    this.ctx.fillStyle = color;
    this.ctx.globalAlpha = alpha;

    for (let i = 0; i < bands.length; i++) {
      const energy = bands[i];
      const normalized = energy / maxVal;
      const barHeight = normalized * this.height * 0.9;

      const x = i * barWidth;
      const y = this.height - barHeight;

      this.ctx.fillRect(x, y, barWidth - 1, barHeight);
    }

    this.ctx.globalAlpha = 1.0;
  }

  private drawLegend(): void {
    this.ctx.font = '11px monospace';

    this.ctx.fillStyle = '#ff4444';
    this.ctx.fillRect(10, 10, 12, 12);
    this.ctx.fillStyle = '#fff';
    this.ctx.fillText('Raw Bark', 26, 20);

    this.ctx.fillStyle = '#00ff88';
    this.ctx.fillRect(10, 26, 12, 12);
    this.ctx.fillStyle = '#fff';
    this.ctx.fillText('Clean Bark', 26, 36);
  }
}
