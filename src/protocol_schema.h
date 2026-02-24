#ifndef PROTOCOL_SCHEMA_H
#define PROTOCOL_SCHEMA_H

#include <stdint.h>

#define SAMPLE_RATE 48000
#define FRAME_SIZE 480
#define FRAMES_PER_BATCH 4

typedef struct __attribute__((packed)) {
    uint32_t frame_seq;
    float    vad_prob;
    float    rms_raw;
    int16_t  raw_pcm[FRAME_SIZE];
    int16_t  clean_pcm[FRAME_SIZE];
} AudioFrame; // Exact 1932 bytes

typedef struct __attribute__((packed)) {
    uint32_t magic;         // 0xABCD1234
    uint8_t  version;       // 0x01
    uint8_t  reserved[3];
    uint32_t batch_seq;
    uint32_t timestamp_ms;
} BatchHeader; // Exact 16 bytes

typedef struct __attribute__((packed)) {
    BatchHeader header;
    AudioFrame frames[FRAMES_PER_BATCH];
} BatchPacket; // Exact 7744 bytes

#endif
