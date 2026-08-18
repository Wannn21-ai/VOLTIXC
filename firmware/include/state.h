#pragma once

#include <Arduino.h>
#include "types.h"

struct AppConfig {
  float tariffPerKwh;
  char currency[8];
  float overloadThresholdW;
  float overloadWarningPercent;
  float loadCurrentThresholdA;
  float loadPowerThresholdW;
  unsigned long loadRemovedDelaySec;
  unsigned long offlineTimeoutSec;
  unsigned long checkpointIntervalSec;
  uint64_t configRevision;
  bool configPendingSync;
  char configSource[24];
  char deviceName[32];
  char pairingCode[8];
};

struct SensorData {
  float voltage;
  float current;
  float power;
  float energy;
  float frequency;
  float powerFactor;
  bool valid;
  bool loadDetected;
  unsigned long lastReadMs;
};

struct SessionData {
  SessionState state;
  EndReason endReason;
  char sessionId[24];
  char uid[64];
  char deviceName[32];
  SystemMode startMode;
  unsigned long startedAtMs;
  unsigned long endedAtMs;
  unsigned long lastUpdateMs;
  unsigned long durationMs;
  float startEnergyKwh;
  float energyWh;
  float energyKwh;
  float cost;
  float averagePowerW;
  float peakPowerW;
  bool pendingSync;
};

struct ActiveSessionCheckpoint {
  char sessionId[24];
  char uid[64];
  char deviceName[32];
  bool active;
  SessionState sessionState;
  unsigned long startMillis;
  unsigned long elapsedSec;
  float energyWh;
  float energyKwh;
  float cost;
  float peakPower;
  float averagePower;
  float tariff;
  char currency[8];
  float overloadThreshold;
  SystemMode startMode;
  uint64_t startUnixMs;
  unsigned long lastCheckpointMs;
  bool relayState;
  char createdFrom[32];
};

struct CompletedSessionSnapshot {
  char id[24];
  char sessionId[24];
  char uid[64];
  char deviceName[32];
  bool offlineSession;
  const char* sessionTag;
  unsigned long startMillis;
  unsigned long stopMillis;
  unsigned long durationSec;
  float energyWh;
  float energyKwh;
  float cost;
  float averagePower;
  float peakPower;
  float voltage;
  float current;
  float frequency;
  float powerFactor;
  float tariff;
  const char* currency;
  float overloadThreshold;
  EndReason endReason;
  SystemMode startMode;
  SystemMode endMode;
  char date[11];
  char time[9];
  uint64_t timestamp;
  bool recovered;
  const char* recoverySource;
};

extern AppConfig appConfig;
extern SensorData sensorData;
extern SessionData sessionData;
extern SystemMode systemMode;

void stateBegin();
