#pragma once
#include <driver/i2s.h>

// Pin mapping from Section 3.2 of your design doc
#define I2S_MIC_SCK     GPIO_NUM_4
#define I2S_MIC_WS      GPIO_NUM_5
#define I2S_MIC_SD      GPIO_NUM_6

// Audio specs matching your doc (Section 4.2)
#define SAMPLE_RATE     16000
#define BUFFER_SIZE     512     // samples per frame
#define I2S_PORT        I2S_NUM_0

// DMA buffer config (tuned for low latency)
#define DMA_BUF_COUNT   4
#define DMA_BUF_LEN     512

// Function declarations
esp_err_t i2s_mic_init();
void i2s_mic_deinit();
size_t i2s_read_samples(int32_t* buffer, size_t samples_to_read);
