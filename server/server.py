import asyncio
import websockets
from websockets.asyncio.server import serve, ServerConnection
import struct
import time
import math
import json
import numpy as np
from scipy.fft import rfft
from dataclasses import dataclass, asdict, field
from typing import Set, List, Optional, Dict, Any
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
FFT_SIZE = 512
HOP_LENGTH = 256

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


# ============================================================================
# DTO VERSIONS (Backward Compatible)
# ============================================================================

@dataclass
class VisualizationDTO:
    """
    LEGACY DTO - v1.0 API (maintained for backward compatibility)
    Used by: /visualizer?version=legacy or /visualizer-legacy
    """
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


@dataclass
class WaveformData:
    """Waveform container for new DTO"""
    raw: List[int] = field(default_factory=list)
    clean: List[int] = field(default_factory=list)
    sampleRate: int = SAMPLE_RATE
    durationMs: int = 40


@dataclass
class SpectrumData:
    """Spectrum container for new DTO"""
    raw: List[float] = field(default_factory=list)
    clean: List[float] = field(default_factory=list)
    frequencies: List[float] = field(default_factory=list)
    fftSize: int = FFT_SIZE
    hopLength: int = HOP_LENGTH


@dataclass
class BarkBandsData:
    """Bark psychoacoustic bands"""
    raw: List[float] = field(default_factory=list)
    clean: List[float] = field(default_factory=list)
    bandEdges: List[float] = field(default_factory=list)


@dataclass
class SystemMetrics:
    """System-level metrics"""
    frameSeq: int = 0
    serverProcessingMs: float = 0.0
    queueDepth: int = 4  # Fixed by design


@dataclass
class VisualizationDTOv2:
    """
    ENHANCED DTO - v2.0 API (new comprehensive format)
    Used by: /visualizer (default) or /visualizer?version=2

    Includes all legacy fields plus:
    - Structured waveform/spectrum objects
    - Bark band energies (psychoacoustic)
    - RMS aggregate (from frame headers)
    - Connection status
    - Total cumulative packet loss
    - Detailed system metrics
    """
    # Core identifiers
    batchSeq: int
    timestampMs: int  # From ESP32 (ms since boot)

    # Performance metrics
    latencyMs: int
    snr: float
    vad: float
    rmsRaw: float  # Aggregate from frame headers
    packetLoss: int  # Per-batch loss
    totalPacketLoss: int  # Cumulative
    connectionStatus: str = "online"

    # Structured data containers
    waveform: WaveformData = field(default_factory=WaveformData)
    spectrum: SpectrumData = field(default_factory=SpectrumData)
    barkBands: BarkBandsData = field(default_factory=BarkBandsData)

    # System metrics
    system: SystemMetrics = field(default_factory=SystemMetrics)

    # Legacy compatibility fields (flattened for easy access)
    timestamp: float = field(default=0.0)  # Server Unix timestamp
    peak_raw: int = field(default=0)
    rms_db: float = field(default=0.0)
    voice_detected: bool = field(default=False)
    rawSpectrum: List[float] = field(default_factory=list)  # Alias for spectrum.raw
    cleanSpectrum: List[float] = field(default_factory=list)  # Alias for spectrum.clean
    rawWaveform: List[int] = field(default_factory=list)  # Alias for waveform.raw
    cleanWaveform: List[int] = field(default_factory=list)  # Alias for waveform.clean

    def to_legacy_dict(self) -> Dict[str, Any]:
        """Convert to legacy flat format for old clients"""
        return {
            "batchSeq": self.batchSeq,
            "latencyMs": self.latencyMs,
            "snr": self.snr,
            "vad": self.vad,
            "packetLoss": self.packetLoss,
            "rawSpectrum": self.rawSpectrum or self.spectrum.raw,
            "cleanSpectrum": self.cleanSpectrum or self.spectrum.clean,
            "rawWaveform": self.rawWaveform or self.waveform.raw,
            "cleanWaveform": self.cleanWaveform or self.waveform.clean,
            "timestamp": self.timestamp,
            "peak_raw": self.peak_raw,
            "rms_db": self.rms_db,
            "voice_detected": self.voice_detected,
        }

    def to_v2_dict(self) -> Dict[str, Any]:
        """Convert to new nested format"""
        return {
            "batchSeq": self.batchSeq,
            "timestampMs": self.timestampMs,
            "latencyMs": self.latencyMs,
            "snr": self.snr,
            "vad": self.vad,
            "rmsRaw": self.rmsRaw,
            "packetLoss": self.packetLoss,
            "totalPacketLoss": self.totalPacketLoss,
            "connectionStatus": self.connectionStatus,
            "waveform": {
                "raw": self.waveform.raw,
                "clean": self.waveform.clean,
                "sampleRate": self.waveform.sampleRate,
                "durationMs": self.waveform.durationMs
            },
            "spectrum": {
                "raw": self.spectrum.raw,
                "clean": self.spectrum.clean,
                "frequencies": self.spectrum.frequencies,
                "fftSize": self.spectrum.fftSize,
                "hopLength": self.spectrum.hopLength
            },
            "barkBands": {
                "raw": self.barkBands.raw,
                "clean": self.barkBands.clean,
                "bandEdges": self.barkBands.bandEdges
            },
            "system": {
                "frameSeq": self.system.frameSeq,
                "serverProcessingMs": self.system.serverProcessingMs,
                "queueDepth": self.system.queueDepth
            },
            # Include legacy aliases for mixed clients
            "timestamp": self.timestamp,
            "peak_raw": self.peak_raw,
            "rms_db": self.rms_db,
            "voice_detected": self.voice_detected,
        }


# ============================================================================
# VOICE ACTIVITY LOGGER (Unchanged)
# ============================================================================

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


# ============================================================================
# ENHANCED AUDIO PROCESSING ENGINE
# ============================================================================

class AudioProcessingEngine:
    def __init__(self, n_fft: int = FFT_SIZE, hop_length: int = HOP_LENGTH):
        self.n_fft = n_fft
        self.hop_length = hop_length
        self.window = np.hanning(n_fft)

        # Bark scale band edges (24 bands, 0-24 Bark ≈ 0-15500 Hz @ 48kHz)
        # Pre-computed for 48kHz sample rate
        self.bark_edges = np.array([
            20, 100, 200, 300, 400, 510, 630, 770, 920, 1080,
            1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700,
            4400, 5300, 6400, 7700, 9500, 12000, 15500
        ])
        self.n_bands = len(self.bark_edges) - 1

    def compute_stft(self, pcm_samples: List[int]) -> np.ndarray:
        """Compute STFT magnitude spectrum"""
        if len(pcm_samples) < self.n_fft:
            samples = np.pad(pcm_samples, (0, self.n_fft - len(pcm_samples)), mode='constant')
        else:
            # Use last n_fft samples for real-time display
            samples = np.array(pcm_samples[-self.n_fft:], dtype=np.float32)
        windowed = samples * self.window
        fft_result = rfft(windowed)
        magnitude = np.abs(fft_result)
        return magnitude

    def compute_stft_with_freqs(self, pcm_samples: List[int]) -> tuple:
        """Compute STFT and return with frequency bins"""
        magnitude = self.compute_stft(pcm_samples)
        freqs = np.fft.rfftfreq(self.n_fft, 1.0 / SAMPLE_RATE)
        return magnitude, freqs

    def compute_bark_energies(self, spectrum: np.ndarray, freqs: np.ndarray) -> np.ndarray:
        """Calculate energy in Bark frequency bands"""
        magnitude_sq = spectrum ** 2
        energies = np.zeros(self.n_bands)

        for i in range(self.n_bands):
            mask = (freqs >= self.bark_edges[i]) & (freqs < self.bark_edges[i + 1])
            if np.any(mask):
                energies[i] = np.sum(magnitude_sq[mask])

        return energies

    def compute_snr(self, raw_pcm: List[int], clean_pcm: List[int]) -> float:
        """Calculate SNR in dB"""
        raw_array = np.array(raw_pcm, dtype=np.float64)
        clean_array = np.array(clean_pcm, dtype=np.float64)
        signal_power = np.mean(clean_array ** 2)
        noise_array = raw_array - clean_array
        noise_power = np.mean(noise_array ** 2)
        if noise_power < 1e-10:
            return 60.0
        snr_db = 10 * math.log10(signal_power / noise_power)
        return round(min(snr_db, 60.0), 2)


# ============================================================================
# BROADCAST MANAGER (Enhanced with version support)
# ============================================================================

class BroadcastManager:
    def __init__(self):
        self.frontend_clients: Set[ServerConnection] = set()
        self.client_versions: Dict[ServerConnection, str] = {}  # Track API version per client

    def register(self, websocket: ServerConnection, version: str = "2"):
        """Register client with API version preference"""
        self.frontend_clients.add(websocket)
        self.client_versions[websocket] = version
        logger.info(f"📈 Frontend client registered (API v{version}). Total: {len(self.frontend_clients)}")

    def unregister(self, websocket: ServerConnection):
        self.frontend_clients.discard(websocket)
        self.client_versions.pop(websocket, None)
        logger.info(f"📉 Frontend client unregistered. Total: {len(self.frontend_clients)}")

    def broadcast_dto(self, dto_v2: VisualizationDTOv2):
        """Broadcast to all clients with version-appropriate formatting"""
        if not self.frontend_clients:
            return

        # Prepare both message formats
        legacy_msg = json.dumps(dto_v2.to_legacy_dict())
        v2_msg = json.dumps(dto_v2.to_v2_dict())

        # Send appropriate version to each client
        for client in self.frontend_clients:
            version = self.client_versions.get(client, "2")
            try:
                if version == "legacy" or version == "1":
                    websockets.broadcast({client}, legacy_msg)
                else:
                    websockets.broadcast({client}, v2_msg)
            except Exception as e:
                logger.warning(f"Failed to send to client: {e}")


# ============================================================================
# ENHANCED HANDLERS
# ============================================================================

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
        start_proc = time.perf_counter()

        if not isinstance(message, bytes) or len(message) != EXPECTED_PACKET_SIZE:
            logger.warning(f"Invalid packet size: {len(message) if isinstance(message, bytes) else type(message)}")
            return

        # Parse header
        header_data = message[:BATCH_HEADER_SIZE]
        magic, version, reserved, batch_seq, timestamp_ms = struct.unpack(HEADER_FORMAT, header_data)

        if magic != MAGIC_NUMBER:
            logger.warning(f"Invalid magic: {hex(magic)}")
            return
        if version != 0x01:
            logger.warning(f"Unknown version: {version}")
            return

        # Packet loss detection
        packet_loss = 0
        if self.last_batch_seq is not None:
            expected = self.last_batch_seq + 1
            if batch_seq != expected:
                lost = batch_seq - expected
                self.packet_loss_count += lost
                packet_loss = lost
        self.last_batch_seq = batch_seq

        # Latency calculation (estimated budget due to clock skew)
        # Design Doc v1.2: Don't trust timestamp diff due to no NTP sync
        latency_ms = 63  # Budget: 40 + 3 + 5 + 10 + 5

        # Parse frames
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

        # Aggregate data from all 4 frames (40ms window)
        last_frame = frames[-1]
        all_raw, all_clean = [], []
        for f in frames:
            all_raw.extend(f.raw_pcm)
            all_clean.extend(f.clean_pcm)

        # DSP calculations
        raw_spectrum, freqs = self.dsp_engine.compute_stft_with_freqs(all_raw)
        clean_spectrum, _ = self.dsp_engine.compute_stft_with_freqs(all_clean)
        snr = self.dsp_engine.compute_snr(last_frame.raw_pcm, last_frame.clean_pcm)

        # Bark band energies
        raw_bark = self.dsp_engine.compute_bark_energies(raw_spectrum, freqs)
        clean_bark = self.dsp_engine.compute_bark_energies(clean_spectrum, freqs)

        # Aggregate metrics
        mean_rms_raw = np.mean([f.rms_raw for f in frames])
        max_vad = max(f.vad_prob for f in frames)
        server_proc_ms = (time.perf_counter() - start_proc) * 1000

        # Legacy metrics for compatibility
        peak_raw = self.voice_logger.calculate_peak(all_raw)
        rms_db = self.voice_logger.calculate_rms_db(all_raw)
        voice_detected = max_vad > 0.5

        # Log voice activity
        self.voice_logger.log_voice_activity(
            batch_seq, frames, snr, packet_loss,
            len(self.broadcast_manager.frontend_clients)
        )

        # Build enhanced DTO v2
        dto_v2 = VisualizationDTOv2(
            batchSeq=batch_seq,
            timestampMs=timestamp_ms,
            latencyMs=int(latency_ms),
            snr=snr,
            vad=round(max_vad, 4),
            rmsRaw=round(float(mean_rms_raw), 6),
            packetLoss=packet_loss,
            totalPacketLoss=self.packet_loss_count,
            connectionStatus="online",

            waveform=WaveformData(
                raw=all_raw,
                clean=all_clean,
                sampleRate=SAMPLE_RATE,
                durationMs=40
            ),

            spectrum=SpectrumData(
                raw=raw_spectrum.tolist(),
                clean=clean_spectrum.tolist(),
                frequencies=freqs.tolist(),
                fftSize=FFT_SIZE,
                hopLength=HOP_LENGTH
            ),

            barkBands=BarkBandsData(
                raw=raw_bark.tolist(),
                clean=clean_bark.tolist(),
                bandEdges=self.dsp_engine.bark_edges.tolist()
            ),

            system=SystemMetrics(
                frameSeq=last_frame.frame_seq,
                serverProcessingMs=round(server_proc_ms, 2),
                queueDepth=4
            ),

            # Legacy compatibility fields
            timestamp=time.time(),
            peak_raw=peak_raw,
            rms_db=rms_db,
            voice_detected=voice_detected,
            rawSpectrum=raw_spectrum.tolist(),
            cleanSpectrum=clean_spectrum.tolist(),
            rawWaveform=all_raw,
            cleanWaveform=all_clean
        )

        # Broadcast to all clients (version-appropriate formatting)
        self.broadcast_manager.broadcast_dto(dto_v2)


class FrontendHandler:
    def __init__(self, broadcast_manager: BroadcastManager):
        self.broadcast_manager = broadcast_manager

    async def handle(self, websocket: ServerConnection, api_version: str = "2"):
        """Handle visualizer client with version negotiation"""
        client_addr = websocket.remote_address
        logger.info(f"🖥️  Frontend connected from {client_addr} (API v{api_version})")

        self.broadcast_manager.register(websocket, api_version)

        try:
            await websocket.wait_closed()
        except websockets.ConnectionClosed:
            pass
        finally:
            self.broadcast_manager.unregister(websocket)
            logger.info(f"🖥️  Frontend disconnected from {client_addr}")


# ============================================================================
# ENHANCED SERVER WITH ROUTING
# ============================================================================

class AudioServer:
    def __init__(self, host: str = "0.0.0.0", port: int = 8080):
        self.host = host
        self.port = port
        self.broadcast_manager = BroadcastManager()
        self.esp32_handler = ESP32Handler(self.broadcast_manager)
        self.frontend_handler = FrontendHandler(self.broadcast_manager)

    def _parse_path_version(self, path: str) -> tuple:
        """Parse endpoint path and version query parameter"""
        # Remove query string for path matching
        base_path = path.split('?')[0]

        # Parse version from query string
        version = "2"  # Default to v2
        if '?' in path:
            query = path.split('?')[1]
            params = dict(p.split('=') for p in query.split('&') if '=' in p)
            version = params.get('version', '2')

        # Legacy endpoint mapping
        if base_path == "/visualizer-legacy" or base_path == "/visualizer/v1":
            version = "legacy"
            base_path = "/visualizer"

        return base_path, version

    async def route_connection(self, websocket: ServerConnection):
        """Route connections to appropriate handlers"""
        raw_path = websocket.request.path if hasattr(websocket, 'request') else '/'
        path, version = self._parse_path_version(raw_path)

        if path == "/esp32" or path == "/":
            await self.esp32_handler.handle(websocket)
        elif path == "/visualizer":
            await self.frontend_handler.handle(websocket, version)
        else:
            await websocket.close(code=1000, reason=f"Unknown endpoint: {path}")

    async def start(self):
        logger.info(f"🚀 Server starting on ws://{self.host}:{self.port}")
        logger.info(f"   ESP32:      ws://{self.host}:{self.port}/esp32")
        logger.info(f"   Visualizer: ws://{self.host}:{self.port}/visualizer")
        logger.info(f"   Legacy:     ws://{self.host}:{self.port}/visualizer?version=legacy")
        logger.info(f"   Legacy Alt: ws://{self.host}:{self.port}/visualizer-legacy")
        logger.info("\n🎤 MIC TEST READY: Speak near the microphone to see volume bars!\n")

        server = await serve(
            self.route_connection,
            self.host,
            self.port,
            ping_interval=20,
            ping_timeout=10
        )
        await server.serve_forever()


# ============================================================================
# MAIN ENTRY
# ============================================================================

async def main():
    server = AudioServer()
    await server.start()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("\n🛑 Server stopped")
