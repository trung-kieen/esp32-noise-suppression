export class VADHistoryRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private history: number[] = [];
  private readonly maxHistory = 100;

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

  addValue(vad: number): void {
    this.history.push(vad);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  render(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);

    // Background
    this.ctx.fillStyle = '#0a0a0a';
    this.ctx.fillRect(0, 0, this.width, this.height);

    if (this.history.length < 2) return;

    // Draw threshold line at 0.5
    const thresholdY = this.height * 0.5;
    this.ctx.strokeStyle = '#444';
    this.ctx.setLineDash([5, 5]);
    this.ctx.beginPath();
    this.ctx.moveTo(0, thresholdY);
    this.ctx.lineTo(this.width, thresholdY);
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    // Draw VAD sparkline
    this.ctx.strokeStyle = '#00aaff';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();

    const step = this.width / (this.maxHistory - 1);

    for (let i = 0; i < this.history.length; i++) {
      const x = i * step;
      const y = this.height - (this.history[i] * this.height);

      if (i === 0) {
        this.ctx.moveTo(x, y);
      } else {
        this.ctx.lineTo(x, y);
      }
    }

    this.ctx.stroke();

    // Fill area under curve
    this.ctx.lineTo((this.history.length - 1) * step, this.height);
    this.ctx.lineTo(0, this.height);
    this.ctx.closePath();
    this.ctx.fillStyle = 'rgba(0, 170, 255, 0.2)';
    this.ctx.fill();

    // Draw current value indicator
    if (this.history.length > 0) {
      const lastVal = this.history[this.history.length - 1];
      const lastX = (this.history.length - 1) * step;
      const lastY = this.height - (lastVal * this.height);

      this.ctx.fillStyle = lastVal > 0.5 ? '#00ff88' : '#ff4444';
      this.ctx.beginPath();
      this.ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
      this.ctx.fill();
    }

    // Label
    this.ctx.fillStyle = '#666';
    this.ctx.font = '10px monospace';
    this.ctx.fillText('VAD History (last 4s)', 5, 12);
  }
}
