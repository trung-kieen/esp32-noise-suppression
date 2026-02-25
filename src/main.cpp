/**
 * @file main.cpp
 * @brief ESP32-S3 Real-time Audio Streaming with Pluggable AI Denoising
 * @version 2.1.0
 *
 * Architecture Overview:
 * ─────────────────────────────────────────────────────────────────────────────
 *  Pipeline:  I2S → [IAudioProcessor] → BatchAssembler → WebSocket Batch
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Design Goals (matching Design Doc v1.2 SSOT):
 *  - 48 kHz / 480 samples per frame / 4 frames per batch
 *  - Binary WebSocket protocol (BatchHeader 16 B + 4 × AudioFrame 1932 B = 7744 B)
 *  - All buffers statically allocated — no malloc/new in runtime loop
 *  - Audio processing never blocks on networking
 *
 * Inference Separation (v2.1 change):
 *  - All denoising/inference logic lives inside classes that implement IAudioProcessor.
 *  - To swap in an AI model, create a new IAudioProcessor subclass and pass it to
 *    g_pipeline.begin() in setup(). No other code needs to change.
 *  - The default ScaledPassThroughProcessor scales output by CLEAN_PCM_SCALE (0.8)
 *    instead of a raw copy.  This headroom guarantees the visualizer never clips
 *    when the AI model is integrated and its output is louder than expected.
 *
 * How to Add a New AI Model:
 *  1. Create a class that inherits from IAudioProcessor.
 *  2. Load your model in init() — SPIFFS, SD card, or compiled-in weights.
 *  3. Run inference in processFrame() — convert int16→float, infer, convert back.
 *  4. Return the model's VAD probability (0.0–1.0).
 *  5. In setup(), replace `static ScaledPassThroughProcessor proc;`
 *     with     `static MyAIModelProcessor proc;`
 *     and update g_pipeline.begin(&proc, g_audioQueue).
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h>
#include "protocol_schema.h"   // AudioFrame, BatchPacket, BatchHeader definitions
#include "config.h"            // CONFIG_WIFI_SSID, CONFIG_WIFI_PASS macros

// ============================================================================
// PROTOCOL CONSTANTS  (must match protocol_schema.h exactly)
// ============================================================================

#ifndef PROTOCOL_MAGIC
#define PROTOCOL_MAGIC    0xABCD1234u
#endif

#ifndef PROTOCOL_VERSION
#define PROTOCOL_VERSION  0x01u
#endif

// ============================================================================
// TUNING CONSTANTS
// ============================================================================

/**
 * @brief Output amplitude scale applied to clean_pcm by every processor.
 *
 * WHY 0.8:
 *   A pure-copy passthrough outputs samples at full scale.  When an AI model
 *   is later integrated, slight gain differences can push peaks above INT16_MAX
 *   and cause wrap-around artifacts.  By pre-attenuating to 80 % we guarantee:
 *     * The visualizer always receives valid, non-clipping PCM.
 *     * AI model output (which is already attenuated by the model) sits
 *       comfortably within range without additional clamping logic.
 *
 * CHANGING THIS VALUE:
 *   Adjust only this constant.  All IAudioProcessor implementations call the
 *   shared helper applyScale() — no per-class change required.
 */
static constexpr float CLEAN_PCM_SCALE = 0.8f;

// ============================================================================
// CONFIGURATION  (all compile-time constants, no magic numbers in code)
// ============================================================================

namespace Config {
    // Network
    constexpr const char* WIFI_SSID = CONFIG_WIFI_SSID;
    constexpr const char* WIFI_PASS = CONFIG_WIFI_PASS;
    constexpr const char* WS_HOST   = "192.168.1.14";
    constexpr int         WS_PORT   = 8080;
    constexpr const char* WS_PATH   = "/";

    // I2S Pins (INMP441)
    // BCLK must equal 64 x WS at 48 kHz -> BCLK = 3.072 MHz (Design Doc 4.2)
    constexpr gpio_num_t I2S_SCK = GPIO_NUM_4;
    constexpr gpio_num_t I2S_WS  = GPIO_NUM_5;
    constexpr gpio_num_t I2S_SD  = GPIO_NUM_6;

    // RTOS Task Config
    constexpr uint32_t    TASK_STACK_MIC  = 4096;
    constexpr uint32_t    TASK_STACK_PROC = 8192;
    constexpr UBaseType_t TASK_PRIO_MIC   = 10;   // High — never miss I2S DMA
    constexpr UBaseType_t TASK_PRIO_PROC  = 5;    // Medium — inference + send
    constexpr BaseType_t  CORE_MIC        = 0;
    constexpr BaseType_t  CORE_PROC       = 1;

    // Queue depth >= 8 so the high-priority I2S task never blocks on a slow
    // RNNoise inference frame (Design Doc 9.2)
    constexpr uint8_t QUEUE_DEPTH = 8;
}

// ============================================================================
// SHARED UTILITY: PCM SCALING
// ============================================================================

/**
 * @brief Scale each PCM sample in `src` by `scale` and write to `dst`.
 *
 * Result is clamped to [INT16_MIN, INT16_MAX] to prevent wrap-around.
 * All IAudioProcessor implementations MUST route their output through this
 * function so the scale factor is enforced uniformly.
 *
 * @param dst    Destination int16 buffer (FRAME_SIZE samples, pre-allocated)
 * @param src    Source int16 buffer      (FRAME_SIZE samples, read-only)
 * @param scale  Amplitude multiplier (use CLEAN_PCM_SCALE = 0.8f by default)
 */
static void applyScale(int16_t* dst, const int16_t* src, float scale) {
    for (int i = 0; i < FRAME_SIZE; ++i) {
        float scaled = static_cast<float>(src[i]) * scale;
        if      (scaled >  32767.0f) scaled =  32767.0f;
        else if (scaled < -32768.0f) scaled = -32768.0f;
        dst[i] = static_cast<int16_t>(scaled);
    }
}

// ============================================================================
// ABSTRACT INFERENCE INTERFACE
// ============================================================================

/**
 * @class IAudioProcessor
 * @brief Strategy interface for audio denoising / inference.
 *
 * Every concrete processor (passthrough, RNNoise, TFLite, ONNX...) must:
 *  - Implement processFrame() -- the sole inference entry point.
 *  - Call applyScale(output, ..., CLEAN_PCM_SCALE) so downstream consumers
 *    always receive 80%-scaled PCM regardless of the model used.
 *  - Optionally override init() / deinit() for resource management.
 *
 * CONTRACT for processFrame():
 *   input  : raw int16 PCM,  FRAME_SIZE (480) samples
 *   output : cleaned int16 PCM, FRAME_SIZE samples, pre-allocated
 *            output MUST be filled via applyScale() (see above)
 *   return : VAD probability [0.0 - 1.0], or -1.0 on hard failure
 */
class IAudioProcessor {
public:
    virtual ~IAudioProcessor() = default;

    /**
     * @brief Run inference on one audio frame.
     * @param input   Raw PCM buffer -- read-only, FRAME_SIZE int16 samples.
     * @param output  Output PCM buffer -- write here, FRAME_SIZE int16 samples.
     *                Output MUST be produced via applyScale() to enforce the
     *                CLEAN_PCM_SCALE headroom guarantee.
     * @return        VAD probability in [0.0, 1.0], or -1.0 on error.
     */
    virtual float processFrame(const int16_t* input, int16_t* output) = 0;

    /** @brief Human-readable name for telemetry / logs. */
    virtual const char* getName() const = 0;

    /**
     * @brief One-time initialization (load model, allocate tensor arena, etc.)
     * @return true if ready; false triggers automatic fallback to
     *         ScaledPassThroughProcessor inside AudioPipeline::begin().
     */
    virtual bool init() { return true; }

    /** @brief Release all resources allocated in init(). */
    virtual void deinit() {}
};

// ============================================================================
// CONCRETE PROCESSOR: SCALED PASS-THROUGH  (default / fallback)
// ============================================================================

/**
 * @class ScaledPassThroughProcessor
 * @brief Copies raw audio to clean_pcm with CLEAN_PCM_SCALE attenuation.
 *
 * Use this when:
 *  - No AI model is available yet (development / baseline).
 *  - You want to verify the pipeline without inference overhead.
 *  - Serving as an automatic fallback when AIModelProcessor::init() fails.
 *
 * WHY NOT a raw memcpy:
 *  A raw copy outputs samples at full amplitude.  Once an AI model is
 *  integrated the output amplitude may differ, causing visualization glitches.
 *  Pre-scaling to 0.8 keeps the pipeline consistent before and after the swap.
 */
class ScaledPassThroughProcessor : public IAudioProcessor {
public:
    /**
     * @brief Scale input by CLEAN_PCM_SCALE and write to output.
     *        Returns a fixed VAD of 0.99 (always-active signal).
     */
    float processFrame(const int16_t* input, int16_t* output) override {
        applyScale(output, input, CLEAN_PCM_SCALE);
        return 0.99f;   // Treat every frame as active voice for visualizer
    }

    const char* getName() const override { return "ScaledPassThrough@0.8"; }
};

// ============================================================================
// CONCRETE PROCESSOR: AI MODEL  (placeholder -- implement your model here)
// ============================================================================

/**
 * @class AIModelProcessor
 * @brief Placeholder for TFLite / ONNX / custom AI denoising model.
 *
 * IMPLEMENTATION GUIDE
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  Step 1 -- init():
 *    - Mount SPIFFS / SD card if model weights are stored externally.
 *    - Allocate a static tensor arena:
 *        static uint8_t tensorArena[YOUR_ARENA_SIZE];
 *    - Create TfLiteModel / OnnxSession from file or embedded array.
 *    - Verify input tensor shape: [1, FRAME_SIZE] float32.
 *    - Return false on any failure -> pipeline auto-falls back to
 *      ScaledPassThroughProcessor so audio keeps flowing.
 *
 *  Step 2 -- processFrame():
 *    (a) Normalize:  float normIn[FRAME_SIZE];
 *                    for (i) normIn[i] = input[i] / 32768.0f;
 *    (b) Run model:  interpreter->Invoke() / session->Run(...)
 *    (c) Read output tensor (float array, same length as input).
 *    (d) Convert back to int16 via applyScale() -- MANDATORY:
 *                    applyScale(output, rawInt16Buf, CLEAN_PCM_SCALE);
 *        or inline the scale:
 *                    for (i) output[i] = clamp(normOut[i] * 32768.0f * CLEAN_PCM_SCALE)
 *    (e) Return the model VAD probability (0.0-1.0).
 *
 *  Step 3 -- deinit():
 *    - Delete interpreter / session.
 *    - Unmount filesystem if needed.
 *
 *  Step 4 -- Activate in setup():
 *    Replace:  static ScaledPassThroughProcessor proc;
 *    With:     static AIModelProcessor proc;
 * ─────────────────────────────────────────────────────────────────────────
 */
class AIModelProcessor : public IAudioProcessor {
public:
    bool init() override {
        // TODO: Load model weights (SPIFFS / SD / embedded array)
        // TODO: Allocate tensor arena
        // TODO: Initialize interpreter / session
        // TODO: Validate input / output tensor shapes
        Serial.println("[AI] Model loading not implemented yet -- "
                       "falling back to ScaledPassThrough");
        return false;   // Returning false triggers automatic fallback
    }

    /**
     * @brief AI model inference stub.
     *
     * Replace the applyScale() call below with real inference output.
     * The applyScale() call MUST be retained (or equivalent inline logic)
     * to honour the CLEAN_PCM_SCALE contract.
     */
    float processFrame(const int16_t* input, int16_t* output) override {
        // TODO: Replace this block with real inference
        //
        //   float normIn[FRAME_SIZE];
        //   for (int i = 0; i < FRAME_SIZE; ++i)
        //       normIn[i] = input[i] / 32768.0f;
        //
        //   /* ... run model ... */
        //
        //   float normOut[FRAME_SIZE];  // model output
        //   for (int i = 0; i < FRAME_SIZE; ++i) {
        //       float s = normOut[i] * 32768.0f * CLEAN_PCM_SCALE;
        //       if (s >  32767.f) s =  32767.f;
        //       if (s < -32768.f) s = -32768.f;
        //       output[i] = static_cast<int16_t>(s);
        //   }
        //   return vadProbFromModel;
        //
        // Fallback until real inference is ready:
        applyScale(output, input, CLEAN_PCM_SCALE);
        return 0.5f;   // Placeholder VAD
    }

    const char* getName() const override { return "AIModel(stub)"; }

    void deinit() override {
        // TODO: Release model resources
    }

private:
    // TODO: Add model handle, tensor arena, interpreter pointer here
    //   e.g.:
    //   static uint8_t  s_tensorArena[96 * 1024];
    //   TfLiteInterpreter* interpreter_ = nullptr;
};

// ============================================================================
// DATA STRUCTURES  (internal pipeline types, not wire protocol)
// ============================================================================

/**
 * @brief Queue element carrying one captured audio frame between tasks.
 *
 * NOTE: This is the *internal* queue format.
 *       Wire protocol format is defined in protocol_schema.h (AudioFrame).
 */
struct AudioBuffer {
    int16_t  pcm[FRAME_SIZE];   ///< Raw PCM samples from I2S DMA
    uint32_t sequence;          ///< Global monotonic frame counter
    uint32_t timestampUs;       ///< Capture timestamp from micros()
};

/**
 * @brief Accumulates AudioFrames until a full batch of FRAMES_PER_BATCH is ready.
 *        Only accessed from the processing task -- not thread-safe by design.
 */
struct BatchAssembler {
    BatchPacket packet;               ///< Wire-protocol batch being built
    uint8_t     frameCount    = 0;    ///< Frames accumulated so far
    uint32_t    batchSequence = 0;    ///< Incremented each time a batch is sent

    /** @brief Reset frame count and clear header before starting a new batch. */
    void reset() {
        frameCount = 0;
        memset(&packet.header, 0, sizeof(packet.header));
    }
};

// ============================================================================
// AUDIO PIPELINE  (orchestrates capture -> inference -> batch assembly)
// ============================================================================

/**
 * @class AudioPipeline
 * @brief Wires IAudioProcessor, BatchAssembler, and the audio queue together.
 *
 * The pipeline is deliberately thin -- it owns no inference logic.
 * All denoising decisions live in the IAudioProcessor strategy object.
 */
class AudioPipeline {
public:
    AudioPipeline() : processor_(nullptr), queue_(nullptr) {}

    /**
     * @brief Attach a processor and the shared audio queue.
     *
     * If processor->init() returns false, the pipeline automatically
     * substitutes a ScaledPassThroughProcessor so audio keeps flowing.
     *
     * @param processor Pointer to an IAudioProcessor implementation.
     * @param queue     FreeRTOS queue producing AudioBuffer items.
     * @return          Always true (fallback guarantees success).
     */
    bool begin(IAudioProcessor* processor, QueueHandle_t queue) {
        processor_ = processor;
        queue_     = queue;

        if (!processor_->init()) {
            Serial.printf("[Pipeline] '%s' init failed -- switching to ScaledPassThrough\n",
                          processor_->getName());
            static ScaledPassThroughProcessor fallback;
            processor_ = &fallback;
            processor_->init();
        }

        assembler_.reset();
        Serial.printf("[Pipeline] Running with processor: %s\n", processor_->getName());
        return true;
    }

    /**
     * @brief Feed one captured frame through inference and into the batch.
     *
     * Internally calls processor_->processFrame(), which MUST produce output
     * via applyScale() (enforced by the IAudioProcessor contract).
     * The 0.8 scale is therefore baked into every clean_pcm in the batch.
     *
     * @param buffer  Frame captured by taskAudioCapture.
     * @return        true when a complete batch of FRAMES_PER_BATCH is ready.
     */
    bool processFrame(const AudioBuffer& buffer) {
        AudioFrame* frame = &assembler_.packet.frames[assembler_.frameCount];

        // Populate frame header fields
        frame->frame_seq = buffer.sequence;

        // Core inference step:
        // processor_->processFrame() writes scaled output to frame->clean_pcm.
        frame->vad_prob = processor_->processFrame(buffer.pcm, frame->clean_pcm);

        // Metadata for telemetry / visualizer
        frame->rms_raw = calculateRMS(buffer.pcm);
        memcpy(frame->raw_pcm, buffer.pcm, sizeof(buffer.pcm));

        assembler_.frameCount++;

        if (assembler_.frameCount >= FRAMES_PER_BATCH) {
            finalizeBatch();
            return true;   // Caller should transmit immediately
        }
        return false;
    }

    /** @brief Const access to the completed batch (valid only when processFrame returns true). */
    const BatchPacket* getBatch() const { return &assembler_.packet; }

    /** @brief Reset assembler after successful transmission. */
    void markTransmitted() { assembler_.reset(); }

private:
    /**
     * @brief Seal the batch header before transmission.
     */
    void finalizeBatch() {
        BatchHeader& hdr   = assembler_.packet.header;
        hdr.magic          = PROTOCOL_MAGIC;
        hdr.version        = PROTOCOL_VERSION;
        hdr.reserved[0]    = 0x00;
        hdr.reserved[1]    = 0x00;
        hdr.reserved[2]    = 0x00;
        hdr.batch_seq      = assembler_.batchSequence++;
        // timestamp_ms: ms since ESP32 boot (NOT Unix time -- Design Doc v1.2 sec.2)
        hdr.timestamp_ms   = static_cast<uint32_t>(esp_timer_get_time() / 1000ULL);
    }

    /**
     * @brief Compute Root-Mean-Square of a PCM frame for the rms_raw field.
     * @param pcm  Input buffer, FRAME_SIZE samples.
     * @return     RMS as a float.
     */
    static float calculateRMS(const int16_t* pcm) {
        float sum = 0.0f;
        for (int i = 0; i < FRAME_SIZE; ++i) {
            float s = static_cast<float>(pcm[i]);
            sum += s * s;
        }
        return sqrtf(sum / FRAME_SIZE);
    }

    IAudioProcessor* processor_;   ///< Pluggable inference strategy
    QueueHandle_t    queue_;       ///< Reference to inter-task audio queue
    BatchAssembler   assembler_;   ///< Batch accumulation state
};

// ============================================================================
// HARDWARE DRIVER: I2S  (INMP441 microphone input)
// ============================================================================

/**
 * @class I2SDriver
 * @brief Thin wrapper around ESP-IDF I2S driver for INMP441 capture.
 *
 * Design Doc 4.2 requirements honoured:
 *  - use_apll = true  -- mandatory for accurate 48 kHz clock generation
 *  - bits_per_sample = 32-bit -- produces BCLK = 64 x WS = 3.072 MHz
 *    (16-bit mode would give 32 x WS, wrong for INMP441)
 */
class I2SDriver {
public:
    bool begin() {
        i2s_config_t config = {
            .mode                 = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX),
            .sample_rate          = SAMPLE_RATE,                 // 48 000 Hz
            .bits_per_sample      = I2S_BITS_PER_SAMPLE_32BIT,  // BCLK = 64 x WS
            .channel_format       = I2S_CHANNEL_FMT_ONLY_LEFT,
            .communication_format = I2S_COMM_FORMAT_STAND_I2S,
            .intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1,
            .dma_buf_count        = 8,
            .dma_buf_len          = FRAME_SIZE,
            .use_apll             = true,    // Required for 48 kHz accuracy
            .tx_desc_auto_clear   = false,
            .fixed_mclk           = 0
        };

        i2s_pin_config_t pins = {
            .bck_io_num   = Config::I2S_SCK,
            .ws_io_num    = Config::I2S_WS,
            .data_out_num = I2S_PIN_NO_CHANGE,
            .data_in_num  = Config::I2S_SD
        };

        esp_err_t err = i2s_driver_install(I2S_NUM_0, &config, 0, NULL);
        if (err != ESP_OK) {
            Serial.printf("[I2S] Driver install failed: %d\n", err);
            return false;
        }

        err = i2s_set_pin(I2S_NUM_0, &pins);
        if (err != ESP_OK) {
            Serial.printf("[I2S] Pin config failed: %d\n", err);
            return false;
        }

        i2s_zero_dma_buffer(I2S_NUM_0);
        Serial.println("[I2S] Initialized at 48 kHz (APLL, BCLK = 3.072 MHz)");
        return true;
    }

    /**
     * @brief Blocking read of one audio frame from I2S DMA.
     * @param buffer     Destination -- must hold FRAME_SIZE int16 samples.
     * @param timeoutMs  Maximum wait time in milliseconds.
     * @return           Bytes read, or 0 on error / timeout.
     */
    size_t read(int16_t* buffer, size_t timeoutMs = portMAX_DELAY) {
        size_t bytesRead = 0;
        esp_err_t err = i2s_read(I2S_NUM_0,
                                 buffer,
                                 sizeof(int16_t) * FRAME_SIZE,
                                 &bytesRead,
                                 pdMS_TO_TICKS(timeoutMs));
        if (err != ESP_OK || bytesRead == 0) return 0;
        return bytesRead;
    }
};

// ============================================================================
// NETWORK MANAGER: WebSocket client
// ============================================================================

/**
 * @class WebSocketManager
 * @brief Manages the WebSocket connection to the Python bridge server.
 *
 * Sends fully assembled BatchPacket blobs (7744 bytes) as binary frames.
 * Reconnects automatically every 5 s on disconnection.
 */
class WebSocketManager {
public:
    void begin() {
        ws_.begin(Config::WS_HOST, Config::WS_PORT, Config::WS_PATH);
        ws_.setReconnectInterval(5000);
        ws_.enableHeartbeat(15000, 3000, 2);
        Serial.printf("[WS] Connecting to ws://%s:%d%s\n",
                      Config::WS_HOST, Config::WS_PORT, Config::WS_PATH);
    }

    void loop() { ws_.loop(); }

    bool isConnected() { return ws_.isConnected(); }

    /**
     * @brief Transmit a completed batch as a single binary WebSocket frame.
     * @param batch  Pointer to a fully populated BatchPacket (7744 bytes).
     */
    void sendBatch(const BatchPacket* batch) {
        if (!isConnected()) return;
        ws_.sendBIN(reinterpret_cast<const uint8_t*>(batch), sizeof(BatchPacket));

        const BatchHeader& hdr = batch->header;
        Serial.printf("[TX] Batch #%lu | %d frames | t=%lu ms\n",
                      hdr.batch_seq, FRAMES_PER_BATCH, hdr.timestamp_ms);
    }

    WebSocketsClient& client() { return ws_; }

private:
    WebSocketsClient ws_;
};

// ============================================================================
// GLOBAL INSTANCES  (all static -- no heap allocation)
// ============================================================================

static I2SDriver        g_i2s;
static WebSocketManager g_websocket;
static AudioPipeline    g_pipeline;
static QueueHandle_t    g_audioQueue = nullptr;

struct Telemetry {
    uint32_t framesCaptured  = 0;
    uint32_t framesProcessed = 0;
    uint32_t batchesSent     = 0;
    uint32_t queueOverruns   = 0;
} g_telemetry;

// ============================================================================
// RTOS TASK: Audio Capture  (Core 0, high priority)
// ============================================================================

/**
 * @brief Reads I2S DMA frames and pushes them to g_audioQueue.
 *
 * Intentionally minimal -- no processing here.  Any slowdown in this task
 * causes DMA buffer overrun and introduces audio glitches.
 */
void taskAudioCapture(void* pvParameters) {
    AudioBuffer buffer;
    uint32_t    sequence = 0;

    Serial.println("[Task] AudioCapture started on Core 0");

    while (true) {
        size_t bytesRead = g_i2s.read(buffer.pcm, 100);

        if (bytesRead > 0) {
            buffer.sequence    = sequence++;
            buffer.timestampUs = micros();

            if (xQueueSend(g_audioQueue, &buffer, pdMS_TO_TICKS(10)) == pdPASS) {
                g_telemetry.framesCaptured++;
            } else {
                g_telemetry.queueOverruns++;
                // Frame dropped -- queue full means processing task is behind
            }
        }
    }
}

// ============================================================================
// RTOS TASK: Audio Processing  (Core 1, medium priority)
// ============================================================================

/**
 * @brief Pulls frames from g_audioQueue, runs inference, and sends batches.
 *
 * Inference budget (Design Doc v1.2 sec.5):
 *   ScaledPassThrough  ~0.1 ms/frame
 *   RNNoise            ~2-5 ms/frame  (240 MHz, -O2)
 *   Hard limit         = 10 ms/frame  (must finish before next frame)
 */
void taskAudioProcessing(void* pvParameters) {
    AudioBuffer buffer;

    Serial.println("[Task] AudioProcessing started on Core 1");

    while (true) {
        if (xQueueReceive(g_audioQueue, &buffer, portMAX_DELAY) == pdTRUE) {
            g_telemetry.framesProcessed++;

            // processFrame() calls processor_->processFrame() internally,
            // which applies CLEAN_PCM_SCALE (0.8) to clean_pcm.
            bool batchReady = g_pipeline.processFrame(buffer);

            if (batchReady) {
                g_websocket.sendBatch(g_pipeline.getBatch());
                g_pipeline.markTransmitted();
                g_telemetry.batchesSent++;
            }
        }
    }
}

// ============================================================================
// SETUP
// ============================================================================

void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println("\n========================================");
    Serial.println("  ESP32-S3 Audio Streamer  v2.1.0");
    Serial.println("  clean_pcm scale: 0.8 (headroom mode)");
    Serial.println("========================================");

    // WiFi
    WiFi.begin(Config::WIFI_SSID, Config::WIFI_PASS);
    Serial.print("[WiFi] Connecting");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.printf("\n[WiFi] Connected -- IP: %s\n", WiFi.localIP().toString().c_str());

    // WebSocket
    g_websocket.begin();

    // Inter-task queue (statically sized, no malloc)
    g_audioQueue = xQueueCreate(Config::QUEUE_DEPTH, sizeof(AudioBuffer));
    if (!g_audioQueue) {
        Serial.println("[FATAL] Queue creation failed -- halting");
        while (true) delay(100);
    }

    // I2S hardware
    if (!g_i2s.begin()) {
        Serial.println("[FATAL] I2S init failed -- halting");
        while (true) delay(100);
    }

    // ── SELECT INFERENCE STRATEGY ─────────────────────────────────────────
    //
    //  Option A (current default): Scaled pass-through
    //    Copies raw audio to clean_pcm at 80% amplitude.
    //    Zero latency, guarantees visualizer headroom.
    //
    static ScaledPassThroughProcessor proc;
    g_pipeline.begin(&proc, g_audioQueue);
    //
    //  Option B: AI denoising model (when AIModelProcessor is implemented)
    //    Uncomment the two lines below and comment out Option A.
    //
    //  static AIModelProcessor proc;
    //  g_pipeline.begin(&proc, g_audioQueue);
    //
    // ──────────────────────────────────────────────────────────────────────

    // RTOS Tasks
    xTaskCreatePinnedToCore(
        taskAudioCapture,   "AudioCapture",
        Config::TASK_STACK_MIC,  NULL,
        Config::TASK_PRIO_MIC,   NULL,
        Config::CORE_MIC
    );

    xTaskCreatePinnedToCore(
        taskAudioProcessing, "AudioProcessing",
        Config::TASK_STACK_PROC, NULL,
        Config::TASK_PRIO_PROC,  NULL,
        Config::CORE_PROC
    );

    Serial.println("[System] Startup complete -- streaming started");
}

// ============================================================================
// LOOP  (WebSocket service + periodic health report)
// ============================================================================

void loop() {
    g_websocket.loop();

    static unsigned long lastReport = 0;
    if (millis() - lastReport > 10000UL) {
        Serial.printf(
            "[Stats] captured=%lu  processed=%lu  batches=%lu  overruns=%lu\n",
            g_telemetry.framesCaptured,
            g_telemetry.framesProcessed,
            g_telemetry.batchesSent,
            g_telemetry.queueOverruns
        );
        lastReport = millis();
    }

    delay(1);   // Yield to RTOS
}
