
/**
 * Scrolling mel spectrogram heatmap renderer.
 *
 * Assumptions (adjust to match your server):
 *  - DTO field:  dto.melSpectrogram.raw / .clean  (40 float values each)
 *  - Values:     log-mel / dB (already log-scaled by the server, passed straight to colormap)
 *  - Mel bins:   40 (low-index = low freq, high-index = high freq)
 *  - History:    200 frames ≈ 8 seconds at 25 Hz
 */

export type MelChannel = 'raw' | 'clean';

// ---------------------------------------------------------------------------
// Inferno-inspired colormap  (black → purple → red → orange → yellow-white)
// ---------------------------------------------------------------------------
function buildInfernoLUT(): Uint8Array {
  const stops: [number, number, number][] = [
    [0, 0, 4],
    [40, 11, 84],
    [101, 21, 110],
    [188, 55, 84],
    [237, 105, 37],
    [249, 168, 9],
    [252, 230, 100],
    [252, 255, 164],
  ];
  const lut = new Uint8Array(256 * 3);
  const n = stops.length - 1;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const seg = t * n;
    const lo = Math.floor(seg);
    const hi = Math.min(lo + 1, n);
    const frac = seg - lo;
    lut[i * 3]     = Math.round(stops[lo][0] + (stops[hi][0] - stops[lo][0]) * frac);
    lut[i * 3 + 1] = Math.round(stops[lo][1] + (stops[hi][1] - stops[lo][1]) * frac);
    lut[i * 3 + 2] = Math.round(stops[lo][2] + (stops[hi][2] - stops[lo][2]) * frac);
  }
  return lut;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
export class MelSpectrogramRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  // Offscreen canvas: each pixel = one (frame × mel-bin) cell → GPU scales it up
  private readonly offscreen: HTMLCanvasElement;
  private readonly offCtx: CanvasRenderingContext2D;
  private imageData: ImageData;

  private readonly MEL_BINS: number;
  private readonly HISTORY: number;
  private readonly isLogScaled: boolean; // true if server already sends dB

  // Ring buffer: Float32Array[HISTORY * MEL_BINS]
  private readonly buffer: Float32Array;
  private writeHead = 0;
  private filledFrames = 0; // how many frames have been received so far

  private readonly colorLUT: Uint8Array;

  // Running percentile-based normalization for stable color scaling
  private readonly normMin: number;
  private readonly normRange: number;

  // dB display range — match to your server's normalization.
  // librosa default: top_db=80 → values in [-80, 0].
  // Adjust if your server uses a different range (e.g. [-100, 0] or absolute dBFS).
  private readonly DB_FLOOR = -80;  // maps to black on the inferno colormap
  private readonly DB_CEIL  =   0;  // maps to white

  constructor(
    canvas: HTMLCanvasElement,
    options: {
      melBins?: number;
      historyFrames?: number;
      isLogScaled?: boolean; // set true if server sends dB already
    } = {}
  ) {
    this.canvas    = canvas;
    this.ctx       = canvas.getContext('2d')!;
    this.MEL_BINS  = options.melBins      ?? 40;
    this.HISTORY   = options.historyFrames ?? 200;
    this.isLogScaled = options.isLogScaled ?? false;

    this.buffer    = new Float32Array(this.HISTORY * this.MEL_BINS);
    this.colorLUT  = buildInfernoLUT();
    this.normMin   = this.DB_FLOOR;
    this.normRange = this.DB_CEIL - this.DB_FLOOR;

    // Offscreen canvas: exactly HISTORY × MEL_BINS pixels
    this.offscreen = document.createElement('canvas');
    this.offscreen.width  = this.HISTORY;
    this.offscreen.height = this.MEL_BINS;
    this.offCtx = this.offscreen.getContext('2d')!;
    this.imageData = this.offCtx.createImageData(this.HISTORY, this.MEL_BINS);

    this.initCanvas();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Feed one frame of mel energies (length = MEL_BINS). */
  addFrame(melData: number[]): void {
    const base = this.writeHead * this.MEL_BINS;
    for (let i = 0; i < this.MEL_BINS; i++) {
      const raw = melData[i] ?? 0;
      // Convert to dB if not already
      this.buffer[base + i] = this.isLogScaled
        ? raw
        : (raw > 1e-10 ? 20 * Math.log10(raw) : this.DB_FLOOR);
    }
    this.writeHead = (this.writeHead + 1) % this.HISTORY;
    if (this.filledFrames < this.HISTORY) this.filledFrames++;
  }

  /** Render the spectrogram onto the canvas.  Call from rAF loop. */
  render(label = ''): void {
    this.syncCanvasSize();

    const dpr  = window.devicePixelRatio || 1;
    const W    = this.canvas.width  / dpr;
    const H    = this.canvas.height / dpr;

    // ---- 1. Fill offscreen ImageData (HISTORY × MEL_BINS pixels) ----------
    const pixels = this.imageData.data;
    const filled = this.filledFrames;

    for (let col = 0; col < this.HISTORY; col++) {
      // oldest frame first (left), newest last (right)
      const bufCol = (this.writeHead + col) % this.HISTORY;
      const isUnfilled = col >= filled;

      for (let bin = 0; bin < this.MEL_BINS; bin++) {
        // Flip Y: bin 0 → bottom, bin MEL_BINS-1 → top
        const pixY = this.MEL_BINS - 1 - bin;
        const pixIdx = (pixY * this.HISTORY + col) * 4;

        if (isUnfilled) {
          pixels[pixIdx]     = 0;
          pixels[pixIdx + 1] = 0;
          pixels[pixIdx + 2] = 0;
          pixels[pixIdx + 3] = 255;
          continue;
        }

        const dB  = this.buffer[bufCol * this.MEL_BINS + bin];
        const t   = Math.max(0, Math.min(1, (dB - this.normMin) / this.normRange));
        const lut = Math.floor(t * 255);
        pixels[pixIdx]     = this.colorLUT[lut * 3];
        pixels[pixIdx + 1] = this.colorLUT[lut * 3 + 1];
        pixels[pixIdx + 2] = this.colorLUT[lut * 3 + 2];
        pixels[pixIdx + 3] = 255;
      }
    }

    this.offCtx.putImageData(this.imageData, 0, 0);

    // ---- 2. Draw scaled offscreen onto main canvas (nearest-neighbor) ------
    this.ctx.imageSmoothingEnabled = false; // crisp pixel blocks
    this.ctx.drawImage(this.offscreen, 0, 0, W, H);

    // ---- 3. Overlay: time cursor line (newest frame) ----------------------
    const cursorX = ((filled >= this.HISTORY ? this.HISTORY - 1 : filled - 1) / this.HISTORY) * W;
    this.ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    this.ctx.lineWidth   = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(cursorX, 0);
    this.ctx.lineTo(cursorX, H);
    this.ctx.stroke();

    // ---- 4. Overlay: frequency axis labels (right edge) -------------------
    this.ctx.font      = '9px monospace';
    this.ctx.textAlign = 'right';

    const freqLabels = [
      { text: '8k', y: H * 0.05 },
      { text: '4k', y: H * 0.25 },
      { text: '2k', y: H * 0.45 },
      { text: '1k', y: H * 0.65 },
      { text: '500', y: H * 0.80 },
    ];
    freqLabels.forEach(({ text, y }) => {
      this.ctx.fillStyle = 'rgba(0,0,0,0.55)';
      this.ctx.fillRect(W - 28, y - 9, 26, 11);
      this.ctx.fillStyle = 'rgba(255,255,255,0.7)';
      this.ctx.fillText(text, W - 3, y);
    });

    // ---- 5. Overlay: time axis labels (bottom edge) -----------------------
    this.ctx.textAlign = 'left';
    const secTotal = this.HISTORY / 25; // 25 Hz
    const timeLabels = [0, secTotal * 0.25, secTotal * 0.5, secTotal * 0.75, secTotal];
    timeLabels.forEach((sec, i) => {
      const x = (i / (timeLabels.length - 1)) * W;
      this.ctx.fillStyle = 'rgba(0,0,0,0.55)';
      this.ctx.fillRect(x, H - 12, 24, 11);
      this.ctx.fillStyle = 'rgba(255,255,255,0.5)';
      this.ctx.fillText(`-${(secTotal - sec).toFixed(0)}s`, x + 2, H - 2);
    });

    // ---- 6. Overlay: dB range legend (top-left) ---------------------------
    if (label) {
      this.ctx.textAlign = 'left';
      this.ctx.fillStyle = 'rgba(0,0,0,0.6)';
      this.ctx.fillRect(4, 4, label.length * 7.5 + 8, 16);
      this.ctx.fillStyle = '#fff';
      this.ctx.font = '10px monospace';
      this.ctx.fillText(label, 8, 16);
    }

    // ---- 7. Colorbar (thin strip on left edge) ----------------------------
    this.drawColorbar(H);
  }

  /** Call on canvas resize events. */
  resize(): void {
    this.initCanvas();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private initCanvas(): void {
    const dpr  = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w    = Math.round((rect.width  || 600) * dpr);
    const h    = Math.round((rect.height || 160) * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width  = w;
      this.canvas.height = h;
    }
  }

  private syncCanvasSize(): void {
    const dpr  = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w    = Math.round(rect.width  * dpr);
    const h    = Math.round(rect.height * dpr);
    if (rect.width > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width  = w;
      this.canvas.height = h;
    }
  }

  private drawColorbar(H: number): void {
    const barW = 6;
    const barH = H * 0.6;
    const barY = H * 0.2;

    for (let i = 0; i < barH; i++) {
      const t   = 1 - i / barH; // top = bright, bottom = dark
      const lut = Math.floor(t * 255);
      this.ctx.fillStyle =
        `rgb(${this.colorLUT[lut * 3]},${this.colorLUT[lut * 3 + 1]},${this.colorLUT[lut * 3 + 2]})`;
      this.ctx.fillRect(2, barY + i, barW, 1);
    }

    // dB tick labels beside colorbar
    this.ctx.font      = '8px monospace';
    this.ctx.textAlign = 'left';
    this.ctx.fillStyle = 'rgba(255,255,255,0.55)';
    this.ctx.fillText(`${this.DB_CEIL}dB`,  barW + 4, barY + 6);
    this.ctx.fillText(`${this.DB_FLOOR}dB`, barW + 4, barY + barH - 2);
  }
}
