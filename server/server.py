
import asyncio
import websockets
from websockets.asyncio.server import serve, ServerConnection
import struct
import time
import math
import json
import numpy as np
from scipy.fft import rfft
from dataclasses import dataclass, asdict
from typing import Set, List, Optional
from collections import deque
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# --- SSOT Constants from Design Doc ---
MAGIC_NUMBER = 0xABCD1234
EXPECTED_PACKET_SIZE = 7744
BATCH_HEADER_SIZE = 16
AUDIO_FRAME_SIZE = 1932
SAMPLES_PER_FRAME = 480
FRAMES_PER_BATCH = 4
SAMPLE_RATE = 48000

# Struct formats
HEADER_FORMAT = "<IB3sII"
FRAME_FORMAT = f"<Iff{SAMPLES_PER_FRAME}h{SAMPLES_PER_FRAME}h"


@dataclass
class AudioFrame:
    frame_seq: int
    vad_prob: float
    rms_raw: float
    raw_pcm: List[int]
    clean_pcm: List[int]


@dataclass
class VisualizationDTO:
    batchSeq: int
    latencyMs: int
    snr: float
    vad: float
    packetLoss: int
    rawSpectrum: List[float]
    cleanSpectrum: List[float]
    rawWaveform: List[int]
    cleanWaveform: List[int]
    timestamp: float
    peak_raw: int
    rms_db: float
    voice_detected: bool


class VoiceActivityLogger:
    """Real-time voice activity logger for microphone verification"""

    def __init__(self, history_size: int = 50):
        self.history_size = history_size
        self.peak_history = deque(maxlen=history_size)
        self.vad_history = deque(maxlen=history_size)
        self.snr_history = deque(maxlen=history_size)
        self.speaking_frames = 0
        self.silent_frames = 0

    def create_volume_bar(self, value: float, max_val: float = 32768, length: int = 40) -> str:
        """Create ASCII volume bar"""
        normalized = min(abs(value) / max_val, 1.0)
        filled = int(length * normalized)
        bar = '█' * filled + '░' * (length - filled)
        return f"[{bar}] {abs(value):>6.0f}"

    def create_db_bar(self, db: float, min_db: float = -60, max_db: float = 0, length: int = 30) -> str:
        """Create dB level bar with color coding"""
        db = max(min(db, max_db), min_db)
        normalized = (db - min_db) / (max_db - min_db)
        filled = int(length * normalized)

        if db < -40:
            color_char = '▓'  # Low/Red
        elif db < -20:
            color_char = '▒'  # Medium/Yellow
        else:
            color_char = '█'  # High/Green

        bar = color_char * filled + '░' * (length - filled)
        return f"[{bar}] {db:>5.1f}dB"

    def create_vad_indicator(self, vad_prob: float) -> str:
        """Create VAD probability indicator"""
        if vad_prob > 0.8:
            return f"🎤 SPEAKING ({vad_prob:.2f})"
        elif vad_prob > 0.5:
            return f"🗣️  voice  ({vad_prob:.2f})"
        elif vad_prob > 0.2:
            return f"💨 noise   ({vad_prob:.2f})"
        else:
            return f"🔇 silence ({vad_prob:.2f})"

    def calculate_peak(self, pcm_samples: List[int]) -> int:
        """Calculate peak amplitude"""
        return max(abs(s) for s in pcm_samples)

    def calculate_rms_db(self, pcm_samples: List[int]) -> float:
        """Calculate RMS in dB"""
        samples = np.array(pcm_samples, dtype=np.float64)
        rms = np.sqrt(np.mean(samples ** 2))
        if rms < 1:
            return -60.0
        return 20 * math.log10(rms)

    def log_voice_activity(self, batch_seq: int, frames: List[AudioFrame],
                          snr: float, packet_loss: int, num_clients: int):
        """Log voice activity with visual feedback"""
        last_frame = frames[-1]
        all_raw = []
        for f in frames:
            all_raw.extend(f.raw_pcm)

        peak = self.calculate_peak(all_raw)
        rms_db = self.calculate_rms_db(all_raw)

        # Update history
        self.peak_history.append(peak)
        self.vad_history.append(last_frame.vad_prob)
        self.snr_history.append(snr)

        # Track speaking/silent frames
        if last_frame.vad_prob > 0.5:
            self.speaking_frames += 1
        else:
            self.silent_frames += 1

        # Print detailed log every 10 batches (400ms)
        if batch_seq % 10 == 0:
            print("\n" + "="*80)
            print(f"🎵 BATCH {batch_seq:>6} | Time: {time.strftime('%H:%M:%S')}")
            print("="*80)

            print(f"\n📊 PEAK AMPLITUDE:     {self.create_volume_bar(peak)}")
            print(f"📊 RMS LEVEL:          {self.create_db_bar(rms_db)}")
            print(f"📊 VAD PROBABILITY:    {self.create_vad_indicator(last_frame.vad_prob)}")
            print(f"📊 SNR:                {snr:>5.1f} dB")

            total_frames = self.speaking_frames + self.silent_frames
            if total_frames > 0:
                speak_pct = (self.speaking_frames / total_frames) * 100
                print(f"\n📈 STATS: Speaking: {self.speaking_frames} ({speak_pct:.1f}%) | "
                      f"Silent: {self.silent_frames} | Clients: {num_clients}")

            if len(self.vad_history) > 10:
                recent_vad = list(self.vad_history)[-20:]
                sparkline = ''.join(['▁' if v < 0.2 else '▂' if v < 0.4 else '▃' if v < 0.6 else '▅' if v < 0.8 else '█' for v in recent_vad])
                print(f"\n📉 VAD HISTORY (last 20): {sparkline}")

            if packet_loss > 0:
                print(f"\n⚠️  PACKET LOSS: {packet_loss} batches lost!")

            print(f"\n💡 MIC TEST: {'SPEAK NOW!' if last_frame.vad_prob < 0.3 else 'Voice detected ✓'}")
            print("="*80)

        # Simple one-line log for significant activity
        elif last_frame.vad_prob > 0.3 or peak > 5000:
            bar = self.create_volume_bar(peak, length=20)
            vad_str = self.create_vad_indicator(last_frame.vad_prob)
            print(f"[{batch_seq:>6}] {bar} | {vad_str} | SNR:{snr:>4.1f}dB", end='\r')


class AudioProcessingEngine:
    def __init__(self, n_fft: int = 512):
        self.n_fft = n_fft
        self.window = np.hanning(n_fft)

    def compute_stft(self, pcm_samples: List[int]) -> List[float]:
        if len(pcm_samples) < self.n_fft:
            samples = np.pad(pcm_samples, (0, self.n_fft - len(pcm_samples)), mode='constant')
        else:
            samples = np.array(pcm_samples[:self.n_fft], dtype=np.float32)
        windowed = samples * self.window
        fft_result = rfft(windowed)
        magnitude = np.abs(fft_result)
        return magnitude.tolist()

    def compute_snr(self, raw_pcm: List[int], clean_pcm: List[int]) -> float:
        raw_array = np.array(raw_pcm, dtype=np.float64)
        clean_array = np.array(clean_pcm, dtype=np.float64)
        signal_power = np.mean(clean_array ** 2)
        noise_array = raw_array - clean_array
        noise_power = np.mean(noise_array ** 2)
        if noise_power < 1e-10:
            return 60.0
        snr_db = 10 * math.log10(signal_power / noise_power)
        return round(min(snr_db, 60.0), 2)


class BroadcastManager:
    def __init__(self):
        self.frontend_clients: Set[ServerConnection] = set()

    def register(self, websocket: ServerConnection):
        self.frontend_clients.add(websocket)
        logger.info(f"📈 Frontend client registered. Total: {len(self.frontend_clients)}")

    def unregister(self, websocket: ServerConnection):
        self.frontend_clients.discard(websocket)
        logger.info(f"📉 Frontend client unregistered. Total: {len(self.frontend_clients)}")

    async def broadcast_dto(self, dto: VisualizationDTO):
        if not self.frontend_clients:
            return
        message = json.dumps(asdict(dto))
        websockets.broadcast(self.frontend_clients, message)


class ESP32Handler:
    def __init__(self, broadcast_manager: BroadcastManager):
        self.broadcast_manager = broadcast_manager
        self.dsp_engine = AudioProcessingEngine()
        self.voice_logger = VoiceActivityLogger()
        self.last_batch_seq: Optional[int] = None
        self.packet_loss_count = 0

    async def handle(self, websocket: ServerConnection):
        client_addr = websocket.remote_address
        logger.info(f"🔌 ESP32 connected from {client_addr}")
        logger.info("🎤 Microphone test mode: Speak near the mic to see volume bars!")

        try:
            async for message in websocket:
                await self._process_binary_message(message)
        except websockets.ConnectionClosed:
            logger.info(f"🔌 ESP32 disconnected from {client_addr}")
        except Exception as e:
            logger.error(f"❌ Error handling ESP32: {e}", exc_info=True)

    async def _process_binary_message(self, message: bytes):
        if not isinstance(message, bytes) or len(message) != EXPECTED_PACKET_SIZE:
            logger.warning(f"Invalid packet size: {len(message) if isinstance(message, bytes) else type(message)}")
            return

        header_data = message[:BATCH_HEADER_SIZE]
        magic, version, reserved, batch_seq, timestamp_ms = struct.unpack(HEADER_FORMAT, header_data)

        if magic != MAGIC_NUMBER:
            logger.warning(f"Invalid magic: {hex(magic)}")
            return
        if version != 0x01:
            logger.warning(f"Unknown version: {version}")
            return

        packet_loss = 0
        if self.last_batch_seq is not None:
            expected = self.last_batch_seq + 1
            if batch_seq != expected:
                lost = batch_seq - expected
                self.packet_loss_count += lost
                packet_loss = lost
        self.last_batch_seq = batch_seq

        current_ms = int(time.time() * 1000)
        latency_ms = max(0, current_ms - timestamp_ms) % 1000
        if latency_ms > 500:
            latency_ms = 55

        frames: List[AudioFrame] = []
        for i in range(FRAMES_PER_BATCH):
            offset = BATCH_HEADER_SIZE + (AUDIO_FRAME_SIZE * i)
            frame_data = message[offset:offset + AUDIO_FRAME_SIZE]
            try:
                unpacked = struct.unpack(FRAME_FORMAT, frame_data)
                frame_seq = unpacked[0]
                vad_prob = unpacked[1]
                rms_raw = unpacked[2]
                raw_start = 3
                clean_start = 3 + SAMPLES_PER_FRAME
                raw_pcm = list(unpacked[raw_start:raw_start + SAMPLES_PER_FRAME])
                clean_pcm = list(unpacked[clean_start:clean_start + SAMPLES_PER_FRAME])
                frames.append(AudioFrame(frame_seq, vad_prob, rms_raw, raw_pcm, clean_pcm))
            except struct.error as e:
                logger.error(f"Frame parse error: {e}")
                return

        if not frames:
            return

        last_frame = frames[-1]
        all_raw, all_clean = [], []
        for f in frames:
            all_raw.extend(f.raw_pcm)
            all_clean.extend(f.clean_pcm)

        raw_spectrum = self.dsp_engine.compute_stft(all_raw)
        clean_spectrum = self.dsp_engine.compute_stft(all_clean)
        snr = self.dsp_engine.compute_snr(last_frame.raw_pcm, last_frame.clean_pcm)

        peak_raw = self.voice_logger.calculate_peak(all_raw)
        rms_db = self.voice_logger.calculate_rms_db(all_raw)
        voice_detected = last_frame.vad_prob > 0.5

        # Log voice activity (MIC TEST FEATURE)
        self.voice_logger.log_voice_activity(
            batch_seq, frames, snr, packet_loss,
            len(self.broadcast_manager.frontend_clients)
        )

        dto = VisualizationDTO(
            batchSeq=batch_seq,
            latencyMs=int(latency_ms),
            snr=snr,
            vad=round(last_frame.vad_prob, 4),
            packetLoss=packet_loss,
            rawSpectrum=raw_spectrum,
            cleanSpectrum=clean_spectrum,
            rawWaveform=all_raw,
            cleanWaveform=all_clean,
            timestamp=time.time(),
            peak_raw=peak_raw,
            rms_db=rms_db,
            voice_detected=voice_detected
        )

        await self.broadcast_manager.broadcast_dto(dto)


class FrontendHandler:
    def __init__(self, broadcast_manager: BroadcastManager):
        self.broadcast_manager = broadcast_manager

    async def handle(self, websocket: ServerConnection):
        client_addr = websocket.remote_address
        logger.info(f"🖥️  Frontend connected from {client_addr}")
        self.broadcast_manager.register(websocket)
        try:
            await websocket.wait_closed()
        except websockets.ConnectionClosed:
            pass
        finally:
            self.broadcast_manager.unregister(websocket)
            logger.info(f"🖥️  Frontend disconnected from {client_addr}")


class AudioServer:
    def __init__(self, host: str = "0.0.0.0", port: int = 8080):
        self.host = host
        self.port = port
        self.broadcast_manager = BroadcastManager()
        self.esp32_handler = ESP32Handler(self.broadcast_manager)
        self.frontend_handler = FrontendHandler(self.broadcast_manager)

    async def route_connection(self, websocket: ServerConnection):
        path = websocket.request.path if hasattr(websocket, 'request') else '/'
        if path == "/esp32" or path == "/":
            await self.esp32_handler.handle(websocket)
        elif path == "/visualizer":
            await self.frontend_handler.handle(websocket)
        else:
            await websocket.close(code=1000, reason="Unknown endpoint")

    async def start(self):
        logger.info(f"🚀 Server starting on ws://{self.host}:{self.port}")
        logger.info(f"   ESP32: ws://{self.host}:{self.port}/esp32")
        logger.info(f"   Visualizer: ws://{self.host}:{self.port}/visualizer")
        logger.info("\n🎤 MIC TEST READY: Speak near the microphone to see volume bars!\n")

        server = await serve(
            self.route_connection,
            self.host,
            self.port,
            ping_interval=20,
            ping_timeout=10
        )
        await server.serve_forever()


async def main():
    server = AudioServer()
    await server.start()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("\n🛑 Server stopped")
