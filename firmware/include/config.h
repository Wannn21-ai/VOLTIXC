#pragma once

namespace Config {
static constexpr const char* PROJECT_NAME = "Voltix";
static constexpr const char* DEVICE_ID = "esp32-voltix-001";
static constexpr const char* DEFAULT_DEVICE_NAME = "Voltix-ESP32";
static constexpr const char* FIRMWARE_VERSION = "development";

// Transitional runtime paths. Keep these unchanged until the coordinated
// migration adopts the final helpers in firebase_paths.h.
static constexpr const char* FIREBASE_DEVICE_LIVE_PATH = "/devices/esp32-voltix-001/live";
static constexpr const char* FIREBASE_DEVICE_CONFIG_PATH = "/devices/esp32-voltix-001/config";
static constexpr const char* FIREBASE_COMMAND_CURRENT_PATH = "/devices/esp32-voltix-001/commands/current";
static constexpr const char* FIREBASE_COMMAND_LAST_ACK_PATH = "/devices/esp32-voltix-001/commands/lastAck";
static constexpr const char* FIREBASE_COMPLETED_SESSIONS_PATH = "/devices/esp32-voltix-001/completedSessions";
static constexpr const char* FIREBASE_COMPLETED_SESSION_PATH_FORMAT = "/devices/esp32-voltix-001/completedSessions/%s";

static constexpr int RELAY_PIN = 27;
static constexpr int PZEM_RX_PIN = 16;
static constexpr int PZEM_TX_PIN = 17;
// External DS-134 momentary button on GPIO32 to GND, active LOW.
static constexpr int BUTTON_PIN = 32;
static constexpr int WIFI_LED_PIN = 2;
static constexpr int GREEN_LED_PIN = 25;
static constexpr int RED_LED_PIN = 26;
static constexpr int BUZZER_PIN = 5;

static constexpr bool RELAY_ACTIVE_LOW = true;

static constexpr float DEFAULT_TARIFF = 1444.70f;
static constexpr const char* DEFAULT_CURRENCY = "IDR";
static constexpr float OVERLOAD_THRESHOLD_W = 2000.0f;
static constexpr float LOAD_CURRENT_THRESHOLD_A = 0.02f;
static constexpr float LOAD_POWER_THRESHOLD_W = 1.0f;
static constexpr float AC_PRESENT_MIN_VOLTAGE = 180.0f;
static constexpr unsigned long LOAD_SETTLE_MS = 2000UL;
static constexpr unsigned long LOAD_DETECT_TIMEOUT_MS = 8000UL;
static constexpr unsigned long OFFLINE_LOAD_DETECT_TIMEOUT_MS = 12000UL;
static constexpr unsigned int LOAD_DETECT_STABLE_SAMPLES = 2;

static constexpr unsigned long SENSOR_INTERVAL_MS = 1000UL;
static constexpr unsigned long SESSION_INTERVAL_MS = 1000UL;
static constexpr unsigned long LIVE_PRINT_INTERVAL_MS = 3000UL;
static constexpr unsigned long FIREBASE_TODO_LOG_INTERVAL_MS = 5000UL;
static constexpr unsigned long BOOT_DELAY_MS = 300UL;
}
