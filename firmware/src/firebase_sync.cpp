#include "firebase_sync.h"
#include "config.h"
#include "credentials.h"
#include "device_auth.h"
#include "device_auth_config.h"
#include "firebase_paths.h"
#include "network.h"
#include "relay.h"
#include "session.h"
#include "state.h"
#include "storage.h"
#include "time_sync.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <math.h>
#include <stdlib.h>
#include <WiFi.h>
#include <Preferences.h>
#include <WiFiClientSecure.h>

static constexpr unsigned long HTTP_LOG_INTERVAL_MS = 5000UL;
static constexpr unsigned long SINGULAR_COMMAND_FALLBACK_POLL_INTERVAL_MS = 5000UL;
static constexpr uint64_t FINAL_COMMAND_MAX_AGE_MS = 5ULL * 60ULL * 1000ULL;
static constexpr const char* PREF_NAMESPACE_FB = "fb_sync";
static constexpr const char* PREF_KEY_LAST_CMD_ID = "last_cmd_id";
static char lastProcessedCommandId[48] = "";
static uint64_t lastProcessedFinalCommandAt = 0;
static char ackId[48] = "";
static char ackType[12] = "";
static char ackStatus[12] = "DONE";
static char ackReason[24] = "";
static char ackMessage[64] = "Command processed";
static bool pendingStartAck = false;
static bool transitionAckRequested = false;
static char pendingStartCommandId[48] = "";
static unsigned long lastLiveLogMs = 0;
static unsigned long lastPollLogMs = 0;
static unsigned long lastFinalCommandPollMs = 0;
static unsigned long lastFinalCommandLogMs = 0;
static uint64_t lastLoggedStaleFinalCommandAt = 0;
static bool missingLiveDeviceIdLogged = false;
static bool missingCommandDeviceIdLogged = false;
static bool configPushBlockedByRules = false;
static bool singularCommandFallbackDisabled = false;
static bool legacyHistoryMirrorDisabled = false;
class CommandPollTimingScope {
 public:
  CommandPollTimingScope() : startedAtMs(millis()) {
    Serial.print("[timing] command poll started millis=");
    Serial.println(startedAtMs);
  }

  ~CommandPollTimingScope() {
    Serial.print("[timing] command poll completed millis=");
    Serial.println(millis());
  }

 private:
  unsigned long startedAtMs;
};

static String configJsonPath(const String& configPath) {
  return configPath + ".json";
}

static String finalConfigJsonPath() {
  return configJsonPath(FirebasePaths::pathDeviceConfig(String(Config::DEVICE_ID)));
}

static String legacyConfigJsonPath() {
  return configJsonPath(String(Config::FIREBASE_DEVICE_CONFIG_PATH));
}

static String finalCommandJsonPath() {
  return configJsonPath(FirebasePaths::pathDeviceCommand(String(Config::DEVICE_ID)));
}

static void saveLastProcessedCommandId(const char* id) {
  if (id == nullptr || id[0] == '\0' || strcmp(id, lastProcessedCommandId) == 0) {
    return;
  }
  strlcpy(lastProcessedCommandId, id, sizeof(lastProcessedCommandId));

  Preferences prefs;
  if (prefs.begin(PREF_NAMESPACE_FB, false)) { // read-write
    prefs.putString(PREF_KEY_LAST_CMD_ID, lastProcessedCommandId);
    prefs.end();
  } else {
    Serial.println("[firebase] ERROR: Failed to save last processed command ID");
  }
}

static String configRevisionText(uint64_t revision) {
  char buffer[24];
  snprintf(buffer, sizeof(buffer), "%llu", revision);
  return String(buffer);
}

static bool readRevision(JsonDocument& doc, uint64_t& revision) {
  if (doc["configRevision"].is<uint64_t>()) {
    revision = doc["configRevision"].as<uint64_t>();
    return true;
  }
  if (doc["configRevision"].is<const char*>()) {
    revision = strtoull(doc["configRevision"].as<const char*>(), nullptr, 10);
    return true;
  }
  if (doc["configRevision"].is<double>()) {
    revision = static_cast<uint64_t>(doc["configRevision"].as<double>());
    return true;
  }
  return false;
}

static void logRejectedConfigField(const char* field) {
  Serial.print("[config] Ignored invalid field ");
  Serial.println(field);
}

static bool readFiniteFloat(JsonDocument& doc, const char* field, float& value) {
  if (!doc.containsKey(field)) {
    return false;
  }
  if (!doc[field].is<float>()) {
    logRejectedConfigField(field);
    return false;
  }
  const float candidate = doc[field].as<float>();
  if (!isfinite(candidate)) {
    logRejectedConfigField(field);
    return false;
  }
  value = candidate;
  return true;
}

static bool applyPositiveFloat(JsonDocument& doc, const char* field, float& target) {
  float candidate = 0.0f;
  if (!readFiniteFloat(doc, field, candidate)) {
    return false;
  }
  if (candidate <= 0.0f) {
    logRejectedConfigField(field);
    return false;
  }
  target = candidate;
  return true;
}

static bool applyNonNegativeFloat(JsonDocument& doc, const char* field, float& target) {
  float candidate = 0.0f;
  if (!readFiniteFloat(doc, field, candidate)) {
    return false;
  }
  if (candidate < 0.0f) {
    logRejectedConfigField(field);
    return false;
  }
  target = candidate;
  return true;
}

static bool applyPositiveULong(JsonDocument& doc, const char* field, unsigned long& target) {
  if (!doc.containsKey(field)) {
    return false;
  }
  if (!doc[field].is<unsigned long>()) {
    logRejectedConfigField(field);
    return false;
  }
  const unsigned long candidate = doc[field].as<unsigned long>();
  if (candidate == 0) {
    logRejectedConfigField(field);
    return false;
  }
  target = candidate;
  return true;
}

static bool applyConfigDocument(JsonDocument& doc, const char* source) {
  bool applied = false;
  applied = applyPositiveFloat(doc, "tariff", appConfig.tariffPerKwh) || applied;
  applied = applyPositiveFloat(doc, "overloadThreshold", appConfig.overloadThresholdW) || applied;
  applied = applyNonNegativeFloat(doc, "loadPowerThreshold", appConfig.loadPowerThresholdW) || applied;
  applied = applyNonNegativeFloat(doc, "loadCurrentThreshold", appConfig.loadCurrentThresholdA) || applied;
  applied = applyPositiveULong(doc, "loadRemovedDelaySec", appConfig.loadRemovedDelaySec) || applied;
  applied = applyPositiveULong(doc, "offlineTimeoutSec", appConfig.offlineTimeoutSec) || applied;
  applied = applyPositiveULong(doc, "checkpointIntervalSec", appConfig.checkpointIntervalSec) || applied;

  float warningPercent = 0.0f;
  if (readFiniteFloat(doc, "overloadWarningPercent", warningPercent)) {
    const float clampedWarning = constrain(warningPercent, 1.0f, 100.0f);
    if (clampedWarning != warningPercent) {
      Serial.println("[config] Clamped overloadWarningPercent to 1..100");
    }
    appConfig.overloadWarningPercent = clampedWarning;
    applied = true;
  }

  if (doc.containsKey("currency")) {
    if (doc["currency"].is<const char*>()) {
      const char* currency = doc["currency"].as<const char*>();
      if (currency != nullptr && currency[0] != '\0' && strlen(currency) < sizeof(appConfig.currency)) {
        strlcpy(appConfig.currency, currency, sizeof(appConfig.currency));
        applied = true;
      } else {
        logRejectedConfigField("currency");
      }
    } else {
      logRejectedConfigField("currency");
    }
  }

  if (!applied) {
    return false;
  }
  if (doc["source"].is<const char*>()) {
    strlcpy(appConfig.configSource, doc["source"].as<const char*>(), sizeof(appConfig.configSource));
  } else {
    strlcpy(appConfig.configSource, source, sizeof(appConfig.configSource));
  }
  return true;
}

static bool shouldLog(unsigned long& lastLogMs) {
  const unsigned long now = millis();
  if (lastLogMs == 0 || now - lastLogMs >= HTTP_LOG_INTERVAL_MS) {
    lastLogMs = now;
    return true;
  }
  return false;
}

static String normalizeBaseUrl() {
  String base = FIREBASE_DATABASE_URL;
  while (base.endsWith("/")) {
    base.remove(base.length() - 1);
  }
  return base;
}

static String makeUrl(const char* jsonPath) {
  String path = jsonPath;
  if (!path.startsWith("/")) {
    path = "/" + path;
  }
  return deviceAuthAppendAuthQuery(normalizeBaseUrl() + path);
}

static String sanitizedLogPath(const char* path) {
  String sanitized = path == nullptr ? "" : path;
  const int queryIndex = sanitized.indexOf('?');
  if (queryIndex >= 0) {
    sanitized.remove(queryIndex);
  }
  const int fragmentIndex = sanitized.indexOf('#');
  if (fragmentIndex >= 0) {
    sanitized.remove(fragmentIndex);
  }
  if (sanitized.length() > 160) {
    sanitized.remove(160);
  }
  for (size_t index = 0; index < sanitized.length(); index++) {
    const char c = sanitized[index];
    const bool safe =
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c == '/' || c == '_' || c == '-' || c == '.';
    if (!safe) {
      sanitized.setCharAt(index, '_');
    }
  }
  return sanitized.length() > 0 ? sanitized : "/";
}

static void logRtdbUnauthorized(
  const char* prefix,
  const char* path,
  const char* suffix
) {
  Serial.print(prefix);
  Serial.print(sanitizedLogPath(path));
  Serial.println(suffix);
}

static void logHttp(const char* method, const char* path, int statusCode, bool ok, bool forceLog) {
  if (!forceLog && ok) {
    return;
  }
  Serial.print("[firebase] ");
  Serial.print(method);
  Serial.print(" ");
  Serial.print(sanitizedLogPath(path));
  Serial.print(" status=");
  Serial.print(statusCode);
  Serial.print(" ");
  if (ok) {
    Serial.println("OK");
  } else if (statusCode == 401 || statusCode == 403) {
    Serial.println("AUTH_REQUIRED (local operation continues)");
  } else {
    Serial.println("FAIL");
  }
}

static int performHttpRequest(
  const char* method,
  const char* path,
  const String& payload,
  String* response
) {
  WiFiClientSecure client;
  if (deviceAuthIsEnabled()) {
    client.setCACert(VOLTIX_FIREBASE_RTDB_ROOT_CA);
  } else {
    client.setInsecure();
  }

  HTTPClient http;
  const String url = makeUrl(path);
  if (!http.begin(client, url)) {
    return -1;
  }

  http.setTimeout(3000);
  http.addHeader("Content-Type", "application/json");
  int statusCode = -1;
  if (strcmp(method, "GET") == 0) {
    statusCode = http.GET();
  } else if (strcmp(method, "PUT") == 0) {
    statusCode = http.PUT(payload);
  } else if (strcmp(method, "PATCH") == 0) {
    statusCode = http.PATCH(payload);
  }

  if (response != nullptr) {
    *response = http.getString();
  }
  http.end();
  return statusCode;
}

static bool httpRequest(
  const char* method,
  const char* path,
  const String& payload,
  String* response,
  bool forceLog,
  int* statusOut = nullptr,
  bool* pathUnauthorizedOut = nullptr
) {
  if (pathUnauthorizedOut != nullptr) {
    *pathUnauthorizedOut = false;
  }
  if (!networkIsConnected()) {
    if (statusOut != nullptr) {
      *statusOut = -1;
    }
    if (forceLog) {
      Serial.print("[firebase] SKIP ");
      Serial.print(method);
      Serial.print(" ");
      Serial.print(sanitizedLogPath(path));
      Serial.println(" WiFi offline");
    }
    return false;
  }

  if (deviceAuthIsEnabled() && !deviceAuthEnsureAuthenticated()) {
    if (statusOut != nullptr) {
      *statusOut = -1;
    }
    if (forceLog) {
      Serial.print("[firebase] SKIP ");
      Serial.print(method);
      Serial.print(" ");
      Serial.print(sanitizedLogPath(path));
      Serial.println(" device auth unavailable (local operation continues)");
    }
    return false;
  }

  int statusCode = performHttpRequest(method, path, payload, response);
  if (statusCode == 401 && deviceAuthIsEnabled()) {
    deviceAuthHandleRtdbUnauthorized(statusCode);
    logRtdbUnauthorized(
      "[auth] RTDB 401 path=",
      path,
      "; retrying once"
    );
    if (deviceAuthEnsureAuthenticated(true)) {
      statusCode = performHttpRequest(method, path, payload, response);
      if (statusCode == 401 || statusCode == 403) {
        deviceAuthHandleRtdbPathUnauthorized(statusCode);
        if (pathUnauthorizedOut != nullptr) {
          *pathUnauthorizedOut = true;
        }
        logRtdbUnauthorized(
          "[auth] RTDB unauthorized after retry path=",
          path,
          "; auth session preserved"
        );
      }
    }
  } else if (statusCode == 403 && deviceAuthIsEnabled()) {
    deviceAuthHandleRtdbPathUnauthorized(statusCode);
    if (pathUnauthorizedOut != nullptr) {
      *pathUnauthorizedOut = true;
    }
    logRtdbUnauthorized(
      "[auth] RTDB path denied path=",
      path,
      "; auth session preserved"
    );
  }

  const bool ok = statusCode >= 200 && statusCode < 300;
  if (statusOut != nullptr) {
    *statusOut = statusCode;
  }

  logHttp(method, path, statusCode, ok, forceLog || !ok);
  return ok;
}

static bool fetchConfigDocument(const String& jsonPath, const char* source, JsonDocument& doc) {
  String response;
  if (!httpRequest("GET", jsonPath.c_str(), "", &response, true)) {
    return false;
  }
  if (response == "null" || response.length() == 0) {
    Serial.print("[config] ");
    Serial.print(source);
    Serial.println(" config empty");
    return false;
  }

  const DeserializationError error = deserializeJson(doc, response);
  if (error) {
    Serial.print("[config] ");
    Serial.print(source);
    Serial.print(" config parse FAIL ");
    Serial.println(error.c_str());
    return false;
  }
  return true;
}

static void formatDuration(unsigned long durationSec, char* out, size_t outSize) {
  const unsigned long hours = durationSec / 3600UL;
  const unsigned long minutes = (durationSec % 3600UL) / 60UL;
  const unsigned long seconds = durationSec % 60UL;
  snprintf(out, outSize, "%02lu:%02lu:%02lu", hours, minutes, seconds);
}

static void formatCostText(float cost, char* out, size_t outSize) {
  snprintf(out, outSize, "Rp %.0f", cost);
}

static String finalHistoryJsonPath(const char* historyId) {
  return configJsonPath(FirebasePaths::pathDeviceHistory(String(Config::DEVICE_ID), String(historyId)));
}

static String completedSessionJsonPath(const char* sessionId) {
  return configJsonPath(FirebasePaths::pathCompletedSession(String(Config::DEVICE_ID), String(sessionId)));
}

static String historyCleanupCurrentJsonPath() {
  return configJsonPath(
    FirebasePaths::pathDeviceRoot(String(Config::DEVICE_ID)) + "/historyCleanup/current"
  );
}

static String historyCleanupLastAckJsonPath() {
  return configJsonPath(
    FirebasePaths::pathDeviceRoot(String(Config::DEVICE_ID)) + "/historyCleanup/lastAck"
  );
}

static bool acknowledgeHistoryCleanup(
  const char* requestId,
  const char* type,
  const char* status,
  int deletedCount
) {
  StaticJsonDocument<384> doc;
  doc["requestId"] = requestId;
  doc["type"] = type;
  doc["status"] = status;
  doc["deletedCount"] = deletedCount;
  doc["completedAt"] = timeIsSynced()
    ? getUnixMs()
    : static_cast<uint64_t>(millis());

  String payload;
  serializeJson(doc, payload);
  const String ackPath = historyCleanupLastAckJsonPath();
  if (!httpRequest("PUT", ackPath.c_str(), payload, nullptr, true)) {
    return false;
  }

  Serial.print("[history-cleanup] ack sent requestId=");
  Serial.println(requestId);
  const String currentPath = historyCleanupCurrentJsonPath();
  return httpRequest("PUT", currentPath.c_str(), "null", nullptr, true);
}

static bool parseCleanupBeforeTs(JsonVariantConst value, uint64_t& beforeTs) {
  if (!(value.is<uint64_t>() || value.is<unsigned long>() || value.is<double>())) {
    return false;
  }
  const double numeric = value.as<double>();
  if (!isfinite(numeric) || numeric <= 0.0) {
    return false;
  }
  beforeTs = value.as<uint64_t>();
  if (beforeTs < 100000000000ULL) {
    beforeTs *= 1000ULL;
  }
  return beforeTs > 0;
}

static bool pushHistoryPayload(const char* sessionId, const String& payload) {
  if (Config::DEVICE_ID == nullptr || Config::DEVICE_ID[0] == '\0') {
    Serial.println("[history] cloud sync skipped: missing deviceId");
    return false;
  }

  int finalStatus = -1;
  const String finalPath = finalHistoryJsonPath(sessionId);
  const bool finalOk = httpRequest("PUT", finalPath.c_str(), payload, nullptr, true, &finalStatus);
  if (finalOk) {
    Serial.print("[history] Synced to final device history sessionId=");
    Serial.println(sessionId);
  } else {
    Serial.print("[history] Final history sync failed, kept pending sessionId=");
    Serial.print(sessionId);
    Serial.print(" status=");
    Serial.println(finalStatus);
    return false;
  }

  if (!legacyHistoryMirrorDisabled) {
    int legacyStatus = -1;
    bool legacyPathDenied = false;
    const String legacyPath = completedSessionJsonPath(sessionId);
    const bool legacyOk = httpRequest(
      "PUT",
      legacyPath.c_str(),
      payload,
      nullptr,
      true,
      &legacyStatus,
      &legacyPathDenied
    );
    if (legacyOk) {
      Serial.print("[history] Legacy completedSessions compatibility synced sessionId=");
      Serial.println(sessionId);
    } else if (legacyPathDenied) {
      legacyHistoryMirrorDisabled = true;
      Serial.print("[history] Legacy completedSessions denied; compatibility mirror disabled sessionId=");
      Serial.println(sessionId);
    } else {
      Serial.print("[history] Legacy completedSessions mirror failed optional sessionId=");
      Serial.print(sessionId);
      Serial.print(" status=");
      Serial.println(legacyStatus);
    }
  } else {
    Serial.print("[history] Legacy completedSessions mirror skipped sessionId=");
    Serial.println(sessionId);
  }

  return finalOk;
}

static void addFinalHistoryFields(JsonDocument& doc) {
  doc["energyKwh"] = doc["energy"];
  doc["powerAvg"] = doc["averagePower"];
  doc["powerMax"] = doc["peakPower"];
  doc["modeStart"] = doc["startMode"];
  doc["modeEnd"] = doc["endMode"];

  const char* startMode = doc["startMode"] | "";
  const char* endMode = doc["endMode"] | "";
  if (startMode[0] != '\0' && endMode[0] != '\0') {
    doc["modePath"] = strcmp(startMode, endMode) == 0
      ? String(startMode)
      : String(startMode) + "->" + endMode;
  }

  const char* date = doc["date"] | "";
  const uint64_t endTime = doc["timestamp"] | 0ULL;
  const unsigned long durationSec = doc["durationSec"] | 0UL;
  if (date[0] != '\0' && strcmp(date, "-") != 0 && endTime > 0) {
    doc["endTime"] = endTime;
    const uint64_t durationMs = static_cast<uint64_t>(durationSec) * 1000ULL;
    if (endTime >= durationMs) {
      doc["startTime"] = endTime - durationMs;
    }
  }
}

static bool isSessionActiveForLive() {
  return sessionData.state == SessionState::MONITORING ||
         sessionData.state == SessionState::OVERLOAD;
}

static void writeServerTimestamp(JsonObject parent, const char* field) {
  JsonObject timestamp = parent.createNestedObject(field);
  timestamp[".sv"] = "timestamp";
}

static void setAck(const char* id, const char* type, const char* status, const char* message, const char* reason = "") {
  strlcpy(ackId, id == nullptr ? "" : id, sizeof(ackId));
  strlcpy(ackType, type == nullptr ? "" : type, sizeof(ackType));
  strlcpy(ackStatus, status == nullptr ? "DONE" : status, sizeof(ackStatus));
  strlcpy(ackReason, reason == nullptr ? "" : reason, sizeof(ackReason));
  strlcpy(ackMessage, message == nullptr ? "Command processed" : message, sizeof(ackMessage));
}

static bool publishPendingStartAckIfReady() {
  if (!pendingStartAck) {
    return false;
  }

  StartValidationResult result = StartValidationResult::NONE;
  if (!sessionConsumeStartValidationResult(result)) {
    return false;
  }

  if (result == StartValidationResult::VERIFIED) {
    setAck(pendingStartCommandId, "START", "DONE", "Load verified. Monitoring started.");
  } else if (result == StartValidationResult::REJECTED_NO_LOAD) {
    setAck(
      pendingStartCommandId,
      "START",
      "REJECTED",
      "No load detected. Connect a device before starting monitoring.",
      "NO_LOAD"
    );
    Serial.println("[firebase] START ack rejected reason=NO_LOAD");
  }

  transitionAckRequested = true;
  pendingStartAck = false;
  pendingStartCommandId[0] = '\0';
  return true;
}

static bool readCommandTimestamp(JsonDocument& doc, uint64_t& updatedAt) {
  const char* timestampKey = doc["updatedAt"].isNull() ? "createdAt" : "updatedAt";
  if (doc[timestampKey].is<uint64_t>()) {
    updatedAt = doc[timestampKey].as<uint64_t>();
    return updatedAt > 0;
  }
  if (doc[timestampKey].is<double>()) {
    const double value = doc[timestampKey].as<double>();
    if (!isfinite(value) || value <= 0.0) {
      return false;
    }
    updatedAt = static_cast<uint64_t>(value);
    return true;
  }
  return false;
}

static bool validateFinalCommand(JsonDocument& doc, uint64_t& updatedAt) {
  if (!doc["relay"].is<const char*>() ||
      !doc["startSession"].is<bool>() ||
      !doc["stopSession"].is<bool>() ||
      !doc["resetAlarm"].is<bool>() ||
      !readCommandTimestamp(doc, updatedAt)) {
    Serial.println("[command] Invalid singular fallback shape ignored");
    return false;
  }

  const char* relay = doc["relay"].as<const char*>();
  if (strcmp(relay, "ON") != 0 &&
      strcmp(relay, "OFF") != 0 &&
      strcmp(relay, "UNCHANGED") != 0) {
    Serial.println("[command] Invalid relay command ignored");
    return false;
  }
  return true;
}

static bool commandTimestampExpired(uint64_t updatedAt) {
  if (timeIsSynced()) {
    const uint64_t now = getUnixMs();
    if (updatedAt < now && now - updatedAt > FINAL_COMMAND_MAX_AGE_MS) {
      return true;
    }
  }
  return false;
}

static bool finalCommandIsStale(uint64_t updatedAt) {
  if (updatedAt <= lastProcessedFinalCommandAt) {
    return true;
  }
  return commandTimestampExpired(updatedAt);
}

static bool primaryCommandIsStale(uint64_t updatedAt) {
  return updatedAt == 0 || commandTimestampExpired(updatedAt);
}

static bool commandTypeIsStart(const char* type) {
  return strcmp(type, "START") == 0 || strcmp(type, "START_SESSION") == 0;
}

static bool commandTypeIsStop(const char* type) {
  return strcmp(type, "STOP") == 0 || strcmp(type, "STOP_SESSION") == 0;
}

static unsigned long commandAgeMs(uint64_t updatedAt) {
  if (!timeIsSynced()) {
    return 0;
  }
  const uint64_t now = getUnixMs();
  if (updatedAt == 0 || updatedAt > now) {
    return 0;
  }
  const uint64_t age = now - updatedAt;
  return age > 0xFFFFFFFFULL
    ? 0xFFFFFFFFUL
    : static_cast<unsigned long>(age);
}

static void logCommandLatency(
  const char* action,
  const char* source,
  unsigned long ageAtReceiveMs,
  unsigned long receivedAtMs
) {
  Serial.print("[command] ");
  Serial.print(action);
  Serial.print(" accepted ageMs=");
  Serial.print(ageAtReceiveMs);
  Serial.print(" relayLatencyMs=");
  const unsigned long relayAtMs = relayLastToggleMs();
  Serial.print(relayAtMs >= receivedAtMs ? relayAtMs - receivedAtMs : 0UL);
  Serial.print(" source=");
  Serial.println(source);
}

static void processFinalCommand(JsonDocument& doc, uint64_t updatedAt) {
  const unsigned long receivedAtMs = millis();
  const unsigned long ageAtReceiveMs = commandAgeMs(updatedAt);
  const char* relay = doc["relay"].as<const char*>();
  const bool startRequested = doc["startSession"].as<bool>() || strcmp(relay, "ON") == 0;
  const bool stopRequested = doc["stopSession"].as<bool>() || strcmp(relay, "OFF") == 0;
  const bool resetRequested = doc["resetAlarm"].as<bool>();

  // Mark a valid command before action so failed/busy commands cannot loop.
  lastProcessedFinalCommandAt = updatedAt;

  if (startRequested && stopRequested) {
    Serial.println("[command] Conflicting singular fallback ignored");
    return;
  }

  if (resetRequested) {
    Serial.println("[command] resetAlarm ignored: no existing reset runtime semantics");
  }

  if (startRequested) {
    Serial.print("[timing] START command received millis=");
    Serial.println(receivedAtMs);
    if (!sessionStart(appConfig.deviceName)) {
      Serial.println("[command] Singular fallback START ignored: device busy");
      return;
    }
    logCommandLatency("START", "singular-fallback", ageAtReceiveMs, receivedAtMs);
    return;
  }

  if (stopRequested) {
    Serial.print("[timing] STOP command received millis=");
    Serial.println(receivedAtMs);
    if (sessionIsActive()) {
      sessionStop(EndReason::USER_STOP);
    }
    logCommandLatency("STOP", "singular-fallback", ageAtReceiveMs, receivedAtMs);
    return;
  }

  if (!resetRequested) {
    Serial.println("[command] Singular fallback has no action");
  }
}

static bool pollFinalCommand() {
  const unsigned long now = millis();
  if (singularCommandFallbackDisabled ||
      (lastFinalCommandPollMs > 0 &&
       now - lastFinalCommandPollMs < SINGULAR_COMMAND_FALLBACK_POLL_INTERVAL_MS)) {
    return false;
  }
  lastFinalCommandPollMs = now;

  const String path = finalCommandJsonPath();
  String response;
  if (!httpRequest("GET", path.c_str(), "", &response, false)) {
    return false;
  }
  if (response == "null" || response.length() == 0) {
    return false;
  }

  StaticJsonDocument<384> doc;
  const DeserializationError error = deserializeJson(doc, response);
  if (error) {
    if (shouldLog(lastFinalCommandLogMs)) {
      Serial.print("[command] Singular fallback parse FAIL ");
      Serial.println(error.c_str());
    }
    return false;
  }

  uint64_t updatedAt = 0;
  if (!validateFinalCommand(doc, updatedAt)) {
    return true;
  }
  if (finalCommandIsStale(updatedAt)) {
    if (updatedAt != lastLoggedStaleFinalCommandAt &&
        shouldLog(lastFinalCommandLogMs)) {
      lastLoggedStaleFinalCommandAt = updatedAt;
      Serial.println("[command] Ignored stale singular command fallback");
    }
    return true;
  }

  Serial.println("[command] Loaded from singular command fallback");
  processFinalCommand(doc, updatedAt);
  return true;
}

void firebaseBegin() {
  Serial.print("[firebase] REST initialized deviceId=");
  Serial.println(Config::DEVICE_ID);

  // Load the last processed command ID from NVS
  Preferences prefs;
  if (prefs.begin(PREF_NAMESPACE_FB, true)) { // read-only
    prefs.getString(PREF_KEY_LAST_CMD_ID, lastProcessedCommandId, sizeof(lastProcessedCommandId));
    prefs.end();
    if (lastProcessedCommandId[0] != '\0') {
      Serial.print("[firebase] Loaded last processed command ID: ");
      Serial.println(lastProcessedCommandId);
    }
  }
  deviceAuthBegin();
  if (deviceAuthIsEnabled()) {
    Serial.println("[firebase] Device auth scaffold enabled; tokens remain redacted");
  } else {
    Serial.println("[firebase] Using RTDB REST with Web API key only; no database secret/service account");
  }
}

bool firebaseAuthenticateDevice() {
  if (!deviceAuthIsEnabled()) {
    return false;
  }
  Serial.println("[auth] boot/network-ready authentication attempt");
  const bool authenticated = deviceAuthEnsureAuthenticated();
  deviceAuthPrintStatus();
  return authenticated;
}

void firebasePrintAuthStatus() {
  deviceAuthPrintStatus();
}

void firebasePublishLive() {
  if (Config::DEVICE_ID == nullptr || Config::DEVICE_ID[0] == '\0') {
    if (!missingLiveDeviceIdLogged) {
      missingLiveDeviceIdLogged = true;
      Serial.println("[live] skipped: missing deviceId");
    }
    return;
  }
  missingLiveDeviceIdLogged = false;

  StaticJsonDocument<1792> doc;
  JsonObject system = doc.createNestedObject("system");
  // Compatibility fields remain until web readers migrate relay/timestamp.
  system["timestamp"] = millis();
  system["internet"] = networkIsConnected();
  system["relay"] = relayIsOn();
  system["systemMode"] = systemModeToString(systemMode);
  system["sessionState"] = sessionStateToString(sessionData.state);
  system["deviceId"] = Config::DEVICE_ID;
  // Final live/system fields that do not conflict with compatibility readers.
  system["timestampUnixMs"] = timeIsSynced() ? getUnixMs() : static_cast<uint64_t>(0);
  writeServerTimestamp(system, "lastSeen");
  system["mode"] = systemModeToString(systemMode);
  system["relayState"] = relayIsOn() ? "ON" : "OFF";
  system["wifiStatus"] = networkIsPortalActive() ? "AP_MODE" : (networkIsConnected() ? "CONNECTED" : "DISCONNECTED");
  system["activeSsid"] = networkIsConnected() ? WiFi.SSID() : "";
  system["firmwareVersion"] = Config::FIRMWARE_VERSION;

  const bool liveElectricalActive =
    relayIsOn() &&
    sessionData.state != SessionState::IDLE &&
    sessionData.state != SessionState::FINISHED;
  JsonObject device = doc.createNestedObject("device");
  writeServerTimestamp(device, "timestamp");
  device["connected"] = liveElectricalActive && sensorData.valid;
  device["voltage"] = sensorData.voltage;
  device["current"] = liveElectricalActive ? sensorData.current : 0.0f;
  device["power"] = liveElectricalActive ? sensorData.power : 0.0f;
  device["apparent"] = liveElectricalActive
    ? sensorData.voltage * sensorData.current
    : 0.0f;
  device["frequency"] = sensorData.frequency;
  device["pf"] = sensorData.powerFactor;
  device["powerFactor"] = sensorData.powerFactor;
  device["energy"] = sensorData.energy;
  device["cost"] = sessionData.cost;
  device["duration"] = sessionData.durationMs / 1000UL;
  device["overload"] = sessionData.state == SessionState::OVERLOAD;
  device["loadDetected"] = liveElectricalActive && sensorData.loadDetected;

  JsonObject session = doc.createNestedObject("session");
  session["active"] = isSessionActiveForLive();
  session["sessionId"] = sessionData.sessionId;
  session["uid"] = sessionData.uid;
  session["deviceName"] = sessionData.deviceName;
  session["sessionState"] = sessionStateToString(sessionData.state);
  session["elapsedSec"] = sessionData.durationMs / 1000UL;
  session["energyWh"] = serialized(String(sessionData.energyWh, 6));
  session["energy"] = serialized(String(sessionData.energyKwh, 8));
  session["cost"] = serialized(String(sessionData.cost, 4));
  session["endReason"] = endReasonToString(sessionData.endReason);

  if (doc.overflowed()) {
    if (shouldLog(lastLiveLogMs)) {
      Serial.println("[live] skipped: payload overflow");
    }
    return;
  }

  String payload;
  serializeJson(doc, payload);
  const String livePath = configJsonPath(FirebasePaths::pathLiveRoot(String(Config::DEVICE_ID)));
  httpRequest("PATCH", livePath.c_str(), payload, nullptr, shouldLog(lastLiveLogMs));
}

void firebaseReadConfig() {
  StaticJsonDocument<768> doc;
  const String finalPath = finalConfigJsonPath();
  const String legacyPath = legacyConfigJsonPath();
  const char* configSource = "DEVICE_CONFIG";

  bool loaded = fetchConfigDocument(finalPath, "device", doc);
  if (!loaded && legacyPath != finalPath) {
    doc.clear();
    loaded = fetchConfigDocument(legacyPath, "legacy", doc);
    configSource = "LEGACY_CONFIG";
  }
  if (!loaded) {
    Serial.print("[config] Keeping cached/default config source=");
    Serial.println(appConfig.configSource[0] == '\0' ? "DEFAULT" : appConfig.configSource);
    return;
  }

  uint64_t firebaseRevision = 0;
  const bool hasRevision = readRevision(doc, firebaseRevision);
  Serial.print("[config] Firebase config received revision=");
  Serial.print(hasRevision ? configRevisionText(firebaseRevision) : "none");
  Serial.print(" overload=");
  Serial.println(doc["overloadThreshold"] | appConfig.overloadThresholdW);

  if (hasRevision && firebaseRevision < appConfig.configRevision) {
    Serial.println("[config] Firebase config ignored because local config is newer");
    return;
  }
  if (!hasRevision && appConfig.configPendingSync && appConfig.configRevision > 0) {
    Serial.println("[config] Firebase config ignored because local config is newer");
    return;
  }

  if (!applyConfigDocument(doc, configSource)) {
    Serial.println("[config] No valid device config fields; keeping cached/default config");
    return;
  }
  if (hasRevision) {
    appConfig.configRevision = firebaseRevision;
  } else if (appConfig.configRevision == 0) {
    appConfig.configRevision = 1;
  }
  appConfig.configPendingSync = false;
  saveLocalConfig();

  Serial.print("[config] Loaded from ");
  Serial.println(configSource);
  Serial.print("[firebase] Config applied tariff=");
  Serial.print(appConfig.tariffPerKwh, 2);
  Serial.print(" overload=");
  Serial.println(appConfig.overloadThresholdW, 2);
}

bool firebasePushDeviceConfig() {
  if (configPushBlockedByRules) {
    return false;
  }

  StaticJsonDocument<640> doc;
  doc["tariff"] = appConfig.tariffPerKwh;
  doc["currency"] = appConfig.currency[0] == '\0' ? Config::DEFAULT_CURRENCY : appConfig.currency;
  doc["overloadThreshold"] = appConfig.overloadThresholdW;
  doc["overloadWarningPercent"] = appConfig.overloadWarningPercent;
  doc["loadPowerThreshold"] = appConfig.loadPowerThresholdW;
  doc["loadCurrentThreshold"] = appConfig.loadCurrentThresholdA;
  doc["loadRemovedDelaySec"] = appConfig.loadRemovedDelaySec;
  doc["offlineTimeoutSec"] = appConfig.offlineTimeoutSec;
  doc["checkpointIntervalSec"] = appConfig.checkpointIntervalSec;
  doc["configRevision"] = appConfig.configRevision;
  doc["updatedAt"] = timeIsSynced() ? getUnixMs() : static_cast<uint64_t>(millis());
  doc["updatedBy"] = "ESP32";
  doc["source"] = appConfig.configSource[0] == '\0' ? "CAPTIVE_PORTAL" : appConfig.configSource;

  String payload;
  serializeJson(doc, payload);
  const String path = finalConfigJsonPath();
  int statusCode = -1;
  bool pathUnauthorized = false;
  const bool ok = httpRequest(
    "PATCH",
    path.c_str(),
    payload,
    nullptr,
    true,
    &statusCode,
    &pathUnauthorized
  );
  if (ok) {
    appConfig.configPendingSync = false;
    saveLocalConfig();
  } else if (pathUnauthorized) {
    configPushBlockedByRules = true;
    Serial.println(
      "[config] Device config push blocked by rules; local config remains pending"
    );
  }
  return ok;
}

bool firebaseDeviceConfigPushBlocked() {
  return configPushBlockedByRules;
}

void firebasePollCommand() {
  CommandPollTimingScope timingScope;

  if (publishPendingStartAckIfReady()) {
    return;
  }

  if (Config::DEVICE_ID == nullptr || Config::DEVICE_ID[0] == '\0') {
    if (!missingCommandDeviceIdLogged) {
      missingCommandDeviceIdLogged = true;
      Serial.println("[command] skipped: missing deviceId");
    }
    return;
  }
  missingCommandDeviceIdLogged = false;

  String response;
  const bool forceLog = shouldLog(lastPollLogMs);
  bool pathUnauthorized = false;
  const String commandPath = String("/devices/") + Config::DEVICE_ID + "/commands/current.json";
  const unsigned long commandHttpStartedAtMs = millis();
  const bool commandHttpOk = httpRequest(
        "GET",
        commandPath.c_str(),
        "",
        &response,
        forceLog,
        nullptr,
        &pathUnauthorized
      );
  Serial.print("[timing] command HTTP duration millis=");
  Serial.println(millis() - commandHttpStartedAtMs);
  if (!commandHttpOk) {
    if (pathUnauthorized) {
      Serial.println("[command] Primary commands/current denied; trying singular fallback");
    }
    pollFinalCommand();
    return;
  }
  if (!singularCommandFallbackDisabled) {
    singularCommandFallbackDisabled = true;
    Serial.println("[command] Primary commands/current available; singular fallback disabled");
  }
  if (response == "null" || response.length() == 0) {
    return;
  }

  StaticJsonDocument<512> doc;
  const DeserializationError error = deserializeJson(doc, response);
  if (error) {
    Serial.print("[firebase] Command parse FAIL ");
    Serial.println(error.c_str());
    return;
  }

  const char* id = doc["id"] | "";
  const char* type = doc["type"] | "";
  const char* uid = doc["uid"] | "";
  const char* commandSessionId = doc["sessionId"] | "";
  uint64_t commandUpdatedAt = 0;
  const bool hasCommandTimestamp = readCommandTimestamp(doc, commandUpdatedAt);
  const unsigned long receivedAtMs = millis();
  const unsigned long ageAtReceiveMs = commandAgeMs(commandUpdatedAt);

  if (id[0] == '\0' || type[0] == '\0') {
    Serial.println("[firebase] Command missing id/type");
    return;
  }

  if (!hasCommandTimestamp || primaryCommandIsStale(commandUpdatedAt)) {
    saveLastProcessedCommandId(id);
    Serial.println("[command] Ignored stale commands/current command");
    setAck(id, type, "REJECTED", "Stale command ignored", "STALE");
    const String lastAckPath = String("/devices/") + Config::DEVICE_ID + "/commands/lastAck.json";
    firebaseAckCommand(lastAckPath.c_str());
    httpRequest("PUT", commandPath.c_str(), "null", nullptr, true);
    return;
  }

  if (strcmp(id, lastProcessedCommandId) == 0) {
    if (pendingStartAck && strcmp(id, pendingStartCommandId) == 0) {
      return;
    }
    setAck(id, type, "DONE", "Duplicate command ignored");
    const String lastAckPath = String("/devices/") + Config::DEVICE_ID + "/commands/lastAck.json";
    firebaseAckCommand(lastAckPath.c_str());
    httpRequest("PUT", commandPath.c_str(), "null", nullptr, true);
    return;
  }

  saveLastProcessedCommandId(id);

  if (commandTypeIsStart(type)) {
    Serial.println("[COMMAND] START_SESSION received");
    Serial.print("[timing] START command received millis=");
    Serial.println(receivedAtMs);
    const char* deviceName = doc["deviceName"] | Config::DEFAULT_DEVICE_NAME;
    if (doc["tariff"].is<float>()) appConfig.tariffPerKwh = doc["tariff"].as<float>();
    if (doc["overloadThreshold"].is<float>()) appConfig.overloadThresholdW = doc["overloadThreshold"].as<float>();
    if (doc["loadPowerThreshold"].is<float>()) appConfig.loadPowerThresholdW = doc["loadPowerThreshold"].as<float>();
    if (doc["loadCurrentThreshold"].is<float>()) appConfig.loadCurrentThresholdA = doc["loadCurrentThreshold"].as<float>();
    saveLocalConfig();
    if (!sessionStart(deviceName)) {
      setAck(id, type, "ERROR", "Device is busy");
      const String lastAckPath = String("/devices/") + Config::DEVICE_ID + "/commands/lastAck.json";
      firebaseAckCommand(lastAckPath.c_str());
      httpRequest("PUT", commandPath.c_str(), "null", nullptr, true);
      return;
    }
    sessionSetRemoteContext(uid, commandSessionId);
    logCommandLatency("START", "commands/current", ageAtReceiveMs, receivedAtMs);
    pendingStartAck = true;
    strlcpy(pendingStartCommandId, id, sizeof(pendingStartCommandId));
    return;
  }

  if (commandTypeIsStop(type)) {
    Serial.println("[COMMAND] STOP_SESSION received");
    Serial.print("[timing] STOP command received millis=");
    Serial.println(receivedAtMs);
    sessionSetRemoteContext(uid, commandSessionId);
    pendingStartAck = false;
    pendingStartCommandId[0] = '\0';
    sessionStop(EndReason::USER_STOP);
    logCommandLatency("STOP", "commands/current", ageAtReceiveMs, receivedAtMs);
    setAck(id, type, "DONE", "STOP command processed");
    transitionAckRequested = true;
    return;
  }

  setAck(id, type, "ERROR", "Unknown command type");
  const String lastAckPath = String("/devices/") + Config::DEVICE_ID + "/commands/lastAck.json";
  firebaseAckCommand(lastAckPath.c_str());
}

bool firebaseCommandTransitionPending() {
  return pendingStartAck ||
    transitionAckRequested ||
    sessionData.state == SessionState::WAITING_LOAD ||
    sessionData.state == SessionState::FINISHING;
}

bool firebaseTransitionAckRequested() {
  return transitionAckRequested;
}

void firebaseFlushTransitionAck() {
  if (!transitionAckRequested) {
    return;
  }
  const String lastAckPath = String("/devices/") + Config::DEVICE_ID + "/commands/lastAck.json";
  firebaseAckCommand(lastAckPath.c_str());
  const String currentCommandPath = String("/devices/") + Config::DEVICE_ID + "/commands/current.json";
  httpRequest("PUT", currentCommandPath.c_str(), "null", nullptr, true);
  transitionAckRequested = false;
}

void firebaseAckCommand(const char* path) {
  StaticJsonDocument<384> doc;
  doc["id"] = ackId;
  doc["type"] = ackType;
  doc["status"] = ackStatus;
  if (ackReason[0] != '\0') {
    doc["reason"] = ackReason;
  }
  doc["message"] = ackMessage;
  doc["processedAt"] = millis();

  String payload;
  serializeJson(doc, payload);
  httpRequest("PUT", path, payload, nullptr, true);
}

HistoryCleanupPollResult firebasePollHistoryCleanup() {
  Serial.println("[history-cleanup] poll started");
  if (!networkIsConnected()) {
    Serial.println("[history-cleanup] skipped reason=offline");
    return HistoryCleanupPollResult::FAILED;
  }
  if (sessionIsActive()) {
    Serial.println("[history-cleanup] skipped reason=active session");
    return HistoryCleanupPollResult::SKIPPED_UNSAFE;
  }

  const String currentPath = historyCleanupCurrentJsonPath();
  String response;
  if (!httpRequest("GET", currentPath.c_str(), "", &response, false)) {
    return HistoryCleanupPollResult::FAILED;
  }
  if (response.length() == 0 || response == "null") {
    return HistoryCleanupPollResult::NO_REQUEST;
  }

  StaticJsonDocument<1024> doc;
  const DeserializationError error = deserializeJson(doc, response);
  if (error || !doc.is<JsonObject>()) {
    Serial.println("[history-cleanup] skipped reason=invalid request");
    return HistoryCleanupPollResult::FAILED;
  }

  const char* requestId = doc["requestId"] | "";
  const char* type = doc["type"] | "";
  Serial.print("[history-cleanup] current request found type=");
  Serial.println(type[0] == '\0' ? "(missing)" : type);
  if (requestId[0] == '\0' || type[0] == '\0') {
    Serial.println("[history-cleanup] skipped reason=invalid request");
    return HistoryCleanupPollResult::FAILED;
  }

  int deletedCount = 0;
  if (strcmp(type, "DELETE_HISTORY_SESSION") == 0) {
    if (!doc["sessionIds"].is<JsonArray>()) {
      Serial.println("[history-cleanup] skipped reason=invalid request");
      return HistoryCleanupPollResult::FAILED;
    }
    for (JsonVariantConst value : doc["sessionIds"].as<JsonArrayConst>()) {
      const char* sessionId = value.as<const char*>();
      if (sessionId == nullptr || sessionId[0] == '\0') {
        continue;
      }
      const int deleted = storageDeleteCompletedSession(sessionId);
      if (deleted < 0) {
        return HistoryCleanupPollResult::FAILED;
      }
      deletedCount += deleted;
    }
  } else if (strcmp(type, "DELETE_ALL_HISTORY") == 0) {
    uint64_t beforeTs = 0;
    if (!parseCleanupBeforeTs(doc["beforeTs"], beforeTs)) {
      Serial.println("[history-cleanup] skipped reason=invalid beforeTs");
      return HistoryCleanupPollResult::FAILED;
    }
    char beforeTsText[24];
    snprintf(beforeTsText, sizeof(beforeTsText), "%llu", beforeTs);
    Serial.print("[history-cleanup] delete all beforeTs=");
    Serial.println(beforeTsText);
    deletedCount = storageClearCompletedHistoryBefore(beforeTs);
    if (deletedCount < 0) {
      return HistoryCleanupPollResult::FAILED;
    }
  } else {
    Serial.println("[history-cleanup] skipped reason=invalid request");
    return HistoryCleanupPollResult::FAILED;
  }

  if (!acknowledgeHistoryCleanup(requestId, type, "DONE", deletedCount)) {
    return HistoryCleanupPollResult::FAILED;
  }
  return HistoryCleanupPollResult::PROCESSED;
}

bool firebasePushCompletedSession(const CompletedSessionSnapshot& snapshot) {
  if (snapshot.sessionId[0] == '\0') {
    Serial.println("[firebase] Completed session push FAIL missing sessionId");
    return false;
  }

  char duration[16];
  char costText[24];
  formatDuration(snapshot.durationSec, duration, sizeof(duration));
  formatCostText(snapshot.cost, costText, sizeof(costText));

  StaticJsonDocument<1536> doc;
  doc["id"] = snapshot.id;
  doc["sessionId"] = snapshot.sessionId;
  doc["deviceId"] = Config::DEVICE_ID;
  doc["uid"] = snapshot.uid;
  doc["name"] = snapshot.deviceName;
  doc["offlineSession"] = snapshot.offlineSession;
  if (snapshot.offlineSession) {
    doc["sessionTag"] = snapshot.sessionTag;
  }
  doc["duration"] = duration;
  doc["durationSec"] = snapshot.durationSec;
  doc["power"] = snapshot.averagePower;
  doc["averagePower"] = snapshot.averagePower;
  doc["peakPower"] = snapshot.peakPower;
  doc["energyWh"] = serialized(String(snapshot.energyWh, 6));
  doc["energy"] = serialized(String(snapshot.energyKwh, 8));
  doc["cost"] = serialized(String(snapshot.cost, 4));
  doc["costText"] = costText;
  doc["voltage"] = snapshot.voltage;
  doc["current"] = snapshot.current;
  doc["frequency"] = snapshot.frequency;
  doc["powerFactor"] = snapshot.powerFactor;
  doc["tariff"] = snapshot.tariff;
  doc["currency"] = snapshot.currency;
  doc["overload"] = snapshot.endReason == EndReason::OVERLOAD;
  doc["overloadThreshold"] = snapshot.overloadThreshold;
  doc["startMode"] = systemModeToString(snapshot.startMode);
  doc["endMode"] = systemModeToString(snapshot.endMode);
  doc["endReason"] = endReasonToString(snapshot.endReason);
  if (snapshot.recovered) {
    doc["recovered"] = true;
    doc["recoverySource"] = snapshot.recoverySource == nullptr ? "active_session_checkpoint" : snapshot.recoverySource;
  }
  doc["date"] = snapshot.date;
  doc["time"] = snapshot.time;
  doc["timestamp"] = snapshot.timestamp;
  doc["syncStatus"] = "SYNCED";
  doc["createdFrom"] = "ESP32";
  addFinalHistoryFields(doc);

  if (doc.overflowed()) {
    Serial.print("[history] Cloud sync skipped: payload overflow sessionId=");
    Serial.println(snapshot.sessionId);
    return false;
  }

  String payload;
  serializeJson(doc, payload);
  const bool ok = pushHistoryPayload(snapshot.sessionId, payload);
  if (ok) {
    Serial.print("[history] Final history sync complete sessionId=");
    Serial.println(snapshot.sessionId);
  } else {
    Serial.print("[history] Cloud sync incomplete, local session kept pending sessionId=");
    Serial.println(snapshot.sessionId);
  }
  return ok;
}

bool firebasePushCompletedSession(JsonObject entry) {
  const char* sessionId = entry["sessionId"] | entry["id"] | "";
  if (sessionId[0] == '\0') {
    Serial.println("[firebase] Completed session push FAIL missing sessionId");
    return false;
  }

  StaticJsonDocument<1536> doc;
  doc.set(entry);
  addFinalHistoryFields(doc);

  if (doc.overflowed()) {
    Serial.print("[history] Cloud sync skipped: payload overflow sessionId=");
    Serial.println(sessionId);
    return false;
  }

  String payload;
  serializeJson(doc, payload);
  const bool ok = pushHistoryPayload(sessionId, payload);
  if (ok) {
    Serial.print("[history] Final history sync complete sessionId=");
    Serial.println(sessionId);
  } else {
    Serial.print("[history] Cloud sync incomplete, local session kept pending sessionId=");
    Serial.println(sessionId);
  }
  return ok;
}
