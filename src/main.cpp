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


#include <Adafruit_NeoPixel.h>

#define LED_BUILTIN_PIN 38 // NeoPixel pin on ESP32S3
#define NUM_PIXELS 1       // Number of NeoPixels

Adafruit_NeoPixel inbuilt_led(NUM_PIXELS, LED_BUILTIN_PIN, NEO_GRB + NEO_KHZ800);

void setup()
{
  // Initialize serial communication at 115200 bits per second:
  Serial.begin(115200);
  while (!Serial)
  {
    delay(10);
  }

  inbuilt_led.begin();
  inbuilt_led.setBrightness(5); // Set brightness to 5% (0 to 255)
}

void loop()
{
  printf("*");
  inbuilt_led.clear(); // Clear the NeoPixel
  inbuilt_led.show();
  Serial.println("OFF");
  delay(500); // Wait for 500 milliseconds

  inbuilt_led.setPixelColor(0, inbuilt_led.Color(255, 0, 0)); // Set NeoPixel color (Red)
  inbuilt_led.show();
  Serial.println("ON");
  delay(500); // Wait for 500 milliseconds
}
