
![Demo](assets/v.2.1.1.gif)
<!-- <video src="./assets/v.2.1.1.mp4" width="1280" height="720" controls></video> -->

## 1. System Architecture Overview

```mermaid
flowchart TB
    subgraph ESP32["ESP32-S3 Hardware"]
        INMP441["INMP441<br/>MEMS Microphone<br/>(I2S Digital)"]
        I2S["I2S Peripheral<br/>48kHz/16-bit"]
        CORE0["Core 0<br/>High Priority"]
        CORE1["Core 1<br/>Processing"]
    end
    
    subgraph Firmware["Audio Pipeline Firmware"]
        CAPTURE["Audio Capture<br/>Task (RTOS)"]
        QUEUE["FreeRTOS Queue<br/>Depth: 8 buffers"]
        PROCESS["Processing &<br/>Batching Task"]
        WS_CLIENT["WebSocket Client<br/>Binary Protocol"]
    end
    
    subgraph Network["Network Layer"]
        WIFI["WiFi Station"]
        ROUTER["WiFi Router"]
    end
    
    subgraph Server["Python Backend Server"]
        WS_SERVER["WebSocket Server<br/>Port 8080"]
        DECODER["Binary Protocol<br/>Decoder"]
        ANALYZER["Signal Analyzer<br/>(VAD/RMS/SNR)"]
        API["REST/WebSocket API<br/>DTO Schema"]
    end
    
    INMP441 -->|"SCK/WS/SD"| I2S
    I2S -->|"DMA Buffer"| CORE0
    CORE0 --> CAPTURE
    CAPTURE -->|"AudioBuffer<br/>480 samples"| QUEUE
    QUEUE --> CORE1
    CORE1 --> PROCESS
    PROCESS -->|"BatchPacket<br/>4 frames"| WS_CLIENT
    WS_CLIENT --> WIFI
    WIFI --> ROUTER
    ROUTER -->|"ws://192.168.1.14:8080/"| WS_SERVER
    WS_SERVER --> DECODER
    DECODER --> ANALYZER
    ANALYZER --> API
    
    style INMP441 fill:#e1f5fe
    style WS_SERVER fill:#fff3e0
    style QUEUE fill:#f3e5f5
```

---

## 2. Data Flow & Pipeline Sequence

---


![Dataflow](./assets/dataflow.png)



## 3. Binary Protocol Structure (Wire Format)

```mermaid
classDiagram
    class BatchHeader {
        +uint32_t magic = 0xABCD1234
        +uint8_t version = 0x01
        +uint8_t reserved[3]
        +uint32_t batch_seq
        +uint32_t timestamp_ms
        +uint16_t frame_count = 4
        +uint16_t processor_id
        -- 16 bytes total --
    }
    
    class AudioFrame {
        +uint32_t frame_seq
        +float vad_prob
        +float rms_raw
        +int16_t raw_pcm[480]
        +int16_t clean_pcm[480]
        -- 1932 bytes total --
    }
    
    class BatchPacket {
        +BatchHeader header
        +AudioFrame frames[4]
        -- 7744 bytes total --
    }
    
    class PythonDTO {
        +int batchSeq
        +long timestampMs
        +float latencyMs
        +float snr
        +float vad
        +float rmsRaw
        +Waveform waveform
        +Spectrum spectrum
        +BarkBands barkBands
        +SystemInfo system
    }
    
    class Waveform {
        +int16[] raw (1920 samples)
        +int16[] clean (1920 samples)
        +int sampleRate = 48000
        +int durationMs = 40
    }
    
    class Spectrum {
        +float[] raw (257 bins)
        +float[] clean (257 bins)
        +float[] frequencies (257)
        +int fftSize = 512
        +int hopLength = 256
    }
    
    class BarkBands {
        +float[] raw (24 bands)
        +float[] clean (24 bands)
        +float[] bandEdges (25)
    }
    
    BatchPacket *-- BatchHeader : contains
    BatchPacket *-- "4" AudioFrame : contains
    PythonDTO *-- Waveform : contains
    PythonDTO *-- Spectrum : contains
    PythonDTO *-- BarkBands : contains
    
    note for BatchPacket "Wire Protocol:<br/>Little-endian binary<br/>Sent via WebSocket BINARY frame"
    note for PythonDTO "Server-side DTO:<br/>Nested JSON structure<br/>After FFT processing"
```

---

## 4. ESP32 Class Architecture (Strategy Pattern)

```mermaid
classDiagram
    direction TB
    
    class IAudioProcessor {
        <<interface>>
        +processFrame(input, output) float
        +getName() const char*
        +init() bool
        +deinit() void
    }
    
    class PassThroughProcessor {
        +processFrame() float
        +getName() "PassThrough"
        -- Zero latency --
    }
    
    class AIModelProcessor {
        -modelHandle*
        -tensorArena[]
        +init() bool
        +processFrame() float
        +getName() "AIModel"
        +deinit() void
        -- TFLite/ONNX --
    }
    
    class AudioPipeline {
        -IAudioProcessor* processor_
        -QueueHandle_t queue_
        -BatchAssembler assembler_
        +begin(processor, queue) bool
        +processFrame(buffer) bool
        +getBatch() BatchPacket*
        +markTransmitted() void
        -calculateRMS() float
        -finalizeBatch() void
    }
    
    class I2SDriver {
        -i2s_port_t port
        +begin() bool
        +read(buffer, timeout) size_t
    }
    
    class WebSocketManager {
        -WebSocketsClient ws_
        +begin() void
        +loop() void
        +isConnected() bool
        +sendBatch(batch) void
    }
    
    class BatchAssembler {
        +BatchPacket packet
        +uint8_t frameCount
        +uint32_t batchSequence
        +reset() void
    }
    
    class AudioBuffer {
        +int16_t pcm[480]
        +uint32_t sequence
        +uint32_t timestampUs
    }
    
    IAudioProcessor <|-- PassThroughProcessor : implements
    IAudioProcessor <|-- AIModelProcessor : implements
    AudioPipeline --> IAudioProcessor : uses strategy
    AudioPipeline *-- BatchAssembler : contains
    AudioPipeline ..> AudioBuffer : processes
    I2SDriver ..> AudioBuffer : fills
    WebSocketManager ..> BatchPacket : sends
    
    note for AudioPipeline "Strategy Pattern:<br/>Swappable processors<br/>without code change"
    note for BatchAssembler "Accumulates 4 frames<br/>before transmission"
```

---

## 5. Python Server Architecture

```mermaid
flowchart LR
    subgraph Server["Python FastAPI/WebSocket Server"]
        WS["WebSocket Endpoint<br/>/ (port 8080)"]
        
        subgraph Decoder["Protocol Decoder"]
            HDR["Parse BatchHeader<br/>16 bytes"]
            FRAMES["Extract 4 AudioFrames<br/>4 × 1932 bytes"]
            VALID["Validate Magic<br/>0xABCD1234"]
        end
        
        subgraph Processing["Signal Processing"]
            CONCAT["Concatenate Frames<br/>1920 samples"]
            FFT["FFT Analysis<br/>512-point → 257 bins"]
            BARK["Bark Scale<br/>24 psychoacoustic bands"]
            VAD["VAD Detection<br/>Voice Activity"]
            METRICS["Compute SNR, RMS<br/>Latency tracking"]
        end
        
        subgraph DTO["DTO Assembly"]
            WAVE["Waveform Object<br/>raw/clean arrays"]
            SPEC["Spectrum Object<br/>raw/clean + freqs"]
            BARK_OBJ["BarkBands Object<br/>24 bands + edges"]
            SYS["System Info<br/>frameSeq, timing"]
        end
        
        API["WebSocket/REST API<br/>JSON Response"]
    end
    
    Client["ESP32 Client"] -->|"7744 bytes binary"| WS
    WS --> HDR
    HDR --> VALID
    VALID --> FRAMES
    FRAMES --> CONCAT
    CONCAT --> FFT
    CONCAT --> VAD
    CONCAT --> METRICS
    FFT --> SPEC
    FFT --> BARK
    BARK --> BARK_OBJ
    CONCAT --> WAVE
    METRICS --> SYS
    
    WAVE --> API
    SPEC --> API
    BARK_OBJ --> API
    SYS --> API
    
    style Decoder fill:#e3f2fd
    style Processing fill:#e8f5e9
    style DTO fill:#fff3e0
```

---
## Payload Structure 

### 1. Batch Header (16 bytes)

| Offset | Field | Size | Value |
|--------|-------|------|-------|
| 0 | Magic Number | 4 bytes | `0xABCD1234` |
| 4 | Version | 1 byte | `0x01` |
| 5 | Reserved | 3 bytes | `0x00` |
| 8 | Batch Sequence | 4 bytes | Incrementing 0,1,2... |
| 12 | Timestamp (ms) | 4 bytes | Send time |
| 16 | Frame Count | 2 bytes | `4` |
| 18 | Processor ID | 2 bytes | Processor type |

---

### 2. Audio Frame (1932 bytes) × 4 frames

Each frame contains:

| Offset in frame | Field | Size | Description |
|-----------------|-------|------|-------------|
| 0 | Frame Sequence | 4 bytes | Frame sequence number |
| 4 | VAD Probability | 4 bytes | Float 0.0-1.0 (from AI) |
| 8 | RMS Raw | 4 bytes | Original audio intensity |
| 12 | Raw PCM | 960 bytes | **Original data** (480 samples × 2 bytes) |
| 972 | Clean PCM | 960 bytes | **AI-processed data** (480 samples × 2 bytes) |

---

### 3. Total Structure (7744 bytes)

```
┌─────────────────────────────────────┐
│         BATCH HEADER (16 bytes)     │
│  Magic | Version | Seq | Timestamp  │
├─────────────────────────────────────┤
│      FRAME 0 (1932 bytes)           │
│  Seq | VAD | RMS | Raw[480] | Clean[480] │
├─────────────────────────────────────┤
│      FRAME 1 (1932 bytes)           │
│  (same as frame 0)                  │
├─────────────────────────────────────┤
│      FRAME 2 (1932 bytes)           │
├─────────────────────────────────────┤
│      FRAME 3 (1932 bytes)           │
└─────────────────────────────────────┘
        ↓
   WebSocket BINARY frame
   Sent in one transmission
```



## Example 

**Assume** you say "Hello" into the microphone:

| Field | Sample Value |
|-------|--------------|
| `raw_pcm` | [1205, 3021, -1500, 800, ...] ← Has background noise |
| `clean_pcm` | [1200, 3019, -1498, 802, ...] ← Noise filtered |
| `vad_prob` | 0.95 ← AI detected speech |

The server receives both formats to:
- **Listen to** `clean_pcm` (processed version)
- **Compare** with `raw_pcm` (evaluate AI quality)
- **Analyze** `vad_prob` (know which segments contain speech)



# Setup

## Prerequisites

### Hardware
- ESP32-S3 development board
- INMP441 I2S microphone module
- USB cable for programming

### Software
- [PlatformIO IDE](https://platformio.org/install/ide?install=vscode) (VS Code extension or CLI)
- Python 3.8+
- Node.js 18+ and npm

---

## 1. ESP32 Firmware

Copy and edit the configuration:
```bash
cp src/config.example.h src/config.h
# Edit src/config.h with your WiFi credentials and server IP
```

Build and upload to device:
```bash
# Via PlatformIO CLI
pio run --target upload

# Or use the Makefile shortcut 
make
```

Monitor serial output:
```bash
pio device monitor --baud 115200
```

---

## 2. Python Observability Server

Navigate to server directory and set up environment:
```bash
cd python-server/

# Create virtual environment
python -m venv .env

# Activate (Linux/Mac)
source .env/bin/activate

# Activate (Windows PowerShell)
# .env\Scripts\Activate.ps1

# Activate (Windows CMD)
# .env\Scripts\activate.bat

# Install dependencies 
pip install -r requirements.txt

# Start server
python server.py
```

Server runs on `ws://localhost:8080` by default.

---

## 3. React Visualization Client

Navigate to client directory and install dependencies:
```bash
cd audio-visualizer/

# Install dependencies
npm install

# Start development server
npm run start
```

Client opens at `http://localhost:3000`

