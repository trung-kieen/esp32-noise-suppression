/*
 * Real-Time Noise Suppression — ESP32-S3
 * Phase 1: I2S mic input (INMP441) + WebSocket sender
 *
 * Architecture:
 *   Task 1 (AudioInput)   → reads 480 samples from INMP441 via I2S
 *   Task 2 (WSSender)     → encodes PCM as base64, sends JSON via WebSocket
 *
 * NOTE: RNNoise denoising is stubbed out — audio_clean = audio_raw for now.
 *       Replace the stub section with rnnoise_process_frame() in Phase 2.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>

// ─────────────────────────────────────────────
//  WiFi credentials — CHANGE THESE
// ─────────────────────────────────────────────
#define WIFI_SSID     "NothingMore"
#define WIFI_PASSWORD "12345asdf"

// Python server address — CHANGE THIS
#define SERVER_HOST   "192.168.1.100"
#define SERVER_PORT   8765
#define SERVER_PATH   "/ws/esp32"

// ─────────────────────────────────────────────
//  I2S pins (INMP441)
//  Match your report's pin mapping
// ─────────────────────────────────────────────
#define I2S_PORT        I2S_NUM_0
#define I2S_SCK_PIN     4   // Bit Clock
#define I2S_WS_PIN      5   // Word Select (LRCK)
#define I2S_SD_PIN      6   // Data In

// ─────────────────────────────────────────────
//  Audio config — RNNoise requires 48kHz / 480 samples
// ─────────────────────────────────────────────
#define SAMPLE_RATE     48000
#define FRAME_SAMPLES   480           // 10ms @ 48kHz
#define BYTES_PER_FRAME (FRAME_SAMPLES * sizeof(int16_t))

// ─────────────────────────────────────────────
//  FreeRTOS queue: AudioInput → WSSender
//  Each item is one full frame (480 × int16)
// ─────────────────────────────────────────────
#define QUEUE_DEPTH     8   // buffer up to 8 frames

typedef struct {
    int16_t raw[FRAME_SAMPLES];
    int16_t clean[FRAME_SAMPLES];
    float   vad_prob;
} AudioFrame_t;

static QueueHandle_t audioQueue = nullptr;

// ─────────────────────────────────────────────
//  WebSocket client (global)
// ─────────────────────────────────────────────
static WebSocketsClient wsClient;
static volatile bool    wsConnected = false;

// ─────────────────────────────────────────────
//  Base64 encoding table
// ─────────────────────────────────────────────
static const char b64chars[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static String base64Encode(const uint8_t* data, size_t len) {
    String out;
    out.reserve(((len + 2) / 3) * 4 + 1);
    for (size_t i = 0; i < len; i += 3) {
        uint8_t b0 = data[i];
        uint8_t b1 = (i + 1 < len) ? data[i + 1] : 0;
        uint8_t b2 = (i + 2 < len) ? data[i + 2] : 0;
        out += b64chars[(b0 >> 2) & 0x3F];
        out += b64chars[((b0 << 4) | (b1 >> 4)) & 0x3F];
        out += (i + 1 < len) ? b64chars[((b1 << 2) | (b2 >> 6)) & 0x3F] : '=';
        out += (i + 2 < len) ? b64chars[b2 & 0x3F] : '=';
    }
    return out;
}

// ─────────────────────────────────────────────
//  WebSocket event handler
// ─────────────────────────────────────────────
void onWebSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
    switch (type) {
        case WStype_CONNECTED:
            wsConnected = true;
            Serial.println("[WS] Connected to server");
            // Send handshake
            {
                StaticJsonDocument<256> doc;
                doc["type"]        = "handshake";
                doc["sample_rate"] = SAMPLE_RATE;
                doc["frame_size"]  = FRAME_SAMPLES;
                doc["ai_model"]    = "rnnoise_stub";
                String msg;
                serializeJson(doc, msg);
                wsClient.sendTXT(msg);
                Serial.println("[WS] Handshake sent");
            }
            break;

        case WStype_DISCONNECTED:
            wsConnected = false;
            Serial.println("[WS] Disconnected");
            break;

        case WStype_TEXT:
            // Optionally handle ACK from server
            Serial.printf("[WS] Server: %s\n", payload);
            break;

        default:
            break;
    }
}

// ─────────────────────────────────────────────
//  Task 1 — AudioInput
//  Reads FRAME_SAMPLES from I2S every ~10ms
//  Packs into AudioFrame_t and sends to queue
// ─────────────────────────────────────────────

// Static buffers — keep OFF the task stack to avoid overflow
static int32_t  s_dmaBuffer[FRAME_SAMPLES];
static int16_t  s_pcm16[FRAME_SAMPLES];

void taskAudioInput(void* pvParam) {
    int32_t* dmaBuffer = s_dmaBuffer;
    int16_t* pcm16     = s_pcm16;
    size_t   bytesRead = 0;

    Serial.println("[AudioInput] Task started");

    while (true) {
        // Read one frame from I2S DMA
        esp_err_t err = i2s_read(
            I2S_PORT,
            dmaBuffer,
            FRAME_SAMPLES * sizeof(int32_t),
            &bytesRead,
            portMAX_DELAY
        );

        if (err != ESP_OK) {
            Serial.printf("[AudioInput] i2s_read error: %d\n", err);
            continue;
        }

        int samplesRead = bytesRead / sizeof(int32_t);

        // INMP441 outputs 24-bit data left-justified in 32-bit words
        // Shift right by 8 to get signed 24-bit, then scale to 16-bit
        for (int i = 0; i < samplesRead; i++) {
            pcm16[i] = (int16_t)(dmaBuffer[i] >> 11);
        }

        // ── RNNoise stub ─────────────────────────────────
        // TODO Phase 2: replace with rnnoise_process_frame()
        // For now, clean = raw (passthrough)
        AudioFrame_t frame;
        memcpy(frame.raw,   pcm16, BYTES_PER_FRAME);
        memcpy(frame.clean, pcm16, BYTES_PER_FRAME);  // stub
        frame.vad_prob = 0.0f;                        // stub
        // ──────────────────────────────────────────────────

        // Send to queue (drop frame if queue full — no blocking)
        if (xQueueSend(audioQueue, &frame, 0) != pdTRUE) {
            // Queue full — WSSender is too slow; drop this frame
        }
    }
}

// ─────────────────────────────────────────────
//  Task 2 — WSSender
//  Picks frames from queue, encodes to JSON, sends over WebSocket
// ─────────────────────────────────────────────
void taskWSSender(void* pvParam) {
    AudioFrame_t frame;
    Serial.println("[WSSender] Task started");
    printf("\n[WSSender] Task started");

    while (true) {
        // Block until a frame is available
        if (xQueueReceive(audioQueue, &frame, portMAX_DELAY) != pdTRUE) {
            continue;
        }

        if (!wsConnected) {
            continue;   // discard frames when not connected
        }

        // Encode raw and clean PCM as base64
        String rawB64   = base64Encode((uint8_t*)frame.raw,   BYTES_PER_FRAME);
        String cleanB64 = base64Encode((uint8_t*)frame.clean, BYTES_PER_FRAME);

        // Build JSON message
        // Use DynamicJsonDocument — frame is ~1280 bytes of b64 each side
        DynamicJsonDocument doc(4096);
        doc["type"]                  = "audio_frame";
        doc["audio_raw"]             = rawB64;
        doc["audio_clean"]           = cleanB64;
        doc["metrics"]["vad_prob"]   = frame.vad_prob;

        String msg;
        serializeJson(doc, msg);
        wsClient.sendTXT(msg);
    }
}

// ─────────────────────────────────────────────
//  I2S Initialization — INMP441, 48kHz, mono
// ─────────────────────────────────────────────
void initI2S() {
    i2s_config_t cfg = {
        .mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate          = SAMPLE_RATE,
        .bits_per_sample      = I2S_BITS_PER_SAMPLE_32BIT,
        .channel_format       = I2S_CHANNEL_FMT_ONLY_LEFT,   // INMP441 L/R pin → GND = left
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count        = 4,
        .dma_buf_len          = FRAME_SAMPLES,
        .use_apll             = false,
        .tx_desc_auto_clear   = false,
        .fixed_mclk           = 0
    };

    i2s_pin_config_t pins = {
        .bck_io_num   = I2S_SCK_PIN,
        .ws_io_num    = I2S_WS_PIN,
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num  = I2S_SD_PIN
    };

    ESP_ERROR_CHECK(i2s_driver_install(I2S_PORT, &cfg, 0, nullptr));
    ESP_ERROR_CHECK(i2s_set_pin(I2S_PORT, &pins));
    ESP_ERROR_CHECK(i2s_zero_dma_buffer(I2S_PORT));

    Serial.println("[I2S] INMP441 initialized @ 48kHz");
    printf("\n[I2S] INMP441 initialized @ 48kHz");
}

// ─────────────────────────────────────────────
//  WiFi connect (blocking)
// ─────────────────────────────────────────────
void connectWiFi() {
    printf("[WiFi] Connecting to %s", WIFI_SSID);
    Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.printf("\n[WiFi] Connected — IP: %s\n", WiFi.localIP().toString().c_str());
    printf("\n[WiFi] Connected — IP: %s\n", WiFi.localIP().toString().c_str());
}

// ─────────────────────────────────────────────
//  setup()
// ─────────────────────────────────────────────
void setup() {

    printf("Init setup");
    Serial.begin(115200);
    delay(1000);
    Serial.println("\n=== ESP32-S3 RNNoise Sender ===");
    printf("\n=== ESP32-S3 RNNoise Sender ===");

    // 1. WiFi
    connectWiFi();

    // 2. WebSocket
    wsClient.begin(SERVER_HOST, SERVER_PORT, SERVER_PATH);
    wsClient.onEvent(onWebSocketEvent);
    wsClient.setReconnectInterval(2000);
    Serial.printf("[WS] Connecting to ws://%s:%d%s\n", SERVER_HOST, SERVER_PORT, SERVER_PATH);
    printf("[WS] Connecting to ws://%s:%d%s\n", SERVER_HOST, SERVER_PORT, SERVER_PATH);

    // 3. I2S
    initI2S();

    // 4. Queue
    audioQueue = xQueueCreate(QUEUE_DEPTH, sizeof(AudioFrame_t));
    if (!audioQueue) {
        Serial.println("[FATAL] Could not create audio queue!");
        while (true) delay(1000);
    }

    // 5. Tasks
    // AudioInput on Core 1 (high priority) — keep audio capture stable
    xTaskCreatePinnedToCore(
        taskAudioInput,
        "AudioInput",
        8192,   // increased: I2S driver overhead is significant
        nullptr,
        5,      // priority
        nullptr,
        1       // core 1
    );

    // WSSender on Core 0 (lower priority, WiFi stack lives here too)
    xTaskCreatePinnedToCore(
        taskWSSender,
        "WSSender",
        8192,   // larger stack for JSON serialization
        nullptr,
        3,
        nullptr,
        0       // core 0
    );

    Serial.println("[Setup] Done — tasks running");
    printf("\n[Setup] Done — tasks running");
}

// ─────────────────────────────────────────────
//  loop() — just runs WebSocket loop
// ─────────────────────────────────────────────
void loop() {
    // printf("\n");
    wsClient.loop();
    delay(1);   // yield to RTOS
}
