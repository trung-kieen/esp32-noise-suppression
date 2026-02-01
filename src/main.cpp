// #include <Arduino.h>
// #include "i2s_config.h"
// #include "audio_processor.h"

// AudioProcessor audioProc;
// unsigned long lastStatsTime = 0;
// const unsigned long STATS_INTERVAL = 1000; // Print stats every 1 second

// void setup() {
//     // Initialize Serial
//     Serial.begin(115200);
//     while (!Serial) {
//         delay(10);
//     }

//     delay(1000); // Give time for serial monitor

//     Serial.println("\n\n=================================");
//     Serial.println("ESP32-S3 + INMP441 I2S Microphone");
//     Serial.println("=================================\n");

//     // Initialize I2S microphone
//     esp_err_t err = i2s_mic_init();
//     if (err != ESP_OK) {
//         Serial.println("FATAL: I2S initialization failed!");
//         while (1) {
//             delay(1000);
//         }
//     }

//     // Initialize audio processor
//     audioProc.begin();

//     Serial.println("\nSystem ready! Listening for audio...\n");
// }

// void loop() {
//     // Continuously process audio
//     audioProc.processAudio();

//     // Print statistics periodically
//     unsigned long currentTime = millis();
//     if (currentTime - lastStatsTime >= STATS_INTERVAL) {
//         audioProc.printAudioStats();
//         lastStatsTime = currentTime;
//     }
// }
//


#include <Arduino.h>
#include <WiFi.h>
#include <esp_chip_info.h>
#include <esp_flash.h>

// Kiểm tra nếu chưa định nghĩa mới define (tránh warning)
#ifndef LED_BUILTIN
#define LED_BUILTIN 38  // Thử 2, 8, 38, 48 nếu không sáng
#endif

void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println("\n\n================================");
    Serial.println("ESP32-S3 WROOM-1 N16R8 TEST");
    Serial.println("================================");

    // 1. TEST LED CƠ BẢN
    Serial.println("\n[1] TEST LED...");
    pinMode(LED_BUILTIN, OUTPUT);
    for(int i=0; i<5; i++) {
        digitalWrite(LED_BUILTIN, HIGH);
        delay(200);
        digitalWrite(LED_BUILTIN, LOW);
        delay(200);
    }
    Serial.println("    -> LED blink OK!");

    // 2. THÔNG TIN CHIP
    Serial.println("\n[2] CHIP INFO:");
    esp_chip_info_t chip_info;
    esp_chip_info(&chip_info);

    Serial.printf("    Chip Model: %s\n", CONFIG_IDF_TARGET);
    Serial.printf("    Cores: %d\n", chip_info.cores);
    Serial.printf("    Revision: %d\n", chip_info.revision);
    Serial.printf("    Features: %s%s%s\n",
        (chip_info.features & CHIP_FEATURE_WIFI_BGN) ? "WiFi " : "",
        (chip_info.features & CHIP_FEATURE_BLE) ? "BLE " : "",
        (chip_info.features & CHIP_FEATURE_EMB_PSRAM) ? "PSRAM" : "");

    // 3. TEST FLASH (16MB)
    Serial.println("\n[3] FLASH MEMORY:");
    uint32_t flash_size;
    if(esp_flash_get_size(NULL, &flash_size) == ESP_OK) {
        Serial.printf("    Flash Size: %d MB\n", flash_size / (1024*1024));
        Serial.printf("    Flash Speed: %d MHz\n", ESP.getFlashChipSpeed()/1000000);
    }

    // 4. TEST PSRAM (8MB) - QUAN TRỌNG NHẤT
    Serial.println("\n[4] PSRAM TEST (8MB Octal):");
    if(psramInit()) {
        Serial.printf("    PSRAM Status: OK\n");
        Serial.printf("    Total PSRAM: %d bytes (%.2f MB)\n",
            ESP.getPsramSize(), ESP.getPsramSize()/(1024.0*1024.0));
        Serial.printf("    Free PSRAM: %d bytes\n", ESP.getFreePsram());

        // Test cấp phát bộ nhớ lớn
        Serial.println("    Testing large memory allocation (4MB)...");
        size_t test_size = 4 * 1024 * 1024;
        uint8_t *test_mem = (uint8_t*)ps_malloc(test_size);

        if(test_mem) {
            // Ghi dữ liệu test pattern
            memset(test_mem, 0xA5, test_size);

            // Kiểm tra pattern
            bool mem_ok = true;
            for(size_t i=0; i<test_size; i+=4096) {
                if(test_mem[i] != 0xA5) {
                    mem_ok = false;
                    break;
                }
            }
            free(test_mem);
            Serial.printf("    -> Memory Test: %s\n", mem_ok ? "PASS" : "FAIL");
        } else {
            Serial.println("    -> FAIL: Cannot allocate 4MB");
        }
    } else {
        Serial.println("    -> FAIL: PSRAM not initialized!");
    }

    // 5. TEST WIFI SCAN
    Serial.println("\n[5] WIFI SCAN:");
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    delay(100);

    int n = WiFi.scanNetworks();
    Serial.printf("    Networks found: %d\n", n);
    if(n > 0) {
        for(int i=0; i<min(n, 5); i++) {
            Serial.printf("      %d: %s (%d dBm)\n",
                i+1, WiFi.SSID(i).c_str(), WiFi.RSSI(i));
        }
    }

    // 6. TEST TOUCH SENSOR (thay cho Hall Sensor)
    Serial.println("\n[6] TOUCH SENSOR TEST:");
    Serial.println("    Touch pins available: 1-14");
    // Đọc giá trị touch ở GPIO1 (TD1)
    int touch_val = touchRead(T1);  // GPIO1
    Serial.printf("    Touch T1 (GPIO1): %d\n", touch_val);
    Serial.println("    (Lower value = touched, Normal > 50000)");

    // 7. TEST ADC
    Serial.println("\n[7] ADC TEST:");
    analogReadResolution(12);  // 12-bit ADC
    int adc_val = analogRead(1);  // GPIO1 - ADC1_CH0
    Serial.printf("    ADC GPIO1 (12-bit): %d / 4095\n", adc_val);

    // 8. BENCHMARK TỐC ĐỘ CPU
    Serial.println("\n[8] CPU BENCHMARK:");
    uint32_t start = millis();
    volatile uint64_t dummy = 0;
    for(uint32_t i=0; i<10000000; i++) {
        dummy += i;
    }
    uint32_t elapsed = millis() - start;
    Serial.printf("    10M iterations: %d ms\n", elapsed);
    Serial.printf("    CPU Freq: %d MHz\n", getCpuFrequencyMhz());

    Serial.println("\n================================");
    Serial.println("SETUP COMPLETE - ENTERING LOOP");
    Serial.println("================================");
}

void loop() {
    // Blink LED
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));

    // Hiển thị thông số hệ thống
    Serial.printf("[Alive] Uptime: %ds | Heap: %d KB | PSRAM: %d KB | Temp: %.1f°C\n",
        millis()/1000,
        ESP.getFreeHeap()/1024,
        ESP.getFreePsram()/1024,
        temperatureRead());

    delay(5000);
}
