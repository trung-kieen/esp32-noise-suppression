#pragma once
#include <stdint.h>

// ============================================================
//  Audio Constants — Single Source of Truth
//  DO NOT CHANGE unless you also change RNNoise model
// ============================================================
#define SAMPLE_RATE         48000
#define FRAME_SAMPLES       480         // 10ms @ 48kHz — RNNoise requirement
#define FRAME_BYTES_INT32   (FRAME_SAMPLES * 4)   // DMA buffer (I2S 32-bit)
#define FRAME_BYTES_INT16   (FRAME_SAMPLES * 2)   // PCM int16

// I2S pins — INMP441 (RX)
#define I2S_MIC_SCK         GPIO_NUM_4
#define I2S_MIC_WS          GPIO_NUM_5
#define I2S_MIC_SD          GPIO_NUM_6

// I2S pins — MAX98357A (TX)
#define I2S_SPK_DOUT        GPIO_NUM_17
#define I2S_SPK_BCLK        GPIO_NUM_8
#define I2S_SPK_LRC         GPIO_NUM_9

// RTOS queue depths
#define AUDIO_QUEUE_DEPTH   4    // DMA -> inference (frames)
#define WS_QUEUE_DEPTH      8    // inference -> WS sender (80ms buffer)

// ============================================================
//  Binary WebSocket Frame Layout (1932 bytes)
//  [ 4:seq | 4:ts_ms | 2:vad | 1:flags | 1:rsvd |
//    960:raw_pcm | 960:clean_pcm ]
// ============================================================
#define WS_FRAME_SIZE       1932

#pragma pack(push, 1)
typedef struct {
    uint32_t seq_num;
    uint32_t timestamp_ms;
    uint16_t vad_prob;       // 0..65535 = 0.0..1.0
    uint8_t  frame_flags;
    uint8_t  reserved;
    int16_t  raw_pcm[FRAME_SAMPLES];
    int16_t  clean_pcm[FRAME_SAMPLES];
} audio_ws_frame_t;          // must be exactly 1932 bytes
#pragma pack(pop)

// frame_flags bitmask
#define FLAG_QUEUE_OVERFLOW  0x01
#define FLAG_WIFI_RETRANSMIT 0x02
#define FLAG_HIGH_NOISE      0x04

// Payload passed through RTOS queues (by pointer to avoid copy)
typedef struct {
    int16_t  raw_s16[FRAME_SAMPLES];
    int16_t  clean_s16[FRAME_SAMPLES];
    float    vad_probability;
    uint8_t  flags;
} ws_payload_t;
