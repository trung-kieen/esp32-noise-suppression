/**
 * @file main.cpp
 * @brief ESP32-S3 Real-time Audio Streaming with Pluggable AI Denoising
 * @version 2.0.0
 *
 * Architecture Overview:
 * - Pipeline: I2S → [Denoising Strategy] → WebSocket Batch
 * - Strategy pattern allows easy swapping between PassThrough and AI models
 * - Zero-copy where possible, double-buffering for thread safety
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h>
#include "protocol_schema.h"
#include "config.h"

// ============================================================================
// PROTOCOL CONSTANTS (Match your protocol_schema.h exactly)
// ============================================================================

#ifndef PROTOCOL_MAGIC
#define PROTOCOL_MAGIC 0xABCD1234
#endif

#ifndef PROTOCOL_VERSION
#define PROTOCOL_VERSION 0x01
#endif

// ============================================================================
// CONFIGURATION SECTION
// ============================================================================

namespace Config {
    // Network
    constexpr const char* WIFI_SSID = CONFIG_WIFI_SSID;
    constexpr const char* WIFI_PASS = CONFIG_WIFI_PASS;
    constexpr const char* WS_HOST = "192.168.1.14";
    constexpr int WS_PORT = 8080;
    constexpr const char* WS_PATH = "/";

    // I2S Pins (INMP441)
    constexpr gpio_num_t I2S_SCK = GPIO_NUM_4;
    constexpr gpio_num_t I2S_WS  = GPIO_NUM_5;
    constexpr gpio_num_t I2S_SD  = GPIO_NUM_6;

    // Task Configuration
    constexpr uint32_t TASK_STACK_MIC = 4096;
    constexpr uint32_t TASK_STACK_PROC = 8192;
    constexpr UBaseType_t TASK_PRIO_MIC = 10;
    constexpr UBaseType_t TASK_PRIO_PROC = 5;
    constexpr BaseType_t CORE_MIC = 0;
    constexpr BaseType_t CORE_PROC = 1;

    // Queue depth as per design doc
    constexpr uint8_t QUEUE_DEPTH = 8;
}

// ============================================================================
// AUDIO PROCESSING STRATEGY INTERFACE
// ============================================================================
/**
 * @brief Abstract interface for audio denoising algorithms
 *
 * HOW TO ADD NEW AI MODEL:
 * 1. Create new class inheriting from IAudioProcessor
 * 2. Implement processFrame() with your model inference
 * 3. Change AudioPipeline's processor_ in setup()
 *
 * Example:
 * class RNNoiseProcessor : public IAudioProcessor {
 *     float processFrame(const int16_t* input, int16_t* output) override {
 *         // Run RNNoise inference
 *         // Return cleaned audio buffer
 *     }
 * };
 */

class IAudioProcessor {
public:
    virtual ~IAudioProcessor() = default;

    /**
     * @brief Process a single frame of audio
     * @param input Raw PCM buffer (FRAME_SIZE samples)
     * @param output Cleaned PCM buffer (FRAME_SIZE samples) - pre-allocated
     * @return VAD probability (0.0 - 1.0), or -1.0 if processing failed
     */
    virtual float processFrame(const int16_t* input, int16_t* output) = 0;

    /**
     * @brief Get processor name for telemetry
     */
    virtual const char* getName() const = 0;

    /**
     * @brief Initialize processor resources (models, buffers, etc.)
     * @return true if initialization successful
     */
    virtual bool init() { return true; }

    /**
     * @brief Cleanup resources
     */
    virtual void deinit() {}
};

// ============================================================================
// CONCRETE PROCESSOR IMPLEMENTATIONS
// ============================================================================

/**
 * @brief Pass-through processor (zero latency, no processing)
 * Use this for: baseline testing, when AI model is not ready
 */
class PassThroughProcessor : public IAudioProcessor {
public:
    float processFrame(const int16_t* input, int16_t* output) override {
        memcpy(output, input, sizeof(int16_t) * FRAME_SIZE);
        return 0.99f; // Always active
    }

    const char* getName() const override { return "PassThrough"; }
};

/**
 * @brief Placeholder for future AI model integration
 *
 * TODO: Your team implements this
 * - Load TFLite/ONNX model in init()
 * - Run inference in processFrame()
 * - Handle model quantization (int8 vs float)
 * - Manage tensor arena memory
 */
class AIModelProcessor : public IAudioProcessor {
public:
    bool init() override {
        // TODO: Load model from SPIFFS/SD card
        // TODO: Allocate tensor arena
        // TODO: Initialize interpreter
        Serial.println("[AI] Model loading not implemented yet");
        return false; // Failover to PassThrough
    }

    float processFrame(const int16_t* input, int16_t* output) override {
        // TODO:
        // 1. Convert int16 → float (normalize to -1.0..1.0)
        // 2. Run model inference
        // 3. Convert float → int16
        // 4. Return actual VAD from model

        // Fallback to pass-through for now
        memcpy(output, input, sizeof(int16_t) * FRAME_SIZE);
        return 0.5f;
    }

    const char* getName() const override { return "AIModel"; }

    void deinit() override {
        // TODO: Free model resources
    }
};

// ============================================================================
// DATA STRUCTURES
// ============================================================================

/**
 * @brief Thread-safe audio buffer with metadata
 * NOTE: This is internal queue format, NOT the wire protocol format
 */
struct AudioBuffer {
    int16_t pcm[FRAME_SIZE];
    uint32_t sequence;      // Global frame sequence number
    uint32_t timestampUs;   // Microsecond timestamp for latency tracking
};

/**
 * @brief Batch assembly context (non-thread-safe, used only in processing task)
 */
struct BatchAssembler {
    BatchPacket packet;
    uint8_t frameCount = 0;
    uint32_t batchSequence = 0;

    void reset() {
        frameCount = 0;
        // Only clear header, preserve frame memory layout
        memset(&packet.header, 0, sizeof(packet.header));
    }
};

// ============================================================================
// AUDIO PIPELINE CLASS
// ============================================================================

class AudioPipeline {
public:
    AudioPipeline() : processor_(nullptr), queue_(nullptr) {}

    /**
     * @brief Initialize pipeline with chosen processing strategy
     */
    bool begin(IAudioProcessor* processor, QueueHandle_t queue) {
        processor_ = processor;
        queue_ = queue;

        if (!processor_->init()) {
            Serial.printf("[Pipeline] %s init failed, falling back to PassThrough\n",
                         processor_->getName());
            static PassThroughProcessor fallback;
            processor_ = &fallback;
        }

        assembler_.reset();
        Serial.printf("[Pipeline] Started with processor: %s\n", processor_->getName());
        return true;
    }

    /**
     * @brief Process single audio frame through pipeline
     * @param buffer Input audio buffer from queue
     * @return true if batch is ready to send
     */
    bool processFrame(const AudioBuffer& buffer) {
        AudioFrame* frame = &assembler_.packet.frames[assembler_.frameCount];

        // Fill metadata (matching your protocol_schema.h AudioFrame struct)
        frame->frame_seq = buffer.sequence;
        // Note: timestamp_us is NOT in your original AudioFrame struct
        // If you need it, add it to protocol_schema.h or track separately

        // === CORE PROCESSING STEP ===
        // This is where AI model runs (or pass-through)
        frame->vad_prob = processor_->processFrame(buffer.pcm, frame->clean_pcm);

        // Calculate RMS for telemetry (optional: move to processor)
        frame->rms_raw = calculateRMS(buffer.pcm);

        // Copy raw for comparison/debugging
        memcpy(frame->raw_pcm, buffer.pcm, sizeof(buffer.pcm));

        assembler_.frameCount++;

        // Check if batch is complete
        if (assembler_.frameCount >= FRAMES_PER_BATCH) {
            finalizeBatch();
            return true; // Ready to transmit
        }
        return false;
    }

    /**
     * @brief Get completed batch packet for transmission
     */
    const BatchPacket* getBatch() const {
        return &assembler_.packet;
    }

    /**
     * @brief Reset assembler after successful transmission
     */
    void markTransmitted() {
        assembler_.reset();
    }

    IAudioProcessor* getProcessor() const { return processor_; }

private:
    IAudioProcessor* processor_;
    QueueHandle_t queue_;
    BatchAssembler assembler_;

    float calculateRMS(const int16_t* samples) {
        float sum = 0.0f;
        for (int i = 0; i < FRAME_SIZE; i++) {
            float s = static_cast<float>(samples[i]) / 32768.0f;
            sum += s * s;
        }
        return sqrtf(sum / FRAME_SIZE);
    }

    void finalizeBatch() {
        auto& hdr = assembler_.packet.header;
        hdr.magic = PROTOCOL_MAGIC;        // 0xABCD1234
        hdr.version = PROTOCOL_VERSION;    // 0x01
        hdr.batch_seq = assembler_.batchSequence++;
        hdr.timestamp_ms = millis();
        // Note: processor_id is NOT in your original BatchHeader struct
        // Add to protocol_schema.h if you need to track which processor was used
    }
};

// ============================================================================
// HARDWARE DRIVERS
// ============================================================================

class I2SDriver {
public:
    bool begin() {
        i2s_config_t config = {
            .mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX),
            .sample_rate = SAMPLE_RATE,
            .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
            .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
            .communication_format = I2S_COMM_FORMAT_STAND_I2S,
            .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
            .dma_buf_count = 8,
            .dma_buf_len = FRAME_SIZE,
            .use_apll = true,  // Required for 48kHz accuracy
            .tx_desc_auto_clear = false,
            .fixed_mclk = 0
        };

        i2s_pin_config_t pins = {
            .bck_io_num = Config::I2S_SCK,
            .ws_io_num = Config::I2S_WS,
            .data_out_num = I2S_PIN_NO_CHANGE,
            .data_in_num = Config::I2S_SD
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
        Serial.println("[I2S] Initialized at 48kHz");
        return true;
    }

    /**
     * @brief Read audio samples from I2S
     * @param buffer Destination buffer (must hold FRAME_SIZE int16)
     * @return Number of bytes actually read, 0 on error
     */
    size_t read(int16_t* buffer, size_t timeoutMs = portMAX_DELAY) {
        size_t bytesRead = 0;
        esp_err_t err = i2s_read(I2S_NUM_0, buffer,
                                sizeof(int16_t) * FRAME_SIZE,
                                &bytesRead, pdMS_TO_TICKS(timeoutMs));

        if (err != ESP_OK || bytesRead == 0) {
            return 0;
        }
        return bytesRead;
    }
};

// ============================================================================
// NETWORK MANAGER
// ============================================================================

class WebSocketManager {
public:
    void begin() {
        ws_.begin(Config::WS_HOST, Config::WS_PORT, Config::WS_PATH);
        ws_.setReconnectInterval(5000);
        ws_.enableHeartbeat(15000, 3000, 2);
        Serial.printf("[WS] Connecting to %s:%d...\n", Config::WS_HOST, Config::WS_PORT);
    }

    void loop() {
        ws_.loop();
    }

    bool isConnected() {
        return ws_.isConnected();
    }

    void sendBatch(const BatchPacket* batch) {
        if (!isConnected()) return;

        ws_.sendBIN(reinterpret_cast<const uint8_t*>(batch), sizeof(BatchPacket));

        // Telemetry
        const auto& hdr = batch->header;
        Serial.printf("[TX] Batch #%lu (%d frames) @ %lu ms\n",
                     hdr.batch_seq, FRAMES_PER_BATCH, hdr.timestamp_ms);
    }

    WebSocketsClient& client() { return ws_; }

private:
    WebSocketsClient ws_;
};

// ============================================================================
// GLOBAL INSTANCES
// ============================================================================

static I2SDriver g_i2s;
static WebSocketManager g_websocket;
static AudioPipeline g_pipeline;
static QueueHandle_t g_audioQueue = nullptr;

// Statistics for monitoring
struct Telemetry {
    uint32_t framesCaptured = 0;
    uint32_t framesProcessed = 0;
    uint32_t batchesSent = 0;
    uint32_t queueOverruns = 0;
} g_telemetry;

// ============================================================================
// RTOS TASKS
// ============================================================================

/**
 * @brief High-priority audio capture task (Core 0)
 * Reads I2S and pushes to queue with minimal latency
 */
void taskAudioCapture(void* pvParameters) {
    AudioBuffer buffer;
    uint32_t sequence = 0;

    Serial.println("[Task] Audio capture started on Core 0");

    while (true) {
        size_t bytesRead = g_i2s.read(buffer.pcm, 100); // 100ms timeout

        if (bytesRead > 0) {
            buffer.sequence = sequence++;
            buffer.timestampUs = micros();

            BaseType_t sent = xQueueSend(g_audioQueue, &buffer, pdMS_TO_TICKS(10));

            if (sent == pdPASS) {
                g_telemetry.framesCaptured++;
            } else {
                g_telemetry.queueOverruns++;
                // Optional: Log overrun every N occurrences
            }
        }
    }
}

/**
 * @brief Processing and transmission task (Core 1)
 * Assembles batches and applies AI processing
 */
void taskAudioProcessing(void* pvParameters) {
    AudioBuffer buffer;

    Serial.println("[Task] Audio processing started on Core 1");

    while (true) {
        if (xQueueReceive(g_audioQueue, &buffer, portMAX_DELAY) == pdTRUE) {
            g_telemetry.framesProcessed++;

            // Process through pipeline (AI or pass-through)
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
// SETUP & LOOP
// ============================================================================

void setup() {
    Serial.begin(115200);
    delay(1000); // Allow serial monitor to attach

    Serial.println("\n========================================");
    Serial.println("ESP32-S3 Audio Streamer v2.0");
    Serial.println("========================================");

    // Initialize WiFi
    WiFi.begin(Config::WIFI_SSID, Config::WIFI_PASS);
    Serial.print("[WiFi] Connecting");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.printf("\n[WiFi] Connected, IP: %s\n", WiFi.localIP().toString().c_str());

    // Initialize WebSocket
    g_websocket.begin();

    // Create audio queue (thread-safe buffer between tasks)
    g_audioQueue = xQueueCreate(Config::QUEUE_DEPTH, sizeof(AudioBuffer));
    if (!g_audioQueue) {
        Serial.println("[ERROR] Queue creation failed!");
        while (1) delay(100);
    }

    // Initialize I2S hardware
    if (!g_i2s.begin()) {
        Serial.println("[ERROR] I2S init failed!");
        while (1) delay(100);
    }

    // === SELECT PROCESSOR STRATEGY HERE ===
    // Option 1: PassThrough (current, zero latency)
    static PassThroughProcessor passThrough;
    g_pipeline.begin(&passThrough, g_audioQueue);

    // Option 2: AI Model (when ready)
    // static AIModelProcessor aiModel;
    // g_pipeline.begin(&aiModel, g_audioQueue);

    // Create tasks
    xTaskCreatePinnedToCore(
        taskAudioCapture, "AudioCapture",
        Config::TASK_STACK_MIC, NULL,
        Config::TASK_PRIO_MIC, NULL,
        Config::CORE_MIC
    );

    xTaskCreatePinnedToCore(
        taskAudioProcessing, "AudioProcessing",
        Config::TASK_STACK_PROC, NULL,
        Config::TASK_PRIO_PROC, NULL,
        Config::CORE_PROC
    );

    Serial.println("[System] Startup complete");
}

void loop() {
    g_websocket.loop();

    // Periodic telemetry report (every 10 seconds)
    static unsigned long lastReport = 0;
    if (millis() - lastReport > 10000) {
        Serial.printf("[Stats] Captured: %lu, Processed: %lu, Batches: %lu, Overruns: %lu\n",
                     g_telemetry.framesCaptured, g_telemetry.framesProcessed,
                     g_telemetry.batchesSent, g_telemetry.queueOverruns);
        lastReport = millis();
    }

    delay(1); // Yield to RTOS
}
