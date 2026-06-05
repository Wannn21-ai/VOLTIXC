#include "firebase_sync.h"
#include "config.h"
#include "credentials.h"
#include "firebase_paths.h"
#include "network.h"
#include "relay.h"
#include "session.h"
#include "state.h"
#include "time_sync.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <math.h>
#include <stdlib.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

static constexpr unsigned long HTTP_LOG_INTERVAL_MS = 5000UL;

static char lastProcessedCommandId[48] = "";
static char ackId[48] = "";
static char ackType[12] = "";
static char ackStatus[12] = "DONE";
static char ackReason[24] = "";
static char ackMessage[64] = "Command processed";
static bool pendingStartAck = false;
static char pendingStartCommandId[48] = "";
static unsigned long lastLiveLogMs = 0;
static unsigned long lastPollLogMs = 0;

static String configJsonPath(const String& configPath) {
  return configPath + ".json";
}

static String finalConfigJsonPath() {
  return configJsonPath(FirebasePaths::pathDeviceConfig(String(Config::DEVICE_ID)));
}

static String legacyConfigJsonPath() {
  return configJsonPath(String(Config::FIREBASE_DEVICE_CONFIG_PATH));
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
  return normalizeBaseUrl() + path;
}

static void logHttp(const char* method, const char* path, int statusCode, bool ok, bool forceLog) {
  if (!forceLog && ok) {
    return;
  }
  Serial.print("[firebase] ");
  Serial.print(method);
  Serial.print(" ");
  Serial.print(path);
  Serial.print(" status=");
  Serial.print(statusCode);
  Serial.print(" ");
  Serial.println(ok ? "OK" : "FAIL");
}

static bool httpRequest(const char* method, const char* path, const String& payload, String* response, bool forceLog, int* statusOut = nullptr) {
  if (!networkIsConnected()) {
    if (statusOut != nullptr) {
      *statusOut = -1;
    }
    if (forceLog) {
      Serial.print("[firebase] SKIP ");
      Serial.print(method);
      Serial.print(" ");
      Serial.print(path);
      Serial.println(" WiFi offline");
    }
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  const String url = makeUrl(path);
  if (!http.begin(client, url)) {
    if (statusOut != nullptr) {
      *statusOut = -1;
    }
    logHttp(method, path, -1, false, true);
    return false;
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

  const bool ok = statusCode >= 200 && statusCode < 300;
  if (statusOut != nullptr) {
    *statusOut = statusCode;
  }
  if (response != nullptr) {
    *response = http.getString();
  }
  http.end();

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

static String completedSessionPath(const char* sessionId) {
  char path[128];
  snprintf(path, sizeof(path), "/devices/%s/completedSessions/%s.json", Config::DEVICE_ID, sessionId);
  return String(path);
}

static bool isSessionActiveForLive() {
  return sessionData.state == SessionState::MONITORING ||
         sessionData.state == SessionState::OVERLOAD;
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

  firebaseAckCommand();
  httpRequest("PUT", "/devices/esp32-voltix-001/commands/current.json", "null", nullptr, true);
  pendingStartAck = false;
  pendingStartCommandId[0] = '\0';
  return true;
}

void firebaseBegin() {
  Serial.print("[firebase] REST initialized deviceId=");
  Serial.println(Config::DEVICE_ID);
  Serial.println("[firebase] Using RTDB REST with Web API key only; no database secret/service account");
}

void firebasePublishLive() {
  StaticJsonDocument<1024> doc;
  JsonObject system = doc.createNestedObject("system");
  system["timestamp"] = millis();
  system["internet"] = networkIsConnected();
  system["relay"] = relayIsOn();
  system["systemMode"] = systemModeToString(systemMode);
  system["sessionState"] = sessionStateToString(sessionData.state);
  system["deviceId"] = Config::DEVICE_ID;

  JsonObject device = doc.createNestedObject("device");
  device["voltage"] = sensorData.voltage;
  device["current"] = sensorData.current;
  device["power"] = sensorData.power;
  device["apparent"] = sensorData.voltage * sensorData.current;
  device["frequency"] = sensorData.frequency;
  device["powerFactor"] = sensorData.powerFactor;
  device["energy"] = sensorData.energy;
  device["loadDetected"] = sensorData.loadDetected;

  JsonObject session = doc.createNestedObject("session");
  session["active"] = isSessionActiveForLive();
  session["sessionId"] = sessionData.sessionId;
  session["uid"] = sessionData.uid;
  session["deviceName"] = sessionData.deviceName;
  session["elapsedSec"] = sessionData.durationMs / 1000UL;
  session["energyWh"] = serialized(String(sessionData.energyWh, 6));
  session["energy"] = serialized(String(sessionData.energyKwh, 8));
  session["cost"] = serialized(String(sessionData.cost, 4));
  session["endReason"] = endReasonToString(sessionData.endReason);

  String payload;
  serializeJson(doc, payload);
  httpRequest("PATCH", "/devices/esp32-voltix-001/live.json", payload, nullptr, shouldLog(lastLiveLogMs));
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
  const bool ok = httpRequest("PATCH", path.c_str(), payload, nullptr, true);
  if (ok) {
    appConfig.configPendingSync = false;
    saveLocalConfig();
  }
  return ok;
}

void firebasePollCommand() {
  if (publishPendingStartAckIfReady()) {
    return;
  }

  String response;
  const bool forceLog = shouldLog(lastPollLogMs);
  if (!httpRequest("GET", "/devices/esp32-voltix-001/commands/current.json", "", &response, forceLog)) {
    return;
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

  if (id[0] == '\0' || type[0] == '\0') {
    Serial.println("[firebase] Command missing id/type");
    return;
  }

  if (strcmp(id, lastProcessedCommandId) == 0) {
    if (pendingStartAck && strcmp(id, pendingStartCommandId) == 0) {
      return;
    }
    setAck(id, type, "DONE", "Duplicate command ignored");
    firebaseAckCommand();
    httpRequest("PUT", "/devices/esp32-voltix-001/commands/current.json", "null", nullptr, true);
    return;
  }

  strlcpy(lastProcessedCommandId, id, sizeof(lastProcessedCommandId));

  if (strcmp(type, "START") == 0) {
    const char* deviceName = doc["deviceName"] | Config::DEFAULT_DEVICE_NAME;
    if (doc["tariff"].is<float>()) appConfig.tariffPerKwh = doc["tariff"].as<float>();
    if (doc["overloadThreshold"].is<float>()) appConfig.overloadThresholdW = doc["overloadThreshold"].as<float>();
    if (doc["loadPowerThreshold"].is<float>()) appConfig.loadPowerThresholdW = doc["loadPowerThreshold"].as<float>();
    if (doc["loadCurrentThreshold"].is<float>()) appConfig.loadCurrentThresholdA = doc["loadCurrentThreshold"].as<float>();
    saveLocalConfig();
    if (!sessionStart(deviceName)) {
      setAck(id, type, "ERROR", "Device is busy");
      firebaseAckCommand();
      httpRequest("PUT", "/devices/esp32-voltix-001/commands/current.json", "null", nullptr, true);
      return;
    }
    sessionSetRemoteContext(uid, commandSessionId);
    pendingStartAck = true;
    strlcpy(pendingStartCommandId, id, sizeof(pendingStartCommandId));
    return;
  }

  if (strcmp(type, "STOP") == 0) {
    sessionSetRemoteContext(uid, commandSessionId);
    pendingStartAck = false;
    pendingStartCommandId[0] = '\0';
    if (sessionIsActive()) {
      sessionStop(EndReason::USER_STOP);
    }
    setAck(id, type, "DONE", "STOP command processed");
    firebaseAckCommand();
    httpRequest("PUT", "/devices/esp32-voltix-001/commands/current.json", "null", nullptr, true);
    return;
  }

  setAck(id, type, "ERROR", "Unknown command type");
  firebaseAckCommand();
}

void firebaseAckCommand() {
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
  httpRequest("PUT", "/devices/esp32-voltix-001/commands/lastAck.json", payload, nullptr, true);
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

  StaticJsonDocument<1280> doc;
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

  String payload;
  serializeJson(doc, payload);
  const String path = completedSessionPath(snapshot.sessionId);
  int statusCode = -1;
  const bool ok = httpRequest("PUT", path.c_str(), payload, nullptr, true, &statusCode);
  if (ok) {
    Serial.print("[firebase] Pending session queued sessionId=");
    Serial.println(snapshot.sessionId);
  } else {
    Serial.print("[firebase] Completed session push FAIL sessionId=");
    Serial.print(snapshot.sessionId);
    Serial.print(" status=");
    Serial.println(statusCode);
    Serial.print("[firebase] payload=");
    Serial.println(payload);
  }
  return ok;
}

bool firebasePushCompletedSession(JsonObject entry) {
  const char* sessionId = entry["sessionId"] | entry["id"] | "";
  if (sessionId[0] == '\0') {
    Serial.println("[firebase] Completed session push FAIL missing sessionId");
    return false;
  }

  String payload;
  serializeJson(entry, payload);
  const String path = completedSessionPath(sessionId);
  int statusCode = -1;
  const bool ok = httpRequest("PUT", path.c_str(), payload, nullptr, true, &statusCode);
  if (ok) {
    Serial.print("[firebase] Pending session queued sessionId=");
    Serial.println(sessionId);
  } else {
    Serial.print("[firebase] Completed session push FAIL sessionId=");
    Serial.print(sessionId);
    Serial.print(" status=");
    Serial.println(statusCode);
    Serial.print("[firebase] payload=");
    Serial.println(payload);
  }
  return ok;
}
