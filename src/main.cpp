/**
 * main.cpp — Real-Time Audio Capture + WebSocket Sender
 * ESP32-S3 + INMP441 + MAX98357A
 * Legacy driver/i2s.h — works on all IDF versions
 */



#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "driver/i2s.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "audio_config.h"
#include "wifi_config.h"


// #include <driver/i2s.h>

#define I2S_WS   5
#define I2S_SD   6
#define I2S_SCK  4
#define I2S_PORT I2S_NUM_0

#define SAMPLE_RATE 16000
#define BUFFER_LEN  16   // nhỏ => latency thấp

int32_t samples[BUFFER_LEN];


// ============================================================
//  Logging macros — rich printf with timestamp + core + level
// ============================================================
#define _LOG(level, tag, fmt, ...) \
    Serial.printf("[%8lu ms][C%d][%s][%s] " fmt "\n", \
        (unsigned long)(esp_timer_get_time() / 1000ULL), \
        (int)xPortGetCoreID(), level, tag, ##__VA_ARGS__)

#define LOGI(tag, fmt, ...)  _LOG("INFO ", tag, fmt, ##__VA_ARGS__)
#define LOGW(tag, fmt, ...)  _LOG("WARN ", tag, fmt, ##__VA_ARGS__)
#define LOGE(tag, fmt, ...)  _LOG("ERROR", tag, fmt, ##__VA_ARGS__)
#define LOGD(tag, fmt, ...)  _LOG("DEBUG", tag, fmt, ##__VA_ARGS__)

// Separator line for visual grouping in serial monitor
#define LOG_SEP(tag) \
    Serial.printf("----[%s]----------------------------------------------\n", tag)

// ============================================================
//  RTOS Queues & Payload Pool
// ============================================================
#define POOL_SIZE (WS_QUEUE_DEPTH + AUDIO_QUEUE_DEPTH + 2)

static ws_payload_t  payload_pool[POOL_SIZE];
static uint8_t       pool_head    = 0;

static QueueHandle_t audio_queue  = NULL;
static QueueHandle_t ws_queue     = NULL;
static QueueHandle_t dac_queue    = NULL;

static int16_t       dma_pool[AUDIO_QUEUE_DEPTH][FRAME_SAMPLES];
static uint8_t       dma_pool_idx = 0;

static WebSocketsClient wsClient;
static volatile bool    ws_connected = false;
static uint32_t         seq_counter  = 0;

// ---- Runtime stats (printed every 5 seconds) ----
static volatile uint32_t stat_frames_captured = 0;
static volatile uint32_t stat_frames_sent     = 0;
static volatile uint32_t stat_ws_overflow     = 0;
static volatile uint32_t stat_dac_overflow    = 0;
static volatile uint32_t stat_i2s_errors      = 0;
static volatile int16_t  stat_last_peak       = 0;   // loudest sample in last window

// ============================================================
//  I2S Init
// ============================================================
static void i2s_init(void)
{
    LOG_SEP("I2S");
    LOGI("I2S", "Configuring RX — INMP441 on I2S_NUM_0");
    LOGI("I2S", "  Pins: SCK=GPIO%d  WS=GPIO%d  SD=GPIO%d",
         I2S_MIC_SCK, I2S_MIC_WS, I2S_MIC_SD);
    LOGI("I2S", "  Rate=%d Hz  Bits=32  Chan=LEFT  APLL=true", SAMPLE_RATE);
    LOGI("I2S", "  DMA: buf_count=%d  buf_len=%d  total=%d bytes",
         AUDIO_QUEUE_DEPTH, FRAME_SAMPLES,
         AUDIO_QUEUE_DEPTH * FRAME_SAMPLES * 4);

    i2s_config_t rx_cfg = {
        .mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate          = SAMPLE_RATE,
        .bits_per_sample      = I2S_BITS_PER_SAMPLE_32BIT,
        .channel_format       = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count        = AUDIO_QUEUE_DEPTH,
        .dma_buf_len          = FRAME_SAMPLES,
        .use_apll             = true,
        .tx_desc_auto_clear   = false,
        .fixed_mclk           = 0,
        .mclk_multiple        = I2S_MCLK_MULTIPLE_256,
        .bits_per_chan         = I2S_BITS_PER_CHAN_32BIT,
    };
    i2s_pin_config_t rx_pins = {
        .mck_io_num   = I2S_PIN_NO_CHANGE,
        .bck_io_num   = I2S_MIC_SCK,
        .ws_io_num    = I2S_MIC_WS,
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num  = I2S_MIC_SD,
    };

    esp_err_t err = i2s_driver_install(I2S_NUM_0, &rx_cfg, 0, NULL);
    if (err != ESP_OK) {
        LOGE("I2S", "RX driver_install FAILED  err=0x%x (%s)",
             err, esp_err_to_name(err));
        LOGE("I2S", ">>> HALTED — check pin wiring and IDF version <<<");
        while (1) delay(1000);
    }
    err = i2s_set_pin(I2S_NUM_0, &rx_pins);
    if (err != ESP_OK) {
        LOGE("I2S", "RX set_pin FAILED  err=0x%x (%s)",
             err, esp_err_to_name(err));
        while (1) delay(1000);
    }
    LOGI("I2S", "RX OK — INMP441 ready");

    // ---- TX: MAX98357A ----
    LOGI("I2S", "Configuring TX — MAX98357A on I2S_NUM_1");
    LOGI("I2S", "  Pins: BCLK=GPIO%d  LRC=GPIO%d  DOUT=GPIO%d",
         I2S_SPK_BCLK, I2S_SPK_LRC, I2S_SPK_DOUT);
    LOGI("I2S", "  Rate=%d Hz  Bits=16  Chan=LEFT  APLL=true", SAMPLE_RATE);

    i2s_config_t tx_cfg = {
        .mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
        .sample_rate          = SAMPLE_RATE,
        .bits_per_sample      = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format       = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count        = AUDIO_QUEUE_DEPTH,
        .dma_buf_len          = FRAME_SAMPLES,
        .use_apll             = true,
        .tx_desc_auto_clear   = true,
        .fixed_mclk           = 0,
        .mclk_multiple        = I2S_MCLK_MULTIPLE_256,
        .bits_per_chan         = I2S_BITS_PER_CHAN_16BIT,
    };
    i2s_pin_config_t tx_pins = {
        .mck_io_num   = I2S_PIN_NO_CHANGE,
        .bck_io_num   = I2S_SPK_BCLK,
        .ws_io_num    = I2S_SPK_LRC,
        .data_out_num = I2S_SPK_DOUT,
        .data_in_num  = I2S_PIN_NO_CHANGE,
    };

    err = i2s_driver_install(I2S_NUM_1, &tx_cfg, 0, NULL);
    if (err != ESP_OK) {
        LOGE("I2S", "TX driver_install FAILED  err=0x%x (%s)",
             err, esp_err_to_name(err));
        while (1) delay(1000);
    }
    err = i2s_set_pin(I2S_NUM_1, &tx_pins);
    if (err != ESP_OK) {
        LOGE("I2S", "TX set_pin FAILED  err=0x%x (%s)",
             err, esp_err_to_name(err));
        while (1) delay(1000);
    }
    LOGI("I2S", "TX OK — MAX98357A ready");
    LOG_SEP("I2S");
}

// ============================================================
//  Payload pool allocator
// ============================================================
static ws_payload_t *alloc_payload(void)
{
    ws_payload_t *p = &payload_pool[pool_head];
    pool_head = (pool_head + 1) % POOL_SIZE;
    return p;
}

// ============================================================
//  Task 1: Audio Input — core 1, priority 6
// ============================================================
static void task_audio_input(void *arg)
{
    static int32_t dma_buf[FRAME_SAMPLES];
    size_t   bytes_read  = 0;
    uint32_t frame_count = 0;
    uint32_t err_count   = 0;

    LOGI("T1:AudioIn", "Task started — waiting for DMA frames...");
    LOGI("T1:AudioIn", "Expecting %d bytes/read (%d samples x 4 bytes)",
         FRAME_BYTES_INT32, FRAME_SAMPLES);

    for (;;) {
        esp_err_t err = i2s_read(
            I2S_NUM_0, dma_buf, FRAME_BYTES_INT32, &bytes_read, portMAX_DELAY);

        if (err != ESP_OK) {
            err_count++;
            stat_i2s_errors++;
            LOGE("T1:AudioIn", "i2s_read error #%lu  err=0x%x (%s)",
                 err_count, err, esp_err_to_name(err));
            continue;
        }
        if (bytes_read != (size_t)FRAME_BYTES_INT32) {
            LOGW("T1:AudioIn", "Partial read: got %d expected %d bytes",
                 (int)bytes_read, FRAME_BYTES_INT32);
            continue;
        }

        // INMP441: 24-bit MSB-justified in 32-bit slot → shift right 16
        int16_t *dst  = dma_pool[dma_pool_idx];
        int16_t  peak = 0;
        for (int i = 0; i < FRAME_SAMPLES; i++) {
            dst[i] = (int16_t)(dma_buf[i] >> 16);
            int16_t abs_s = dst[i] < 0 ? -dst[i] : dst[i];
            if (abs_s > peak) peak = abs_s;
        }
        stat_last_peak = peak;
        stat_frames_captured++;
        frame_count++;

        // First frame: confirm mic is producing non-zero data
        if (frame_count == 1) {
            LOGI("T1:AudioIn", "First frame received — peak sample: %d %s",
                 peak, peak < 10 ? "(WARNING: near-zero — check mic wiring!)" : "(OK)");
        }

        // Every 500 frames (~5s) log a signal health line
        if (frame_count % 500 == 0) {
            LOGD("T1:AudioIn", "Frame #%lu  peak=%d  i2s_errors=%lu  queue_spaces=%d",
                 frame_count, peak, err_count,
                 (int)uxQueueSpacesAvailable(audio_queue));
        }

        uint8_t idx = dma_pool_idx;
        dma_pool_idx = (dma_pool_idx + 1) % AUDIO_QUEUE_DEPTH;

        if (xQueueSend(audio_queue, &idx, 0) != pdTRUE) {
            LOGW("T1:AudioIn", "audio_queue FULL — frame #%lu dropped (process task too slow?)",
                 frame_count);
        }
    }
}

// ============================================================
//  Task 2: Audio Processing — core 0, priority 5
// ============================================================
static void task_audio_process(void *arg)
{
    uint8_t  dma_idx;
    uint32_t frame_count = 0;

    LOGI("T2:Proc", "Task started");

    for (;;) {
        if (xQueueReceive(audio_queue, &dma_idx, portMAX_DELAY) != pdTRUE) continue;

        frame_count++;
        int16_t      *raw = dma_pool[dma_idx];
        ws_payload_t *pay = alloc_payload();
        pay->flags        = 0;

        memcpy(pay->raw_s16, raw, FRAME_BYTES_INT16);

        // =====================================================
        //  RNNoise slot — replace this block when porting:
        //
        //  static float in_f[FRAME_SAMPLES], out_f[FRAME_SAMPLES];
        //  for (int i = 0; i < FRAME_SAMPLES; i++) in_f[i] = (float)raw[i];
        //  pay->vad_probability = rnnoise_process_frame(rnn_state, out_f, in_f);
        //  for (int i = 0; i < FRAME_SAMPLES; i++) pay->clean_s16[i] = (int16_t)out_f[i];
        //  LOGD("T2:Proc", "RNNoise vad=%.3f", pay->vad_probability);
        //
        //  Passthrough for now:
        // =====================================================
        memcpy(pay->clean_s16, raw, FRAME_BYTES_INT16);
        pay->vad_probability = 0.0f;

        if (frame_count == 1) {
            LOGI("T2:Proc", "First frame processed — passthrough active (RNNoise not yet ported)");
        }

        // DAC queue
        if (xQueueSend(dac_queue, &pay, 0) != pdTRUE) {
            stat_dac_overflow++;
            LOGW("T2:Proc", "dac_queue FULL (#%lu overflows) — speaker may glitch",
                 stat_dac_overflow);
        }

        // WS queue — overflow: evict oldest, set flag
        if (xQueueSend(ws_queue, &pay, 0) != pdTRUE) {
            ws_payload_t *dummy = NULL;
            xQueueReceive(ws_queue, &dummy, 0);
            pay->flags |= FLAG_QUEUE_OVERFLOW;
            xQueueSend(ws_queue, &pay, 0);
            stat_ws_overflow++;
            LOGW("T2:Proc", "ws_queue FULL (#%lu overflows) — evicted oldest frame. "
                 "WiFi too slow? Consider batched mode.",
                 stat_ws_overflow);
        }
    }
}

// ============================================================
//  Task 3: Audio Output — core 1, priority 6
// ============================================================
static void task_audio_output(void *arg)
{
    ws_payload_t *pay         = NULL;
    size_t        bytes_written = 0;
    uint32_t      frame_count  = 0;
    uint32_t      underrun_count = 0;

    LOGI("T3:DACOut", "Task started");

    for (;;) {
        if (xQueueReceive(dac_queue, &pay, portMAX_DELAY) != pdTRUE) continue;

        frame_count++;
        esp_err_t err = i2s_write(
            I2S_NUM_1, pay->clean_s16, FRAME_BYTES_INT16,
            &bytes_written, pdMS_TO_TICKS(20));

        if (err != ESP_OK) {
            LOGE("T3:DACOut", "i2s_write FAILED  err=0x%x (%s)",
                 err, esp_err_to_name(err));
        } else if (bytes_written != (size_t)FRAME_BYTES_INT16) {
            underrun_count++;
            LOGW("T3:DACOut", "Partial write: %d/%d bytes (underrun #%lu) — "
                 "speaker may pop",
                 (int)bytes_written, FRAME_BYTES_INT16, underrun_count);
        }

        if (frame_count == 1) {
            LOGI("T3:DACOut", "First frame written to speaker OK");
        }
    }
}

// ============================================================
//  Task 4: WebSocket Sender — core 0, priority 3
// ============================================================
static void task_ws_sender(void *arg)
{
    static audio_ws_frame_t frame;
    ws_payload_t *pay         = NULL;
    uint32_t      sent_count  = 0;
    uint32_t      skip_count  = 0;

    LOGI("T4:WSSend", "Task started — frame size = %d bytes", WS_FRAME_SIZE);

    for (;;) {
        if (xQueueReceive(ws_queue, &pay, portMAX_DELAY) != pdTRUE) continue;

        if (!ws_connected) {
            skip_count++;
            if (skip_count % 100 == 1) {
                LOGW("T4:WSSend", "Not connected — skipping frames (%lu skipped so far). "
                     "Check server IP=%s PORT=%d PATH=%s",
                     skip_count, WS_SERVER_HOST, WS_SERVER_PORT, WS_SERVER_PATH);
            }
            continue;
        }

        frame.seq_num      = seq_counter++;
        frame.timestamp_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
        frame.vad_prob     = (uint16_t)(pay->vad_probability * 65535.0f);
        frame.frame_flags  = pay->flags;
        frame.reserved     = 0;
        memcpy(frame.raw_pcm,   pay->raw_s16,   FRAME_BYTES_INT16);
        memcpy(frame.clean_pcm, pay->clean_s16, FRAME_BYTES_INT16);

        bool ok = wsClient.sendBIN((const uint8_t *)&frame, WS_FRAME_SIZE);
        sent_count++;
        stat_frames_sent++;

        if (!ok) {
            LOGE("T4:WSSend", "sendBIN FAILED on seq=%lu — connection may be broken",
                 frame.seq_num);
        }

        // Log first frame + every 500 frames
        if (sent_count == 1) {
            LOGI("T4:WSSend", "First binary frame sent OK — seq=0  size=%d bytes",
                 WS_FRAME_SIZE);
        }
        if (sent_count % 500 == 0) {
            LOGD("T4:WSSend", "Stats: sent=%lu  ws_overflow=%lu  dac_overflow=%lu  "
                 "i2s_errors=%lu  peak=%d  ws_queue_used=%d/%d",
                 stat_frames_sent,
                 stat_ws_overflow,
                 stat_dac_overflow,
                 stat_i2s_errors,
                 (int)stat_last_peak,
                 (int)(WS_QUEUE_DEPTH - uxQueueSpacesAvailable(ws_queue)),
                 WS_QUEUE_DEPTH);
        }
    }
}

// ============================================================
//  WebSocket Event Handler
// ============================================================
static void ws_event(WStype_t type, uint8_t *payload, size_t length)
{
    switch (type) {
    case WStype_CONNECTED:
        ws_connected = true;
        seq_counter  = 0;
        LOGI("WS", "Connected to server ws://%s:%d%s",
             WS_SERVER_HOST, WS_SERVER_PORT, WS_SERVER_PATH);
        LOGI("WS", "Sending handshake JSON...");
        {
            StaticJsonDocument<128> doc;
            doc["type"]        = "handshake";
            doc["sample_rate"] = SAMPLE_RATE;
            doc["frame_size"]  = FRAME_SAMPLES;
            doc["frame_bytes"] = WS_FRAME_SIZE;
            doc["ai_model"]    = "passthrough";
            char buf[128];
            serializeJson(doc, buf);
            wsClient.sendTXT(buf);
            LOGI("WS", "Handshake sent: %s", buf);
        }
        break;

    case WStype_DISCONNECTED:
        ws_connected = false;
        LOGW("WS", "Disconnected from server — will retry in 500ms");
        LOGW("WS", "Frames sent before disconnect: %lu", stat_frames_sent);
        break;

    case WStype_TEXT:
        LOGI("WS", "Server message (%d bytes): %.*s",
             (int)length, (int)length, (char *)payload);
        break;

    case WStype_BIN:
        LOGD("WS", "Server sent binary (%d bytes) — unexpected", (int)length);
        break;

    case WStype_ERROR:
        LOGE("WS", "WebSocket error — check server is running at %s:%d",
             WS_SERVER_HOST, WS_SERVER_PORT);
        break;

    case WStype_PING:
        LOGD("WS", "PING received from server");
        break;

    case WStype_PONG:
        LOGD("WS", "PONG received from server");
        break;

    default:
        LOGD("WS", "Unknown WS event type: %d", (int)type);
        break;
    }
}

// ============================================================
//  WiFi
// ============================================================
static void wifi_connect(void)
{
    LOG_SEP("WiFi");
    LOGI("WiFi", "Mode: STA");
    LOGI("WiFi", "SSID: %s", WIFI_SSID);
    LOGI("WiFi", "Connecting", "");

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    uint32_t t0      = millis();
    uint32_t attempt = 0;
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        attempt++;
        Serial.printf(".");
        if (attempt % 20 == 0) {
            LOGW("WiFi", "Still connecting... (%lu ms elapsed)  status=%d",
                 millis() - t0, (int)WiFi.status());
        }
        if (millis() - t0 > 20000) {
            Serial.println();
            LOGE("WiFi", "Connection TIMEOUT after 20s");
            LOGE("WiFi", "Check: SSID correct? 2.4GHz? Password correct?");
            LOGE("WiFi", "Restarting ESP32...");
            delay(500);
            ESP.restart();
        }
    }
    Serial.println();
    LOGI("WiFi", "Connected!");
    LOGI("WiFi", "  IP Address : %s",   WiFi.localIP().toString().c_str());
    LOGI("WiFi", "  Gateway    : %s",   WiFi.gatewayIP().toString().c_str());
    LOGI("WiFi", "  RSSI       : %d dBm", WiFi.RSSI());
    LOGI("WiFi", "  Channel    : %d",   WiFi.channel());
    LOGI("WiFi", "Target server: ws://%s:%d%s",
         WS_SERVER_HOST, WS_SERVER_PORT, WS_SERVER_PATH);
    LOG_SEP("WiFi");
}

// ============================================================
//  setup()
// ============================================================
// void setup(void)
// {
//     Serial.begin(115200);
//     delay(500);

//     Serial.println();
//     Serial.println("========================================");
//     Serial.println("   ESP32-S3 Audio Pipeline  v1.0");
//     Serial.println("========================================");
//     LOGI("BOOT", "Chip: ESP32-S3  Cores: %d  Flash: %luMB  PSRAM: %luKB",
//          ESP.getChipCores(),
//          ESP.getFlashChipSize() / (1024 * 1024),
//          ESP.getPsramSize() / 1024);
//     LOGI("BOOT", "Free heap at boot: %lu bytes", ESP.getFreeHeap());
//     LOGI("BOOT", "IDF version: %s", esp_get_idf_version());

//     // Compile-time frame size check
//     static_assert(sizeof(audio_ws_frame_t) == WS_FRAME_SIZE,
//                   "audio_ws_frame_t size mismatch — check struct padding!");
//     LOGI("BOOT", "Frame layout check: sizeof(audio_ws_frame_t) = %d bytes (expected %d) OK",
//          (int)sizeof(audio_ws_frame_t), WS_FRAME_SIZE);

//     LOGI("BOOT", "Audio config: %d Hz  frame=%d samples (%d ms)  DMA bufs=%d",
//          SAMPLE_RATE, FRAME_SAMPLES,
//          FRAME_SAMPLES * 1000 / SAMPLE_RATE,
//          AUDIO_QUEUE_DEPTH);

//     // Create queues
//     LOGI("BOOT", "Creating RTOS queues...");
//     audio_queue = xQueueCreate(AUDIO_QUEUE_DEPTH, sizeof(uint8_t));
//     ws_queue    = xQueueCreate(WS_QUEUE_DEPTH,    sizeof(ws_payload_t *));
//     dac_queue   = xQueueCreate(4,                 sizeof(ws_payload_t *));

//     if (!audio_queue || !ws_queue || !dac_queue) {
//         LOGE("BOOT", "Queue creation FAILED — not enough heap! Free=%lu", ESP.getFreeHeap());
//         while (1) delay(1000);
//     }
//     LOGI("BOOT", "Queues OK — audio:%d  ws:%d  dac:4",
//          AUDIO_QUEUE_DEPTH, WS_QUEUE_DEPTH);

//     // I2S
//     i2s_init();

//     // WiFi + WebSocket
//     wifi_connect();

//     LOGI("BOOT", "Starting WebSocket client...");
//     wsClient.begin(WS_SERVER_HOST, WS_SERVER_PORT, WS_SERVER_PATH);
//     wsClient.onEvent(ws_event);
//     wsClient.setReconnectInterval(500);
//     LOGI("BOOT", "WebSocket client started — reconnect interval=500ms");

//     // Spawn tasks
//     LOGI("BOOT", "Spawning FreeRTOS tasks...");
//     BaseType_t r1 = xTaskCreatePinnedToCore(
//         task_audio_input,   "AudioIn",   4096, NULL, 6, NULL, 1);
//     BaseType_t r2 = xTaskCreatePinnedToCore(
//         task_audio_process, "AudioProc", 4096, NULL, 5, NULL, 0);
//     BaseType_t r3 = xTaskCreatePinnedToCore(
//         task_audio_output,  "AudioOut",  2048, NULL, 6, NULL, 1);
//     BaseType_t r4 = xTaskCreatePinnedToCore(
//         task_ws_sender,     "WSSend",    4096, NULL, 3, NULL, 0);

//     if (r1 != pdPASS || r2 != pdPASS || r3 != pdPASS || r4 != pdPASS) {
//         LOGE("BOOT", "Task creation FAILED  r1=%d r2=%d r3=%d r4=%d",
//              r1, r2, r3, r4);
//         LOGE("BOOT", "Free heap: %lu bytes", ESP.getFreeHeap());
//         while (1) delay(1000);
//     }

//     LOGI("BOOT", "All 4 tasks spawned:");
//     LOGI("BOOT", "  [T1] AudioIn   — core 1, priority 6");
//     LOGI("BOOT", "  [T2] AudioProc — core 0, priority 5");
//     LOGI("BOOT", "  [T3] AudioOut  — core 1, priority 6");
//     LOGI("BOOT", "  [T4] WSSend    — core 0, priority 3");

//     Serial.println("========================================");
//     LOGI("BOOT", "Pipeline running — streaming to ws://%s:%d%s",
//          WS_SERVER_HOST, WS_SERVER_PORT, WS_SERVER_PATH);
//     Serial.println("========================================");
// }

// // ============================================================
// //  loop() — WebSocket keepalive + periodic health report
// // ============================================================
// static uint32_t last_health_ms = 0;

// void loop(void)
// {
//     wsClient.loop();

//     // Print health report every 5 seconds
//     uint32_t now = millis();
//     if (now - last_health_ms >= 5000) {
//         last_health_ms = now;
//         LOGI("HEALTH", "uptime=%lus  captured=%lu  sent=%lu  "
//              "ws_overflow=%lu  dac_overflow=%lu  i2s_err=%lu  "
//              "peak=%d  heap_free=%lu  wifi_rssi=%d dBm  ws=%s",
//              now / 1000,
//              stat_frames_captured,
//              stat_frames_sent,
//              stat_ws_overflow,
//              stat_dac_overflow,
//              stat_i2s_errors,
//              (int)stat_last_peak,
//              ESP.getFreeHeap(),
//              WiFi.RSSI(),
//              ws_connected ? "CONNECTED" : "DISCONNECTED");
//     }

//     delay(1);
// }


void setup() {
  Serial.begin(115200);
  delay(200);

  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = BUFFER_LEN,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pin = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = -1,
    .data_in_num = I2S_SD
  };

  i2s_driver_install(I2S_PORT, &cfg, 0, NULL);
  i2s_set_pin(I2S_PORT, &pin);
}

void loop() {
  size_t bytes_read = 0;
  esp_err_t r = i2s_read(I2S_PORT, samples, sizeof(samples), &bytes_read, pdMS_TO_TICKS(2));
  if (r != ESP_OK || bytes_read == 0) return;

  int n = bytes_read / 4;
  int32_t peak = 0;
  for (int i = 0; i < n; i++) {
    int32_t v = samples[i] >> 14;
    int32_t a = (v < 0) ? -v : v;
    if (a > peak) peak = a;
  }
  printf("\n%d", peak);
  Serial.println(peak);

  // 200Hz update (đủ nhanh mà Serial không nghẽn)
  delay(5);
}
