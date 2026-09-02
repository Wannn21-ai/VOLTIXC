#pragma once

#include <Arduino.h>

#include "credentials.h"

// Define these values only in include/credentials.h. The checked-in example
// intentionally contains placeholders, never production broker credentials.
#ifndef VOLTIX_MQTT_USERNAME
#define VOLTIX_MQTT_USERNAME ""
#endif

#ifndef VOLTIX_MQTT_PASSWORD
#define VOLTIX_MQTT_PASSWORD ""
#endif

#ifndef VOLTIX_MQTT_ROOT_CA
#define VOLTIX_MQTT_ROOT_CA ""
#endif

namespace MqttConfig {

static constexpr const char* HOST =
  "ed7655203a9e419493d52c0b8771c836.s1.eu.hivemq.cloud";
static constexpr uint16_t PORT = 8883;

// MQTT identity is intentionally separate from the existing Firebase device
// identity while the communication layer is migrated incrementally.
static constexpr const char* DEVICE_ID = "device01";
static constexpr const char* CLIENT_ID = "device01";

static constexpr const char* USERNAME = VOLTIX_MQTT_USERNAME;
static constexpr const char* PASSWORD = VOLTIX_MQTT_PASSWORD;
static constexpr const char* ROOT_CA = VOLTIX_MQTT_ROOT_CA;

static constexpr const char* BASE_TOPIC = "voltix/device01";
static constexpr const char* TOPIC_STATUS = "voltix/device01/status";
static constexpr const char* TOPIC_TELEMETRY = "voltix/device01/telemetry";
static constexpr const char* TOPIC_SESSION = "voltix/device01/session";
static constexpr const char* TOPIC_EVENT = "voltix/device01/event";
static constexpr const char* TOPIC_COMMAND = "voltix/device01/command";
static constexpr const char* TOPIC_CONFIG = "voltix/device01/config";

static constexpr const char* OFFLINE_WILL_PAYLOAD = "{\"online\":false}";
static constexpr uint16_t KEEP_ALIVE_SECONDS = 30;
static constexpr unsigned long RECONNECT_INTERVAL_MS = 10000UL;
static constexpr unsigned long NETWORK_TIMEOUT_MS = 5000UL;
static constexpr size_t MAX_INBOUND_PAYLOAD_BYTES = 512;

}  // namespace MqttConfig
