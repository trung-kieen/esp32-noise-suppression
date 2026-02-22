"""
Real-Time Noise Suppression — Python WebSocket Server
Receives binary PCM frames from ESP32, computes STFT, broadcasts to browser.

Binary frame format (must match firmware):
  [0]      magic    = 0xAA
  [1]      type     = 0x01
  [2..3]   vad_prob as uint16 (0..10000)
  [4..963] raw PCM  int16 × 480 samples

Run:
    pip install -r requirements.txt
    python server.py
Then open: http://localhost:8765
"""

import json
import logging
import time
from collections import deque
from typing import Set

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
import uvicorn

# ──────────────────────────────────────────────
#  Logging — verbose, coloured by level
# ──────────────────────────────────────────────
logging.basicConfig(
    level=logging.DEBUG,                          # show everything
    format="%(asctime)s [%(levelname)-8s] %(message)s",
    datefmt="%H:%M:%S"
)
# Silence noisy third-party loggers
logging.getLogger("uvicorn.error").setLevel(logging.WARNING)
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
logging.getLogger("websockets").setLevel(logging.WARNING)
logging.getLogger("asyncio").setLevel(logging.WARNING)

log = logging.getLogger("server")

# ──────────────────────────────────────────────
#  Audio config (must match firmware)
# ──────────────────────────────────────────────
SAMPLE_RATE       = 48000
FRAME_SAMPLES     = 480
FRAME_MAGIC       = 0xAA
FRAME_TYPE_AUDIO  = 0x01
HEADER_SIZE       = 4
BINARY_FRAME_SIZE = HEADER_SIZE + FRAME_SAMPLES * 2   # 964 bytes

# STFT
STFT_NFFT      = 256
STFT_HOP       = 128
STFT_WINDOW    = np.hanning(STFT_NFFT)
HISTORY_FRAMES = 50    # rolling PCM window (~500ms)

# Bark band edges Hz — 22 bands matching RNNoise
BARK_EDGES_HZ = [
    0, 200, 400, 600, 800, 1000, 1200, 1400,
    1600, 2000, 2400, 2800, 3200, 4000, 4800,
    5600, 6800, 8000, 9600, 12000, 15600, 20000
]

# ──────────────────────────────────────────────
#  Server state
# ──────────────────────────────────────────────
class State:
    def __init__(self):
        self.browser_clients: Set[WebSocket] = set()
        self.esp32_config: dict = {}
        self.connect_time: float = 0.0
        self.pcm_history  = deque(maxlen=HISTORY_FRAMES)
        self.snr_history  = deque(maxlen=100)
        self.vad_history  = deque(maxlen=100)
        self.frames_rx    = 0
        self.frames_tx    = 0
        # DSP timing stats
        self.dsp_times: deque = deque(maxlen=100)

state = State()

# ──────────────────────────────────────────────
#  DSP
# ──────────────────────────────────────────────

def compute_stft_db(pcm_concat: np.ndarray) -> list:
    frames = []
    pos = 0
    while pos + STFT_NFFT <= len(pcm_concat):
        chunk    = pcm_concat[pos:pos + STFT_NFFT].astype(np.float32) * STFT_WINDOW
        spec_db  = 10 * np.log10(np.abs(np.fft.rfft(chunk)) ** 2 + 1e-10)
        frames.append(spec_db.tolist())
        pos += STFT_HOP
    if not frames:
        return []
    return np.array(frames).T.tolist()   # (n_freqs, n_time_frames)


def compute_bark_bands(pcm: np.ndarray) -> list:
    spectrum = np.abs(np.fft.rfft(pcm.astype(np.float32), n=FRAME_SAMPLES)) ** 2
    freqs    = np.fft.rfftfreq(FRAME_SAMPLES, d=1.0 / SAMPLE_RATE)
    bands    = []
    for i in range(len(BARK_EDGES_HZ) - 1):
        lo, hi = BARK_EDGES_HZ[i], BARK_EDGES_HZ[i + 1]
        mask   = (freqs >= lo) & (freqs < hi)
        energy = float(np.sum(spectrum[mask]))
        bands.append(round(10 * np.log10(energy + 1e-10), 2))
    return bands


def compute_snr(pcm: np.ndarray) -> float:
    rms         = float(np.sqrt(np.mean(pcm.astype(np.float64) ** 2)))
    sorted_abs  = np.sort(np.abs(pcm.astype(np.float64)))
    noise_floor = float(np.mean(sorted_abs[:max(1, len(sorted_abs) // 5)])) + 1e-10
    return round(20 * np.log10(rms / noise_floor + 1e-10), 2)


def parse_binary_frame(data: bytes):
    if len(data) != BINARY_FRAME_SIZE:
        raise ValueError(f"Bad size {len(data)} != {BINARY_FRAME_SIZE}")
    if data[0] != FRAME_MAGIC:
        raise ValueError(f"Bad magic 0x{data[0]:02X}")
    if data[1] != FRAME_TYPE_AUDIO:
        raise ValueError(f"Bad type 0x{data[1]:02X}")
    vad_prob = ((data[2] << 8) | data[3]) / 10000.0
    pcm      = np.frombuffer(data[HEADER_SIZE:], dtype=np.int16).copy()
    return pcm, vad_prob


def process_frame(pcm: np.ndarray, vad_prob: float) -> dict:
    t0 = time.perf_counter()

    state.pcm_history.append(pcm)
    bark = compute_bark_bands(pcm)
    snr  = compute_snr(pcm)
    state.snr_history.append(snr)
    state.vad_history.append(round(vad_prob, 3))

    if len(state.pcm_history) >= 4:
        concat  = np.concatenate(list(state.pcm_history))
        stft_db = compute_stft_db(concat)
    else:
        stft_db = []

    dsp_ms = (time.perf_counter() - t0) * 1000
    state.dsp_times.append(dsp_ms)

    return {
        "type":        "frame_update",
        "waveform":    pcm[::2].tolist(),          # 480 → 240 points
        "stft_db":     stft_db,                    # (n_freqs, n_frames)
        "bark_bands":  bark,                       # 22 values in dB
        "snr_db":      snr,
        "snr_history": list(state.snr_history),
        "vad_prob":    round(vad_prob, 3),
        "vad_history": list(state.vad_history),
        "dsp_ms":      round(dsp_ms, 2),
        "stats": {
            "frames_rx":  state.frames_rx,
            "frames_tx":  state.frames_tx,
            "uptime_s":   round(time.time() - state.connect_time, 1),
            "browsers":   len(state.browser_clients),
        }
    }

# ──────────────────────────────────────────────
#  FastAPI app
# ──────────────────────────────────────────────
app = FastAPI(title="RNNoise Server")


async def broadcast(payload: dict):
    if not state.browser_clients:
        return
    msg  = json.dumps(payload)
    dead = set()
    for ws in state.browser_clients:
        try:
            await ws.send_text(msg)
            state.frames_tx += 1
        except Exception as e:
            log.warning(f"[Broadcast] Failed to send to browser: {e}")
            dead.add(ws)
    for ws in dead:
        state.browser_clients.discard(ws)
        log.info(f"[Broadcast] Removed dead browser client | "
                 f"remaining={len(state.browser_clients)}")


# ── ESP32 WebSocket endpoint ──────────────────
@app.websocket("/ws/esp32")
async def ws_esp32(websocket: WebSocket):
    await websocket.accept()
    state.connect_time = time.time()
    state.frames_rx    = 0
    ip = websocket.client.host
    log.info(f"[ESP32] ✓ Connected from {ip}")
    log.debug(f"[ESP32] Waiting for handshake...")

    try:
        while True:
            try:
                msg = await websocket.receive()
            except RuntimeError as e:
                log.info(f"[ESP32] Socket closed ({e})")
                break

            if msg.get("type") == "websocket.disconnect":
                log.info(f"[ESP32] Clean disconnect after {state.frames_rx} frames")
                break

            # ── Handshake (text) ─────────────────
            if "text" in msg and msg["text"]:
                try:
                    data  = json.loads(msg["text"])
                    mtype = data.get("type")
                    if mtype == "handshake":
                        state.esp32_config = data
                        log.info(f"[ESP32] Handshake received:")
                        log.info(f"[ESP32]   sample_rate = {data.get('sample_rate')}")
                        log.info(f"[ESP32]   frame_size  = {data.get('frame_size')}")
                        log.info(f"[ESP32]   encoding    = {data.get('encoding')}")
                        log.info(f"[ESP32]   ai_model    = {data.get('ai_model')}")
                        ack = json.dumps({"type": "ack", "status": "ok"})
                        await websocket.send_text(ack)
                        log.info(f"[ESP32] ACK sent — ready to receive audio frames")

                        # notify browsers that ESP32 is connected
                        await broadcast({
                            "type": "esp32_config",
                            **data
                        })
                    else:
                        log.warning(f"[ESP32] Unknown text msg type: '{mtype}'")
                except json.JSONDecodeError as e:
                    log.warning(f"[ESP32] Bad JSON: {e} | raw={msg['text'][:80]}")
                except Exception as e:
                    log.error(f"[ESP32] Text handler error: {e}")

            # ── Audio frame (binary) ─────────────
            elif "bytes" in msg and msg["bytes"]:
                raw_bytes = msg["bytes"]
                state.frames_rx += 1

                # Log first frame in detail
                if state.frames_rx == 1:
                    log.info(f"[ESP32] 🎙 First audio frame received! size={len(raw_bytes)}B")
                    log.debug(f"[ESP32] Header bytes: "
                              f"0x{raw_bytes[0]:02X} 0x{raw_bytes[1]:02X} "
                              f"0x{raw_bytes[2]:02X} 0x{raw_bytes[3]:02X}")

                try:
                    pcm, vad  = parse_binary_frame(raw_bytes)
                    payload   = process_frame(pcm, vad)
                    await broadcast(payload)

                    # Log first successful DSP
                    if state.frames_rx == 1:
                        log.info(f"[ESP32] ✓ First DSP OK | "
                                 f"pcm_range=[{pcm.min()}, {pcm.max()}] | "
                                 f"snr={payload['snr_db']} dB | "
                                 f"dsp={payload['dsp_ms']} ms | "
                                 f"stft_shape=({len(payload['stft_db'])},"
                                 f"{len(payload['stft_db'][0]) if payload['stft_db'] else 0})")

                except ValueError as e:
                    log.warning(f"[ESP32] Frame #{state.frames_rx} parse error: {e}")
                except Exception as e:
                    log.error(f"[ESP32] DSP error on frame #{state.frames_rx}: "
                              f"{type(e).__name__}: {e}")

                # Periodic stats log — every 100 frames (~1 second)
                if state.frames_rx % 100 == 0:
                    elapsed  = time.time() - state.connect_time
                    fps      = state.frames_rx / elapsed if elapsed > 0 else 0
                    avg_dsp  = (sum(state.dsp_times) / len(state.dsp_times)
                                if state.dsp_times else 0)
                    log.info(
                        f"[ESP32] ── {state.frames_rx} frames ── "
                        f"fps={fps:.1f} | "
                        f"browsers={len(state.browser_clients)} | "
                        f"tx={state.frames_tx} | "
                        f"dsp_avg={avg_dsp:.1f}ms | "
                        f"uptime={elapsed:.0f}s"
                    )

            elif msg.get("type") not in ("websocket.connect", "websocket.disconnect"):
                log.debug(f"[ESP32] Unhandled msg keys: {list(msg.keys())}")

    except WebSocketDisconnect:
        elapsed = time.time() - state.connect_time
        log.info(f"[ESP32] ✗ Disconnected | frames={state.frames_rx} | "
                 f"uptime={elapsed:.1f}s")
    except Exception as e:
        log.warning(f"[ESP32] Connection lost: {type(e).__name__}: {e}")
    finally:
        log.info(f"[ESP32] Session summary: rx={state.frames_rx} tx={state.frames_tx}")


# ── Browser WebSocket endpoint ────────────────
@app.websocket("/ws/browser")
async def ws_browser(websocket: WebSocket):
    await websocket.accept()
    state.browser_clients.add(websocket)
    ip = websocket.client.host
    log.info(f"[Browser] ✓ Connected from {ip} | "
             f"total_clients={len(state.browser_clients)}")

    # Push ESP32 config immediately if already connected
    if state.esp32_config:
        await websocket.send_text(json.dumps({
            "type": "esp32_config",
            **state.esp32_config
        }))
        log.debug(f"[Browser] Sent cached ESP32 config to new client")

    try:
        async for msg in websocket.iter_text():
            log.debug(f"[Browser] Received from browser: {msg[:80]}")
    except WebSocketDisconnect:
        log.info(f"[Browser] ✗ Disconnected from {ip}")
    except Exception as e:
        log.warning(f"[Browser] Error: {type(e).__name__}: {e}")
    finally:
        state.browser_clients.discard(websocket)
        log.info(f"[Browser] Removed | remaining={len(state.browser_clients)}")


# ── Dashboard HTML ────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def root():
    log.debug("[HTTP] Dashboard requested")
    with open("dashboard.html") as f:
        return f.read()


# ──────────────────────────────────────────────
#  Entry point
# ──────────────────────────────────────────────
if __name__ == "__main__":
    log.info("=" * 52)
    log.info("  RNNoise Visualization Server — starting")
    log.info(f"  ESP32  WS → ws://0.0.0.0:8765/ws/esp32")
    log.info(f"  Browser   → http://localhost:8765")
    log.info(f"  Frame     : {BINARY_FRAME_SIZE} bytes binary")
    log.info(f"  STFT      : nfft={STFT_NFFT} hop={STFT_HOP} "
             f"history={HISTORY_FRAMES} frames")
    log.info(f"  Bark      : {len(BARK_EDGES_HZ)-1} bands")
    log.info("=" * 52)

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8765,
        log_level="warning",          # uvicorn's own logs stay quiet
        ws_ping_interval=None,        # disable pings — ESP32 can't respond at 100fps
        ws_ping_timeout=None,
    )
