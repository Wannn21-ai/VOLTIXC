#include "state.h"
#include "config.h"

#include <string.h>

AppConfig appConfig;
SensorData sensorData;
SessionData sessionData;
SystemMode systemMode = SystemMode::BOOT;

void stateBegin() {
  appConfig.tariffPerKwh = Config::DEFAULT_TARIFF;
  strlcpy(appConfig.currency, Config::DEFAULT_CURRENCY, sizeof(appConfig.currency));
  appConfig.overloadThresholdW = Config::OVERLOAD_THRESHOLD_W;
  appConfig.overloadWarningPercent = 99.0f;
  appConfig.loadCurrentThresholdA = Config::LOAD_CURRENT_THRESHOLD_A;
  appConfig.loadPowerThresholdW = Config::LOAD_POWER_THRESHOLD_W;
  appConfig.loadRemovedDelaySec = 2;
  appConfig.offlineTimeoutSec = 300;
  appConfig.checkpointIntervalSec = 30;
  appConfig.configRevision = 0;
  appConfig.configPendingSync = false;
  strlcpy(appConfig.configSource, "DEFAULT", sizeof(appConfig.configSource));
  strlcpy(appConfig.deviceName, Config::DEFAULT_DEVICE_NAME, sizeof(appConfig.deviceName));
  appConfig.pairingCode[0] = '\0';
  appConfig.paired = false;
  appConfig.ownerUid[0] = '\0';
  appConfig.ownerDisplayName[0] = '\0';

  sensorData.voltage = 0.0f;
  sensorData.current = 0.0f;
  sensorData.power = 0.0f;
  sensorData.energy = 0.0f;
  sensorData.frequency = 0.0f;
  sensorData.powerFactor = 0.0f;
  sensorData.valid = false;
  sensorData.loadDetected = false;
  sensorData.lastReadMs = 0;

  sessionData.state = SessionState::IDLE;
  sessionData.endReason = EndReason::NONE;
  sessionData.sessionId[0] = '\0';
  sessionData.uid[0] = '\0';
  sessionData.deviceName[0] = '\0';
  sessionData.startMode = SystemMode::BOOT;
  sessionData.startedAtMs = 0;
  sessionData.endedAtMs = 0;
  sessionData.lastUpdateMs = 0;
  sessionData.durationMs = 0;
  sessionData.startEnergyKwh = 0.0f;
  sessionData.energyWh = 0.0f;
  sessionData.energyKwh = 0.0f;
  sessionData.cost = 0.0f;
  sessionData.averagePowerW = 0.0f;
  sessionData.peakPowerW = 0.0f;
  sessionData.pendingSync = false;

  systemMode = SystemMode::BOOT;
  Serial.println("[state] Initialized defaults");
}

const char* systemModeToString(SystemMode mode) {
  switch (mode) {
    case SystemMode::BOOT: return "BOOT";
    case SystemMode::ONLINE: return "ONLINE";
    case SystemMode::OFFLINE: return "OFFLINE";
    case SystemMode::SETUP: return "SETUP";
    case SystemMode::TRANSITION: return "TRANSITION";
  }
  return "UNKNOWN";
}

const char* sessionStateToString(SessionState state) {
  switch (state) {
    case SessionState::IDLE: return "IDLE";
    case SessionState::WAITING_LOAD: return "WAITING_LOAD";
    case SessionState::MONITORING: return "MONITORING";
    case SessionState::OVERLOAD: return "OVERLOAD";
    case SessionState::FINISHING: return "FINISHING";
    case SessionState::FINISHED: return "FINISHED";
  }
  return "UNKNOWN";
}

const char* endReasonToString(EndReason reason) {
  switch (reason) {
    case EndReason::NONE: return "NONE";
    case EndReason::USER_STOP: return "USER_STOP";
    case EndReason::LOAD_REMOVED: return "LOAD_REMOVED";
    case EndReason::LOAD_REMOVED_AFTER_POWER_LOSS: return "LOAD_REMOVED_AFTER_POWER_LOSS";
    case EndReason::OVERLOAD: return "OVERLOAD";
    case EndReason::NO_LOAD_DETECTED: return "NO_LOAD_DETECTED";
    case EndReason::POWER_LOSS_RECOVERY: return "POWER_LOSS_RECOVERY";
  }
  return "UNKNOWN";
}

const char* offlineEntryReasonToString(OfflineEntryReason reason) {
  switch (reason) {
    case OfflineEntryReason::AUTO_NO_WIFI: return "AUTO_NO_WIFI";
    case OfflineEntryReason::MANUAL_BOOT_10S: return "BOOT_10S";
    case OfflineEntryReason::MANUAL_CAPTIVE_PORTAL: return "CAPTIVE_PORTAL";
    case OfflineEntryReason::MANUAL_MENU: return "MANUAL_MENU";
  }
  return "UNKNOWN";
}
