#pragma once

#include <Arduino.h>

enum class MqttCommandType : uint8_t {
  START,
  STOP,
  RELAY,
  RESET
};

struct MqttCommand {
  MqttCommandType type;
  bool hasRelayValue;
  bool relayValue;
};

using MqttCommandHandler = void (*)(const MqttCommand& command);
using MqttConfigHandler = void (*)(const char* json, size_t length);

// Initializes the MQTT client. Connection work runs in the ESP-IDF MQTT task,
// outside the main sensor/session loop.
void mqttBegin();

// Starts MQTT once Wi-Fi is available. This function never waits for a broker.
void mqttLoop();

bool mqttConnected();

void mqttSetCommandHandler(MqttCommandHandler handler);
void mqttSetConfigHandler(MqttConfigHandler handler);

bool mqttPublishStatus(bool online, const char* mode, bool relayOn);
bool mqttPublishTelemetry(
  float voltage,
  float current,
  float power,
  float energy,
  float frequency,
  float powerFactor
);
bool mqttPublishSession(
  bool active,
  const char* sessionId,
  const char* mode,
  unsigned long durationSeconds,
  float energyKwh
);
bool mqttPublishEvent(
  const char* type,
  const char* sessionId = nullptr,
  bool includePower = false,
  float power = 0.0f
);
