#include <Arduino.h>

#include "config.h"
#include "display.h"
#include "firebase_sync.h"
#include "indicators.h"
#include "network.h"
#include "relay.h"
#include "sensor.h"
#include "session.h"
#include "state.h"
#include "storage.h"
#include "time_sync.h"

#include <ctype.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

static constexpr const char* TEST_DEVICE_NAME = "Test Load";
static constexpr float SERIAL_THRESHOLD_MIN_W = 1.0f;
static constexpr float SERIAL_THRESHOLD_MAX_W = 5000.0f;
static constexpr unsigned long REQUESTED_HISTORY_SYNC_RETRY_MS = 2000UL;
static constexpr unsigned long PERIODIC_HISTORY_SYNC_MS = 30000UL;
static constexpr unsigned long HISTORY_CLEANUP_POLL_INTERVAL_MS = 5000UL;
static constexpr unsigned int AUTO_HISTORY_SYNC_MAX_UPLOADS = 3;
static constexpr unsigned long IDLE_COMMAND_POLL_COOLDOWN_MS = 750UL;
static constexpr unsigned long MONITORING_COMMAND_POLL_COOLDOWN_MS = 500UL;
static constexpr unsigned long WAITING_LOAD_COMMAND_POLL_COOLDOWN_MS = 1000UL;
static constexpr unsigned long WAITING_LOAD_TASK_INTERVAL_MS = 250UL;
static constexpr unsigned long COMMAND_POLL_SKIP_LOG_INTERVAL_MS = 1000UL;

static unsigned long lastSensorUpdateMs = 0;
static unsigned long lastSessionUpdateMs = 0;
static unsigned long lastLivePrintMs = 0;
static unsigned long lastFirebaseConfigMs = 0;
static unsigned long lastFirebaseLiveMs = 0;
static unsigned long lastFirebaseCommandCompletedMs = 0;
static unsigned long lastPendingHistorySyncMs = 0;
static unsigned long lastHistoryCleanupPollMs = 0;
static unsigned long offlineNoNetworkSinceMs = 0;
static unsigned long lastCommandPollSkipLogMs = 0;
static char serialCommandBuffer[32];
static size_t serialCommandLength = 0;
static bool serialCommandOverflow = false;
static bool wasWifiConnected = false;
static bool wasOnlineServicesAllowed = false;
static bool wasRecoveryActive = false;
static bool orphanRelayLoadLogged = false;

static const char* transitionTimingLabel(SessionTransitionRefresh type) {
  switch (type) {
    case SessionTransitionRefresh::START_VERIFIED: return "START";
    case SessionTransitionRefresh::STOP_FINISHED: return "STOP";
    default: return "transition";
  }
}

static void flushSessionTransitionPriority(bool onlineServicesAllowed) {
  const SessionTransitionRefresh type = sessionTransitionRefreshType();
  if (type == SessionTransitionRefresh::NONE) {
    return;
  }

  const char* label = transitionTimingLabel(type);
  if (sessionDisplayRefreshRequested()) {
    displayShowStatus();
    sessionMarkDisplayRefreshed();
    Serial.print("[timing] OLED refreshed after ");
    Serial.print(label);
    Serial.print(" millis=");
    Serial.println(millis());
  }

  if (onlineServicesAllowed && sessionLivePublishRequested()) {
    firebasePublishLive();
    lastFirebaseLiveMs = millis();
    sessionMarkLivePublished();
    Serial.print("[timing] live published after ");
    Serial.print(label);
    Serial.print(" millis=");
    Serial.println(millis());
  }
}

static unsigned long commandPollIntervalMs() {
  switch (sessionData.state) {
    case SessionState::WAITING_LOAD:
      return WAITING_LOAD_COMMAND_POLL_COOLDOWN_MS;
    case SessionState::MONITORING:
    case SessionState::OVERLOAD:
    case SessionState::FINISHING:
      return MONITORING_COMMAND_POLL_COOLDOWN_MS;
    default:
      return IDLE_COMMAND_POLL_COOLDOWN_MS;
  }
}

static unsigned long sensorUpdateIntervalMs() {
  return sessionData.state == SessionState::WAITING_LOAD
    ? WAITING_LOAD_TASK_INTERVAL_MS
    : Config::SENSOR_INTERVAL_MS;
}

static unsigned long sessionUpdateIntervalMs() {
  return sessionData.state == SessionState::WAITING_LOAD
    ? WAITING_LOAD_TASK_INTERVAL_MS
    : Config::SESSION_INTERVAL_MS;
}

static bool localRealtimeTasksDue(bool recoveryActive) {
  if (recoveryActive) {
    return false;
  }
  const unsigned long now = millis();
  return now - lastSensorUpdateMs >= sensorUpdateIntervalMs() ||
    now - lastSessionUpdateMs >= sessionUpdateIntervalMs();
}

static void logCommandPollSkipped(const char* reason) {
  const unsigned long now = millis();
  if (lastCommandPollSkipLogMs != 0 &&
      now - lastCommandPollSkipLogMs < COMMAND_POLL_SKIP_LOG_INTERVAL_MS) {
    return;
  }
  lastCommandPollSkipLogMs = now;
  Serial.print("[timing] skipped command poll reason=");
  Serial.println(reason);
}

static bool pollCommandIfDue(
  bool onlineServicesAllowed,
  bool recoveryActive,
  bool force = false,
  bool allowWaitingLoadPreemption = false
) {
  if (!onlineServicesAllowed) {
    return false;
  }

  if (!allowWaitingLoadPreemption && localRealtimeTasksDue(recoveryActive)) {
    logCommandPollSkipped("local tasks due");
    return false;
  }

  const unsigned long now = millis();
  if (!force &&
      lastFirebaseCommandCompletedMs != 0 &&
      now - lastFirebaseCommandCompletedMs < commandPollIntervalMs()) {
    logCommandPollSkipped("cooldown active");
    return false;
  }

  firebasePollCommand();
  lastFirebaseCommandCompletedMs = millis();
  flushSessionTransitionPriority(onlineServicesAllowed);
  if (firebaseTransitionAckRequested()) {
    firebaseFlushTransitionAck();
  }
  return true;
}

static void serviceLocalRealtimeTasks(bool recoveryActive) {
  if (recoveryActive) {
    return;
  }

  unsigned long now = millis();
  bool sensorUpdated = false;
  if (now - lastSensorUpdateMs >= sensorUpdateIntervalMs()) {
    lastSensorUpdateMs = now;
    sensorUpdate();
    sensorUpdated = true;
    Serial.print("[timing] sensor update millis=");
    Serial.println(millis());

    if (!sessionIsActive() && relayIsOn() && sensorData.loadDetected) {
      if (!orphanRelayLoadLogged) {
        orphanRelayLoadLogged = true;
        Serial.println("[SESSION] Ignored load detection without START command");
      }
    } else if (!relayIsOn() || sessionIsActive()) {
      orphanRelayLoadLogged = false;
    }
  }

  now = millis();
  const bool validateAfterSensor =
    sensorUpdated && sessionData.state == SessionState::WAITING_LOAD;
  if (validateAfterSensor ||
      now - lastSessionUpdateMs >= sessionUpdateIntervalMs()) {
    lastSessionUpdateMs = now;
    sessionUpdate();
    Serial.print("[timing] session update millis=");
    Serial.println(millis());
  }
}

static void printLiveData() {
  Serial.print("[live] mode=");
  Serial.print(systemModeToString(systemMode));
  Serial.print(" session=");
  Serial.print(sessionStateToString(sessionData.state));
  Serial.print(" relay=");
  Serial.print(relayIsOn() ? "ON" : "OFF");
  Serial.print(" valid=");
  Serial.print(sensorData.valid ? "yes" : "no");
  Serial.print(" load=");
  Serial.print(sensorData.loadDetected ? "yes" : "no");
  Serial.print(" V=");
  Serial.print(sensorData.voltage, 2);
  Serial.print(" I=");
  Serial.print(sensorData.current, 3);
  Serial.print(" P=");
  Serial.print(sensorData.power, 2);
  Serial.print(" E=");
  Serial.print(sensorData.energy, 6);
  Serial.print(" sessionWh=");
  Serial.print(sessionData.energyWh, 6);
  Serial.print(" sessionE=");
  Serial.print(sessionData.energyKwh, 8);
  Serial.print(" cost=");
  Serial.print(sessionData.cost, 4);
  Serial.print(" ");
  Serial.println(appConfig.currency);
}

static void printHelp() {
  Serial.println("Serial commands: on | off | toggle | status | config | setthreshold <watts> | time | history | count | pending | sync | clearhistory | wificreds | clearwifi | restart | checkpoint | clearcheckpoint | recoverystatus | help");
}

static void printConfig() {
  char revisionText[24];
  snprintf(revisionText, sizeof(revisionText), "%llu", appConfig.configRevision);

  Serial.println("[config] ---- Voltix runtime config ----");
  Serial.print("[config] overloadThreshold=");
  Serial.print(appConfig.overloadThresholdW, 2);
  Serial.println("W");
  Serial.print("[config] tariff=");
  Serial.println(appConfig.tariffPerKwh, 2);
  Serial.print("[config] loadPowerThreshold=");
  Serial.print(appConfig.loadPowerThresholdW, 2);
  Serial.println("W");
  Serial.print("[config] loadCurrentThreshold=");
  Serial.print(appConfig.loadCurrentThresholdA, 3);
  Serial.println("A");
  Serial.print("[config] checkpointIntervalSec=");
  Serial.println(appConfig.checkpointIntervalSec);
  Serial.print("[config] configRevision=");
  Serial.println(revisionText);
  Serial.print("[config] configSource=");
  Serial.println(appConfig.configSource[0] == '\0' ? "UNKNOWN" : appConfig.configSource);
  Serial.print("[config] pendingSync=");
  Serial.println(appConfig.configPendingSync ? "true" : "false");
}

static void setSerialOverloadThreshold(const char* valueText) {
  while (*valueText != '\0' && isspace(static_cast<unsigned char>(*valueText))) {
    valueText++;
  }

  if (*valueText == '\0') {
    Serial.println("[config] ERROR: usage setthreshold <watts>");
    return;
  }

  char* parseEnd = nullptr;
  const float thresholdW = strtof(valueText, &parseEnd);
  while (parseEnd != nullptr && *parseEnd != '\0' && isspace(static_cast<unsigned char>(*parseEnd))) {
    parseEnd++;
  }

  if (parseEnd == valueText || parseEnd == nullptr || *parseEnd != '\0' || !isfinite(thresholdW)) {
    Serial.println("[config] ERROR: threshold must be a numeric watt value");
    return;
  }

  if (thresholdW < SERIAL_THRESHOLD_MIN_W || thresholdW > SERIAL_THRESHOLD_MAX_W) {
    Serial.print("[config] ERROR: threshold must be between ");
    Serial.print(SERIAL_THRESHOLD_MIN_W, 0);
    Serial.print("W and ");
    Serial.print(SERIAL_THRESHOLD_MAX_W, 0);
    Serial.println("W");
    return;
  }

  if (sessionIsActive() || relayIsOn() || sessionRecoveryIsActive()) {
    Serial.println("[config] ERROR: setthreshold requires idle session and relay OFF");
    return;
  }

  appConfig.overloadThresholdW = thresholdW;
  const uint64_t millisRevision = static_cast<uint64_t>(millis());
  const uint64_t nextRevision = appConfig.configRevision + 1ULL;
  appConfig.configRevision = nextRevision > millisRevision ? nextRevision : millisRevision;
  appConfig.configPendingSync = true;
  strlcpy(appConfig.configSource, "SERIAL", sizeof(appConfig.configSource));

  if (!saveLocalConfig()) {
    Serial.print("[config] WARN: overloadThreshold runtime set to ");
    Serial.print(appConfig.overloadThresholdW, 2);
    Serial.println("W but local persistence failed");
    return;
  }

  Serial.print("[config] overloadThreshold set to ");
  Serial.print(appConfig.overloadThresholdW, 2);
  Serial.println("W");
}

static void printStatus() {
  Serial.println("[status] ---- Voltix local test status ----");
  Serial.print("[status] mode=");
  Serial.print(systemModeToString(systemMode));
  Serial.print(" relay=");
  Serial.print(relayIsOn() ? "ON" : "OFF");
  Serial.print(" session=");
  Serial.print(sessionStateToString(sessionData.state));
  Serial.print(" endReason=");
  Serial.println(endReasonToString(sessionData.endReason));

  Serial.print("[status] sensor valid=");
  Serial.print(sensorData.valid ? "yes" : "no");
  Serial.print(" load=");
  Serial.print(sensorData.loadDetected ? "yes" : "no");
  Serial.print(" voltage=");
  Serial.print(sensorData.voltage, 2);
  Serial.print("V current=");
  Serial.print(sensorData.current, 3);
  Serial.print("A power=");
  Serial.print(sensorData.power, 2);
  Serial.print("W energy=");
  Serial.print(sensorData.energy, 6);
  Serial.print("kWh frequency=");
  Serial.print(sensorData.frequency, 2);
  Serial.print("Hz pf=");
  Serial.println(sensorData.powerFactor, 2);

  Serial.print("[status] session active=");
  Serial.print(sessionIsActive() ? "yes" : "no");
  Serial.print(" id=");
  Serial.print(sessionData.sessionId);
  Serial.print(" name=");
  Serial.print(sessionData.deviceName);
  Serial.print(" elapsed=");
  Serial.print(sessionData.durationMs / 1000UL);
  Serial.print("s energyWh=");
  Serial.print(sessionData.energyWh, 6);
  Serial.print(" energy=");
  Serial.print(sessionData.energyKwh, 8);
  Serial.print("kWh cost=");
  Serial.print(sessionData.cost, 4);
  Serial.print(" ");
  Serial.print(appConfig.currency);
  Serial.print(" avgPower=");
  Serial.print(sessionData.averagePowerW, 2);
  Serial.print("W");
  Serial.print(" peakPower=");
  Serial.print(sessionData.peakPowerW, 2);
  Serial.println("W");
  Serial.print("[status] recovery=");
  Serial.println(sessionRecoveryStatus());
  firebasePrintAuthStatus();
}

static void printTimeStatus() {
  const bool synced = timeIsSynced();
  const String date = getDateString();
  const String time = getTimeString();
  const uint64_t unixMs = getUnixMs();
  char unixMsText[24];
  snprintf(unixMsText, sizeof(unixMsText), "%llu", unixMs);

  Serial.print("[time] synced=");
  Serial.print(synced ? "yes" : "no");
  Serial.print(" date=");
  Serial.print(date);
  Serial.print(" time=");
  Serial.print(time);
  Serial.print(" unixMs=");
  Serial.print(unixMsText);
  Serial.print(" millis=");
  Serial.println(millis());
}

static char* trimCommand(char* command) {
  while (*command != '\0' && isspace(static_cast<unsigned char>(*command))) {
    command++;
  }

  char* end = command + strlen(command);
  while (end > command && isspace(static_cast<unsigned char>(*(end - 1)))) {
    end--;
  }
  *end = '\0';

  for (char* cursor = command; *cursor != '\0'; cursor++) {
    *cursor = static_cast<char>(tolower(static_cast<unsigned char>(*cursor)));
  }

  return command;
}

static void processSerialCommand(char* rawCommand) {
  char* command = trimCommand(rawCommand);
  if (command[0] == '\0') {
    return;
  }

  Serial.print("[serial] Command: ");
  Serial.println(command);

  if (strcmp(command, "on") == 0) {
    if (sessionIsActive()) { // Jika sesi sudah aktif, cukup pastikan relay ON
      relaySet(true);
      Serial.println("[serial] OK: relay ON, existing session kept active");
    } else {
      sessionStart(TEST_DEVICE_NAME);
      Serial.println("[serial] OK: relay ON, test session started as Test Load");
    }
    return;
  }

  if (strcmp(command, "off") == 0) {
    if (sessionIsActive()) {
      sessionStop(EndReason::USER_STOP); // Hentikan sesi jika aktif
    } else {
      relaySet(false);
    }
    Serial.println("[serial] OK: relay OFF");
    return;
  }

  if (strcmp(command, "toggle") == 0) {
    const bool turnOn = !relayIsOn();
    if (!turnOn && sessionIsActive()) { // Jika ingin mematikan relay dan ada sesi aktif, hentikan sesi
      sessionStop(EndReason::USER_STOP);
      Serial.println("[serial] OK: relay toggled OFF, session stopped");
    } else {
      relaySet(turnOn);
      Serial.print("[serial] OK: relay toggled ");
      Serial.println(turnOn ? "ON" : "OFF");
    }
    return;
  }

  if (strcmp(command, "status") == 0) {
    Serial.println("[serial] OK: printing status");
    printStatus();
    return;
  }

  if (strcmp(command, "config") == 0) {
    Serial.println("[serial] OK: printing runtime config");
    printConfig();
    return;
  }

  static constexpr const char* SET_THRESHOLD_COMMAND = "setthreshold";
  const size_t setThresholdLength = strlen(SET_THRESHOLD_COMMAND);
  if (strncmp(command, SET_THRESHOLD_COMMAND, setThresholdLength) == 0 &&
      (command[setThresholdLength] == '\0' ||
       isspace(static_cast<unsigned char>(command[setThresholdLength])))) {
    setSerialOverloadThreshold(command + setThresholdLength);
    return;
  }

  if (strcmp(command, "time") == 0) {
    printTimeStatus();
    return;
  }

  if (strcmp(command, "history") == 0) {
    Serial.println("[serial] local history JSON follows");
    if (storagePrintHistoryJson(Serial)) {
      Serial.println();
      Serial.println("[serial] OK: local history JSON");
    } else {
      Serial.println("[serial] ERROR: failed to read local history");
    }
    return;
  }

  if (strcmp(command, "count") == 0) {
    const int count = storageCountHistory();
    if (count >= 0) {
      Serial.print("[serial] OK: local history count=");
      Serial.println(count);
    } else {
      Serial.println("[serial] ERROR: failed to count local history");
    }
    return;
  }

  if (strcmp(command, "pending") == 0) {
    const int count = storageCountPendingHistory();
    if (count >= 0) {
      Serial.print("[serial] OK: pending history count=");
      Serial.println(count);
    } else {
      Serial.println("[serial] ERROR: failed to count pending history");
    }
    return;
  }

  if (strcmp(command, "sync") == 0) {
    if (networkIsConnected()) {
      const bool ok = storageSyncPendingHistoryToFirebase();
      Serial.print("[serial] ");
      Serial.println(ok ? "OK: pending history sync cycle complete" : "WARN: pending history sync cycle incomplete");
    } else {
      Serial.println("[serial] ERROR: WiFi offline, cannot sync pending history");
    }
    return;
  }

  if (strcmp(command, "clearhistory") == 0) {
    if (storageClearHistory()) {
      Serial.println("[serial] OK: local history cleared");
    } else {
      Serial.println("[serial] ERROR: failed to clear local history");
    }
    return;
  }

  if (strcmp(command, "wificreds") == 0) {
    printSavedWiFiStatus();
    return;
  }

  if (strcmp(command, "clearwifi") == 0) {
    clearWiFiCredentials();
    Serial.println("[serial] OK: restarting after WiFi clear");
    ESP.restart();
    return;
  }

  if (strcmp(command, "restart") == 0) {
    Serial.println("[serial] OK: restarting");
    ESP.restart();
    return;
  }

  if (strcmp(command, "checkpoint") == 0) {
    String checkpointJson;
    if (sessionReadCheckpointJson(checkpointJson)) {
      Serial.println("[serial] OK: active session checkpoint JSON");
      Serial.println(checkpointJson);
    } else {
      Serial.println("[serial] ERROR: failed to read active session checkpoint");
    }
    return;
  }

  if (strcmp(command, "clearcheckpoint") == 0) {
    if (sessionClearCheckpoint()) {
      Serial.println("[serial] OK: active session checkpoint cleared");
    } else {
      Serial.println("[serial] ERROR: failed to clear active session checkpoint");
    }
    return;
  }

  if (strcmp(command, "recoverystatus") == 0) {
    Serial.print("[serial] recovery status=");
    Serial.println(sessionRecoveryStatus());
    Serial.print("[serial] recovery active=");
    Serial.println(sessionRecoveryIsActive() ? "yes" : "no");
    return;
  }

  if (strcmp(command, "help") == 0) {
    Serial.println("[serial] OK: printing command list");
    printHelp();
    return;
  }

  Serial.println("[serial] ERROR: unknown command");
  printHelp();
}

static void handleSerialCommands() {
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());

    if (c == '\r' || c == '\n') {
      if (serialCommandOverflow) {
        Serial.println("[serial] ERROR: command too long");
      }
      serialCommandBuffer[serialCommandLength] = '\0';
      if (!serialCommandOverflow) {
        processSerialCommand(serialCommandBuffer);
      }
      serialCommandLength = 0;
      serialCommandBuffer[0] = '\0';
      serialCommandOverflow = false;
      continue;
    }

    if (serialCommandLength < sizeof(serialCommandBuffer) - 1) {
      serialCommandBuffer[serialCommandLength++] = c;
    } else {
      serialCommandOverflow = true;
    }
  }
}

void setup() {
  Serial.begin(115200);
  relayForceOffEarly();
  indicatorsForceSafeEarly();
  delay(Config::BOOT_DELAY_MS);
  Serial.println();
  Serial.println("=== Voltix firmware boot ===");

  stateBegin();
  loadLocalConfig();
  relayBegin();
  sensorBegin();
  indicatorsBegin();
  displayBegin();
  storageBegin();
  sessionBegin();
  sessionRecoveryBegin();
  networkBegin();
  firebaseBegin();
  // Tentukan systemMode awal berdasarkan status jaringan
  systemMode = networkIsPortalActive() ? SystemMode::SETUP : (networkIsConnected() ? SystemMode::ONLINE : SystemMode::OFFLINE);
  displayShowStatus();
  Serial.println("[display] Startup status rendered");
  wasRecoveryActive = sessionRecoveryIsActive();

  Serial.println("[boot] Complete");
  printHelp();
}

void loop() {
  const unsigned long now = millis();

  handleSerialCommands();
  networkUpdate();
  sessionRecoveryUpdate();

  const bool recoveryActive = sessionRecoveryIsActive();
  const bool recoveryCompletedOnline =
    wasRecoveryActive &&
    !recoveryActive &&
    networkIsConnected() &&
    !offlineModeBlocksAutoOnline();
  wasRecoveryActive = recoveryActive;

  const bool wifiConnected = networkIsConnected();
  const bool onlineServicesAllowed = wifiConnected && !offlineModeBlocksAutoOnline();
  const bool onlineRestoredThisLoop = onlineServicesAllowed && !wasOnlineServicesAllowed;
  if (!wifiConnected && wasWifiConnected) {
    sessionWriteCheckpoint(); // Simpan checkpoint jika WiFi terputus saat sesi aktif
    systemMode = SystemMode::OFFLINE;
  }

  if (!wifiConnected &&
      !recoveryActive &&
      !offlineModeIsActive()) {
    if (sessionData.state == SessionState::WAITING_LOAD) {
      offlineNoNetworkSinceMs = 0; // Reset timer jika sedang WAITING_LOAD
      offlineModeEnter(OfflineEntryReason::AUTO_NO_WIFI);
    } else if (!sessionIsActive()) {
      if (offlineNoNetworkSinceMs == 0) {
        offlineNoNetworkSinceMs = now;
      }
      const unsigned long timeoutSec = appConfig.offlineTimeoutSec > 0 ? appConfig.offlineTimeoutSec : 300UL;
      if (now - offlineNoNetworkSinceMs >= timeoutSec * 1000UL) {
        offlineNoNetworkSinceMs = 0; // Reset timer setelah masuk offline mode
        offlineModeEnter(OfflineEntryReason::AUTO_NO_WIFI);
      }
    } else {
      offlineNoNetworkSinceMs = 0;
    }
  } else {
    offlineNoNetworkSinceMs = 0;
  }

  bool commandPollRan = false;
  if (onlineServicesAllowed &&
      sessionData.state == SessionState::WAITING_LOAD &&
      !storageFastHistoryUploadRequested()) {
    commandPollRan = pollCommandIfDue(
      onlineServicesAllowed,
      recoveryActive,
      false,
      true
    );
  }

  serviceLocalRealtimeTasks(recoveryActive);
  offlineModeUpdate();
  flushSessionTransitionPriority(onlineServicesAllowed);
  displayUpdate();

  if (onlineRestoredThisLoop) {
    const bool restoredFromManualOffline = offlineModeHandleOnlineRestored();
    systemMode = SystemMode::ONLINE;
    if (restoredFromManualOffline) {
      Serial.println("[network] Manual offline unlocked, WiFi connected");
    }
    timeSyncBegin();
    firebaseAuthenticateDevice();
    serviceLocalRealtimeTasks(recoveryActive);
    flushSessionTransitionPriority(onlineServicesAllowed);
    displayUpdate();
    if (!storageFastHistoryUploadRequested()) {
      commandPollRan = pollCommandIfDue(onlineServicesAllowed, recoveryActive, true);
    } else {
      logCommandPollSkipped("fast history upload pending");
    }
    if (sessionData.state != SessionState::WAITING_LOAD &&
        !localRealtimeTasksDue(recoveryActive)) {
      firebasePublishLive();
      lastFirebaseLiveMs = millis();
      if (restoredFromManualOffline) {
        Serial.println("[firebase] Live publish after manual offline unlock");
      }
    }
    lastFirebaseConfigMs = millis();
    if (storageCountPendingHistory() > 0) {
      storageRequestPendingHistorySync();
      Serial.println("[history] pending auto-sync requested after online services restored");
    }
  }
  wasWifiConnected = wifiConnected;
  wasOnlineServicesAllowed = onlineServicesAllowed;

  if (onlineServicesAllowed) {
    if (!storageFastHistoryUploadRequested()) {
      commandPollRan =
        pollCommandIfDue(onlineServicesAllowed, recoveryActive) || commandPollRan;
    } else {
      logCommandPollSkipped("fast history upload pending");
    }

    const bool commandTransitionPending = firebaseCommandTransitionPending();
    const bool localTasksDueAfterCommand = localRealtimeTasksDue(recoveryActive);
    const bool waitingLoad = sessionData.state == SessionState::WAITING_LOAD;
    const bool finishing = sessionData.state == SessionState::FINISHING;
    const unsigned long firebaseNow = millis();
    const bool requestedHistorySyncDue =
      storagePendingHistorySyncRequested() &&
      (lastPendingHistorySyncMs == 0 ||
       firebaseNow - lastPendingHistorySyncMs >= REQUESTED_HISTORY_SYNC_RETRY_MS);
    const bool periodicHistorySyncDue =
      lastPendingHistorySyncMs == 0 ||
      firebaseNow - lastPendingHistorySyncMs >= PERIODIC_HISTORY_SYNC_MS;
    const bool fastHistoryUploadDue = storageFastHistoryUploadRequested();
    const bool cleanupPollDue =
      lastHistoryCleanupPollMs == 0 ||
      firebaseNow - lastHistoryCleanupPollMs >= HISTORY_CLEANUP_POLL_INTERVAL_MS;
    const bool requestedHistorySyncEvaluated = requestedHistorySyncDue;
    const bool cleanupRequiredBeforeHistorySync =
      fastHistoryUploadDue ||
      requestedHistorySyncDue ||
      (commandPollRan && periodicHistorySyncDue);
    bool cleanupPollEvaluated = false;
    HistoryCleanupPollResult cleanupResult = HistoryCleanupPollResult::NO_REQUEST;

    if ((cleanupPollDue || cleanupRequiredBeforeHistorySync) &&
        !localTasksDueAfterCommand &&
        !commandTransitionPending) {
      cleanupPollEvaluated = true;
      lastHistoryCleanupPollMs = millis();
      if (waitingLoad) {
        cleanupResult = HistoryCleanupPollResult::SKIPPED_UNSAFE;
        Serial.println("[history-cleanup] skipped reason=waiting load");
      } else if (sessionIsActive()) {
        cleanupResult = HistoryCleanupPollResult::SKIPPED_UNSAFE;
        Serial.println("[history-cleanup] skipped reason=active session");
      } else {
        cleanupResult = firebasePollHistoryCleanup();
      }
    }

    if (fastHistoryUploadDue) {
      if (waitingLoad) {
        Serial.println("[history] fast upload skipped reason=WAITING_LOAD");
      } else if (finishing || commandTransitionPending) {
        Serial.println("[history] fast upload skipped reason=transition pending");
      } else if (sessionIsActive()) {
        Serial.println("[history] fast upload skipped reason=active session");
      } else if (!cleanupPollEvaluated ||
          (cleanupResult != HistoryCleanupPollResult::NO_REQUEST &&
           cleanupResult != HistoryCleanupPollResult::PROCESSED)) {
        Serial.println("[history] fast upload skipped reason=cleanup unavailable");
      } else {
        storageUploadFastCompletedSession();
      }
    }

    if (requestedHistorySyncDue) {
      Serial.println("[history] auto-sync requested=true");
      if (fastHistoryUploadDue) {
        lastPendingHistorySyncMs = firebaseNow;
        Serial.println("[history] auto-sync skipped reason=fast upload pending");
      } else if (waitingLoad) {
        lastPendingHistorySyncMs = firebaseNow;
        Serial.println("[history] auto-sync skipped reason=WAITING_LOAD");
      } else if (finishing || commandTransitionPending) {
        lastPendingHistorySyncMs = firebaseNow;
        Serial.println("[history] auto-sync skipped reason=transition pending");
      } else if (sessionIsActive()) {
        lastPendingHistorySyncMs = firebaseNow;
        Serial.println("[history] auto-sync skipped reason=active session");
      } else if (!cleanupPollEvaluated ||
          (cleanupResult != HistoryCleanupPollResult::NO_REQUEST &&
           cleanupResult != HistoryCleanupPollResult::PROCESSED)) {
        lastPendingHistorySyncMs = firebaseNow;
        Serial.println("[history] auto-sync skipped reason=cleanup unavailable");
      } else {
        if (sessionData.state == SessionState::FINISHED) {
          Serial.println("[history] auto-sync allowed after STOP");
        }
        lastPendingHistorySyncMs = millis();
        Serial.println("[history] auto-sync started");
        Serial.print("[timing] history sync started millis=");
        Serial.println(millis());
        storageSyncPendingHistoryToFirebase(AUTO_HISTORY_SYNC_MAX_UPLOADS);
        Serial.println("[history] sync completed");
        Serial.print("[timing] history sync completed millis=");
        Serial.println(millis());
      }
    }

    if (requestedHistorySyncEvaluated) {
      // Do not repeat requested cleanup/sync or start optional Firebase work this loop.
    } else if (fastHistoryUploadDue) {
      // Do not start optional Firebase work before the just-finished session upload settles.
    } else if (recoveryCompletedOnline && !waitingLoad && !localTasksDueAfterCommand) {
      lastFirebaseLiveMs = firebaseNow;
      firebasePublishLive();
    } else if (commandPollRan &&
        !waitingLoad &&
        !localTasksDueAfterCommand &&
        (lastFirebaseLiveMs == 0 || firebaseNow - lastFirebaseLiveMs >= 2000UL)) {
      lastFirebaseLiveMs = firebaseNow;
      firebasePublishLive();
    } else if (commandPollRan &&
        !localTasksDueAfterCommand &&
        !commandTransitionPending &&
        (requestedHistorySyncDue || periodicHistorySyncDue)) {
      if (waitingLoad || finishing) {
        Serial.println("[history] auto-sync skipped reason=unsafe session state");
      } else if (sessionIsActive()) {
        Serial.println("[history] auto-sync skipped reason=active session");
      } else if (!cleanupPollEvaluated ||
          (cleanupResult != HistoryCleanupPollResult::NO_REQUEST &&
           cleanupResult != HistoryCleanupPollResult::PROCESSED)) {
        Serial.println("[history] auto-sync skipped reason=cleanup unavailable");
      } else {
        lastPendingHistorySyncMs = millis();
        Serial.println("[history] auto-sync started");
        Serial.print("[timing] history sync started millis=");
        Serial.println(millis());
        storageSyncPendingHistoryToFirebase(AUTO_HISTORY_SYNC_MAX_UPLOADS);
        Serial.println("[history] sync completed");
        Serial.print("[timing] history sync completed millis=");
        Serial.println(millis());
      }
    } else if (commandPollRan &&
        !localTasksDueAfterCommand &&
        appConfig.configPendingSync &&
        !commandTransitionPending &&
        !firebaseDeviceConfigPushBlocked() &&
        (lastFirebaseConfigMs == 0 || firebaseNow - lastFirebaseConfigMs >= 30000UL)) {
      lastFirebaseConfigMs = firebaseNow;
      Serial.println("[config] Syncing pending config to Firebase");
      if (firebasePushDeviceConfig()) {
        Serial.println("[config] Pending config sync OK");
      } else {
        Serial.println("[config] Pending config sync FAIL");
      }
    } else if (commandPollRan &&
        !localTasksDueAfterCommand &&
        !commandTransitionPending &&
        (lastFirebaseConfigMs == 0 || firebaseNow - lastFirebaseConfigMs >= 30000UL)) {
      lastFirebaseConfigMs = firebaseNow;
      firebaseReadConfig();
    }
  }

  storageUpdate();
  indicatorsUpdate();

  indicatorsSetWifi(wifiConnected);
  indicatorsSetStatus(
    sessionData.state == SessionState::MONITORING && sensorData.loadDetected,
    sessionData.state == SessionState::OVERLOAD
  );

  if (now - lastLivePrintMs >= Config::LIVE_PRINT_INTERVAL_MS) {
    lastLivePrintMs = now;
    printLiveData();
    displayShowStatus();
  }
}
