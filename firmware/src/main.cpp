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
static constexpr unsigned int AUTO_HISTORY_SYNC_MAX_UPLOADS = 3;

static unsigned long lastSensorUpdateMs = 0;
static unsigned long lastSessionUpdateMs = 0;
static unsigned long lastLivePrintMs = 0;
static unsigned long lastFirebaseConfigMs = 0;
static unsigned long lastFirebaseLiveMs = 0;
static unsigned long lastFirebaseCommandMs = 0;
static unsigned long lastPendingHistorySyncMs = 0;
static unsigned long offlineNoNetworkSinceMs = 0;
static char serialCommandBuffer[32];
static size_t serialCommandLength = 0;
static bool serialCommandOverflow = false;
static bool wasWifiConnected = false;
static bool wasOnlineServicesAllowed = false;
static bool wasRecoveryActive = false;

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
    if (sessionIsActive()) {
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
      sessionStop(EndReason::USER_STOP);
    } else {
      relaySet(false);
    }
    Serial.println("[serial] OK: relay OFF");
    return;
  }

  if (strcmp(command, "toggle") == 0) {
    const bool turnOn = !relayIsOn();
    if (!turnOn && sessionIsActive()) {
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

  if (sessionRecoveryIsActive() || networkIsPortalActive()) {
    displayShowStatus();
  } else {
    displayShowBoot();
  }
  systemMode = networkIsPortalActive() ? SystemMode::SETUP : (networkIsConnected() ? SystemMode::ONLINE : SystemMode::OFFLINE);
  wasRecoveryActive = sessionRecoveryIsActive();

  Serial.println("[boot] Complete");
  printHelp();
  networkMarkBootComplete();
}

void loop() {
  const unsigned long now = millis();

  handleSerialCommands();
  networkUpdate();
  sessionRecoveryUpdate();

  const bool recoveryActive = sessionRecoveryIsActive();
  if (wasRecoveryActive && !recoveryActive && networkIsConnected() && !offlineModeBlocksAutoOnline()) {
    firebasePublishLive();
  }
  wasRecoveryActive = recoveryActive;

  const bool wifiConnected = networkIsConnected();
  const bool onlineServicesAllowed = wifiConnected && !offlineModeBlocksAutoOnline();
  if (onlineServicesAllowed && !wasOnlineServicesAllowed) {
    const bool restoredFromManualOffline = offlineModeHandleOnlineRestored();
    systemMode = SystemMode::ONLINE;
    if (restoredFromManualOffline) {
      Serial.println("[network] Manual offline unlocked, WiFi connected");
    }
    timeSyncBegin();
    firebaseAuthenticateDevice();
    firebasePollCommand();
    flushSessionTransitionPriority(onlineServicesAllowed);
    if (firebaseTransitionAckRequested()) {
      firebaseFlushTransitionAck();
    }
    firebasePublishLive();
    if (restoredFromManualOffline) {
      Serial.println("[firebase] Live publish after manual offline unlock");
    }
    lastFirebaseConfigMs = now;
    lastFirebaseLiveMs = now;
    if (storageCountPendingHistory() > 0) {
      storageRequestPendingHistorySync();
      Serial.println("[history] pending auto-sync requested after online services restored");
    }
  }
  if (!wifiConnected && wasWifiConnected) {
    sessionWriteCheckpoint();
    systemMode = SystemMode::OFFLINE;
  }
  wasWifiConnected = wifiConnected;
  wasOnlineServicesAllowed = onlineServicesAllowed;

  if (!wifiConnected &&
      !sessionIsActive() &&
      !recoveryActive &&
      !offlineModeIsActive()) {
    if (offlineNoNetworkSinceMs == 0) {
      offlineNoNetworkSinceMs = now;
    }
    const unsigned long timeoutSec = appConfig.offlineTimeoutSec > 0 ? appConfig.offlineTimeoutSec : 300UL;
    if (now - offlineNoNetworkSinceMs >= timeoutSec * 1000UL) {
      offlineNoNetworkSinceMs = 0;
      offlineModeEnter(OfflineEntryReason::AUTO_NO_WIFI);
    }
  } else {
    offlineNoNetworkSinceMs = 0;
  }

  storageUpdate();
  indicatorsUpdate();
  displayUpdate();

  if (!recoveryActive && now - lastSensorUpdateMs >= Config::SENSOR_INTERVAL_MS) {
    lastSensorUpdateMs = now;
    sensorUpdate();

    if (!sessionIsActive() &&
        relayIsOn() &&
        sensorData.loadDetected) {
      sessionStart(TEST_DEVICE_NAME);
    }
  }

  if (!recoveryActive && now - lastSessionUpdateMs >= Config::SESSION_INTERVAL_MS) {
    lastSessionUpdateMs = now;
    sessionUpdate();
  }

  offlineModeUpdate();
  flushSessionTransitionPriority(onlineServicesAllowed);

  if (onlineServicesAllowed) {
    bool commandPollRan = false;
    if (lastFirebaseCommandMs == 0 || now - lastFirebaseCommandMs >= 500UL) {
      lastFirebaseCommandMs = now;
      firebasePollCommand();
      commandPollRan = true;
    }

    flushSessionTransitionPriority(onlineServicesAllowed);
    if (firebaseTransitionAckRequested()) {
      firebaseFlushTransitionAck();
    }

    const bool commandTransitionPending = firebaseCommandTransitionPending();
    const bool requestedHistorySyncDue =
      storagePendingHistorySyncRequested() &&
      (lastPendingHistorySyncMs == 0 || now - lastPendingHistorySyncMs >= REQUESTED_HISTORY_SYNC_RETRY_MS);
    const bool periodicHistorySyncDue =
      lastPendingHistorySyncMs == 0 || now - lastPendingHistorySyncMs >= PERIODIC_HISTORY_SYNC_MS;

    if (commandPollRan &&
        !commandTransitionPending &&
        (requestedHistorySyncDue || periodicHistorySyncDue)) {
      lastPendingHistorySyncMs = now;
      Serial.println("[history] auto-sync started");
      Serial.print("[timing] history sync started millis=");
      Serial.println(millis());
      storageSyncPendingHistoryToFirebase(AUTO_HISTORY_SYNC_MAX_UPLOADS);
      Serial.print("[timing] history sync completed millis=");
      Serial.println(millis());
    } else if (commandPollRan &&
        appConfig.configPendingSync &&
        !commandTransitionPending &&
        !firebaseDeviceConfigPushBlocked() &&
        (lastFirebaseConfigMs == 0 || now - lastFirebaseConfigMs >= 30000UL)) {
      lastFirebaseConfigMs = now;
      Serial.println("[config] Syncing pending config to Firebase");
      if (firebasePushDeviceConfig()) {
        Serial.println("[config] Pending config sync OK");
      } else {
        Serial.println("[config] Pending config sync FAIL");
      }
    } else if (commandPollRan &&
        !commandTransitionPending &&
        (lastFirebaseConfigMs == 0 || now - lastFirebaseConfigMs >= 30000UL)) {
      lastFirebaseConfigMs = now;
      firebaseReadConfig();
    } else if (commandPollRan &&
        (lastFirebaseLiveMs == 0 || now - lastFirebaseLiveMs >= 2000UL)) {
      lastFirebaseLiveMs = now;
      firebasePublishLive();
    }
  }

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
