#include "mqtt_cloud_sync.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <math.h>
#include <string.h>

#include "config.h"
#include "mqtt_config.h"
#include "mqtt_manager.h"
#include "network.h"
#include "session.h"
#include "state.h"
#include "storage.h"
#include "time_sync.h"

namespace {

static constexpr size_t COMMAND_QUEUE_SIZE = 4;
static constexpr unsigned long CONFIG_REPORT_INTERVAL_MS = 30000UL;

portMUX_TYPE queueMux = portMUX_INITIALIZER_UNLOCKED;
MqttCommand commandQueue[COMMAND_QUEUE_SIZE]{};
size_t commandReadIndex = 0;
size_t commandWriteIndex = 0;
size_t commandCount = 0;
char pendingConfig[MqttConfig::MAX_INBOUND_PAYLOAD_BYTES + 1] = "";
size_t pendingConfigLength = 0;
bool configQueued = false;
char pendingHistoryAckSessionId[64] = "";
bool pendingHistoryAckStored = false;
bool historyAckQueued = false;
char pendingCleanup[MqttConfig::MAX_INBOUND_PAYLOAD_BYTES + 1] = "";
size_t pendingCleanupLength = 0;
bool cleanupQueued = false;

Preferences commandPreferences;
char lastProcessedCommandId[64] = "";
char lastProcessedCleanupId[64] = "";
bool cleanupAckPending = false;
char cleanupAckRequestId[64] = "";
char cleanupAckStatus[16] = "";
int cleanupAckDeleted = 0;
bool pendingStartAck = false;
char pendingStartCommandId[64] = "";
bool transitionAckRequested = false;
char ackId[64] = "";
char ackCommand[16] = "";
char ackStatus[16] = "";
char ackMessage[128] = "";
char ackReason[32] = "";
unsigned long lastConfigReportMs = 0;

const char* commandName(MqttCommandType type) {
  switch (type) {
    case MqttCommandType::START: return "START";
    case MqttCommandType::STOP: return "STOP";
    case MqttCommandType::RELAY: return "RELAY";
    case MqttCommandType::RESET: return "RESET";
  }
  return "UNKNOWN";
}

void setAck(
  const char* id,
  const char* command,
  const char* status,
  const char* message,
  const char* reason = ""
) {
  strlcpy(ackId, id == nullptr ? "" : id, sizeof(ackId));
  strlcpy(ackCommand, command == nullptr ? "" : command, sizeof(ackCommand));
  strlcpy(ackStatus, status == nullptr ? "ERROR" : status, sizeof(ackStatus));
  strlcpy(ackMessage, message == nullptr ? "Command processed" : message, sizeof(ackMessage));
  strlcpy(ackReason, reason == nullptr ? "" : reason, sizeof(ackReason));
  transitionAckRequested = true;
}

void rememberCommandId(const char* id) {
  strlcpy(lastProcessedCommandId, id, sizeof(lastProcessedCommandId));
  commandPreferences.putString("lastCmd", lastProcessedCommandId);
}

void queueCommandFromMqtt(const MqttCommand& command) {
  portENTER_CRITICAL(&queueMux);
  if (commandCount < COMMAND_QUEUE_SIZE) {
    commandQueue[commandWriteIndex] = command;
    commandWriteIndex = (commandWriteIndex + 1) % COMMAND_QUEUE_SIZE;
    commandCount++;
  }
  portEXIT_CRITICAL(&queueMux);
}

void queueConfigFromMqtt(const char* json, size_t length) {
  if (json == nullptr || length == 0 || length > MqttConfig::MAX_INBOUND_PAYLOAD_BYTES) return;
  portENTER_CRITICAL(&queueMux);
  memcpy(pendingConfig, json, length);
  pendingConfig[length] = '\0';
  pendingConfigLength = length;
  configQueued = true;
  portEXIT_CRITICAL(&queueMux);
}

void queueHistoryAckFromMqtt(const char* sessionId, bool stored) {
  if (sessionId == nullptr || sessionId[0] == '\0') return;
  portENTER_CRITICAL(&queueMux);
  strlcpy(pendingHistoryAckSessionId, sessionId, sizeof(pendingHistoryAckSessionId));
  pendingHistoryAckStored = stored;
  historyAckQueued = true;
  portEXIT_CRITICAL(&queueMux);
}

void queueHistoryCleanupFromMqtt(const char* json, size_t length) {
  if (json == nullptr || length == 0 || length > MqttConfig::MAX_INBOUND_PAYLOAD_BYTES) return;
  portENTER_CRITICAL(&queueMux);
  memcpy(pendingCleanup, json, length);
  pendingCleanup[length] = '\0';
  pendingCleanupLength = length;
  cleanupQueued = true;
  portEXIT_CRITICAL(&queueMux);
}

bool takeCommand(MqttCommand& command) {
  bool available = false;
  portENTER_CRITICAL(&queueMux);
  if (commandCount > 0) {
    command = commandQueue[commandReadIndex];
    commandReadIndex = (commandReadIndex + 1) % COMMAND_QUEUE_SIZE;
    commandCount--;
    available = true;
  }
  portEXIT_CRITICAL(&queueMux);
  return available;
}

bool takeConfig(char* output, size_t outputSize, size_t& length) {
  bool available = false;
  portENTER_CRITICAL(&queueMux);
  if (configQueued && pendingConfigLength + 1 <= outputSize) {
    length = pendingConfigLength;
    memcpy(output, pendingConfig, length + 1);
    configQueued = false;
    available = true;
  }
  portEXIT_CRITICAL(&queueMux);
  return available;
}

bool takeHistoryAck(char* sessionId, size_t outputSize, bool& stored) {
  bool available = false;
  portENTER_CRITICAL(&queueMux);
  if (historyAckQueued) {
    strlcpy(sessionId, pendingHistoryAckSessionId, outputSize);
    stored = pendingHistoryAckStored;
    historyAckQueued = false;
    available = true;
  }
  portEXIT_CRITICAL(&queueMux);
  return available;
}

bool takeHistoryCleanup(char* output, size_t outputSize, size_t& length) {
  bool available = false;
  portENTER_CRITICAL(&queueMux);
  if (cleanupQueued && pendingCleanupLength + 1 <= outputSize) {
    length = pendingCleanupLength;
    memcpy(output, pendingCleanup, length + 1);
    cleanupQueued = false;
    available = true;
  }
  portEXIT_CRITICAL(&queueMux);
  return available;
}

bool finitePositive(float value) {
  return isfinite(value) && value > 0.0f;
}

bool finiteNonNegative(float value) {
  return isfinite(value) && value >= 0.0f;
}

void applyCommandSettings(const MqttCommand& command) {
  if (command.hasTariff && finitePositive(command.tariff)) {
    appConfig.tariffPerKwh = command.tariff;
  }
  if (command.hasOverloadThreshold && finitePositive(command.overloadThreshold)) {
    appConfig.overloadThresholdW = command.overloadThreshold;
  }
  if (command.hasLoadPowerThreshold && finiteNonNegative(command.loadPowerThreshold)) {
    appConfig.loadPowerThresholdW = command.loadPowerThreshold;
  }
  if (command.hasLoadCurrentThreshold && finiteNonNegative(command.loadCurrentThreshold)) {
    appConfig.loadCurrentThresholdA = command.loadCurrentThreshold;
  }
  saveLocalConfig();
}

bool commandExpired(const MqttCommand& command) {
  return command.expiresAt > 0 && timeIsSynced() && getUnixMs() > command.expiresAt;
}

void processCommand(const MqttCommand& command) {
  const char* name = commandName(command.type);
  if (command.id[0] == '\0' || command.uid[0] == '\0') {
    setAck(command.id[0] == '\0' ? "missing" : command.id, name, "REJECTED", "Missing command identity", "INVALID");
    return;
  }
  if (strcmp(command.id, lastProcessedCommandId) == 0) {
    setAck(command.id, name, "DONE", "Duplicate command ignored");
    return;
  }
  if (commandExpired(command)) {
    rememberCommandId(command.id);
    setAck(command.id, name, "REJECTED", "Expired command ignored", "STALE");
    return;
  }

  rememberCommandId(command.id);
  if (command.type == MqttCommandType::START) {
    Serial.print("[mqtt-command] START received millis=");
    Serial.println(millis());
    applyCommandSettings(command);
    const char* deviceName = command.deviceName[0] == '\0'
      ? Config::DEFAULT_DEVICE_NAME
      : command.deviceName;
    if (!sessionStart(deviceName)) {
      setAck(command.id, name, "ERROR", "Device is busy", "BUSY");
      return;
    }
    sessionSetRemoteContext(command.uid, command.sessionId);
    pendingStartAck = true;
    strlcpy(pendingStartCommandId, command.id, sizeof(pendingStartCommandId));
    return;
  }

  if (command.type == MqttCommandType::STOP) {
    Serial.print("[mqtt-command] STOP received millis=");
    Serial.println(millis());
    sessionSetRemoteContext(command.uid, command.sessionId);
    pendingStartAck = false;
    pendingStartCommandId[0] = '\0';
    sessionStop(EndReason::USER_STOP);
    setAck(command.id, name, "DONE", "STOP command processed");
    return;
  }

  setAck(command.id, name, "REJECTED", "Command is not enabled", "UNSUPPORTED");
}

bool applyFloat(JsonDocument& document, const char* key, float& target, bool allowZero) {
  if (!document.containsKey(key)) return false;
  const float value = document[key].as<float>();
  if (!isfinite(value) || (allowZero ? value < 0.0f : value <= 0.0f)) return false;
  target = value;
  return true;
}

bool applyUnsigned(JsonDocument& document, const char* key, unsigned long& target) {
  if (!document[key].is<unsigned long>()) return false;
  const unsigned long value = document[key].as<unsigned long>();
  if (value == 0) return false;
  target = value;
  return true;
}

void processConfig(const char* json, size_t length) {
  StaticJsonDocument<1024> document;
  if (deserializeJson(document, json, length) || !document.is<JsonObject>()) return;
  uint64_t revision = document["revision"] | 0ULL;
  if (revision == 0) revision = document["configRevision"] | 0ULL;
  if (revision > 0 && revision < appConfig.configRevision) {
    Serial.println("[mqtt-config] Ignored older revision");
    return;
  }
  bool applied = false;
  applied = applyFloat(document, "tariff", appConfig.tariffPerKwh, false) || applied;
  applied = applyFloat(document, "overloadThreshold", appConfig.overloadThresholdW, false) || applied;
  applied = applyFloat(document, "loadPowerThreshold", appConfig.loadPowerThresholdW, true) || applied;
  applied = applyFloat(document, "loadCurrentThreshold", appConfig.loadCurrentThresholdA, true) || applied;
  applied = applyUnsigned(document, "loadRemovedDelaySec", appConfig.loadRemovedDelaySec) || applied;
  applied = applyUnsigned(document, "offlineTimeoutSec", appConfig.offlineTimeoutSec) || applied;
  applied = applyUnsigned(document, "checkpointIntervalSec", appConfig.checkpointIntervalSec) || applied;
  if (document["overloadWarningPercent"].is<float>()) {
    appConfig.overloadWarningPercent = constrain(document["overloadWarningPercent"].as<float>(), 1.0f, 100.0f);
    applied = true;
  }
  const char* currency = document["currency"] | "";
  if (currency[0] != '\0' && strlen(currency) < sizeof(appConfig.currency)) {
    strlcpy(appConfig.currency, currency, sizeof(appConfig.currency));
    applied = true;
  }
  if (!applied) {
    Serial.println("[mqtt-config] No valid fields; cached config kept");
    return;
  }
  if (revision > 0) appConfig.configRevision = revision;
  appConfig.configPendingSync = false;
  strlcpy(appConfig.configSource, "MQTT", sizeof(appConfig.configSource));
  saveLocalConfig();
  Serial.println("[mqtt-config] Applied and persisted");
}

void updatePendingStartAck() {
  if (!pendingStartAck) return;
  StartValidationResult result = StartValidationResult::NONE;
  if (!sessionConsumeStartValidationResult(result)) return;
  if (result == StartValidationResult::VERIFIED) {
    setAck(pendingStartCommandId, "START", "DONE", "Load verified. Monitoring started.");
  } else {
    setAck(
      pendingStartCommandId,
      "START",
      "REJECTED",
      "No load detected. Connect a device before starting monitoring.",
      "NO_LOAD"
    );
  }
  pendingStartAck = false;
  pendingStartCommandId[0] = '\0';
}

void setCleanupAck(const char* requestId, const char* status, int deleted) {
  strlcpy(cleanupAckRequestId, requestId, sizeof(cleanupAckRequestId));
  strlcpy(cleanupAckStatus, status, sizeof(cleanupAckStatus));
  cleanupAckDeleted = deleted;
  cleanupAckPending = true;
}

void processHistoryCleanup(const char* json, size_t length) {
  StaticJsonDocument<1024> document;
  if (deserializeJson(document, json, length) || !document.is<JsonObject>()) return;
  const char* requestId = document["requestId"] | "";
  const char* type = document["type"] | "";
  if (requestId[0] == '\0' || type[0] == '\0') return;

  if (strcmp(requestId, lastProcessedCleanupId) == 0) {
    setCleanupAck(requestId, "DONE", 0);
    return;
  }
  int deleted = 0;
  if (strcmp(type, "DELETE_HISTORY_SESSION") == 0) {
    JsonArrayConst sessionIds = document["sessionIds"].as<JsonArrayConst>();
    if (sessionIds.isNull() || sessionIds.size() == 0 || sessionIds.size() > 16) {
      setCleanupAck(requestId, "REJECTED", 0);
      return;
    }
    for (JsonVariantConst value : sessionIds) {
      const char* sessionId = value.as<const char*>();
      if (sessionId == nullptr || sessionId[0] == '\0') continue;
      const int result = storageDeleteCompletedSession(sessionId);
      if (result > 0) deleted += result;
    }
  } else if (strcmp(type, "DELETE_ALL_HISTORY") == 0) {
    const uint64_t beforeTs = document["beforeTs"] | 0ULL;
    if (beforeTs == 0) {
      setCleanupAck(requestId, "REJECTED", 0);
      return;
    }
    deleted = storageClearCompletedHistoryBefore(beforeTs);
    if (deleted < 0) {
      setCleanupAck(requestId, "ERROR", 0);
      return;
    }
  } else {
    setCleanupAck(requestId, "REJECTED", 0);
    return;
  }

  strlcpy(lastProcessedCleanupId, requestId, sizeof(lastProcessedCleanupId));
  commandPreferences.putString("lastClean", lastProcessedCleanupId);
  setCleanupAck(requestId, "DONE", deleted);
}

void flushCleanupAck() {
  if (!cleanupAckPending || !mqttConnected()) return;
  if (mqttPublishHistoryCleanupAck(
        cleanupAckRequestId,
        cleanupAckStatus,
        cleanupAckDeleted
      )) {
    cleanupAckPending = false;
  }
}

}  // namespace

void mqttCloudSyncBegin() {
  commandPreferences.begin("mqtt-cloud", false);
  const String savedId = commandPreferences.getString("lastCmd", "");
  strlcpy(lastProcessedCommandId, savedId.c_str(), sizeof(lastProcessedCommandId));
  const String savedCleanupId = commandPreferences.getString("lastClean", "");
  strlcpy(lastProcessedCleanupId, savedCleanupId.c_str(), sizeof(lastProcessedCleanupId));
  mqttSetCommandHandler(queueCommandFromMqtt);
  mqttSetConfigHandler(queueConfigFromMqtt);
  mqttSetHistoryAckHandler(queueHistoryAckFromMqtt);
  mqttSetHistoryCleanupHandler(queueHistoryCleanupFromMqtt);
}

void mqttCloudSyncUpdate() {
  flushCleanupAck();

  char cleanupJson[MqttConfig::MAX_INBOUND_PAYLOAD_BYTES + 1];
  size_t cleanupLength = 0;
  if (!sessionIsActive() &&
      !sessionRecoveryIsActive() &&
      takeHistoryCleanup(cleanupJson, sizeof(cleanupJson), cleanupLength)) {
    processHistoryCleanup(cleanupJson, cleanupLength);
  }

  char historySessionId[64];
  bool stored = false;
  if (takeHistoryAck(historySessionId, sizeof(historySessionId), stored) && stored) {
    storageMarkSessionQueued(historySessionId);
  }

  char configJson[MqttConfig::MAX_INBOUND_PAYLOAD_BYTES + 1];
  size_t configLength = 0;
  if (takeConfig(configJson, sizeof(configJson), configLength)) {
    processConfig(configJson, configLength);
  }

  if (!transitionAckRequested && !pendingStartAck) {
    MqttCommand command{};
    if (takeCommand(command)) processCommand(command);
  }
  updatePendingStartAck();

  if (appConfig.configPendingSync && mqttConnected()) {
    const unsigned long now = millis();
    if (lastConfigReportMs == 0 || now - lastConfigReportMs >= CONFIG_REPORT_INTERVAL_MS) {
      lastConfigReportMs = now;
      mqttCloudPublishLocalConfig();
    }
  }
}

bool mqttCloudCommandTransitionPending() {
  return pendingStartAck || transitionAckRequested ||
    sessionData.state == SessionState::WAITING_LOAD ||
    sessionData.state == SessionState::FINISHING;
}

bool mqttCloudTransitionAckRequested() {
  return transitionAckRequested;
}

void mqttCloudFlushTransitionAck() {
  if (!transitionAckRequested || !mqttConnected()) return;
  if (mqttPublishCommandAck(ackId, ackCommand, ackStatus, ackMessage, ackReason)) {
    transitionAckRequested = false;
  }
}

bool mqttCloudPublishLocalConfig() {
  StaticJsonDocument<768> document;
  document["deviceId"] = MqttConfig::DEVICE_ID;
  document["tariff"] = appConfig.tariffPerKwh;
  document["currency"] = appConfig.currency;
  document["overloadThreshold"] = appConfig.overloadThresholdW;
  document["overloadWarningPercent"] = appConfig.overloadWarningPercent;
  document["loadPowerThreshold"] = appConfig.loadPowerThresholdW;
  document["loadCurrentThreshold"] = appConfig.loadCurrentThresholdA;
  document["loadRemovedDelaySec"] = appConfig.loadRemovedDelaySec;
  document["offlineTimeoutSec"] = appConfig.offlineTimeoutSec;
  document["checkpointIntervalSec"] = appConfig.checkpointIntervalSec;
  document["configRevision"] = appConfig.configRevision;
  document["source"] = appConfig.configSource;
  char payload[768];
  const size_t length = serializeJson(document, payload, sizeof(payload));
  const bool queued = length > 0 && mqttPublishConfigStateJson(payload, length);
  if (queued) {
    appConfig.configPendingSync = false;
    saveLocalConfig();
    Serial.println("[mqtt-config] Local config queued");
  }
  return queued;
}
