/*
 * Real-Time Noise Suppression — ESP32-S3
 * Optimized: binary WebSocket frames (no base64, no JSON for audio)
 *
 * Binary frame layout (964 bytes total):
 *   [0]     magic    = 0xAA
 *   [1]     type     = 0x01 (audio_frame)
 *   [2..3]  vad_prob as uint16 (0..10000 = 0.0..1.0)
 *   [4..963] raw PCM  int16 × 480 samples = 960 bytes
 *
 * Handshake is still JSON text (sent once at connect).
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
#define WIFI_SSID  "NothingMore"
#define WIFI_PASSWORD   "12345asdf"
#define SERVER_HOST     "10.19.165.77"
#define SERVER_PORT     8765
#define SERVER_PATH     "/ws/esp32"

// ─────────────────────────────────────────────
//  I2S — INMP441
// ─────────────────────────────────────────────
#define I2S_PORT        I2S_NUM_0
#define I2S_SCK_PIN     4
#define I2S_WS_PIN      5
#define I2S_SD_PIN      6

// ─────────────────────────────────────────────
//  Audio
// ─────────────────────────────────────────────
#define SAMPLE_RATE      48000
#define FRAME_SAMPLES    480
#define BYTES_PCM        (FRAME_SAMPLES * sizeof(int16_t))   // 960 bytes

// ─────────────────────────────────────────────
//  Binary frame header
// ─────────────────────────────────────────────
#define FRAME_MAGIC      0xAA
#define FRAME_TYPE_AUDIO 0x01
#define HEADER_SIZE      4
#define BINARY_FRAME_SIZE (HEADER_SIZE + BYTES_PCM)          // 964 bytes

// ─────────────────────────────────────────────
//  Queue
// ─────────────────────────────────────────────
#define QUEUE_DEPTH  16   // increased from 8 since items are the same size

typedef struct {
    int16_t raw[FRAME_SAMPLES];
    float   vad_prob;
} AudioFrame_t;

static QueueHandle_t     s_audioQueue    = nullptr;
static WebSocketsClient  s_wsClient;
static volatile bool     s_wsConnected   = false;
static volatile uint32_t s_framesSent    = 0;
static volatile uint32_t s_framesDropped = 0;

// Static buffers — off the task stack
static int32_t  s_dmaBuffer[FRAME_SAMPLES];
static int16_t  s_pcm16[FRAME_SAMPLES];
static uint8_t  s_txBuf[BINARY_FRAME_SIZE];   // reused every send

// ─────────────────────────────────────────────
//  WebSocket event handler
// ─────────────────────────────────────────────
void onWebSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
    switch (type) {

        case WStype_CONNECTED:
            s_wsConnected = true;
            printf("[WS] ✓ Connected to ws://%s:%d%s\n",
                   SERVER_HOST, SERVER_PORT, SERVER_PATH);
            {
                // Handshake: tell server our format (JSON text, once)
                StaticJsonDocument<256> doc;
                doc["type"]        = "handshake";
                doc["sample_rate"] = SAMPLE_RATE;
                doc["frame_size"]  = FRAME_SAMPLES;
                doc["encoding"]    = "binary";   // <-- server knows to expect binary
                doc["ai_model"]    = "rnnoise_stub";
                String msg;
                serializeJson(doc, msg);
                s_wsClient.sendTXT(msg);
                printf("[WS] Handshake sent (binary mode)\n");
            }
            break;

        case WStype_DISCONNECTED:
            s_wsConnected = false;
            printf("[WS] ✗ Disconnected — retrying in 2s\n");
            printf("[WS]   sent=%lu dropped=%lu\n", s_framesSent, s_framesDropped);
            break;

        case WStype_ERROR:
            printf("[WS] ERROR len=%d\n", (int)length);
            break;

        case WStype_TEXT:
            printf("[WS] Server: %.*s\n", (int)length, payload);
            break;

        default:
            break;
    }
}

// ─────────────────────────────────────────────
//  Task 1 — AudioInput (Core 1, priority 5)
// ─────────────────────────────────────────────
void taskAudioInput(void* pvParam) {
    printf("[AudioInput] Started on core %d | frame=%d samples, %d bytes\n",
           xPortGetCoreID(), FRAME_SAMPLES, (int)BYTES_PCM);

    size_t   bytesRead  = 0;
    uint32_t frameCount = 0;
    uint32_t errCount   = 0;

    while (true) {
        esp_err_t err = i2s_read(I2S_PORT, s_dmaBuffer,
                                 FRAME_SAMPLES * sizeof(int32_t),
                                 &bytesRead, portMAX_DELAY);
        if (err != ESP_OK) {
            errCount++;
            printf("[AudioInput] ✗ i2s_read err=%d (total=%lu)\n", err, errCount);
            continue;
        }

        int n = bytesRead / sizeof(int32_t);

        // INMP441: 24-bit left-justified in 32-bit → scale to 16-bit
        for (int i = 0; i < n; i++) {
            s_pcm16[i] = (int16_t)(s_dmaBuffer[i] >> 11);
        }

        // ── RNNoise stub ─────────────────────────────────────
        // TODO Phase 2: rnnoise_process_frame(rnn, out_f, in_f)
        AudioFrame_t frame;
        memcpy(frame.raw, s_pcm16, BYTES_PCM);
        frame.vad_prob = 0.0f;
        // ─────────────────────────────────────────────────────

        if (xQueueSend(s_audioQueue, &frame, 0) != pdTRUE) {
            s_framesDropped++;
            if (s_framesDropped % 500 == 1) {
                printf("[AudioInput] ⚠ Queue full — dropped=%lu queue=%lu/%d\n",
                       s_framesDropped,
                       (unsigned long)uxQueueMessagesWaiting(s_audioQueue),
                       QUEUE_DEPTH);
            }
        }

        frameCount++;
        if (frameCount % 1000 == 0) {
            printf("[AudioInput] ✓ %lu frames | queue=%lu/%d | dropped=%lu\n",
                   frameCount,
                   (unsigned long)uxQueueMessagesWaiting(s_audioQueue),
                   QUEUE_DEPTH,
                   s_framesDropped);
        }
    }
}

// ─────────────────────────────────────────────
//  Task 2 — WSSender (Core 0, priority 3)
//  Sends raw binary frames — no base64, no JSON
// ─────────────────────────────────────────────
void taskWSSender(void* pvParam) {
    printf("[WSSender] Started on core %d | tx_buf=%d bytes\n",
           xPortGetCoreID(), BINARY_FRAME_SIZE);

    AudioFrame_t frame;
    uint32_t tLastLog = millis();

    while (true) {
        if (xQueueReceive(s_audioQueue, &frame, pdMS_TO_TICKS(100)) != pdTRUE) {
            continue;
        }

        if (!s_wsConnected) continue;

        // Build binary frame: [magic][type][vad_hi][vad_lo][pcm × 480]
        uint16_t vad_u16 = (uint16_t)(frame.vad_prob * 10000.0f);
        s_txBuf[0] = FRAME_MAGIC;
        s_txBuf[1] = FRAME_TYPE_AUDIO;
        s_txBuf[2] = (vad_u16 >> 8) & 0xFF;
        s_txBuf[3] = vad_u16 & 0xFF;
        memcpy(s_txBuf + HEADER_SIZE, frame.raw, BYTES_PCM);

        bool ok = s_wsClient.sendBIN(s_txBuf, BINARY_FRAME_SIZE);
        if (ok) {
            s_framesSent++;
            // Log throughput every second
            uint32_t now = millis();
            if (now - tLastLog >= 1000) {
                printf("[WSSender] ✓ %lu frames sent | heap=%lu | "
                       "queue=%lu/%d | dropped=%lu\n",
                       s_framesSent,
                       (unsigned long)ESP.getFreeHeap(),
                       (unsigned long)uxQueueMessagesWaiting(s_audioQueue),
                       QUEUE_DEPTH,
                       s_framesDropped);
                tLastLog = now;
            }
        } else {
            printf("[WSSender] ✗ sendBIN failed (frame %lu)\n", s_framesSent);
        }
    }
}

// ─────────────────────────────────────────────
//  I2S init
// ─────────────────────────────────────────────
void initI2S() {
    printf("[I2S] Init — rate=%d SCK=%d WS=%d SD=%d\n",
           SAMPLE_RATE, I2S_SCK_PIN, I2S_WS_PIN, I2S_SD_PIN);

    i2s_config_t cfg = {
        .mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate          = SAMPLE_RATE,
        .bits_per_sample      = I2S_BITS_PER_SAMPLE_32BIT,
        .channel_format       = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count        = 8,      // increased for smoother DMA
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
    printf("[I2S] ✓ Ready\n");
}

// ─────────────────────────────────────────────
//  WiFi
// ─────────────────────────────────────────────
void connectWiFi() {
    printf("[WiFi] Connecting to: %s\n", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED) {
        if (millis() - start > 30000) {
            printf("[WiFi] ✗ Timeout — restarting\n");
            delay(2000); ESP.restart();
        }
        delay(500);
        printf("[WiFi] ... status=%d\n", (int)WiFi.status());
    }
    printf("[WiFi] ✓ IP=%s RSSI=%d dBm\n",
           WiFi.localIP().toString().c_str(), WiFi.RSSI());
}

// ─────────────────────────────────────────────
//  setup()
// ─────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(1000);
    printf("\n========================================\n");
    printf("  ESP32-S3 RNNoise Sender (binary mode)\n");
    printf("  Heap: %lu  CPU: %d MHz\n",
           (unsigned long)ESP.getFreeHeap(), ESP.getCpuFreqMHz());
    printf("  Frame: %d bytes (was 2639 with JSON+base64)\n", BINARY_FRAME_SIZE);
    printf("========================================\n\n");

    connectWiFi();

    printf("[WS] → ws://%s:%d%s\n", SERVER_HOST, SERVER_PORT, SERVER_PATH);
    s_wsClient.begin(SERVER_HOST, SERVER_PORT, SERVER_PATH);
    s_wsClient.onEvent(onWebSocketEvent);
    s_wsClient.setReconnectInterval(2000);

    initI2S();

    s_audioQueue = xQueueCreate(QUEUE_DEPTH, sizeof(AudioFrame_t));
    if (!s_audioQueue) { printf("[FATAL] Queue alloc failed\n"); while(1); }
    printf("[Queue] depth=%d item=%d bytes\n",
           QUEUE_DEPTH, (int)sizeof(AudioFrame_t));

    xTaskCreatePinnedToCore(taskAudioInput, "AudioInput", 8192, nullptr, 5, nullptr, 1);
    xTaskCreatePinnedToCore(taskWSSender,   "WSSender",   8192, nullptr, 3, nullptr, 0);

    printf("[Setup] ✓ Running — server at %s:%d\n\n", SERVER_HOST, SERVER_PORT);
}

void loop() {
    s_wsClient.loop();
    delay(1);
}
