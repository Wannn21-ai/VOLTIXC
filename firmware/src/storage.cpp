#include "storage.h"
#include "config.h"
#include "firebase_sync.h"
#include "network.h"
#include "state.h"
#include "time_sync.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <string.h>

static constexpr const char* HISTORY_PATH = "/history.json";
static constexpr const char* ACTIVE_SESSION_PATH = "/active_session.json";
static constexpr size_t HISTORY_DOC_CAPACITY = 16384;
static constexpr size_t CHECKPOINT_DOC_CAPACITY = 1024;

static bool mounted = false;

static void formatDuration(unsigned long durationMs, char* out, size_t outSize) {
  const unsigned long totalSec = durationMs / 1000UL;
  const unsigned long hours = totalSec / 3600UL;
  const unsigned long minutes = (totalSec % 3600UL) / 60UL;
  const unsigned long seconds = totalSec % 60UL;
  snprintf(out, outSize, "%02lu:%02lu:%02lu", hours, minutes, seconds);
}

static void formatCostText(float cost, char* out, size_t outSize) {
  snprintf(out, outSize, "Rp %.0f", cost);
}

static bool loadHistory(DynamicJsonDocument& doc) {
  doc.clear();

  if (!LittleFS.exists(HISTORY_PATH)) {
    doc.to<JsonArray>();
    return true;
  }

  File file = LittleFS.open(HISTORY_PATH, "r");
  if (!file) {
    Serial.println("[storage] Failed to open /history.json for read");
    return false;
  }

  if (file.size() == 0) {
    file.close();
    doc.to<JsonArray>();
    return true;
  }

  const DeserializationError error = deserializeJson(doc, file);
  file.close();

  if (error) {
    Serial.print("[storage] Failed to parse /history.json: ");
    Serial.println(error.c_str());
    return false;
  }

  if (!doc.is<JsonArray>()) {
    Serial.println("[storage] /history.json is not a JSON array");
    return false;
  }

  return true;
}

static bool writeHistory(DynamicJsonDocument& doc) {
  File file = LittleFS.open(HISTORY_PATH, "w");
  if (!file) {
    Serial.println("[storage] Failed to open /history.json for write");
    return false;
  }

  const size_t written = serializeJson(doc, file);
  file.close();
  return written > 0;
}

static bool parseOfflineDeviceNumber(const char* name, unsigned long& number) {
  if (name == nullptr) {
    return false;
  }
  if (strncmp(name, "Device ", 7) != 0) {
    return false;
  }

  const char* digits = name + 7;
  if (*digits == '\0') {
    return false;
  }

  unsigned long parsed = 0;
  while (*digits != '\0') {
    if (*digits < '0' || *digits > '9') {
      return false;
    }
    parsed = parsed * 10UL + static_cast<unsigned long>(*digits - '0');
    digits++;
  }

  number = parsed;
  return parsed > 0;
}

static bool isPendingHistoryEntry(JsonObjectConst entry) {
  const char* syncStatus = entry["syncStatus"] | "";
  if (strcmp(syncStatus, "SYNCED") == 0) {
    return false;
  }
  if (strcmp(syncStatus, "PENDING") == 0) {
    return true;
  }
  return entry["pendingSync"] | false;
}

static void applySyncMetadata(JsonObject entry) {
  if (timeIsSynced()) {
    const uint64_t syncedAt = getUnixMs();
    char syncedAtText[24];
    snprintf(syncedAtText, sizeof(syncedAtText), "%llu", syncedAt);
    entry["syncedAt"] = syncedAtText;
    const String syncedDate = getDateString();
    const String syncedTime = getTimeString();
    entry["syncedDate"] = syncedDate;
    entry["syncedTime"] = syncedTime;

    const char* date = entry["date"] | "";
    if (strcmp(date, "-") == 0 || date[0] == '\0') {
      entry["date"] = "-";
      entry["displayDate"] = syncedDate;
    }

    char sessionId[48];
    strlcpy(sessionId, entry["sessionId"] | entry["id"] | "", sizeof(sessionId));
    Serial.print("[time] Added syncedDate for pending session ");
    Serial.println(sessionId[0] == '\0' ? "(unknown)" : sessionId);
  } else {
    entry["syncedAt"] = millis();
  }
}

static SessionState parseSessionState(const char* value) {
  if (value == nullptr) return SessionState::IDLE;
  if (strcmp(value, "WAITING_LOAD") == 0) return SessionState::WAITING_LOAD;
  if (strcmp(value, "MONITORING") == 0) return SessionState::MONITORING;
  if (strcmp(value, "OVERLOAD") == 0) return SessionState::OVERLOAD;
  if (strcmp(value, "FINISHING") == 0) return SessionState::FINISHING;
  if (strcmp(value, "FINISHED") == 0) return SessionState::FINISHED;
  return SessionState::IDLE;
}

static SystemMode parseSystemMode(const char* value) {
  if (value == nullptr) return SystemMode::BOOT;
  if (strcmp(value, "ONLINE") == 0) return SystemMode::ONLINE;
  if (strcmp(value, "OFFLINE") == 0) return SystemMode::OFFLINE;
  if (strcmp(value, "SETUP") == 0) return SystemMode::SETUP;
  if (strcmp(value, "TRANSITION") == 0) return SystemMode::TRANSITION;
  return SystemMode::BOOT;
}

bool storageBegin() {
  mounted = LittleFS.begin(true);
  Serial.print("[storage] LittleFS ");
  Serial.println(mounted ? "mounted" : "mount failed");
  return mounted;
}

void storageUpdate() {
}

bool storageAppendCompletedSession(const CompletedSessionSnapshot& snapshot) {
  if (!mounted) {
    Serial.println("[storage] Cannot save session, LittleFS is not mounted");
    return false;
  }

  DynamicJsonDocument doc(HISTORY_DOC_CAPACITY);
  if (!loadHistory(doc)) {
    return false;
  }

  JsonArray history = doc.as<JsonArray>();
  for (JsonObjectConst existing : history) {
    const char* existingSessionId = existing["sessionId"] | existing["id"] | "";
    if (strcmp(existingSessionId, snapshot.sessionId) == 0) {
      Serial.print("[storage] Session already in history sessionId=");
      Serial.println(snapshot.sessionId);
      return true;
    }
  }

  JsonObject entry = history.createNestedObject();
  if (entry.isNull()) {
    Serial.println("[storage] Failed to append history entry, document is full");
    return false;
  }

  char duration[16];
  char costText[24];
  char energyKwhText[24];
  char costValueText[24];
  formatDuration(snapshot.durationSec * 1000UL, duration, sizeof(duration));
  formatCostText(snapshot.cost, costText, sizeof(costText));
  snprintf(energyKwhText, sizeof(energyKwhText), "%.8f", snapshot.energyKwh);
  snprintf(costValueText, sizeof(costValueText), "%.4f", snapshot.cost);

  entry["id"] = snapshot.id;
  entry["sessionId"] = snapshot.sessionId;
  entry["deviceId"] = Config::DEVICE_ID;
  entry["uid"] = snapshot.uid;
  entry["name"] = snapshot.deviceName;
  entry["offlineSession"] = snapshot.offlineSession;
  if (snapshot.offlineSession) {
    entry["sessionTag"] = snapshot.sessionTag;
  }
  entry["duration"] = duration;
  entry["durationSec"] = snapshot.durationSec;
  entry["power"] = snapshot.averagePower;
  entry["averagePower"] = snapshot.averagePower;
  entry["peakPower"] = snapshot.peakPower;
  entry["energyWh"] = snapshot.energyWh;
  entry["energy"] = serialized(energyKwhText);
  entry["cost"] = serialized(costValueText);
  entry["costText"] = costText;
  entry["voltage"] = snapshot.voltage;
  entry["current"] = snapshot.current;
  entry["frequency"] = snapshot.frequency;
  entry["powerFactor"] = snapshot.powerFactor;
  entry["tariff"] = snapshot.tariff;
  entry["currency"] = snapshot.currency;
  entry["overload"] = snapshot.endReason == EndReason::OVERLOAD;
  entry["overloadThreshold"] = snapshot.overloadThreshold;
  entry["startMode"] = systemModeToString(snapshot.startMode);
  entry["endMode"] = systemModeToString(snapshot.endMode);
  entry["endReason"] = endReasonToString(snapshot.endReason);
  if (snapshot.recovered) {
    entry["recovered"] = true;
    entry["recoverySource"] = snapshot.recoverySource == nullptr ? "active_session_checkpoint" : snapshot.recoverySource;
  }
  entry["date"] = snapshot.date;
  entry["time"] = snapshot.time;
  entry["timestamp"] = snapshot.timestamp;
  entry["syncStatus"] = "PENDING";
  entry["pendingSync"] = true;
  entry["createdFrom"] = "ESP32";

  const bool saved = writeHistory(doc);
  Serial.print("[storage] Append history ");
  Serial.print(saved ? "OK" : "FAIL");
  Serial.print(" count=");
  Serial.println(saved ? history.size() : 0);
  return saved;
}

bool storageWriteActiveSessionCheckpoint(const ActiveSessionCheckpoint& checkpoint) {
  if (!mounted) {
    Serial.println("[storage] Cannot write checkpoint, LittleFS is not mounted");
    return false;
  }

  StaticJsonDocument<CHECKPOINT_DOC_CAPACITY> doc;
  doc["sessionId"] = checkpoint.sessionId;
  doc["uid"] = checkpoint.uid;
  doc["deviceName"] = checkpoint.deviceName;
  doc["active"] = checkpoint.active;
  doc["sessionState"] = sessionStateToString(checkpoint.sessionState);
  doc["startMillis"] = checkpoint.startMillis;
  doc["elapsedSec"] = checkpoint.elapsedSec;
  doc["energyWh"] = serialized(String(checkpoint.energyWh, 6));
  doc["energyKwh"] = serialized(String(checkpoint.energyKwh, 8));
  doc["cost"] = serialized(String(checkpoint.cost, 4));
  doc["peakPower"] = checkpoint.peakPower;
  doc["averagePower"] = checkpoint.averagePower;
  doc["tariff"] = checkpoint.tariff;
  doc["currency"] = checkpoint.currency;
  doc["overloadThreshold"] = checkpoint.overloadThreshold;
  doc["startMode"] = systemModeToString(checkpoint.startMode);
  doc["startUnixMs"] = checkpoint.startUnixMs;
  doc["lastCheckpointMs"] = checkpoint.lastCheckpointMs;
  doc["relayState"] = checkpoint.relayState;
  doc["createdFrom"] = checkpoint.createdFrom;

  File file = LittleFS.open(ACTIVE_SESSION_PATH, "w");
  if (!file) {
    Serial.println("[storage] Failed to open /active_session.json for write");
    return false;
  }

  const size_t written = serializeJson(doc, file);
  file.close();
  Serial.println(written > 0 ? "[storage] Active session checkpoint saved" : "[storage] Active session checkpoint save failed");
  return written > 0;
}

bool storageReadActiveSessionCheckpoint(ActiveSessionCheckpoint& checkpoint) {
  memset(&checkpoint, 0, sizeof(checkpoint));
  if (!mounted) {
    Serial.println("[storage] Cannot read checkpoint, LittleFS is not mounted");
    return false;
  }
  if (!LittleFS.exists(ACTIVE_SESSION_PATH)) {
    return false;
  }

  File file = LittleFS.open(ACTIVE_SESSION_PATH, "r");
  if (!file) {
    Serial.println("[storage] Failed to open /active_session.json for read");
    return false;
  }

  StaticJsonDocument<CHECKPOINT_DOC_CAPACITY> doc;
  const DeserializationError error = deserializeJson(doc, file);
  file.close();
  if (error) {
    Serial.print("[storage] Failed to parse /active_session.json: ");
    Serial.println(error.c_str());
    return false;
  }

  strlcpy(checkpoint.sessionId, doc["sessionId"] | "", sizeof(checkpoint.sessionId));
  strlcpy(checkpoint.uid, doc["uid"] | "", sizeof(checkpoint.uid));
  strlcpy(checkpoint.deviceName, doc["deviceName"] | Config::DEFAULT_DEVICE_NAME, sizeof(checkpoint.deviceName));
  checkpoint.active = doc["active"] | false;
  checkpoint.sessionState = parseSessionState(doc["sessionState"] | "");
  checkpoint.startMillis = doc["startMillis"] | 0UL;
  checkpoint.elapsedSec = doc["elapsedSec"] | 0UL;
  checkpoint.energyWh = doc["energyWh"] | 0.0f;
  checkpoint.energyKwh = doc["energyKwh"] | 0.0f;
  checkpoint.cost = doc["cost"] | 0.0f;
  checkpoint.peakPower = doc["peakPower"] | 0.0f;
  checkpoint.averagePower = doc["averagePower"] | 0.0f;
  checkpoint.tariff = doc["tariff"] | Config::DEFAULT_TARIFF;
  strlcpy(checkpoint.currency, doc["currency"] | Config::DEFAULT_CURRENCY, sizeof(checkpoint.currency));
  checkpoint.overloadThreshold = doc["overloadThreshold"] | Config::OVERLOAD_THRESHOLD_W;
  checkpoint.startMode = parseSystemMode(doc["startMode"] | "");
  checkpoint.startUnixMs = doc["startUnixMs"] | 0ULL;
  checkpoint.lastCheckpointMs = doc["lastCheckpointMs"] | 0UL;
  checkpoint.relayState = doc["relayState"] | false;
  strlcpy(checkpoint.createdFrom, doc["createdFrom"] | "ESP32", sizeof(checkpoint.createdFrom));
  return checkpoint.sessionId[0] != '\0';
}

bool storageReadActiveSessionCheckpointJson(String& out) {
  out = "{}";
  if (!mounted) {
    Serial.println("[storage] Cannot read checkpoint JSON, LittleFS is not mounted");
    return false;
  }
  if (!LittleFS.exists(ACTIVE_SESSION_PATH)) {
    return true;
  }

  File file = LittleFS.open(ACTIVE_SESSION_PATH, "r");
  if (!file) {
    Serial.println("[storage] Failed to open /active_session.json for read");
    return false;
  }

  out = file.readString();
  file.close();
  if (out.length() == 0) {
    out = "{}";
  }
  return true;
}

bool storageClearActiveSessionCheckpoint() {
  if (!mounted) {
    Serial.println("[storage] Cannot clear checkpoint, LittleFS is not mounted");
    return false;
  }
  if (!LittleFS.exists(ACTIVE_SESSION_PATH)) {
    return true;
  }

  const bool removed = LittleFS.remove(ACTIVE_SESSION_PATH);
  Serial.println(removed ? "[storage] Active session checkpoint cleared" : "[storage] Active session checkpoint clear failed");
  return removed;
}

bool storageReadHistoryJson(String& out) {
  out = "[]";
  if (!mounted) {
    Serial.println("[storage] Cannot read history, LittleFS is not mounted");
    return false;
  }

  if (!LittleFS.exists(HISTORY_PATH)) {
    return true;
  }

  File file = LittleFS.open(HISTORY_PATH, "r");
  if (!file) {
    Serial.println("[storage] Failed to open /history.json for read");
    return false;
  }

  out = file.readString();
  file.close();
  if (out.length() == 0) {
    out = "[]";
  }
  return true;
}

int storageCountHistory() {
  if (!mounted) {
    Serial.println("[storage] Cannot count history, LittleFS is not mounted");
    return -1;
  }

  DynamicJsonDocument doc(HISTORY_DOC_CAPACITY);
  if (!loadHistory(doc)) {
    return -1;
  }

  return doc.as<JsonArray>().size();
}

unsigned long storageNextOfflineDeviceCounterFromHistory() {
  if (!mounted) {
    Serial.println("[storage] Cannot scan offline device names, LittleFS is not mounted");
    return 1UL;
  }

  DynamicJsonDocument doc(HISTORY_DOC_CAPACITY);
  if (!loadHistory(doc)) {
    return 1UL;
  }

  unsigned long maxDeviceNumber = 0;
  for (JsonObjectConst entry : doc.as<JsonArrayConst>()) {
    unsigned long number = 0;
    const char* name = entry["name"] | entry["deviceName"] | "";
    if (parseOfflineDeviceNumber(name, number) && number > maxDeviceNumber) {
      maxDeviceNumber = number;
    }
  }

  Serial.print("[offline] Scanned history max offline device=");
  Serial.println(maxDeviceNumber);
  return maxDeviceNumber + 1UL;
}

bool storageClearHistory() {
  if (!mounted) {
    Serial.println("[storage] Cannot clear history, LittleFS is not mounted");
    return false;
  }

  File file = LittleFS.open(HISTORY_PATH, "w");
  if (!file) {
    Serial.println("[storage] Failed to open /history.json for clear");
    return false;
  }

  const size_t written = file.print("[]");
  file.close();
  Serial.println(written > 0 ? "[storage] History cleared" : "[storage] Clear history failed");
  return written > 0;
}

bool storageMarkSessionQueued(const char* sessionId) {
  if (!mounted) {
    Serial.println("[storage] Cannot mark queued, LittleFS is not mounted");
    return false;
  }
  if (sessionId == nullptr || sessionId[0] == '\0') {
    Serial.println("[storage] Cannot mark queued, empty sessionId");
    return false;
  }

  DynamicJsonDocument doc(HISTORY_DOC_CAPACITY);
  if (!loadHistory(doc)) {
    return false;
  }

  JsonArray history = doc.as<JsonArray>();
  bool changed = false;
  for (JsonObject entry : history) {
    const char* entrySessionId = entry["sessionId"] | entry["id"] | "";
    if (strcmp(entrySessionId, sessionId) == 0) {
      entry["syncStatus"] = "SYNCED";
      entry["pendingSync"] = false;
      applySyncMetadata(entry);
      changed = true;
      break;
    }
  }

  if (!changed) {
    Serial.print("[storage] No local history entry for sessionId=");
    Serial.println(sessionId);
    return false;
  }

  const bool saved = writeHistory(doc);
  Serial.print("[storage] Mark synced ");
  Serial.print(sessionId);
  Serial.print(" ");
  Serial.println(saved ? "OK" : "FAIL");
  return saved;
}

int storageCountPendingHistory() {
  if (!mounted) {
    Serial.println("[storage] Cannot count pending history, LittleFS is not mounted");
    return -1;
  }

  DynamicJsonDocument doc(HISTORY_DOC_CAPACITY);
  if (!loadHistory(doc)) {
    return -1;
  }

  int count = 0;
  for (JsonObjectConst entry : doc.as<JsonArrayConst>()) {
    if (isPendingHistoryEntry(entry)) {
      count++;
    }
  }
  return count;
}

bool storageSyncPendingHistoryToFirebase() {
  if (!mounted) {
    Serial.println("[storage] Cannot sync pending history, LittleFS is not mounted");
    return false;
  }

  DynamicJsonDocument doc(HISTORY_DOC_CAPACITY);
  if (!loadHistory(doc)) {
    return false;
  }

  JsonArray history = doc.as<JsonArray>();
  int pending = 0;
  int queued = 0;
  int failed = 0;

  for (JsonObject entry : history) {
    if (isPendingHistoryEntry(entry)) {
      pending++;
    }
  }
  Serial.print("[history] pending sync count=");
  Serial.println(pending);

  if (!networkIsConnected()) {
    Serial.print("[storage] Pending sync total=");
    Serial.print(pending);
    Serial.println(" queued=0 failed=0 save=SKIP WiFi offline");
    return pending == 0;
  }

  for (JsonObject entry : history) {
    if (!isPendingHistoryEntry(entry)) {
      continue;
    }

    const char* sessionId = entry["sessionId"] | entry["id"] | "";
    Serial.print("[history] Pending sync upload sessionId=");
    Serial.print(sessionId[0] == '\0' ? "(unknown)" : sessionId);
    Serial.println(" budget=one");

    entry["syncStatus"] = "SYNCED";
    entry["pendingSync"] = false;
    applySyncMetadata(entry);

    const bool pushed = firebasePushCompletedSession(entry);
    Serial.print("[history] Firebase push ");
    Serial.print(pushed ? "OK" : "FAIL");
    Serial.print(" sessionId=");
    Serial.println(sessionId[0] == '\0' ? "(unknown)" : sessionId);
    if (pushed) {
      queued++;
      Serial.print("[history] pendingSync=false syncStatus=SYNCED sessionId=");
      Serial.println(sessionId[0] == '\0' ? "(unknown)" : sessionId);
    } else {
      entry["syncStatus"] = "PENDING";
      entry["pendingSync"] = true;
      entry.remove("syncedAt");
      entry.remove("syncedDate");
      entry.remove("syncedTime");
      entry.remove("displayDate");
      failed++;
      Serial.print("[history] pendingSync=true syncStatus=PENDING sessionId=");
      Serial.println(sessionId[0] == '\0' ? "(unknown)" : sessionId);
    }
    break;
  }

  bool saved = true;
  if (queued > 0) {
    saved = writeHistory(doc);
  }

  Serial.print("[storage] Pending sync total=");
  Serial.print(pending);
  Serial.print(" queued=");
  Serial.print(queued);
  Serial.print(" failed=");
  Serial.print(failed);
  Serial.print(" remaining=");
  Serial.print(pending - queued);
  Serial.print(" save=");
  Serial.println(saved ? "OK" : "FAIL");

  return failed == 0 && saved;
}
