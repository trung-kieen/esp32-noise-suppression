#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h> // Sử dụng driver legacy để tương thích v2.0.0
#include "protocol_schema.h"

// --- Cấu hình ---
const char* WIFI_SSID = "virut1969";
const char* WIFI_PASS = "hnabk681969";
const char* WS_HOST = "192.168.1.14";
const int WS_PORT = 8080;

// Cấu hình chân I2S theo Design Doc v1.1
#define I2S_MIC_SCK  GPIO_NUM_4
#define I2S_MIC_WS   GPIO_NUM_5
#define I2S_MIC_SD   GPIO_NUM_6

// --- Khởi tạo tĩnh theo SSOT ---
static BatchPacket global_batch;
static uint32_t global_frame_counter = 0;
static uint32_t global_batch_counter = 0;

QueueHandle_t audioQueue;
WebSocketsClient webSocket;

// --- Task 1: Thu âm (Core 0) ---
void audioInputTask(void *pvParameters) {
    int16_t i2s_raw_buffer[FRAME_SIZE];
    size_t bytes_read;

    while (true) {
        // Đọc 480 samples từ I2S
        esp_err_t result = i2s_read(I2S_NUM_0, i2s_raw_buffer, sizeof(i2s_raw_buffer), &bytes_read, portMAX_DELAY);

        if (result == ESP_OK && bytes_read > 0) {
            xQueueSend(audioQueue, &i2s_raw_buffer, portMAX_DELAY);
        }
    }
}

// --- Task 2: Đóng gói Batch (Core 1) ---
void processingTask(void *pvParameters) {
    int16_t local_pcm[FRAME_SIZE];
    uint8_t frame_idx = 0;

    while (true) {
        if (xQueueReceive(audioQueue, &local_pcm, portMAX_DELAY)) {
            AudioFrame* f = &global_batch.frames[frame_idx];

            f->frame_seq = global_frame_counter++;
            f->vad_prob = 0.99f; // Giả lập RNNoise skip
            f->rms_raw = 0.1f;

            memcpy(f->raw_pcm, local_pcm, sizeof(local_pcm));
            memcpy(f->clean_pcm, local_pcm, sizeof(local_pcm)); // Skip AI

            frame_idx++;

            // Gửi khi đủ 4 frames (1 Batch = 7744 bytes)
            if (frame_idx >= FRAMES_PER_BATCH) {
                global_batch.header.magic = 0xABCD1234;
                global_batch.header.version = 0x01;
                global_batch.header.batch_seq = global_batch_counter++;
                global_batch.header.timestamp_ms = millis();

                if (webSocket.isConnected()) {
                    webSocket.sendBIN((uint8_t*)&global_batch, sizeof(BatchPacket));
                }
                frame_idx = 0;
            }
        }
    }
}

void initI2S() {
    // Cấu hình I2S Legacy
    i2s_config_t i2s_config = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate = SAMPLE_RATE, // 48000
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT, // INMP441 Mono
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 8,
        .dma_buf_len = FRAME_SIZE,
        .use_apll = true, // Bắt buộc dùng APLL cho 48kHz
        .tx_desc_auto_clear = true
    };

    i2s_pin_config_t pin_config = {
        .bck_io_num = I2S_MIC_SCK,
        .ws_io_num = I2S_MIC_WS,
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num = I2S_MIC_SD
    };

    i2s_driver_install(I2S_NUM_0, &i2s_config, 0, NULL);
    i2s_set_pin(I2S_NUM_0, &pin_config);
    i2s_zero_dma_buffer(I2S_NUM_0);
}

void setup() {
    Serial.begin(115200);

    WiFi.begin(WIFI_SSID, WIFI_PASS);
    while (WiFi.status() != WL_CONNECTED) { delay(500); }

    webSocket.begin(WS_HOST, WS_PORT, "/");

    // Queue depth 8 theo thiết kế
    audioQueue = xQueueCreate(8, sizeof(int16_t) * FRAME_SIZE);

    initI2S();

    xTaskCreatePinnedToCore(audioInputTask, "MicTask", 4096, NULL, 10, NULL, 0);
    xTaskCreatePinnedToCore(processingTask, "ProcTask", 8192, NULL, 5, NULL, 1);

}

void loop() {
    webSocket.loop();
}
