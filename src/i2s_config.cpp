#include "i2s_config.h"
#include <Arduino.h>

/**
 * @brief Initialize I2S for INMP441 microphone
 * @return esp_err_t ESP_OK on success
 */
esp_err_t i2s_mic_init() {
    esp_err_t err;

    // I2S configuration for INMP441
    i2s_config_t i2s_config = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate = SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,  // INMP441 outputs 24-bit in 32-bit frames
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,   // Mono microphone
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = DMA_BUF_COUNT,
        .dma_buf_len = DMA_BUF_LEN,
        .use_apll = false,
        .tx_desc_auto_clear = false,
        .fixed_mclk = 0
    };

    // Pin configuration
    i2s_pin_config_t pin_config = {
        .bck_io_num = I2S_MIC_SCK,      // Bit clock (SCK)
        .ws_io_num = I2S_MIC_WS,        // Word select (WS/LRCLK)
        .data_out_num = I2S_PIN_NO_CHANGE,  // Not used for RX
        .data_in_num = I2S_MIC_SD       // Serial data (SD)
    };

    // Install and start I2S driver
    err = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
    if (err != ESP_OK) {
        Serial.printf("Failed to install I2S driver: %d\n", err);
        return err;
    }

    err = i2s_set_pin(I2S_PORT, &pin_config);
    if (err != ESP_OK) {
        Serial.printf("Failed to set I2S pins: %d\n", err);
        i2s_driver_uninstall(I2S_PORT);
        return err;
    }

    // Clear I2S buffer
    i2s_zero_dma_buffer(I2S_PORT);

    Serial.println("I2S microphone initialized successfully");
    Serial.printf("Sample Rate: %d Hz\n", SAMPLE_RATE);
    Serial.printf("Buffer Size: %d samples\n", BUFFER_SIZE);
    Serial.printf("DMA Buffers: %d x %d\n", DMA_BUF_COUNT, DMA_BUF_LEN);

    return ESP_OK;
}

/**
 * @brief Deinitialize I2S
 */
void i2s_mic_deinit() {
    i2s_driver_uninstall(I2S_PORT);
    Serial.println("I2S microphone deinitialized");
}

/**
 * @brief Read samples from I2S microphone
 * @param buffer Pointer to buffer for storing samples (32-bit)
 * @param samples_to_read Number of samples to read
 * @return size_t Number of bytes actually read
 */
size_t i2s_read_samples(int32_t* buffer, size_t samples_to_read) {
    size_t bytes_read = 0;
    size_t bytes_to_read = samples_to_read * sizeof(int32_t);

    esp_err_t result = i2s_read(I2S_PORT, buffer, bytes_to_read, &bytes_read, portMAX_DELAY);

    if (result != ESP_OK) {
        Serial.printf("I2S read error: %d\n", result);
        return 0;
    }

    return bytes_read;
}
