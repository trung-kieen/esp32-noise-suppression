#include "audio_processor.h"
#include "i2s_config.h"

AudioProcessor::AudioProcessor() {
    raw_samples = nullptr;
    processed_samples = nullptr;
    sample_count = 0;
}

void AudioProcessor::begin() {
    // Allocate buffers
    raw_samples = (int32_t*)malloc(BUFFER_SIZE * sizeof(int32_t));
    processed_samples = (int16_t*)malloc(BUFFER_SIZE * sizeof(int16_t));

    if (!raw_samples || !processed_samples) {
        Serial.println("ERROR: Failed to allocate audio buffers!");
        return;
    }

    Serial.println("Audio processor initialized");
}

/**
 * @brief Convert 32-bit I2S samples to 16-bit PCM
 * INMP441 provides 24-bit data in 32-bit container, MSB aligned
 */
void AudioProcessor::convertTo16Bit(int32_t* input, int16_t* output, size_t count) {
    for (size_t i = 0; i < count; i++) {
        // Shift right by 16 bits to get the upper 16 bits of the 24-bit sample
        output[i] = (int16_t)(input[i] >> 16);
    }
}

/**
 * @brief Calculate RMS (Root Mean Square) for audio level monitoring
 */
int16_t AudioProcessor::calculateRMS(int16_t* samples, size_t count) {
    int64_t sum = 0;
    for (size_t i = 0; i < count; i++) {
        sum += (int64_t)samples[i] * samples[i];
    }
    return (int16_t)sqrt(sum / count);
}

/**
 * @brief Main audio processing loop
 */
void AudioProcessor::processAudio() {
    // Read samples from I2S
    size_t bytes_read = i2s_read_samples(raw_samples, BUFFER_SIZE);

    if (bytes_read == 0) {
        return;
    }

    size_t samples_read = bytes_read / sizeof(int32_t);

    // Convert to 16-bit
    convertTo16Bit(raw_samples, processed_samples, samples_read);

    sample_count += samples_read;

    // Here you can add further processing:
    // - FFT analysis
    // - Voice activity detection
    // - Send to speech recognition
    // etc.
}

/**
 * @brief Print audio statistics
 */
void AudioProcessor::printAudioStats() {
    if (!processed_samples) return;

    int16_t rms = calculateRMS(processed_samples, BUFFER_SIZE);

    Serial.printf("Samples: %lu | RMS: %d | Min: ",
                  sample_count, rms);

    // Find min/max for monitoring
    int16_t min_val = 32767;
    int16_t max_val = -32768;

    for (size_t i = 0; i < BUFFER_SIZE; i++) {
        if (processed_samples[i] < min_val) min_val = processed_samples[i];
        if (processed_samples[i] > max_val) max_val = processed_samples[i];
    }

    Serial.printf("%d | Max: %d\n", min_val, max_val);
}
