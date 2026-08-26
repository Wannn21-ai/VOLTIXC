#include "session.h"
#include "config.h"
#include "firebase_sync.h"
#include "network.h"
#include "relay.h"
#include "sensor.h"
#include "state.h"
#include "storage.h"
#include "time_sync.h"

#include <Arduino.h>
#include <Preferences.h>
#include <string.h>

namespace {
constexpr unsigned long RECOVERY_SETTLE_MS = 1200UL;
constexpr unsigned long RECOVERY_SAMPLE_INTERVAL_MS = Config::SENSOR_INTERVAL_MS;
constexpr unsigned long RECOVERY_VALIDATION_TIMEOUT_MS = Config::OFFLINE_LOAD_DETECT_TIMEOUT_MS;
constexpr unsigned long OFFLINE_FINISHED_SUMMARY_MS = 2500UL;
constexpr unsigned long MANUAL_OFFLINE_IDLE_TIMEOUT_MS = 90000UL;
constexpr unsigned long TRYING_ONLINE_DISPLAY_MS = 5000UL;
constexpr const char* PREF_NAMESPACE = "voltix";
constexpr const char* PREF_OFFLINE_DEVICE_COUNTER_NVS = "off_dev_count";
constexpr const char* OFFLINE_SESSION_TAG = "Sesi Offline";

enum class RecoveryState {
  IDLE,
  SETTLING,
  RESUMED,
  FINALIZED,
  FAILED
};

ActiveSessionCheckpoint recoveryCheckpoint;
RecoveryState recoveryState = RecoveryState::IDLE;
unsigned long recoveryStartedAtMs = 0;
unsigned long recoveryLastSampleAtMs = 0;
unsigned int recoveryValidSamples = 0;
unsigned int recoveryLoadSamples = 0;
unsigned int recoveryNoLoadSamples = 0;
unsigned long lastCheckpointWriteMs = 0;
unsigned long elapsedBeforeRecoveryMs = 0;
unsigned long resumeMillis = 0;
unsigned long loadValidationStartedAtMs = 0;
unsigned long loadValidationLastSampleReadMs = 0;
unsigned int loadValidationStableSamples = 0;
unsigned int loadValidationValidSamples = 0;
unsigned int loadValidationSampleIndex = 0;
bool loadValidationWaitingLogged = false;
StartValidationResult startValidationResult = StartValidationResult::NONE;
SessionTransitionRefresh transitionRefreshType = SessionTransitionRefresh::NONE;
bool displayRefreshRequested = false;
bool livePublishRequested = false;
char recoveryStatusText[48] = "idle";
bool recoveryAttemptedThisBoot = false;
bool offlineModeActive = false;
bool offlineNoLoadPrompt = false;
bool offlineReadyForNext = false;
bool offlineManualLock = false;
bool manualOfflineTryingOnline = false;
bool offlineReadyLogged = false;
bool acMissingDuringMonitoringLogged = false;
bool powerLossObservedDuringMonitoring = false;
bool runtimePowerLossPaused = false;
unsigned long powerLossPausedDurationMs = 0;
unsigned int runtimeRecoveryLoadSamples = 0;
unsigned long acMissingSinceMs = 0;
unsigned long loadRemovedSinceMs = 0;
bool lastValidMonitoringSampleAvailable = false;
float lastValidMonitoringVoltage = 0.0f;
float lastValidMonitoringCurrent = 0.0f;
float lastValidMonitoringPower = 0.0f;
float lastValidMonitoringFrequency = 0.0f;
float lastValidMonitoringPowerFactor = 0.0f;
OfflineEntryReason offlineReason = OfflineEntryReason::AUTO_NO_WIFI;
unsigned long offlineFinishedAtMs = 0;
unsigned long manualOfflineIdleStartedAtMs = 0;
unsigned long manualOfflineTryingOnlineAtMs = 0;
unsigned long offlineDeviceCounter = 1UL;
}

static void logSessionStateTransition(SessionState from, SessionState to, const char* reason) {
  Serial.print("[STATE] ");
  Serial.print(sessionStateToString(from));
  Serial.print(" -> ");
  Serial.print(sessionStateToString(to));
  if (reason != nullptr && reason[0] != '\0') {
    Serial.print(" reason=");
    Serial.print(reason);
  }
  Serial.print(" mode=");
  Serial.println(systemModeToString(systemMode));
}

static void logModeStateTransition(const char* from, const char* to, const char* reason) {
  Serial.print("[STATE] ");
  Serial.print(from);
  Serial.print(" -> ");
  Serial.print(to);
  if (reason != nullptr && reason[0] != '\0') {
    Serial.print(" reason=");
    Serial.print(reason);
  }
  Serial.print(" session=");
  Serial.println(sessionStateToString(sessionData.state));
}

static void logOfflineModeState(const char* action, const char* reason) {
  Serial.print("[offline] ");
  Serial.print(action);
  Serial.print(" reason=");
  Serial.println(reason);
}

static void requestTransitionRefresh(SessionTransitionRefresh type) {
  transitionRefreshType = type;
  displayRefreshRequested = true;
  livePublishRequested = true;
}

static void clearTransitionRefreshIfComplete() {
  if (!displayRefreshRequested && !livePublishRequested) {
    transitionRefreshType = SessionTransitionRefresh::NONE;
  }
}

static void clearLastValidMonitoringSample() {
  lastValidMonitoringSampleAvailable = false;
  lastValidMonitoringVoltage = 0.0f;
  lastValidMonitoringCurrent = 0.0f;
  lastValidMonitoringPower = 0.0f;
  lastValidMonitoringFrequency = 0.0f;
  lastValidMonitoringPowerFactor = 0.0f;
}

static void captureLastValidMonitoringSample() {
  if (!sensorData.valid || !sensorData.loadDetected) {
    return;
  }

  lastValidMonitoringSampleAvailable = true;
  lastValidMonitoringVoltage = sensorData.voltage;
  lastValidMonitoringCurrent = sensorData.current;
  lastValidMonitoringPower = sensorData.power;
  lastValidMonitoringFrequency = sensorData.frequency;
  lastValidMonitoringPowerFactor = sensorData.powerFactor;
}

static void updateSessionTotals() {
  const unsigned long now = millis();

  if (sessionData.startedAtMs == 0) {
    sessionData.lastUpdateMs = now;
    return;
  }

  if (!runtimePowerLossPaused &&
      sessionData.lastUpdateMs > 0 && now > sessionData.lastUpdateMs) {
    const unsigned long elapsedMs = now - sessionData.lastUpdateMs;
    if (sensorData.valid && sensorData.power > 0.0f) {
      sessionData.energyWh += sensorData.power * (static_cast<float>(elapsedMs) / 3600000.0f);
    }
  }

  if (runtimePowerLossPaused) {
    sessionData.durationMs = powerLossPausedDurationMs;
  } else if (resumeMillis > 0) {
    sessionData.durationMs = elapsedBeforeRecoveryMs + (now - resumeMillis);
  } else {
    sessionData.durationMs = now - sessionData.startedAtMs;
  }
  sessionData.energyKwh = sessionData.energyWh / 1000.0f;
  if (sensorData.power > sessionData.peakPowerW) {
    sessionData.peakPowerW = sensorData.power;
  }

  sessionData.cost = sessionData.energyKwh * appConfig.tariffPerKwh;
  const float durationHours = static_cast<float>(sessionData.durationMs) / 3600000.0f;
  sessionData.averagePowerW = durationHours > 0.0f ? sessionData.energyWh / durationHours : 0.0f;
  sessionData.lastUpdateMs = now;
}

static void makeSessionId(char* out, size_t outSize, unsigned long startedAtMs) {
  const unsigned long seed = startedAtMs > 0 ? startedAtMs : millis();
  snprintf(out, outSize, "sess_%lu", seed);
}

static unsigned long loadOfflineDeviceCounter() {
  Preferences prefs;
  if (!prefs.begin(PREF_NAMESPACE, true)) {
    return 1UL;
  }

  unsigned long counter = prefs.getULong(PREF_OFFLINE_DEVICE_COUNTER_NVS, 0UL);
  prefs.end();
  return counter == 0 ? 1UL : counter;
}

static bool saveOfflineDeviceCounter(unsigned long nextCounter) {
  Preferences prefs;
  if (!prefs.begin(PREF_NAMESPACE, false)) {
    Serial.println("[offline] Failed to open Preferences for offline device counter");
    return false;
  }

  const size_t written = prefs.putULong(PREF_OFFLINE_DEVICE_COUNTER_NVS, nextCounter);
  prefs.end();
  if (written == 0) {
    Serial.println("[offline] Failed to save offline device counter");
    return false;
  }
  Serial.print("[offline] Offline device counter saved next=");
  Serial.println(nextCounter);
  return true;
}

static void assignOfflineDeviceNameIfNeeded() {
  if (!offlineModeActive || sessionData.deviceName[0] != '\0') {
    return;
  }

  snprintf(sessionData.deviceName, sizeof(sessionData.deviceName), "Device %lu", offlineDeviceCounter);
  Serial.print("[offline] Assigned offline device name=");
  Serial.println(sessionData.deviceName);
  offlineDeviceCounter++;
  if (!saveOfflineDeviceCounter(offlineDeviceCounter)) {
    Serial.println("[offline] Counter kept in RAM; history scan will repair after reboot");
  }
}

static CompletedSessionSnapshot makeFinalSnapshot(EndReason reason) {
  CompletedSessionSnapshot snapshot;
  memset(&snapshot, 0, sizeof(snapshot));

  strlcpy(snapshot.id, sessionData.sessionId, sizeof(snapshot.id));
  strlcpy(snapshot.sessionId, sessionData.sessionId, sizeof(snapshot.sessionId));
  strlcpy(snapshot.uid, sessionData.uid, sizeof(snapshot.uid));
  strlcpy(snapshot.deviceName, sessionData.deviceName, sizeof(snapshot.deviceName));
  snapshot.offlineSession = sessionData.startMode == SystemMode::OFFLINE;
  snapshot.sessionTag = snapshot.offlineSession ? OFFLINE_SESSION_TAG : "";
  snapshot.startMillis = sessionData.startedAtMs;
  snapshot.stopMillis = sessionData.endedAtMs;
  snapshot.durationSec = sessionData.durationMs / 1000UL;
  snapshot.energyWh = sessionData.energyWh;
  snapshot.energyKwh = sessionData.energyKwh;
  snapshot.cost = sessionData.cost;
  snapshot.averagePower = sessionData.averagePowerW;
  snapshot.peakPower = sessionData.peakPowerW;
  snapshot.voltage = lastValidMonitoringSampleAvailable
    ? lastValidMonitoringVoltage
    : sensorData.voltage;
  snapshot.current = lastValidMonitoringSampleAvailable
    ? lastValidMonitoringCurrent
    : sensorData.current;
  snapshot.frequency = lastValidMonitoringSampleAvailable
    ? lastValidMonitoringFrequency
    : sensorData.frequency;
  snapshot.powerFactor = lastValidMonitoringSampleAvailable
    ? lastValidMonitoringPowerFactor
    : sensorData.powerFactor;
  snapshot.tariff = appConfig.tariffPerKwh;
  snapshot.currency = appConfig.currency;
  snapshot.overloadThreshold = appConfig.overloadThresholdW;
  snapshot.endReason = reason;
  snapshot.startMode = sessionData.startMode;
  snapshot.endMode = networkIsConnected() && !offlineModeBlocksAutoOnline() ? SystemMode::ONLINE : systemMode;
  const bool syncedTime = timeIsSynced();
  if (syncedTime) {
    strlcpy(snapshot.date, getDateString().c_str(), sizeof(snapshot.date));
    strlcpy(snapshot.time, getTimeString().c_str(), sizeof(snapshot.time));
    snapshot.timestamp = getUnixMs();
  } else {
    strlcpy(snapshot.date, "-", sizeof(snapshot.date));
    strlcpy(snapshot.time, "-", sizeof(snapshot.time));
    snapshot.timestamp = static_cast<uint64_t>(millis());
    if (snapshot.offlineSession) {
      Serial.println("[time] Offline session has no NTP date, using fallback date=-");
    }
  }
  snapshot.recovered = false;
  snapshot.recoverySource = nullptr;
  return snapshot;
}

static void logHistoryOutcome(const char* sessionId, bool saved, bool pushed, bool pendingSync) {
  Serial.print("[history] LittleFS save ");
  Serial.print(saved ? "OK" : "FAIL");
  Serial.print(" sessionId=");
  Serial.println(sessionId);

  Serial.print("[history] Firebase push ");
  Serial.print(pushed ? "OK" : "FAIL");
  Serial.print(" sessionId=");
  Serial.println(sessionId);

  Serial.print("[history] pendingSync=");
  Serial.print(pendingSync ? "true" : "false");
  Serial.print(" syncStatus=");
  Serial.println(pushed && !pendingSync ? "SYNCED" : (saved ? "PENDING" : "UNSAVED"));
}

static bool shouldCheckpointState() {
  return sessionData.state == SessionState::MONITORING ||
         sessionData.state == SessionState::OVERLOAD;
}

static void fillCheckpointFromSession(ActiveSessionCheckpoint& checkpoint) {
  memset(&checkpoint, 0, sizeof(checkpoint));
  strlcpy(checkpoint.sessionId, sessionData.sessionId, sizeof(checkpoint.sessionId));
  strlcpy(checkpoint.uid, sessionData.uid, sizeof(checkpoint.uid));
  strlcpy(checkpoint.deviceName, sessionData.deviceName, sizeof(checkpoint.deviceName));
  checkpoint.active = shouldCheckpointState();
  checkpoint.sessionState = sessionData.state;
  checkpoint.startMillis = sessionData.startedAtMs;
  checkpoint.elapsedSec = sessionData.durationMs / 1000UL;
  checkpoint.energyWh = sessionData.energyWh;
  checkpoint.energyKwh = sessionData.energyKwh;
  checkpoint.cost = sessionData.cost;
  checkpoint.peakPower = sessionData.peakPowerW;
  checkpoint.averagePower = sessionData.averagePowerW;
  checkpoint.tariff = appConfig.tariffPerKwh;
  strlcpy(checkpoint.currency, appConfig.currency, sizeof(checkpoint.currency));
  checkpoint.overloadThreshold = appConfig.overloadThresholdW;
  checkpoint.startMode = sessionData.startMode;
  checkpoint.startUnixMs = getUnixMs() > sessionData.durationMs ? getUnixMs() - sessionData.durationMs : 0;
  checkpoint.lastCheckpointMs = millis();
  checkpoint.relayState = relayIsOn();
  checkpoint.lastValidVoltage = lastValidMonitoringVoltage;
  checkpoint.lastValidCurrent = lastValidMonitoringCurrent;
  checkpoint.lastValidPower = lastValidMonitoringPower;
  checkpoint.lastValidFrequency = lastValidMonitoringFrequency;
  checkpoint.lastValidPowerFactor = lastValidMonitoringPowerFactor;
  checkpoint.offlineModeActive = offlineModeActive;
  checkpoint.offlineManualLock = offlineManualLock;
  strlcpy(checkpoint.createdFrom, "ESP32", sizeof(checkpoint.createdFrom));
}

static void restoreSessionFromCheckpoint(const ActiveSessionCheckpoint& checkpoint, SessionState state) {
  strlcpy(sessionData.sessionId, checkpoint.sessionId, sizeof(sessionData.sessionId));
  strlcpy(sessionData.uid, checkpoint.uid, sizeof(sessionData.uid));
  strlcpy(sessionData.deviceName, checkpoint.deviceName, sizeof(sessionData.deviceName));
  sessionData.state = state;
  sessionData.endReason = EndReason::NONE;
  sessionData.startedAtMs = checkpoint.startMillis > 0 ? checkpoint.startMillis : millis();
  sessionData.endedAtMs = 0;
  sessionData.lastUpdateMs = millis();
  elapsedBeforeRecoveryMs = checkpoint.elapsedSec * 1000UL;
  resumeMillis = millis();
  sessionData.durationMs = elapsedBeforeRecoveryMs;
  sessionData.startEnergyKwh = sensorData.energy;
  sessionData.energyWh = checkpoint.energyWh;
  sessionData.energyKwh = checkpoint.energyKwh > 0.0f ? checkpoint.energyKwh : checkpoint.energyWh / 1000.0f;
  sessionData.cost = checkpoint.cost;
  sessionData.averagePowerW = checkpoint.averagePower;
  sessionData.peakPowerW = checkpoint.peakPower;
  sessionData.pendingSync = false;
  sessionData.startMode = checkpoint.startMode;
  lastValidMonitoringVoltage = checkpoint.lastValidVoltage;
  lastValidMonitoringCurrent = checkpoint.lastValidCurrent;
  lastValidMonitoringPower = checkpoint.lastValidPower;
  lastValidMonitoringFrequency = checkpoint.lastValidFrequency;
  lastValidMonitoringPowerFactor = checkpoint.lastValidPowerFactor;
  lastValidMonitoringSampleAvailable =
    checkpoint.lastValidVoltage > 0.0f ||
    checkpoint.lastValidCurrent > 0.0f ||
    checkpoint.lastValidPower > 0.0f;
  powerLossObservedDuringMonitoring = true;
  runtimePowerLossPaused = false;
  powerLossPausedDurationMs = 0;
  runtimeRecoveryLoadSamples = 0;
  acMissingSinceMs = 0;
  loadRemovedSinceMs = 0;

  if (checkpoint.tariff > 0.0f) {
    appConfig.tariffPerKwh = checkpoint.tariff;
  }
  if (checkpoint.overloadThreshold > 0.0f) {
    appConfig.overloadThresholdW = checkpoint.overloadThreshold;
  }
  if (checkpoint.currency[0] != '\0') {
    strlcpy(appConfig.currency, checkpoint.currency, sizeof(appConfig.currency));
  }
}

static CompletedSessionSnapshot makeRecoveredSnapshot(const ActiveSessionCheckpoint& checkpoint, EndReason reason) {
  restoreSessionFromCheckpoint(checkpoint, SessionState::MONITORING);
  sessionData.endedAtMs = millis();
  sessionData.endReason = reason;
  sessionData.durationMs = checkpoint.elapsedSec * 1000UL;
  sessionData.cost = sessionData.energyKwh * appConfig.tariffPerKwh;

  CompletedSessionSnapshot snapshot = makeFinalSnapshot(reason);
  snapshot.durationSec = checkpoint.elapsedSec;
  snapshot.recovered = true;
  snapshot.recoverySource = "active_session_checkpoint";
  return snapshot;
}

static void finalizeRecoveredNoLoad() {
  const CompletedSessionSnapshot snapshot = makeRecoveredSnapshot(recoveryCheckpoint, EndReason::LOAD_REMOVED_AFTER_POWER_LOSS);
  sessionData.state = SessionState::FINISHING;
  relaySet(false);

  Serial.print("[history] sessionStop saving sessionId=");
  Serial.print(snapshot.sessionId);
  Serial.print(" reason=");
  Serial.println(endReasonToString(snapshot.endReason));

  const bool saved = storageAppendCompletedSession(snapshot);
  bool queued = false;
  sessionData.pendingSync = saved;

  if (saved) {
    Serial.println("[recovery] Recovered session queued for background cloud sync");
    storageRequestPendingHistorySync();
    storageRequestFastHistoryUpload(snapshot.sessionId);
    Serial.println("[history] pending auto-sync requested after recovered session save");
    if (storageClearActiveSessionCheckpoint()) {
      Serial.println("[recovery] Active checkpoint cleared");
    }
  } else {
    Serial.println("[recovery] Local save failed; active checkpoint retained");
  }
  logHistoryOutcome(snapshot.sessionId, saved, queued, sessionData.pendingSync);

  sessionData.state = SessionState::FINISHED;
  requestTransitionRefresh(SessionTransitionRefresh::STOP_FINISHED);
  if (offlineModeActive) {
    systemMode = SystemMode::OFFLINE;
    offlineNoLoadPrompt = false;
    offlineReadyForNext = true;
    offlineFinishedAtMs = millis();
    manualOfflineTryingOnline = false;
    offlineReadyLogged = false;
    if (offlineManualLock) {
      manualOfflineIdleStartedAtMs = millis();
    }
  }
  recoveryState = saved ? RecoveryState::FINALIZED : RecoveryState::FAILED;
  strlcpy(recoveryStatusText, saved ? "finalized_no_load" : "finalize_failed", sizeof(recoveryStatusText));
  Serial.println("[recovery] No load found, recovery finalized once");
}

static float positiveThresholdOrDefault(float value, float fallback) {
  return value > 0.0f ? value : fallback;
}

static bool isLoadAboveStartThreshold() {
  const float currentThreshold =
    positiveThresholdOrDefault(appConfig.loadCurrentThresholdA, Config::LOAD_CURRENT_THRESHOLD_A);
  const float powerThreshold =
    positiveThresholdOrDefault(appConfig.loadPowerThresholdW, Config::LOAD_POWER_THRESHOLD_W);
  return sensorData.valid &&
         (sensorData.current >= currentThreshold ||
          sensorData.power >= powerThreshold);
}

static bool isLoadBelowNoLoadThreshold() {
  const float currentThreshold =
    positiveThresholdOrDefault(appConfig.loadCurrentThresholdA, Config::LOAD_CURRENT_THRESHOLD_A) * 0.5f;
  const float powerThreshold =
    positiveThresholdOrDefault(appConfig.loadPowerThresholdW, Config::LOAD_POWER_THRESHOLD_W) * 0.5f;
  return !sensorData.valid ||
         (sensorData.current < currentThreshold &&
          sensorData.power < powerThreshold);
}

static void resetLoadValidationState() {
  loadValidationStartedAtMs = 0;
  loadValidationLastSampleReadMs = 0;
  loadValidationStableSamples = 0;
  loadValidationValidSamples = 0;
  loadValidationSampleIndex = 0;
  loadValidationWaitingLogged = false;
}

static unsigned long currentLoadValidationTimeoutMs() {
  return offlineModeActive ? Config::OFFLINE_LOAD_DETECT_TIMEOUT_MS : Config::LOAD_DETECT_TIMEOUT_MS;
}

static void verifyLoadAndStartMonitoring() {
  const unsigned long now = millis();
  const SessionState previousState = sessionData.state;
  assignOfflineDeviceNameIfNeeded();
  // Reset acMissingDuringMonitoringLogged saat sesi dimulai
  acMissingDuringMonitoringLogged = false;
  sessionData.state = SessionState::MONITORING;
  sessionData.endReason = EndReason::NONE;
  sessionData.startedAtMs = now;
  sessionData.endedAtMs = 0;
  sessionData.lastUpdateMs = now;
  sessionData.durationMs = 0;
  sessionData.startEnergyKwh = sensorData.energy;
  sessionData.energyWh = 0.0f;
  sessionData.energyKwh = 0.0f;
  sessionData.cost = 0.0f;
  sessionData.averagePowerW = 0.0f;
  sessionData.peakPowerW = sensorData.power > 0.0f ? sensorData.power : 0.0f;
  sessionData.pendingSync = false;
  powerLossObservedDuringMonitoring = false;
  runtimePowerLossPaused = false;
  powerLossPausedDurationMs = 0;
  runtimeRecoveryLoadSamples = 0;
  acMissingSinceMs = 0;
  loadRemovedSinceMs = 0;
  clearLastValidMonitoringSample();
  captureLastValidMonitoringSample();
  resetLoadValidationState();
  startValidationResult = StartValidationResult::VERIFIED;
  requestTransitionRefresh(SessionTransitionRefresh::START_VERIFIED);
  logSessionStateTransition(previousState, sessionData.state, offlineModeActive ? "offline_load_detected" : "load_detected");
  Serial.println("[LoadCheck] Load verified, monitoring started");
  Serial.print("[timing] load verified millis=");
  Serial.println(now);
  if (offlineModeActive) {
    offlineNoLoadPrompt = false;
    offlineReadyForNext = false;
    manualOfflineIdleStartedAtMs = 0;
    manualOfflineTryingOnline = false;
    offlineReadyLogged = false;
    Serial.println("[offline] Load detected, offline monitoring started");
  }
  sessionWriteCheckpoint();
}

static void clearSessionRuntime(EndReason reason) {
  const SessionState previousState = sessionData.state;
  // Reset semua data sesi ke IDLE dan matikan relay
  relaySet(false);
  sessionData.state = SessionState::IDLE;
  sessionData.endReason = reason;
  sessionData.sessionId[0] = '\0';
  sessionData.uid[0] = '\0';
  sessionData.deviceName[0] = '\0';
  sessionData.startedAtMs = 0;
  sessionData.endedAtMs = 0;
  sessionData.lastUpdateMs = 0;
  sessionData.durationMs = 0;
  sessionData.startEnergyKwh = sensorData.energy; // Simpan energi awal untuk sesi berikutnya
  sessionData.energyWh = 0.0f;
  sessionData.energyKwh = 0.0f;
  sessionData.cost = 0.0f;
  sessionData.averagePowerW = 0.0f;
  sessionData.peakPowerW = 0.0f;
  sessionData.pendingSync = false;
  elapsedBeforeRecoveryMs = 0;
  resumeMillis = 0;
  acMissingDuringMonitoringLogged = false;
  powerLossObservedDuringMonitoring = false;
  runtimePowerLossPaused = false;
  powerLossPausedDurationMs = 0;
  runtimeRecoveryLoadSamples = 0;
  acMissingSinceMs = 0;
  loadRemovedSinceMs = 0;
  clearLastValidMonitoringSample();
  resetLoadValidationState();
  storageClearActiveSessionCheckpoint(); // Pastikan checkpoint dibersihkan

  // Logging
  logSessionStateTransition(previousState, sessionData.state, endReasonToString(reason));
  Serial.println("[RELAY] OFF");
  Serial.println("[SESSION] State -> IDLE");

}

static void cancelLoadValidationNoHistory(EndReason reason = EndReason::NO_LOAD_DETECTED) {
  const SessionState previousState = sessionData.state;
  clearSessionRuntime(reason);
  startValidationResult = StartValidationResult::REJECTED_NO_LOAD;
  logSessionStateTransition(
    previousState,
    sessionData.state,
    reason == EndReason::USER_STOP
      ? "stop during load validation"
      : (offlineModeActive ? "offline no load" : "no load")
  );

  if (offlineModeActive) {
    offlineNoLoadPrompt = true;
    offlineReadyForNext = true;
    offlineFinishedAtMs = 0;
    manualOfflineTryingOnline = false;
    offlineReadyLogged = true;
    logOfflineModeState("No load detected", "relay OFF, counter not incremented, ready for next device");
  } else {
    Serial.println("[LoadCheck] No load detected, START rejected, relay OFF");
  }
}

static void handleLoadValidation() {
  if (sessionData.state != SessionState::WAITING_LOAD) {
    return;
  }

  const unsigned long now = millis();
  if (loadValidationStartedAtMs == 0) {
    loadValidationStartedAtMs = now;
  } // Ini akan di-reset saat sesi dimulai atau di clearSessionRuntime

  if (!loadValidationWaitingLogged) {
    Serial.println("[LOAD DETECT] Settling...");
    Serial.println(offlineModeActive ? "[offline] Waiting load..." : "[LoadCheck] Waiting load");
    loadValidationWaitingLogged = true;
  }

  const unsigned long elapsedMs = now - loadValidationStartedAtMs;
  const unsigned long timeoutMs = currentLoadValidationTimeoutMs();

  if (elapsedMs < Config::LOAD_SETTLE_MS) {
    return; // Tunggu settling time
  }

  if (sensorData.lastReadMs == 0 || // Pastikan ada data sensor baru
      sensorData.lastReadMs == loadValidationLastSampleReadMs) {
    return;
  }
  loadValidationLastSampleReadMs = sensorData.lastReadMs;
  loadValidationSampleIndex++;

  const bool loadDetected = isLoadAboveStartThreshold();
  const bool noLoadSample = isLoadBelowNoLoadThreshold();
  if (sensorData.valid) {
    loadValidationValidSamples++; // Hitung sampel yang valid
  }
  if (loadDetected && sensorData.valid) {
    loadValidationStableSamples++;
  } else if (noLoadSample) {
    loadValidationStableSamples = 0;
  }

  Serial.print("[LOAD DETECT] Sample ");
  Serial.print(loadValidationSampleIndex);
  Serial.print(": V=");
  Serial.print(sensorData.voltage, 1);
  Serial.print(" I=");
  Serial.print(sensorData.current, 3);
  Serial.print(" P=");
  Serial.print(sensorData.power, 2);
  Serial.print(" valid=");
  Serial.print(sensorData.valid ? "yes" : "no");
  Serial.print(" loadDetected=");
  Serial.print(loadDetected ? "yes" : "no");
  Serial.print(" stableSamples=");
  Serial.print(loadValidationStableSamples);
  Serial.print(" validSamples=");
  Serial.print(loadValidationValidSamples);
  Serial.print(" elapsedMs=");
  Serial.print(elapsedMs);
  Serial.print(" timeoutMs=");
  Serial.println(timeoutMs);

  if (loadValidationValidSamples >= Config::LOAD_DETECT_MIN_VALID_SAMPLES &&
      loadValidationStableSamples >= Config::LOAD_DETECT_STABLE_SAMPLES) {
    Serial.println("[LOAD DETECT] Load detected");
    verifyLoadAndStartMonitoring();
    return;
  }

  if (elapsedMs >= timeoutMs) {
    Serial.println("[LOAD DETECT] No load detected");
    Serial.println("[LOAD DETECT] Timeout -> Relay OFF"); // Relay dimatikan di clearSessionRuntime
    cancelLoadValidationNoHistory();
  }
}

void sessionBegin() {
  sessionData.state = SessionState::IDLE;
  sessionData.endReason = EndReason::NONE;
  acMissingDuringMonitoringLogged = false;
  powerLossObservedDuringMonitoring = false;
  runtimePowerLossPaused = false;
  powerLossPausedDurationMs = 0;
  runtimeRecoveryLoadSamples = 0;
  acMissingSinceMs = 0;
  loadRemovedSinceMs = 0;
  clearLastValidMonitoringSample();
  offlineDeviceCounter = loadOfflineDeviceCounter();
  const unsigned long historyCounter = storageNextOfflineDeviceCounterFromHistory();
  if (historyCounter > offlineDeviceCounter) {
    offlineDeviceCounter = historyCounter;
    saveOfflineDeviceCounter(offlineDeviceCounter);
  }
  Serial.print("[offline] Loaded offline device counter=");
  Serial.println(offlineDeviceCounter);
  resetLoadValidationState();
  startValidationResult = StartValidationResult::NONE;
  Serial.println("[session] Ready");
}

bool sessionStart(const char* deviceName) {
  if (sessionIsActive()) {
    return false;
  }

  const char* name = deviceName == nullptr ? appConfig.deviceName : deviceName;
  const unsigned long now = millis(); // Waktu mulai sesi
  const SessionState previousState = sessionData.state;
  strlcpy(sessionData.deviceName, name, sizeof(sessionData.deviceName));
  sessionData.state = SessionState::WAITING_LOAD;
  sessionData.endReason = EndReason::NONE;
  sessionData.startedAtMs = 0;
  makeSessionId(sessionData.sessionId, sizeof(sessionData.sessionId), now);
  sessionData.uid[0] = '\0';
  sessionData.startMode = systemMode;
  sessionData.endedAtMs = 0;
  sessionData.lastUpdateMs = 0;
  sessionData.durationMs = 0;
  sessionData.startEnergyKwh = sensorData.energy;
  sessionData.energyWh = 0.0f;
  sessionData.energyKwh = 0.0f;
  sessionData.cost = 0.0f;
  sessionData.averagePowerW = 0.0f;
  sessionData.peakPowerW = 0.0f;
  sessionData.pendingSync = false;
  elapsedBeforeRecoveryMs = 0;
  resumeMillis = 0;
  powerLossObservedDuringMonitoring = false;
  runtimePowerLossPaused = false;
  powerLossPausedDurationMs = 0;
  runtimeRecoveryLoadSamples = 0;
  acMissingSinceMs = 0;
  loadRemovedSinceMs = 0;
  clearLastValidMonitoringSample();
  loadValidationStartedAtMs = now;
  loadValidationStableSamples = 0;
  loadValidationWaitingLogged = false;
  loadValidationValidSamples = 0; // Reset valid samples
  loadValidationSampleIndex = 0; // Reset sample index
  startValidationResult = StartValidationResult::NONE;

  relaySet(true);
  logSessionStateTransition(previousState, sessionData.state, offlineModeActive ? "offline_start_validation" : "start_validation");
  Serial.println("[LOAD DETECT] Relay ON");
  Serial.println("[LoadCheck] Relay ON for validation");
  Serial.print("[session] Validating load for device ");
  Serial.println(sessionData.deviceName);
  return true;
}

void sessionSetRemoteContext(const char* uid, const char* sessionId) {
  if (uid != nullptr) {
    strlcpy(sessionData.uid, uid, sizeof(sessionData.uid)); // UID dari Firebase
  }
  if (sessionId != nullptr && sessionId[0] != '\0') {
    strlcpy(sessionData.sessionId, sessionId, sizeof(sessionData.sessionId)); // Session ID dari Firebase
  }
  if (shouldCheckpointState()) {
    sessionWriteCheckpoint(); // Simpan checkpoint jika ada perubahan konteks remote
  } // Ini penting untuk recovery jika sesi dimulai dari remote
}

void sessionStop(EndReason reason) {
  if (!sessionIsActive()) {
    if (recoveryState == RecoveryState::FAILED) {
      relaySet(false);
      Serial.println("[session] Stop ignored: failed session checkpoint must be retained");
      return;
    }
    clearSessionRuntime(reason); // Gunakan fungsi reset yang lebih umum
    return;
  }

  Serial.println("[SESSION] Stop requested");
  if (sessionData.state == SessionState::WAITING_LOAD) {
    cancelLoadValidationNoHistory(reason);
    return;
  }

  updateSessionTotals();
  captureLastValidMonitoringSample();
  const SessionState previousState = sessionData.state;
  sessionData.endedAtMs = millis();
  sessionData.endReason = reason;
  sessionData.state = SessionState::FINISHING;
  logSessionStateTransition(previousState, sessionData.state, endReasonToString(reason));
  const CompletedSessionSnapshot snapshot = makeFinalSnapshot(reason);
  relaySet(false);
  Serial.print("[timing] relay OFF millis=");
  Serial.println(millis());

  Serial.print("[history] sessionStop saving sessionId=");
  Serial.print(snapshot.sessionId);
  Serial.print(" reason=");
  Serial.println(endReasonToString(reason));

  Serial.print("[session] Finishing, reason=");
  Serial.println(endReasonToString(reason));

  const bool saved = storageAppendCompletedSession(snapshot);
  bool queued = false;
  sessionData.pendingSync = saved;

  if (saved) {
    storageClearActiveSessionCheckpoint();
    Serial.println("[session] Final session queued for background cloud sync");
    storageRequestPendingHistorySync();
    storageRequestFastHistoryUpload(snapshot.sessionId);
    Serial.println("[history] pending auto-sync requested after sessionStop");
  } else {
    Serial.println("[session] Local save failed, session remains unsynced");
    recoveryState = RecoveryState::FAILED;
    strlcpy(recoveryStatusText, "finalize_failed", sizeof(recoveryStatusText));
    Serial.println("[session] Active checkpoint retained; new sessions blocked until recovery");
  }
  logHistoryOutcome(snapshot.sessionId, saved, queued, sessionData.pendingSync);

  Serial.print("[session] Final snapshot durationSec=");
  Serial.print(snapshot.durationSec);
  Serial.print(" energyWh=");
  Serial.print(snapshot.energyWh, 6);
  Serial.print(" energy_kWh=");
  Serial.print(snapshot.energyKwh, 8);
  Serial.print(" cost=");
  Serial.print(snapshot.cost, 4);
  Serial.print(" peakPower=");
  Serial.print(snapshot.peakPower, 2);
  Serial.print(" date=");
  Serial.print(snapshot.date);
  Serial.print(" time=");
  Serial.print(snapshot.time);
  Serial.print(" timestamp=");
  char timestampText[24];
  snprintf(timestampText, sizeof(timestampText), "%llu", snapshot.timestamp);
  Serial.println(timestampText);
  Serial.print("[session] Final time date=");
  Serial.print(snapshot.date);
  Serial.print(" time=");
  Serial.print(snapshot.time);
  Serial.print(" timestamp=");
  Serial.println(timestampText);

  const SessionState finishingState = sessionData.state;
  sessionData.state = SessionState::FINISHED;
  logSessionStateTransition(finishingState, sessionData.state, endReasonToString(reason));
  requestTransitionRefresh(SessionTransitionRefresh::STOP_FINISHED);
  Serial.print("[timing] state FINISHED millis=");
  Serial.println(millis());
  elapsedBeforeRecoveryMs = 0;
  resumeMillis = 0;
  if (offlineModeActive) {
    offlineNoLoadPrompt = false;
    offlineReadyForNext = true;
    offlineFinishedAtMs = millis();
    manualOfflineTryingOnline = false;
    offlineReadyLogged = false;
    Serial.println("[offline] Session finished, ready for next device");
    Serial.println("[display] Finished summary shown non-blocking");
    if (offlineManualLock) {
      manualOfflineIdleStartedAtMs = millis();
      Serial.println("[offline] Manual offline idle timer started");
    }
    if (reason == EndReason::LOAD_REMOVED && saved) {
      Serial.println("[offline] Load removed, session saved locally");
    }
  }
  Serial.print("[session] Finished name=");
  Serial.print(sessionData.deviceName);
  Serial.print(" durationSec=");
  Serial.print(sessionData.durationMs / 1000UL);
  Serial.print(" energy_kWh=");
  Serial.print(sessionData.energyKwh, 8);
  Serial.print(" cost=");
  Serial.print(sessionData.cost, 4);
  Serial.print(" ");
  Serial.print(appConfig.currency);
  Serial.print(" peakPower=");
  Serial.print(sessionData.peakPowerW, 2);
  Serial.print("W endReason=");
  Serial.print(endReasonToString(reason));
  Serial.print(" saved=");
  Serial.print(saved ? "OK" : "FAIL");
  Serial.print(" firebase=");
  Serial.println(queued ? "QUEUED" : "PENDING");
}

void sessionUpdate() {
  if (sessionData.state == SessionState::WAITING_LOAD) {
    handleLoadValidation();
    return;
  }

  if (!sessionIsActive()) {
    return;
  }

  updateSessionTotals();
  captureLastValidMonitoringSample();

  const unsigned long now = millis();
  const unsigned long checkpointIntervalMs = max(1UL, appConfig.checkpointIntervalSec) * 1000UL;
  if (shouldCheckpointState() &&
      (lastCheckpointWriteMs == 0 || now - lastCheckpointWriteMs >= checkpointIntervalMs)) {
    sessionWriteCheckpoint();
  }

  if (sensorData.valid && sensorData.power >= appConfig.overloadThresholdW) {
    Serial.print("[overload] Triggered power=");
    Serial.print(sensorData.power, 2);
    Serial.print(" threshold=");
    Serial.print(appConfig.overloadThresholdW, 2);
    Serial.print(" mode=");
    Serial.println(systemModeToString(systemMode));
    sessionData.state = SessionState::OVERLOAD; // Set state ke OVERLOAD sebelum stop
    sessionStop(EndReason::OVERLOAD);
    return;
  }

  if (sessionData.state != SessionState::MONITORING) {
    return;
  }

  const bool acPresent = sensorAcInputPresent();
  const bool stableNoLoadSample = sensorData.valid && isLoadBelowNoLoadThreshold();
  const unsigned long stabilizationMs = max(1UL, appConfig.loadRemovedDelaySec) * 1000UL;

  if (!acPresent) {
    loadRemovedSinceMs = 0;
    if (acMissingSinceMs == 0) {
      acMissingSinceMs = now;
      Serial.println("[powerloss] AC missing candidate; waiting stabilization");
    }
    if (now - acMissingSinceMs >= stabilizationMs &&
        !powerLossObservedDuringMonitoring) {
      powerLossObservedDuringMonitoring = true;
      const unsigned long missingElapsedMs = now - acMissingSinceMs;
      powerLossPausedDurationMs = sessionData.durationMs > missingElapsedMs
        ? sessionData.durationMs - missingElapsedMs
        : 0;
      runtimePowerLossPaused = true;
      runtimeRecoveryLoadSamples = 0;
      acMissingDuringMonitoringLogged = true;
      sessionWriteCheckpoint();
      Serial.println("[powerloss] AC loss stabilized; checkpoint retained for same-session recovery");
    }
    return;
  }

  if (acMissingSinceMs > 0) {
    Serial.println("[powerloss] AC restored; evaluating the existing session");
  }
  acMissingSinceMs = 0;
  acMissingDuringMonitoringLogged = false;

  if (runtimePowerLossPaused) {
    if (sensorData.valid && sensorData.loadDetected) {
      runtimeRecoveryLoadSamples++;
      if (runtimeRecoveryLoadSamples < Config::LOAD_DETECT_STABLE_SAMPLES) {
        return;
      }
      elapsedBeforeRecoveryMs = powerLossPausedDurationMs;
      resumeMillis = now;
      runtimePowerLossPaused = false;
      runtimeRecoveryLoadSamples = 0;
      sessionData.lastUpdateMs = now;
      sessionWriteCheckpoint();
      Serial.println("[powerloss] Existing session resumed after stable load returned");
    } else {
      runtimeRecoveryLoadSamples = 0;
      if (!stableNoLoadSample) {
        loadRemovedSinceMs = 0;
        return;
      }
    }
  }

  if (!stableNoLoadSample) {
    if (loadRemovedSinceMs > 0) {
      Serial.println("[load] Load removal candidate cleared");
    }
    loadRemovedSinceMs = 0;
    return;
  }

  if (loadRemovedSinceMs == 0) {
    loadRemovedSinceMs = now;
    Serial.println("[load] Load removal candidate; waiting stabilization");
    return;
  }

  if (now - loadRemovedSinceMs < stabilizationMs) {
    return;
  }

  const EndReason reason = powerLossObservedDuringMonitoring
    ? EndReason::LOAD_REMOVED_AFTER_POWER_LOSS
    : EndReason::LOAD_REMOVED;
  Serial.print("[load] Load removal stabilized, stopping session reason=");
  Serial.println(endReasonToString(reason));
  sessionStop(reason);
}

bool sessionIsActive() {
  return sessionData.state == SessionState::WAITING_LOAD ||
         sessionData.state == SessionState::MONITORING ||
         sessionData.state == SessionState::OVERLOAD ||
         sessionData.state == SessionState::FINISHING;
}

bool sessionConsumeStartValidationResult(StartValidationResult& result) {
  if (startValidationResult == StartValidationResult::NONE) {
    return false;
  }

  result = startValidationResult;
  startValidationResult = StartValidationResult::NONE;
  return true;
}

SessionTransitionRefresh sessionTransitionRefreshType() {
  return transitionRefreshType;
}

bool sessionDisplayRefreshRequested() {
  return displayRefreshRequested;
}

bool sessionLivePublishRequested() {
  return livePublishRequested;
}

void sessionMarkDisplayRefreshed() {
  displayRefreshRequested = false;
  clearTransitionRefreshIfComplete();
}

void sessionMarkLivePublished() {
  livePublishRequested = false;
  clearTransitionRefreshIfComplete();
}

void sessionRecoveryBegin() {
  recoveryState = RecoveryState::IDLE;
  strlcpy(recoveryStatusText, "idle", sizeof(recoveryStatusText));

  if (!storageReadActiveSessionCheckpoint(recoveryCheckpoint) || !recoveryCheckpoint.active) {
    return;
  }

  if (recoveryAttemptedThisBoot) {
    relaySet(false);
    Serial.println("[recovery] Recovery validation already attempted, not retrying");
    return;
  }

  Serial.println("[recovery] active session checkpoint found");
  Serial.println("[recovery] Starting one-time validation");
  offlineModeActive = recoveryCheckpoint.offlineModeActive ||
    recoveryCheckpoint.startMode == SystemMode::OFFLINE;
  offlineManualLock = offlineModeActive && recoveryCheckpoint.offlineManualLock;
  if (offlineModeActive) {
    systemMode = SystemMode::OFFLINE;
    offlineReason = offlineManualLock
      ? OfflineEntryReason::MANUAL_MENU
      : OfflineEntryReason::AUTO_NO_WIFI;
    Serial.println("[recovery] Offline session context restored");
  }
  recoveryAttemptedThisBoot = true;
  recoveryState = RecoveryState::SETTLING;
  strlcpy(recoveryStatusText, "checking_session", sizeof(recoveryStatusText));
  recoveryStartedAtMs = millis();
  recoveryLastSampleAtMs = 0;
  recoveryValidSamples = 0;
  recoveryLoadSamples = 0;
  recoveryNoLoadSamples = 0;

  if (recoveryCheckpoint.relayState) {
    relaySet(true);
  }
}

void sessionRecoveryUpdate() {
  if (recoveryState != RecoveryState::SETTLING) {
    return;
  }

  const unsigned long now = millis();
  if (now - recoveryStartedAtMs < RECOVERY_SETTLE_MS) {
    return;
  }

  if (recoveryLastSampleAtMs > 0 &&
      now - recoveryLastSampleAtMs < RECOVERY_SAMPLE_INTERVAL_MS) {
    return;
  }
  recoveryLastSampleAtMs = now;
  sensorUpdate();
  const bool loadDetected = isLoadAboveStartThreshold();
  const bool noLoadDetected = sensorData.valid && isLoadBelowNoLoadThreshold();
  if (sensorData.valid) {
    recoveryValidSamples++;
    if (loadDetected) {
      recoveryLoadSamples++;
      recoveryNoLoadSamples = 0;
    } else if (noLoadDetected) {
      recoveryNoLoadSamples++;
      recoveryLoadSamples = 0;
    } else {
      recoveryLoadSamples = 0;
      recoveryNoLoadSamples = 0;
    }
  } else {
    recoveryLoadSamples = 0;
    recoveryNoLoadSamples = 0;
  }

  Serial.print("[recovery] Sample valid=");
  Serial.print(sensorData.valid ? "yes" : "no");
  Serial.print(" loadSamples=");
  Serial.print(recoveryLoadSamples);
  Serial.print(" noLoadSamples=");
  Serial.print(recoveryNoLoadSamples);
  Serial.print(" validSamples=");
  Serial.println(recoveryValidSamples);

  if (recoveryValidSamples >= Config::LOAD_DETECT_MIN_VALID_SAMPLES &&
      recoveryLoadSamples >= Config::LOAD_DETECT_STABLE_SAMPLES) {
    restoreSessionFromCheckpoint(recoveryCheckpoint, SessionState::MONITORING);
    relaySet(true); // Pastikan relay ON jika sesi dilanjutkan
    sessionWriteCheckpoint();
    recoveryState = RecoveryState::RESUMED;
    strlcpy(recoveryStatusText, "resumed", sizeof(recoveryStatusText));
    Serial.println("[recovery] session resumed");
    return;
  }

  if (recoveryValidSamples >= Config::LOAD_DETECT_MIN_VALID_SAMPLES &&
      recoveryNoLoadSamples >= Config::LOAD_DETECT_STABLE_SAMPLES) {
    finalizeRecoveredNoLoad();
    return;
  }

  if (now - recoveryStartedAtMs >= RECOVERY_VALIDATION_TIMEOUT_MS) {
    relaySet(false);
    recoveryState = RecoveryState::FAILED;
    strlcpy(recoveryStatusText, "sensor_validation_failed", sizeof(recoveryStatusText));
    Serial.println("[recovery] Validation timeout; relay OFF and checkpoint retained");
  }
}

bool sessionRecoveryIsActive() {
  return recoveryState == RecoveryState::SETTLING ||
         recoveryState == RecoveryState::FAILED;
}

const char* sessionRecoveryStatus() {
  return recoveryStatusText;
}

bool sessionWriteCheckpoint() {
  if (!shouldCheckpointState()) {
    return false;
  }

  updateSessionTotals();
  ActiveSessionCheckpoint checkpoint;
  fillCheckpointFromSession(checkpoint);
  const bool saved = storageWriteActiveSessionCheckpoint(checkpoint);
  if (saved) {
    lastCheckpointWriteMs = millis();
  }
  return saved;
}

bool sessionReadCheckpointJson(String& out) {
  return storageReadActiveSessionCheckpointJson(out);
}

bool sessionClearCheckpoint() {
  return storageClearActiveSessionCheckpoint();
}

bool offlineModeCanStartNextAttempt() {
  return offlineModeActive &&
         !relayIsOn() &&
         !sessionIsActive() &&
         (offlineReadyForNext || offlineNoLoadPrompt || sessionData.state == SessionState::IDLE || sessionData.state == SessionState::FINISHED);
}

bool offlineModeStartNextAttempt(bool firstAttempt) {
  if (!offlineModeCanStartNextAttempt()) {
    return false;
  }

  const bool summaryWasVisible = offlineModeShowFinishedSummary();
  if (summaryWasVisible) { // Jika ringkasan sesi sebelumnya masih tampil, lewati
    Serial.println("[button] BOOT 1s accepted during finished summary");
    Serial.println("[display] Finished summary skipped by next device request");
  }

  systemMode = SystemMode::OFFLINE;
  offlineNoLoadPrompt = false;
  offlineReadyForNext = false;
  if (offlineManualLock && manualOfflineIdleStartedAtMs > 0) {
    manualOfflineIdleStartedAtMs = 0;
    logOfflineModeState("BOOT 1s next device", "manual offline idle timer reset");
  }
  manualOfflineTryingOnline = false;
  offlineFinishedAtMs = 0;
  offlineReadyLogged = false;
  if (sessionData.state == SessionState::FINISHED) {
    sessionData.state = SessionState::IDLE;
  }

  const bool started = sessionStart("");
  if (!started) {
    offlineReadyForNext = true; // Jika gagal start, tetap siap untuk percobaan berikutnya
    return false;
  }
  logSessionStateTransition(SessionState::IDLE, SessionState::WAITING_LOAD, firstAttempt ? "offline_first_attempt" : "offline_next_attempt");
  logModeStateTransition("OFFLINE_MODE", "OFFLINE_MODE", firstAttempt ? "first_attempt_start_validation" : "next_attempt_start_validation");
  if (firstAttempt) {
    Serial.println("[offline] First offline attempt relay ON");
  } else {
    Serial.println("[offline] BOOT 1s next device validation");
  }
  Serial.println("[offline] Next offline validation started");
  return true;
}

bool offlineModeEnter(OfflineEntryReason reason) {
  const bool adoptWaitingLoad =
    sessionData.state == SessionState::WAITING_LOAD &&
    reason == OfflineEntryReason::AUTO_NO_WIFI;
  if ((sessionIsActive() || relayIsOn() || sessionRecoveryIsActive()) &&
      !adoptWaitingLoad) {
    Serial.print("[mode] ONLINE -> OFFLINE rejected session=");
    Serial.print(sessionStateToString(sessionData.state));
    Serial.print(" relay=");
    Serial.print(relayIsOn() ? "ON" : "OFF");
    Serial.print(" recovery=");
    Serial.println(sessionRecoveryIsActive() ? "active" : "idle");
    return false;
  }
  offlineModeActive = true; // Aktifkan mode offline
  offlineReason = reason;
  offlineManualLock = reason == OfflineEntryReason::MANUAL_BOOT_10S ||
                      reason == OfflineEntryReason::MANUAL_CAPTIVE_PORTAL ||
                      reason == OfflineEntryReason::MANUAL_MENU;
  offlineNoLoadPrompt = false;
  offlineReadyForNext = false;
  manualOfflineIdleStartedAtMs = 0;
  manualOfflineTryingOnline = false;
  manualOfflineTryingOnlineAtMs = 0;
  offlineFinishedAtMs = 0;
  offlineReadyLogged = false;
  systemMode = SystemMode::OFFLINE;
  networkStopPortalForOffline(); // Hentikan captive portal jika aktif

  if (offlineManualLock) {
    logOfflineModeState("Enter MANUAL offline", offlineEntryReasonToString(reason));
    logOfflineModeState("Manual offline lock", "enabled");
  } else {
    logOfflineModeState("Enter AUTO offline", offlineEntryReasonToString(reason));
  }
  Serial.print("[offline] Using overload threshold="); // Log threshold yang digunakan
  Serial.print(appConfig.overloadThresholdW, 2);
  Serial.println(" W");

  if (adoptWaitingLoad) {
    // Jika sebelumnya sudah di WAITING_LOAD (misal dari online), adopsi sesi tersebut
    sessionData.startMode = SystemMode::OFFLINE;
    resetLoadValidationState();
    startValidationResult = StartValidationResult::NONE;
    logModeStateTransition("WAITING_LOAD", "OFFLINE_MODE", offlineEntryReasonToString(reason));
    Serial.println("[offline] Existing load validation adopted for offline mode");
    return true;
  }

  offlineModeStartNextAttempt(true); // Mulai percobaan pertama deteksi beban
  return true;
}

bool offlineModeExitManualLockAndTryOnline() {
  if (!offlineModeActive) {
    return false;
  }

  if (sessionIsActive() || relayIsOn() || sessionRecoveryIsActive()) {
    Serial.print("[mode] OFFLINE -> ONLINE rejected session=");
    Serial.print(sessionStateToString(sessionData.state));
    Serial.print(" relay=");
    Serial.print(relayIsOn() ? "ON" : "OFF");
    Serial.print(" recovery=");
    Serial.println(sessionRecoveryIsActive() ? "active" : "idle");
    return false;
  }

  logModeStateTransition("OFFLINE_MODE", "ONLINE", "manual_unlock_menu");
  offlineManualLock = false;
  manualOfflineIdleStartedAtMs = 0;
  manualOfflineTryingOnline = true;
  manualOfflineTryingOnlineAtMs = millis();
  logOfflineModeState("Menu exit offline", "trying online");
  networkReconnectSavedWiFiFromManualOffline();
  return true;
}

void offlineModeUpdate() {
  if (!offlineModeActive) {
    return;
  }

  if (!offlineManualLock && networkIsConnected()) { // Jika tidak terkunci manual dan ada koneksi, beralih ke ONLINE
    systemMode = SystemMode::ONLINE;
  } else {
    systemMode = SystemMode::OFFLINE;
  }

  const unsigned long now = millis();

  if (sessionData.state == SessionState::FINISHED &&
      offlineFinishedAtMs > 0 &&
      now - offlineFinishedAtMs >= OFFLINE_FINISHED_SUMMARY_MS) {
    const SessionState previousState = sessionData.state;
    sessionData.state = SessionState::IDLE; // Kembali ke IDLE setelah ringkasan
    offlineFinishedAtMs = 0;
    logSessionStateTransition(previousState, sessionData.state, "offline summary elapsed");
  }

  if (offlineManualLock &&
      manualOfflineIdleStartedAtMs > 0 &&
      !sessionIsActive() &&
      !relayIsOn() &&
      now - manualOfflineIdleStartedAtMs >= MANUAL_OFFLINE_IDLE_TIMEOUT_MS) {
    offlineManualLock = false;
    manualOfflineIdleStartedAtMs = 0;
    manualOfflineTryingOnline = true;
    manualOfflineTryingOnlineAtMs = now; // Mulai timer untuk display "Trying Online"
    Serial.println("[offline] Manual offline idle timeout, trying online");
    networkReconnectSavedWiFiFromManualOffline();
  }

  if (!sessionIsActive() &&
      !relayIsOn() &&
      !offlineNoLoadPrompt &&
      offlineReadyForNext &&
      offlineFinishedAtMs == 0 &&
      !offlineReadyLogged) { // Log sekali saat siap untuk sesi berikutnya
    offlineReadyLogged = true;
    Serial.println("[offline] Ready for next offline device");
  }
}

bool offlineModeIsActive() {
  return offlineModeActive;
}

bool offlineModeIsManualLocked() {
  return offlineModeActive && offlineManualLock;
}

bool offlineModeBlocksAutoOnline() {
  return offlineModeIsManualLocked();
}

bool offlineModeShowTryingOnline() {
  return manualOfflineTryingOnline &&
         millis() - manualOfflineTryingOnlineAtMs < TRYING_ONLINE_DISPLAY_MS;
}

bool offlineModeShowNoLoadPrompt() {
  return offlineModeActive && offlineNoLoadPrompt;
}

bool offlineModeShowFinishedSummary() {
  return offlineModeActive &&
         sessionData.state == SessionState::FINISHED &&
         offlineFinishedAtMs > 0;
}

bool offlineModeHandleOnlineRestored() {
  if (!offlineModeActive || offlineManualLock) {
    return false;
  }

  const bool restoredFromManual = offlineReason != OfflineEntryReason::AUTO_NO_WIFI ||
                                  manualOfflineTryingOnline;
  const char* restoredState = // Tentukan state yang akan dilanjutkan
    sessionData.state == SessionState::WAITING_LOAD ? "WAITING_LOAD" :
    (sessionData.state == SessionState::MONITORING ? "MONITORING" : "ONLINE");
  offlineModeActive = false;
  offlineNoLoadPrompt = false;
  offlineReadyForNext = false;
  manualOfflineTryingOnline = false;
  manualOfflineIdleStartedAtMs = 0;
  offlineFinishedAtMs = 0;
  offlineReadyLogged = false;
  systemMode = SystemMode::ONLINE;
  logModeStateTransition("OFFLINE_MODE", restoredState, "wifi_restored");

  if (restoredFromManual) {
    Serial.println("[network] Online restored from manual offline");
  }
  return restoredFromManual;
}
