"""
server.py — Real-Time Audio Visualization Server
Receives binary audio frames from ESP32 via WebSocket,
computes FFT/STFT/Bark bands, broadcasts to browser dashboard.

Install:
    pip install fastapi uvicorn websockets numpy scipy

Run:
    python server.py
    Then open http://localhost:8000 in browser
"""

import asyncio
import json
import struct
import time
import math
import logging
from collections import deque
from typing import Set

import numpy as np
from scipy.signal import stft as scipy_stft
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("AudioServer")

# ============================================================
#  Constants (must match ESP32 audio_config.h)
# ============================================================
SAMPLE_RATE   = 48000
FRAME_SAMPLES = 480
FRAME_SIZE    = 1932    # bytes

HEADER_FMT    = "<IIHBBx"        # little-endian: uint32,uint32,uint16,uint8,uint8,pad
HEADER_SIZE   = struct.calcsize(HEADER_FMT)  # 12 bytes

# STFT parameters
STFT_NPERSEG  = 256    # FFT window size
STFT_NOVERLAP = 128    # 50% overlap
STFT_WINDOW   = "hann"

# Spectrogram history (number of frames kept for 2D display)
SPEC_HISTORY  = 100    # ~1 second @ 100fps

# Bark scale boundaries (Hz) — 22 bands matching RNNoise
BARK_BOUNDARIES_HZ = [
    0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 2000,
    2400, 2800, 3200, 4000, 4800, 5600, 6800, 8000, 9600,
    11200, 13600, 16000, 20000
]

# ============================================================
#  Frame Parser
# ============================================================
def parse_frame(data: bytes) -> dict:
    if len(data) != FRAME_SIZE:
        raise ValueError(f"Expected {FRAME_SIZE} bytes, got {len(data)}")

    seq, ts_ms, vad_raw, flags, _ = struct.unpack_from(HEADER_FMT, data, 0)

    # int16 little-endian PCM
    raw_pcm   = np.frombuffer(data[12:972],    dtype="<i2").astype(np.float32)
    clean_pcm = np.frombuffer(data[972:1932],  dtype="<i2").astype(np.float32)

    return {
        "seq":       seq,
        "timestamp": ts_ms,
        "vad_prob":  vad_raw / 65535.0,
        "flags":     flags,
        "raw_pcm":   raw_pcm,
        "clean_pcm": clean_pcm,
    }

# ============================================================
#  DSP Processing
# ============================================================
def compute_fft(pcm: np.ndarray) -> dict:
    """Single-frame FFT magnitude spectrum in dB."""
    N = len(pcm)
    window = np.hanning(N)
    spectrum = np.abs(np.fft.rfft(pcm * window))
    # Avoid log(0)
    spectrum = np.maximum(spectrum, 1e-10)
    spectrum_db = 20.0 * np.log10(spectrum / N)
    freqs = np.fft.rfftfreq(N, d=1.0 / SAMPLE_RATE)
    return {"freqs": freqs.tolist(), "magnitude_db": spectrum_db.tolist()}


def compute_stft(pcm_buffer: np.ndarray) -> dict:
    """
    Compute STFT on a multi-frame buffer.
    Returns time×freq magnitude matrix (dB), capped to [−80, 0].
    """
    f, t, Zxx = scipy_stft(
        pcm_buffer,
        fs=SAMPLE_RATE,
        window=STFT_WINDOW,
        nperseg=STFT_NPERSEG,
        noverlap=STFT_NOVERLAP,
    )
    magnitude_db = 20.0 * np.log10(np.maximum(np.abs(Zxx), 1e-10))
    magnitude_db = np.clip(magnitude_db, -80, 0)
    return {
        "freqs": f.tolist(),
        "times": t.tolist(),
        "magnitude_db": magnitude_db.tolist(),   # shape: [freq_bins, time_bins]
    }


def compute_bark_bands(pcm: np.ndarray) -> list:
    """
    Compute energy in 22 Bark bands.
    Returns list of 22 dB values.
    """
    N = len(pcm)
    window = np.hanning(N)
    spectrum = np.abs(np.fft.rfft(pcm * window)) ** 2
    freqs = np.fft.rfftfreq(N, d=1.0 / SAMPLE_RATE)
    freq_step = freqs[1] - freqs[0]

    bands = []
    for i in range(len(BARK_BOUNDARIES_HZ) - 1):
        f_low  = BARK_BOUNDARIES_HZ[i]
        f_high = BARK_BOUNDARIES_HZ[i + 1]
        mask = (freqs >= f_low) & (freqs < f_high)
        energy = np.sum(spectrum[mask])
        energy_db = 10.0 * math.log10(max(energy, 1e-10))
        bands.append(round(energy_db, 2))

    return bands   # 22 values


def compute_snr(raw_pcm: np.ndarray, clean_pcm: np.ndarray) -> float:
    """
    Estimate SNR: signal power (clean) vs noise power (raw - clean).
    """
    signal_power = float(np.mean(clean_pcm ** 2))
    noise = raw_pcm - clean_pcm
    noise_power  = float(np.mean(noise ** 2))
    if noise_power < 1e-10:
        return 60.0   # effectively no noise
    snr = 10.0 * math.log10(max(signal_power / noise_power, 1e-10))
    return round(snr, 2)

# ============================================================
#  In-Memory Circular Buffers (for spectrogram history)
# ============================================================
class AudioBuffer:
    def __init__(self, max_frames: int = SPEC_HISTORY):
        self.max_frames = max_frames
        self.raw_pcm   = deque(maxlen=max_frames)
        self.clean_pcm = deque(maxlen=max_frames)
        self.snr_history    = deque(maxlen=200)
        self.last_seq       = -1
        self.dropped_frames = 0

    def push(self, frame: dict):
        seq = frame["seq"]
        if self.last_seq >= 0 and seq != self.last_seq + 1:
            gap = seq - self.last_seq - 1
            self.dropped_frames += max(gap, 0)
            if gap > 0:
                log.warning(f"Dropped {gap} frame(s) — seq {self.last_seq} → {seq}")
        self.last_seq = seq

        self.raw_pcm.append(frame["raw_pcm"])
        self.clean_pcm.append(frame["clean_pcm"])

        snr = compute_snr(frame["raw_pcm"], frame["clean_pcm"])
        self.snr_history.append(snr)

    def get_concatenated(self):
        if not self.raw_pcm:
            return np.zeros(FRAME_SAMPLES), np.zeros(FRAME_SAMPLES)
        return (
            np.concatenate(list(self.raw_pcm)),
            np.concatenate(list(self.clean_pcm)),
        )

audio_buf = AudioBuffer()

# ============================================================
#  FastAPI App
# ============================================================
app = FastAPI(title="RNNoise Visualization Server")

# Connected browser clients
browser_clients: Set[WebSocket] = set()

# ============================================================
#  ESP32 WebSocket Endpoint
# ============================================================
@app.websocket("/esp32")
async def esp32_endpoint(ws: WebSocket):
    global browser_clients
    await ws.accept()
    client_ip = ws.client.host
    log.info(f"ESP32 connected from {client_ip}")

    handshake_received = False

    try:
        while True:
            # Use receive() instead of receive_bytes() so we handle
            # both the text handshake and binary audio frames on the
            # same connection without a KeyError crash.
            message = await ws.receive()

            # ---- TEXT frame (handshake JSON from ESP32) ----
            if message["type"] == "websocket.receive" and message.get("text"):
                raw_text = message["text"]
                try:
                    msg = json.loads(raw_text)
                    if msg.get("type") == "handshake":
                        log.info(f"Handshake received: {msg}")
                        handshake_received = True
                        await ws.send_text(json.dumps({"type": "ack", "status": "ok"}))
                        log.info("Ack sent — ready to receive binary frames")
                    else:
                        log.warning(f"Unknown text message: {raw_text}")
                except json.JSONDecodeError:
                    log.warning(f"Received non-JSON text: {raw_text}")
                continue

            # ---- DISCONNECT frame ----
            if message["type"] == "websocket.disconnect":
                log.info(f"ESP32 disconnected cleanly: {client_ip}")
                break

            # ---- BINARY frame (audio_ws_frame_t) ----
            data = message.get("bytes")
            if not data:
                log.warning(f"Received message with no bytes and no text: {message}")
                continue

            handshake_received = True

            if len(data) != FRAME_SIZE:
                log.warning(f"Unexpected frame size: got {len(data)} expected {FRAME_SIZE} bytes")
                continue

            try:
                frame = parse_frame(data)
            except ValueError as e:
                log.error(f"Parse error: {e}")
                continue

            # Push to buffer
            audio_buf.push(frame)

            # Build visualization payload for browser
            raw_buf, clean_buf = audio_buf.get_concatenated()

            # Compute DSP (runs fast enough at 100fps for short buffers)
            fft_raw   = compute_fft(frame["raw_pcm"])
            fft_clean = compute_fft(frame["clean_pcm"])
            bark_raw   = compute_bark_bands(frame["raw_pcm"])
            bark_clean = compute_bark_bands(frame["clean_pcm"])
            snr_db    = compute_snr(frame["raw_pcm"], frame["clean_pcm"])

            # STFT on full history buffer (heavier — throttle to every 5 frames)
            stft_payload = None
            if frame["seq"] % 5 == 0:
                stft_raw   = compute_stft(raw_buf)
                stft_clean = compute_stft(clean_buf)
                stft_payload = {
                    "raw":   stft_raw,
                    "clean": stft_clean,
                }

            # Waveform — send last 480 samples (one frame)
            waveform_raw   = frame["raw_pcm"].tolist()
            waveform_clean = frame["clean_pcm"].tolist()

            broadcast_msg = {
                "type":       "frame_update",
                "seq":        frame["seq"],
                "timestamp":  frame["timestamp"],
                "vad_prob":   round(frame["vad_prob"], 4),
                "flags":      frame["flags"],
                "snr_db":     snr_db,
                "snr_history": list(audio_buf.snr_history)[-50:],
                "dropped_frames": audio_buf.dropped_frames,
                "waveform":   {"raw": waveform_raw, "clean": waveform_clean},
                "fft":        {"raw": fft_raw, "clean": fft_clean},
                "bark_bands": {"raw": bark_raw, "clean": bark_clean},
            }
            if stft_payload:
                broadcast_msg["stft"] = stft_payload

            # Broadcast to all browser clients
            msg_str = json.dumps(broadcast_msg)
            dead = set()
            for browser_ws in browser_clients:
                try:
                    await browser_ws.send_text(msg_str)
                except Exception:
                    dead.add(browser_ws)
            browser_clients -= dead

    except WebSocketDisconnect:
        log.info(f"ESP32 disconnected (WebSocketDisconnect): {client_ip}")
    except Exception as e:
        log.error(f"ESP32 endpoint error: {type(e).__name__}: {e}", exc_info=True)
    finally:
        log.info(f"ESP32 session ended for {client_ip} — "
                 f"total frames received: {audio_buf.last_seq + 1}")

# ============================================================
#  Browser WebSocket Endpoint (receives visualization data)
# ============================================================
@app.websocket("/browser")
async def browser_endpoint(ws: WebSocket):
    global browser_clients
    await ws.accept()
    browser_clients.add(ws)
    log.info(f"Browser connected. Total: {len(browser_clients)}")
    try:
        while True:
            # Keep alive — browser can send pings
            await ws.receive_text()
    except WebSocketDisconnect:
        browser_clients.discard(ws)
        log.info(f"Browser disconnected. Total: {len(browser_clients)}")

# ============================================================
#  Dashboard HTML (served at /)
# ============================================================
# Dashboard HTML embedded directly — no external file needed
DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>ESP32 Audio — Realtime Monitor</title>
  <style>
    :root {
      --bg: #0b1020;
      --card: rgba(255,255,255,0.06);
      --card2: rgba(255,255,255,0.09);
      --text: rgba(255,255,255,0.92);
      --muted: rgba(255,255,255,0.55);
      --grid: rgba(255,255,255,0.07);
      --axis: rgba(255,255,255,0.25);
      --raw:  rgba(120,200,255,0.95);
      --clean: rgba(52,211,153,0.95);
      --ok:   #34d399;
      --bad:  #fb7185;
      --warn: #fbbf24;
      --shadow: 0 18px 45px rgba(0,0,0,0.4);
      --r: 16px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      color: var(--text);
      background:
        radial-gradient(1200px 600px at 10% 10%, #14204a 0%, transparent 60%),
        radial-gradient(900px 500px at 90% 15%, #2b1b4a 0%, transparent 55%),
        linear-gradient(180deg, #070a14, #0b1020);
      min-height: 100vh;
      padding: 16px;
    }

    /* ---- layout ---- */
    .wrap { max-width: 1100px; margin: 0 auto; display: grid; gap: 12px; }

    /* ---- header ---- */
    .header {
      display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
      gap: 10px; padding: 14px 18px;
      border-radius: var(--r);
      background: var(--card); border: 1px solid rgba(255,255,255,0.08);
      box-shadow: var(--shadow); backdrop-filter: blur(10px);
    }
    .title h1 { font-size: 17px; font-weight: 650; letter-spacing: 0.2px; }
    .title .sub { font-size: 11px; color: var(--muted); margin-top: 3px; }
    .pill {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 7px 12px; border-radius: 999px;
      background: var(--card2); border: 1px solid rgba(255,255,255,0.10);
      font-size: 12px; color: var(--muted);
    }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--warn);
           box-shadow: 0 0 0 3px rgba(251,191,36,0.15); transition: all .3s; }
    .dot.ok  { background: var(--ok);  box-shadow: 0 0 0 3px rgba(52,211,153,0.15); }
    .dot.bad { background: var(--bad); box-shadow: 0 0 0 3px rgba(251,113,133,0.15); }

    /* ---- cards ---- */
    .card {
      padding: 14px 16px; border-radius: var(--r);
      background: var(--card); border: 1px solid rgba(255,255,255,0.08);
      box-shadow: var(--shadow); backdrop-filter: blur(8px);
    }
    .card-title {
      font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--muted); margin-bottom: 10px;
    }

    /* ---- stats row ---- */
    .stats-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .stat {
      flex: 1; min-width: 110px;
      padding: 10px 12px; border-radius: 12px;
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
    }
    .stat .k { font-size: 10px; color: var(--muted); margin-bottom: 4px; }
    .stat .v { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .v.ok   { color: var(--ok); }
    .v.warn { color: var(--warn); }
    .v.bad  { color: var(--bad); }
    .v.blue { color: #7dd3fc; }

    /* ---- waveform canvas ---- */
    .cv-wrap { position: relative; }
    canvas {
      width: 100%; border-radius: 12px;
      background: rgba(0,0,0,0.22);
      border: 1px solid rgba(255,255,255,0.07);
      display: block;
    }
    .legend {
      display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
      margin-top: 8px;
    }
    .leg { display: flex; gap: 7px; align-items: center; font-size: 11px; color: var(--muted); }
    .swatch { width: 20px; height: 3px; border-radius: 99px; }
    .swatch.raw   { background: var(--raw); }
    .swatch.clean { background: var(--clean); }

    /* ---- FFT canvas ---- */
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media(max-width:640px){ .two-col { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<div class="wrap">

  <!-- Header -->
  <div class="header">
    <div class="title">
      <h1>ESP32-S3 Audio — Realtime Monitor</h1>
      <div class="sub">INMP441 → RNNoise pipeline  |  48 kHz  |  480 samples / frame (10 ms)</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <div class="pill"><span id="dot" class="dot"></span><span id="status">DISCONNECTED</span></div>
      <div class="pill" id="fps-pill">0 fps</div>
    </div>
  </div>

  <!-- Metrics -->
  <div class="card">
    <div class="card-title">Live Metrics</div>
    <div class="stats-row">
      <div class="stat"><div class="k">Peak (raw)</div>    <div class="v blue" id="m-peak">—</div></div>
      <div class="stat"><div class="k">SNR (dB)</div>      <div class="v ok"   id="m-snr">—</div></div>
      <div class="stat"><div class="k">VAD Prob</div>      <div class="v ok"   id="m-vad">—</div></div>
      <div class="stat"><div class="k">Frame Seq</div>     <div class="v blue" id="m-seq">—</div></div>
      <div class="stat"><div class="k">Dropped</div>       <div class="v ok"   id="m-drop">0</div></div>
      <div class="stat"><div class="k">Latency (ms)</div>  <div class="v blue" id="m-lat">—</div></div>
    </div>
  </div>

  <!-- Waveform — Raw -->
  <div class="card">
    <div class="card-title">Waveform — Raw (mic input, 48 kHz PCM int16)</div>
    <div class="cv-wrap">
      <canvas id="cv-raw" height="160"></canvas>
    </div>
    <div class="legend">
      <div class="leg"><span class="swatch raw"></span>Raw PCM  (−32768 … +32767)</div>
      <div class="leg" id="raw-peak-leg" style="color:#7dd3fc;font-size:11px;">peak: 0</div>
    </div>
  </div>

  <!-- Waveform — Clean -->
  <div class="card">
    <div class="card-title">Waveform — Clean (after RNNoise / passthrough)</div>
    <div class="cv-wrap">
      <canvas id="cv-clean" height="160"></canvas>
    </div>
    <div class="legend">
      <div class="leg"><span class="swatch clean"></span>Clean PCM</div>
    </div>
  </div>

  <!-- FFT + Bark -->
  <div class="two-col">
    <div class="card">
      <div class="card-title">FFT Spectrum (dB)</div>
      <canvas id="cv-fft" height="180"></canvas>
      <div class="legend" style="margin-top:6px;">
        <div class="leg"><span class="swatch raw"></span>Raw</div>
        <div class="leg"><span class="swatch clean"></span>Clean</div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Bark Band Energies — 22 bands (dB)</div>
      <canvas id="cv-bark" height="180"></canvas>
      <div class="legend" style="margin-top:6px;">
        <div class="leg"><span class="swatch raw"></span>Raw</div>
        <div class="leg"><span class="swatch clean"></span>Clean</div>
      </div>
    </div>
  </div>

  <!-- SNR history -->
  <div class="card">
    <div class="card-title">SNR History (dB over time)</div>
    <canvas id="cv-snr" height="120"></canvas>
  </div>

</div><!-- /wrap -->

<script>
// ================================================================
//  Helpers
// ================================================================
const $ = id => document.getElementById(id);

const C = {
  raw:   'rgba(120,200,255,0.9)',
  clean: 'rgba(52,211,153,0.9)',
  grid:  'rgba(255,255,255,0.07)',
  axis:  'rgba(255,255,255,0.20)',
  text:  'rgba(255,255,255,0.45)',
  snr:   'rgba(251,191,36,0.9)',
  bark_raw:   'rgba(120,200,255,0.55)',
  bark_clean: 'rgba(52,211,153,0.55)',
};

// Make canvas pixel-perfect for device pixel ratio
function initCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  cv.width  = rect.width  * dpr || cv.clientWidth  * dpr;
  cv.height = cv.getAttribute('height') * dpr;
  cv.style.height = cv.getAttribute('height') + 'px';
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

// Draw a grid + y-axis labels, return geometry object
function drawGrid(ctx, W, H, pad, yMin, yMax, ySteps=4) {
  const {l,r,t,b} = pad;
  const iW = W - l - r, iH = H - t - b;

  ctx.clearRect(0, 0, W, H);

  // horizontal grid lines + y labels
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  ctx.fillStyle = C.text; ctx.font = `${11}px system-ui`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= ySteps; i++) {
    const frac = i / ySteps;
    const y    = t + iH * frac;
    const val  = yMax - (yMax - yMin) * frac;
    ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + iW, y); ctx.stroke();
    ctx.fillText(Math.round(val).toLocaleString(), l - 5, y);
  }

  // vertical grid lines
  const xSteps = 6;
  for (let i = 0; i <= xSteps; i++) {
    const x = l + iW * i / xSteps;
    ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + iH); ctx.stroke();
  }

  // axes
  ctx.strokeStyle = C.axis; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(l, t); ctx.lineTo(l, t + iH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(l, t + iH); ctx.lineTo(l + iW, t + iH); ctx.stroke();

  return { l, r, t, b, iW, iH, yMin, yMax };
}

// Plot a data series (array of numbers) onto canvas with given geometry
function plotLine(ctx, data, color, geo, lw=1.8) {
  const {l, t, iW, iH, yMin, yMax} = geo;
  const n = data.length;
  if (!n) return;
  ctx.strokeStyle = color;
  ctx.lineWidth   = lw;
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = l + iW * i / (n - 1);
    const v = Math.max(yMin, Math.min(yMax, data[i]));
    const y = t + iH * (1 - (v - yMin) / (yMax - yMin));
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// Plot bar chart (for Bark bands)
function plotBars(ctx, data, color, geo, barFrac=0.4) {
  const {l, t, iW, iH, yMin, yMax} = geo;
  const n = data.length;
  if (!n) return;
  const bw = iW / n * barFrac;
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const cx = l + iW * (i + 0.5) / n;
    const v  = Math.max(yMin, Math.min(yMax, data[i]));
    const y0 = t + iH;
    const bh = iH * (v - yMin) / (yMax - yMin);
    ctx.fillRect(cx - bw / 2, y0 - bh, bw, bh);
  }
}

// ================================================================
//  Canvas setup
// ================================================================
window.addEventListener('load', () => {

const cvRaw   = $('cv-raw');
const cvClean = $('cv-clean');
const cvFft   = $('cv-fft');
const cvBark  = $('cv-bark');
const cvSnr   = $('cv-snr');

// We'll use logical sizes from CSS; init on first draw
let ctxRaw, ctxClean, ctxFft, ctxBark, ctxSnr;
function ensureCtx() {
  if (!ctxRaw) {
    ctxRaw   = cvRaw.getContext('2d');
    ctxClean = cvClean.getContext('2d');
    ctxFft   = cvFft.getContext('2d');
    ctxBark  = cvBark.getContext('2d');
    ctxSnr   = cvSnr.getContext('2d');
  }
}

// ================================================================
//  Rolling waveform buffer (keeps last N_WAVE frames = ~1s)
// ================================================================
const N_WAVE   = 20;   // 20 frames × 480 samples = 9600 samples ≈ 200ms
const FRAME_SZ = 480;

const waveRaw   = [];   // flat rolling array of int16
const waveClean = [];
const snrHistory = [];

function appendWave(dst, src) {
  for (const s of src) dst.push(s);
  // Keep only last N_WAVE frames
  const limit = N_WAVE * FRAME_SZ;
  if (dst.length > limit) dst.splice(0, dst.length - limit);
}

// Subsample array to at most maxPts points for canvas performance
function subsample(arr, maxPts) {
  if (arr.length <= maxPts) return arr;
  const step = arr.length / maxPts;
  const out = [];
  for (let i = 0; i < maxPts; i++) {
    out.push(arr[Math.round(i * step)]);
  }
  return out;
}

// ================================================================
//  Draw functions
// ================================================================
function drawWaveform(cv, ctx, data, color, yMin, yMax) {
  const W = cv.clientWidth, H = parseInt(cv.getAttribute('height'));
  cv.width  = W; cv.height = H;
  const pad = {l: 52, r: 10, t: 12, b: 24};
  const geo = drawGrid(ctx, W, H, pad, yMin, yMax, 4);
  const pts = subsample(data, 1200);
  plotLine(ctx, pts, color, geo, 1.5);
}

function drawFFT(fftRaw, fftClean) {
  if (!fftRaw || !fftRaw.freqs) return;
  const cv  = cvFft;
  const ctx = ctxFft;
  const W = cv.clientWidth, H = parseInt(cv.getAttribute('height'));
  cv.width = W; cv.height = H;
  const pad = {l: 46, r: 10, t: 10, b: 24};
  const geo = drawGrid(ctx, W, H, pad, -80, 0, 4);

  // x-axis: frequency labels
  ctx.fillStyle = C.text; ctx.font = '10px system-ui';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const freqs = fftRaw.freqs;
  const labelAt = [500, 1000, 2000, 4000, 8000, 12000, 16000, 20000];
  for (const f of labelAt) {
    const idx = freqs.findIndex(v => v >= f);
    if (idx < 0) continue;
    const x = geo.l + geo.iW * idx / (freqs.length - 1);
    ctx.fillText(f >= 1000 ? (f/1000)+'k' : f, x, geo.t + geo.iH + 4);
  }

  // subsample for performance
  const step = Math.max(1, Math.floor(freqs.length / 256));
  const sub = arr => arr.filter((_, i) => i % step === 0);

  plotLine(ctx, sub(fftRaw.magnitude_db),   C.raw,   geo, 1.5);
  plotLine(ctx, sub(fftClean.magnitude_db), C.clean, geo, 1.5);
}

function drawBark(barkRaw, barkClean) {
  if (!barkRaw || !barkRaw.length) return;
  const cv  = cvBark;
  const ctx = ctxBark;
  const W = cv.clientWidth, H = parseInt(cv.getAttribute('height'));
  cv.width = W; cv.height = H;
  const pad = {l: 46, r: 10, t: 10, b: 24};
  const geo = drawGrid(ctx, W, H, pad, -80, 20, 4);

  // x-axis band labels (abbreviated)
  const labels = ['100','300','500','700','900','1.1k','1.3k','1.5k','1.8k',
                  '2.2k','2.6k','3k','3.6k','4.4k','5.2k','6.2k','7.4k',
                  '8.8k','10k','12k','15k','18k'];
  ctx.fillStyle = C.text; ctx.font = '9px system-ui';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let i = 0; i < labels.length; i++) {
    const x = geo.l + geo.iW * (i + 0.5) / labels.length;
    ctx.fillText(labels[i], x, geo.t + geo.iH + 4);
  }

  // Draw raw as bars, clean as line on top
  plotBars(ctx, barkRaw,   C.bark_raw,   geo, 0.5);
  plotBars(ctx, barkClean, C.bark_clean, geo, 0.35);
  plotLine(ctx, barkClean, C.clean, geo, 2);
}

function drawSNR(history) {
  if (!history || !history.length) return;
  const cv  = cvSnr;
  const ctx = ctxSnr;
  const W = cv.clientWidth, H = parseInt(cv.getAttribute('height'));
  cv.width = W; cv.height = H;
  const pad = {l: 46, r: 10, t: 10, b: 24};
  const geo = drawGrid(ctx, W, H, pad, -20, 60, 4);

  // Fill area under line
  const n = history.length;
  const {l, t, iW, iH, yMin, yMax} = geo;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = l + iW * i / Math.max(n - 1, 1);
    const v = Math.max(yMin, Math.min(yMax, history[i]));
    const y = t + iH * (1 - (v - yMin) / (yMax - yMin));
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.lineTo(l + iW, t + iH); ctx.lineTo(l, t + iH); ctx.closePath();
  ctx.fillStyle = 'rgba(251,191,36,0.08)';
  ctx.fill();

  plotLine(ctx, history, C.snr, geo, 2);

  // 0 dB reference line
  const y0 = t + iH * (1 - (0 - yMin) / (yMax - yMin));
  ctx.strokeStyle = 'rgba(251,113,133,0.35)'; ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(l, y0); ctx.lineTo(l + iW, y0); ctx.stroke();
  ctx.setLineDash([]);
}

// ================================================================
//  WebSocket connection to server /browser endpoint
// ================================================================
const dot    = $('dot');
const status = $('status');
let   lastFrameTime = 0;
let   frameCount    = 0;
let   fpsTimer      = 0;
let   displayedFps  = 0;

function setStatus(state, text) {
  status.textContent = text;
  dot.className = 'dot ' + state;   // 'ok', 'bad', or ''
}

function connectWS() {
  const host = window.location.hostname || '127.0.0.1';
  const url  = `ws://${host}:8000/browser`;
  setStatus('', 'CONNECTING…');

  const ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus('ok', 'CONNECTED');
    console.log('[WS] connected to', url);
  };

  ws.onclose = () => {
    setStatus('bad', 'DISCONNECTED — retrying in 2s');
    setTimeout(connectWS, 2000);
  };

  ws.onerror = e => {
    console.error('[WS] error', e);
    setStatus('bad', 'ERROR');
  };

  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type !== 'frame_update') return;
    handleFrame(msg);
  };
}

// ================================================================
//  Handle incoming frame_update message
// ================================================================
function handleFrame(msg) {
  ensureCtx();

  // --- FPS counter ---
  frameCount++;
  const now = Date.now();
  if (now - fpsTimer >= 1000) {
    displayedFps = frameCount;
    frameCount   = 0;
    fpsTimer     = now;
    $('fps-pill').textContent = displayedFps + ' fps';
  }

  // --- Append to rolling waveform buffer ---
  if (msg.waveform) {
    appendWave(waveRaw,   msg.waveform.raw);
    appendWave(waveClean, msg.waveform.clean);
  }

  // --- SNR history ---
  if (msg.snr_history) {
    snrHistory.length = 0;
    snrHistory.push(...msg.snr_history);
  }

  // --- Peak ---
  let peak = 0;
  if (msg.waveform && msg.waveform.raw) {
    for (const s of msg.waveform.raw) {
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
  }

  // --- Latency ---
  const lat = msg.timestamp ? (Date.now() % 0x100000000) - msg.timestamp : null;

  // --- Update metric tiles ---
  $('m-peak').textContent = peak.toLocaleString();
  const snrEl = $('m-snr');
  snrEl.textContent = msg.snr_db !== undefined ? msg.snr_db.toFixed(1) : '—';
  snrEl.className = 'v ' + (msg.snr_db > 10 ? 'ok' : msg.snr_db > 0 ? 'warn' : 'bad');
  $('m-vad').textContent  = msg.vad_prob !== undefined
    ? (msg.vad_prob * 100).toFixed(0) + '%' : '—';
  $('m-seq').textContent  = msg.seq ?? '—';
  const dropEl = $('m-drop');
  dropEl.textContent  = msg.dropped_frames ?? 0;
  dropEl.className = 'v ' + (msg.dropped_frames > 0 ? 'bad' : 'ok');
  $('m-lat').textContent  = lat !== null ? Math.abs(lat) : '—';

  $('raw-peak-leg').textContent = 'peak: ' + peak.toLocaleString();

  // --- Draw waveforms ---
  drawWaveform(cvRaw,   ctxRaw,   waveRaw,   C.raw,   -32768, 32767);
  drawWaveform(cvClean, ctxClean, waveClean, C.clean, -32768, 32767);

  // --- Draw FFT ---
  if (msg.fft) drawFFT(msg.fft.raw, msg.fft.clean);

  // --- Draw Bark ---
  if (msg.bark_bands) drawBark(msg.bark_bands.raw, msg.bark_bands.clean);

  // --- Draw SNR history ---
  drawSNR(snrHistory);
}

// Start
connectWS();

}); // window load
</script>
</body>
</html>
"""

@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return HTMLResponse(content=DASHBOARD_HTML)

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "browser_clients": len(browser_clients),
        "last_seq": audio_buf.last_seq,
        "dropped_frames": audio_buf.dropped_frames,
    }

# ============================================================
#  Entry Point
# ============================================================
if __name__ == "__main__":
    import socket

    # dependency check
    print("=" * 55)
    print("  RNNoise Visualization Server")
    print("=" * 55)
    try:
        import fastapi, uvicorn, numpy, scipy
        print(f"[OK] fastapi  {fastapi.__version__}")
        print(f"[OK] uvicorn  {uvicorn.__version__}")
        print(f"[OK] numpy    {numpy.__version__}")
        print(f"[OK] scipy    {scipy.__version__}")
    except ImportError as e:
        print(f"[MISSING] {e}")
        print("Run: pip install fastapi uvicorn websockets numpy scipy")
        raise SystemExit(1)

    # show all local IPs
    print("-" * 55)
    hostname = socket.gethostname()
    print(f"Hostname : {hostname}")
    try:
        ips = socket.getaddrinfo(hostname, None)
        seen = set()
        for entry in ips:
            ip = entry[4][0]
            if ip not in seen and not ip.startswith("127.") and ":" not in ip:
                seen.add(ip)
                print(f"Local IP : {ip}  <- put this in wifi_config.h WS_SERVER_HOST")
    except Exception:
        pass
    print("-" * 55)
    print("Endpoints:")
    print("  Browser dashboard : http://localhost:8000")
    print("  Health check      : http://localhost:8000/health")
    print("  ESP32 WebSocket   : ws://0.0.0.0:8000/esp32")
    print("=" * 55)

    log.info("Starting uvicorn on 0.0.0.0:8000 ...")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
