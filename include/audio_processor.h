#pragma once
#include <Arduino.h>

class AudioProcessor {
public:
    AudioProcessor();
    void begin();
    void processAudio();
    void printAudioStats();

private:
    int32_t* raw_samples;
    int16_t* processed_samples;
    uint32_t sample_count;

    void convertTo16Bit(int32_t* input, int16_t* output, size_t count);
    int16_t calculateRMS(int16_t* samples, size_t count);
};
