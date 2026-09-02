#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

// Target integration state only. Existing SystemMode and SessionState remain
// authoritative until a later migration explicitly maps this scaffold.
enum class VoltixDeviceState {
  BOOT,
  WIFI_SETUP,
  IDLE,
  MONITORING_ONLINE,
  MONITORING_OFFLINE,
  TRANSITION_SYNC,
  OVERLOAD_TRIPPED,
  ERROR_STATE
};

struct VoltixIdentity {
  String deviceId;
  String firmwareVersion;
};

struct LiveSystemPayloadInput {
  uint64_t timestamp = 0;
  bool internet = false;
  String mode;
  String relay;
  String wifiStatus;
  String activeSsid;
  String firmwareVersion;
};

struct LiveDevicePayloadInput {
  bool connected = false;
  float voltage = 0.0f;
  float current = 0.0f;
  float power = 0.0f;
  float apparent = 0.0f;
  float powerFactor = 0.0f;
  float frequency = 0.0f;
  float energy = 0.0f;
  float cost = 0.0f;
  unsigned long durationSec = 0;
  bool overload = false;
};

struct HistoryPayloadInput {
  String name;
  uint64_t startTime = 0;
  uint64_t endTime = 0;
  unsigned long durationSec = 0;
  float energyKwh = 0.0f;
  float cost = 0.0f;
  float voltageAvg = 0.0f;
  float currentAvg = 0.0f;
  float powerAvg = 0.0f;
  float powerMax = 0.0f;
  float powerFactorAvg = 0.0f;
  float frequencyAvg = 0.0f;
  float apparentAvg = 0.0f;
  String modeStart;
  String modeEnd;
  String modePath;
  String endReason;
  bool overload = false;
  String syncStatus;
};

// These builders align with docs/device-live-schema.md but are not wired into
// firebase_sync.cpp yet, preserving the current runtime payloads and paths.
void buildLiveSystemPayload(JsonDocument& output, const LiveSystemPayloadInput& input);
void buildLiveDevicePayload(JsonDocument& output, const LiveDevicePayloadInput& input);
void buildHistoryPayload(JsonDocument& output, const HistoryPayloadInput& input);
