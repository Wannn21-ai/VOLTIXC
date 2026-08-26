#include "storage.h"
#include "config.h"
#include "firebase_sync.h"
#include "network.h"
#include "state.h"
#include "time_sync.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

static constexpr const char* LEGACY_HISTORY_PATH = "/history.json";
static constexpr const char* HISTORY_DIR = "/history";
static constexpr const char* HISTORY_MIGRATION_MARKER_PATH = "/history_migrated.ok";
static constexpr const char* ACTIVE_SESSION_PATH = "/active_session.json";
static constexpr size_t LEGACY_HISTORY_DOC_CAPACITY = 16384;
static constexpr size_t SESSION_DOC_CAPACITY = 2048;
static constexpr size_t CHECKPOINT_DOC_CAPACITY = 1536;

static bool mounted = false;
static bool pendingHistorySyncRequested = false;
static bool fastHistoryUploadRequested = false;
static char fastHistoryUploadSessionId[48] = "";

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

static void makeHistoryPath(const char* sessionId, char* out, size_t outSize) {
  char safeId[64];
  size_t safeIndex = 0;
  for (size_t index = 0; sessionId != nullptr && sessionId[index] != '\0' && safeIndex < sizeof(safeId) - 1; index++) {
    const char c = sessionId[index];
    const bool safe =
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c == '_' || c == '-';
    safeId[safeIndex++] = safe ? c : '_';
  }
  safeId[safeIndex] = '\0';
  snprintf(out, outSize, "%s/%s.json", HISTORY_DIR, safeId[0] == '\0' ? "unknown" : safeId);
}

static bool isHistorySessionFile(File& file) {
  if (!file || file.isDirectory()) {
    return false;
  }
  const String name = file.name();
  return name.endsWith(".json");
}

static bool readSessionFile(File& file, DynamicJsonDocument& doc) {
  doc.clear();
  const DeserializationError error = deserializeJson(doc, file);
  if (error || !doc.is<JsonObject>()) {
    Serial.print("[storage] Failed to parse session file ");
    Serial.print(file.name());
    Serial.print(": ");
    Serial.println(error ? error.c_str() : "not an object");
    return false;
  }
  return true;
}

static bool parseTimestampMs(JsonVariantConst value, uint64_t& timestampMs) {
  uint64_t parsed = 0;
  if (value.is<const char*>()) {
    const char* text = value.as<const char*>();
    if (text == nullptr || text[0] == '\0') {
      return false;
    }
    char* end = nullptr;
    parsed = strtoull(text, &end, 10);
    if (end == text || *end != '\0') {
      return false;
    }
  } else if (value.is<uint64_t>() || value.is<unsigned long>() || value.is<double>()) {
    const double numeric = value.as<double>();
    if (!isfinite(numeric) || numeric <= 0.0) {
      return false;
    }
    parsed = value.as<uint64_t>();
  } else {
    return false;
  }

  if (parsed == 0) {
    return false;
  }
  if (parsed < 100000000000ULL) {
    parsed *= 1000ULL;
  }
  timestampMs = parsed;
  return true;
}

static bool readCompletedSessionTimestampMs(JsonObjectConst entry, uint64_t& timestampMs) {
  static const char* fields[] = {
    "timestamp",
    "endTime",
    "end_ts",
    "startTime",
    "start_ts"
  };
  for (const char* field : fields) {
    if (parseTimestampMs(entry[field], timestampMs)) {
      return true;
    }
  }
  return false;
}

static bool writeSessionDocument(const char* path, JsonObjectConst entry) {
  const String tempPath = String(path) + ".tmp";
  File file = LittleFS.open(tempPath, "w");
  if (!file) {
    Serial.print("[storage] Failed to open session file for write ");
    Serial.println(path);
    return false;
  }
  const size_t written = serializeJson(entry, file);
  file.close();
  if (written == 0) {
    LittleFS.remove(tempPath);
    return false;
  }
  if (!LittleFS.rename(tempPath, path)) {
    LittleFS.remove(tempPath);
    Serial.print("[storage] Failed to commit session file ");
    Serial.println(path);
    return false;
  }
  return true;
}

static bool writeMigrationMarker() {
  File marker = LittleFS.open(HISTORY_MIGRATION_MARKER_PATH, "w");
  if (!marker) {
    return false;
  }
  const size_t written = marker.print("migrated");
  marker.close();
  return written > 0;
}

static void migrateLegacyHistoryIfPossible() {
  if (!LittleFS.exists(LEGACY_HISTORY_PATH) ||
      LittleFS.exists(HISTORY_MIGRATION_MARKER_PATH)) {
    return;
  }

  File file = LittleFS.open(LEGACY_HISTORY_PATH, "r");
  if (!file) {
    Serial.println("[storage] Legacy /history.json preserved; open failed");
    return;
  }

  DynamicJsonDocument legacyDoc(LEGACY_HISTORY_DOC_CAPACITY);
  const DeserializationError error = deserializeJson(legacyDoc, file);
  file.close();
  if (error || !legacyDoc.is<JsonArray>()) {
    Serial.print("[storage] Legacy /history.json preserved; migration parse failed: ");
    Serial.println(error ? error.c_str() : "not an array");
    return;
  }

  int migrated = 0;
  for (JsonObjectConst entry : legacyDoc.as<JsonArrayConst>()) {
    const char* sessionId = entry["sessionId"] | entry["id"] | "";
    if (sessionId[0] == '\0') {
      Serial.println("[storage] Legacy migration incomplete; entry missing sessionId, /history.json preserved");
      return;
    }
    char path[96];
    makeHistoryPath(sessionId, path, sizeof(path));
    if (LittleFS.exists(path) || writeSessionDocument(path, entry)) {
      migrated++;
      continue;
    }
    Serial.println("[storage] Legacy migration incomplete; /history.json preserved");
    return;
  }

  if (writeMigrationMarker()) {
    Serial.print("[storage] Legacy /history.json migrated and preserved entries=");
    Serial.println(migrated);
  } else {
    Serial.println("[storage] Legacy migration complete but marker write failed; /history.json preserved");
  }
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
  if (mounted) {
    if (!LittleFS.exists(HISTORY_DIR) && !LittleFS.mkdir(HISTORY_DIR)) {
      Serial.println("[storage] Failed to create /history directory");
      return false;
    }
    migrateLegacyHistoryIfPossible();
  }
  return mounted;
}

void storageUpdate() {
}

bool storageAppendCompletedSession(const CompletedSessionSnapshot& snapshot) {
  if (!mounted) {
    Serial.println("[storage] Cannot save session, LittleFS is not mounted");
    return false;
  }

  char path[96];
  makeHistoryPath(snapshot.sessionId, path, sizeof(path));
  if (LittleFS.exists(path)) {
    Serial.print("[storage] Session already in history sessionId=");
    Serial.println(snapshot.sessionId);
    return true;
  }

  DynamicJsonDocument doc(SESSION_DOC_CAPACITY);
  JsonObject entry = doc.to<JsonObject>();

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

  if (doc.overflowed()) {
    Serial.println("[storage] Failed to append history entry, session document is full");
    return false;
  }

  const bool saved = writeSessionDocument(path, entry);
  Serial.print("[storage] Append history ");
  Serial.print(saved ? "OK" : "FAIL");
  Serial.print(" sessionId=");
  Serial.println(snapshot.sessionId);
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
  doc["lastValidVoltage"] = checkpoint.lastValidVoltage;
  doc["lastValidCurrent"] = checkpoint.lastValidCurrent;
  doc["lastValidPower"] = checkpoint.lastValidPower;
  doc["lastValidFrequency"] = checkpoint.lastValidFrequency;
  doc["lastValidPowerFactor"] = checkpoint.lastValidPowerFactor;
  doc["offlineModeActive"] = checkpoint.offlineModeActive;
  doc["offlineManualLock"] = checkpoint.offlineManualLock;
  doc["createdFrom"] = checkpoint.createdFrom;

  if (doc.overflowed()) {
    Serial.println("[storage] Active session checkpoint document is full");
    return false;
  }

  const bool saved = writeSessionDocument(ACTIVE_SESSION_PATH, doc.as<JsonObjectConst>());
  Serial.println(saved ? "[storage] Active session checkpoint saved" : "[storage] Active session checkpoint save failed");
  return saved;
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
  checkpoint.lastValidVoltage = doc["lastValidVoltage"] | 0.0f;
  checkpoint.lastValidCurrent = doc["lastValidCurrent"] | 0.0f;
  checkpoint.lastValidPower = doc["lastValidPower"] | 0.0f;
  checkpoint.lastValidFrequency = doc["lastValidFrequency"] | 0.0f;
  checkpoint.lastValidPowerFactor = doc["lastValidPowerFactor"] | 0.0f;
  checkpoint.offlineModeActive = doc["offlineModeActive"] | (checkpoint.startMode == SystemMode::OFFLINE);
  checkpoint.offlineManualLock = doc.containsKey("offlineManualLock")
    ? (doc["offlineManualLock"] | false)
    : (checkpoint.startMode == SystemMode::OFFLINE);
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

bool storagePrintHistoryJson(Print& output) {
  if (!mounted) {
    Serial.println("[storage] Cannot read history, LittleFS is not mounted");
    return false;
  }

  File root = LittleFS.open(HISTORY_DIR);
  if (!root || !root.isDirectory()) {
    Serial.println("[storage] Failed to open /history directory");
    return false;
  }

  bool first = true;
  bool valid = true;
  output.print("[");
  File file = root.openNextFile();
  while (file) {
    if (isHistorySessionFile(file)) {
      DynamicJsonDocument doc(SESSION_DOC_CAPACITY);
      if (readSessionFile(file, doc)) {
        if (!first) {
          output.print(",");
        }
        serializeJson(doc, output);
        first = false;
      } else {
        valid = false;
      }
    }
    file.close();
    file = root.openNextFile();
  }
  root.close();
  output.print("]");
  return valid;
}

int storageCountHistory() {
  if (!mounted) {
    Serial.println("[storage] Cannot count history, LittleFS is not mounted");
    return -1;
  }

  File root = LittleFS.open(HISTORY_DIR);
  if (!root || !root.isDirectory()) {
    return -1;
  }
  int count = 0;
  File file = root.openNextFile();
  while (file) {
    if (isHistorySessionFile(file)) {
      count++;
    }
    file.close();
    file = root.openNextFile();
  }
  root.close();
  return count;
}

unsigned long storageNextOfflineDeviceCounterFromHistory() {
  if (!mounted) {
    Serial.println("[storage] Cannot scan offline device names, LittleFS is not mounted");
    return 1UL;
  }

  unsigned long maxDeviceNumber = 0;
  File root = LittleFS.open(HISTORY_DIR);
  if (!root || !root.isDirectory()) {
    return 1UL;
  }
  File file = root.openNextFile();
  while (file) {
    if (isHistorySessionFile(file)) {
      DynamicJsonDocument doc(SESSION_DOC_CAPACITY);
      if (readSessionFile(file, doc)) {
        unsigned long number = 0;
        const char* name = doc["name"] | doc["deviceName"] | "";
        if (parseOfflineDeviceNumber(name, number) && number > maxDeviceNumber) {
          maxDeviceNumber = number;
        }
      }
    }
    file.close();
    file = root.openNextFile();
  }
  root.close();

  Serial.print("[offline] Scanned history max offline device=");
  Serial.println(maxDeviceNumber);
  return maxDeviceNumber + 1UL;
}

bool storageClearHistory() {
  if (!mounted) {
    Serial.println("[storage] Cannot clear history, LittleFS is not mounted");
    return false;
  }

  bool cleared = true;
  while (true) {
    File root = LittleFS.open(HISTORY_DIR);
    if (!root || !root.isDirectory()) {
      cleared = false;
      break;
    }
    File file = root.openNextFile();
    String path;
    while (file) {
      if (isHistorySessionFile(file)) {
        path = file.path();
        file.close();
        break;
      }
      file.close();
      file = root.openNextFile();
    }
    root.close();
    if (path.length() == 0) {
      break;
    }
    if (!LittleFS.remove(path)) {
      cleared = false;
      break;
    }
  }
  if (LittleFS.exists(LEGACY_HISTORY_PATH) && !LittleFS.remove(LEGACY_HISTORY_PATH)) {
    cleared = false;
  }
  if (LittleFS.exists(HISTORY_MIGRATION_MARKER_PATH) && !LittleFS.remove(HISTORY_MIGRATION_MARKER_PATH)) {
    cleared = false;
  }
  Serial.println(cleared ? "[storage] History cleared" : "[storage] Clear history incomplete");
  return cleared;
}

int storageDeleteCompletedSession(const char* sessionId) {
  if (!mounted) {
    Serial.println("[history-cleanup] skipped reason=LittleFS not mounted");
    return -1;
  }
  if (sessionId == nullptr || sessionId[0] == '\0') {
    Serial.println("[history-cleanup] skipped reason=invalid sessionId");
    return -1;
  }

  char path[96];
  makeHistoryPath(sessionId, path, sizeof(path));
  if (!LittleFS.exists(path)) {
    pendingHistorySyncRequested = storageCountPendingHistory() > 0;
    return 0;
  }
  if (!LittleFS.remove(path)) {
    Serial.print("[history-cleanup] failed local sessionId=");
    Serial.println(sessionId);
    return -1;
  }

  pendingHistorySyncRequested = storageCountPendingHistory() > 0;
  Serial.print("[history-cleanup] deleted local sessionId=");
  Serial.println(sessionId);
  return 1;
}

int storageClearCompletedHistoryBefore(uint64_t beforeTs) {
  if (!mounted) {
    Serial.println("[history-cleanup] skipped reason=LittleFS not mounted");
    return -1;
  }
  if (beforeTs == 0) {
    Serial.println("[history-cleanup] skipped reason=invalid beforeTs");
    return -1;
  }

  int deletedCount = 0;
  while (true) {
    File root = LittleFS.open(HISTORY_DIR);
    if (!root || !root.isDirectory()) {
      return -1;
    }

    File file = root.openNextFile();
    String path;
    String sessionId;
    while (file) {
      if (isHistorySessionFile(file)) {
        DynamicJsonDocument doc(SESSION_DOC_CAPACITY);
        if (readSessionFile(file, doc)) {
          JsonObjectConst entry = doc.as<JsonObjectConst>();
          sessionId = entry["sessionId"] | entry["id"] | "(unknown)";
          uint64_t sessionTimestampMs = 0;
          if (!readCompletedSessionTimestampMs(entry, sessionTimestampMs)) {
            Serial.print("[history-cleanup] keeping local sessionId=");
            Serial.print(sessionId);
            Serial.println(" reason=missing or invalid timestamp");
          } else if (sessionTimestampMs > beforeTs) {
            Serial.print("[history-cleanup] keeping local sessionId=");
            Serial.print(sessionId);
            Serial.println(" reason=after beforeTs");
          } else {
            path = file.path();
            file.close();
            break;
          }
        }
      }
      file.close();
      file = root.openNextFile();
    }
    root.close();

    if (path.length() == 0) {
      break;
    }
    if (!LittleFS.remove(path)) {
      Serial.println("[history-cleanup] delete all local failed");
      return -1;
    }
    deletedCount++;
    Serial.print("[history-cleanup] deleted local sessionId=");
    Serial.println(sessionId);
  }

  const int pendingCount = storageCountPendingHistory();
  pendingHistorySyncRequested = pendingCount < 0 || pendingCount > 0;
  Serial.print("[history-cleanup] delete all local count=");
  Serial.println(deletedCount);
  return deletedCount;
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

  char path[96];
  makeHistoryPath(sessionId, path, sizeof(path));
  File file = LittleFS.open(path, "r");
  if (!file) {
    Serial.print("[storage] No local history entry for sessionId=");
    Serial.println(sessionId);
    return false;
  }
  DynamicJsonDocument doc(SESSION_DOC_CAPACITY);
  const bool parsed = readSessionFile(file, doc);
  file.close();
  if (!parsed) {
    return false;
  }

  JsonObject entry = doc.as<JsonObject>();
  entry["syncStatus"] = "SYNCED";
  entry["pendingSync"] = false;
  applySyncMetadata(entry);
  const bool saved = writeSessionDocument(path, entry);
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

  File root = LittleFS.open(HISTORY_DIR);
  if (!root || !root.isDirectory()) {
    return -1;
  }
  int count = 0;
  bool valid = true;
  File file = root.openNextFile();
  while (file) {
    if (isHistorySessionFile(file)) {
      DynamicJsonDocument doc(SESSION_DOC_CAPACITY);
      if (readSessionFile(file, doc)) {
        if (isPendingHistoryEntry(doc.as<JsonObjectConst>())) {
          count++;
        }
      } else {
        valid = false;
      }
    }
    file.close();
    file = root.openNextFile();
  }
  root.close();
  return valid ? count : -1;
}

void storageRequestPendingHistorySync() {
  pendingHistorySyncRequested = true;
  Serial.println("[history] auto-sync requested=true");
}

bool storagePendingHistorySyncRequested() {
  return pendingHistorySyncRequested;
}

void storageRequestFastHistoryUpload(const char* sessionId) {
  if (sessionId == nullptr || sessionId[0] == '\0') {
    Serial.println("[history] fast upload skipped reason=invalid sessionId");
    return;
  }
  strlcpy(fastHistoryUploadSessionId, sessionId, sizeof(fastHistoryUploadSessionId));
  fastHistoryUploadRequested = true;
  pendingHistorySyncRequested = true;
  Serial.print("[history] fast upload requested sessionId=");
  Serial.println(fastHistoryUploadSessionId);
}

bool storageFastHistoryUploadRequested() {
  return fastHistoryUploadRequested && fastHistoryUploadSessionId[0] != '\0';
}

bool storageUploadFastCompletedSession() {
  if (!storageFastHistoryUploadRequested()) {
    Serial.println("[history] fast upload skipped reason=no request");
    return false;
  }

  char sessionId[sizeof(fastHistoryUploadSessionId)];
  strlcpy(sessionId, fastHistoryUploadSessionId, sizeof(sessionId));
  if (!mounted) {
    fastHistoryUploadRequested = false;
    pendingHistorySyncRequested = true;
    Serial.print("[history] fast upload skipped reason=LittleFS not mounted sessionId=");
    Serial.println(sessionId);
    Serial.print("[history] pending sync fallback enabled sessionId=");
    Serial.println(sessionId);
    return false;
  }
  if (!networkIsConnected()) {
    fastHistoryUploadRequested = false;
    pendingHistorySyncRequested = true;
    Serial.print("[history] fast upload skipped reason=offline sessionId=");
    Serial.println(sessionId);
    Serial.print("[history] pending sync fallback enabled sessionId=");
    Serial.println(sessionId);
    return false;
  }

  char path[96];
  makeHistoryPath(sessionId, path, sizeof(path));
  File file = LittleFS.open(path, "r");
  if (!file) {
    fastHistoryUploadRequested = false;
    const int pendingCount = storageCountPendingHistory();
    pendingHistorySyncRequested = pendingCount < 0 || pendingCount > 0;
    Serial.print("[history] fast upload skipped reason=missing local sessionId=");
    Serial.println(sessionId);
    return false;
  }

  DynamicJsonDocument doc(SESSION_DOC_CAPACITY);
  const bool parsed = readSessionFile(file, doc);
  file.close();
  if (!parsed) {
    fastHistoryUploadRequested = false;
    pendingHistorySyncRequested = true;
    Serial.print("[history] fast upload FAIL sessionId=");
    Serial.println(sessionId);
    Serial.print("[history] pending sync fallback enabled sessionId=");
    Serial.println(sessionId);
    return false;
  }

  JsonObject entry = doc.as<JsonObject>();
  if (!isPendingHistoryEntry(entry)) {
    fastHistoryUploadRequested = false;
    const int pendingCount = storageCountPendingHistory();
    pendingHistorySyncRequested = pendingCount < 0 || pendingCount > 0;
    Serial.print("[history] fast upload skipped reason=already synced sessionId=");
    Serial.println(sessionId);
    return true;
  }

  Serial.print("[history] fast upload started sessionId=");
  Serial.println(sessionId);
  entry["syncStatus"] = "SYNCED";
  entry["pendingSync"] = false;
  applySyncMetadata(entry);
  const bool pushed = firebasePushCompletedSession(entry);
  if (pushed && writeSessionDocument(path, entry)) {
    fastHistoryUploadRequested = false;
    const int pendingCount = storageCountPendingHistory();
    pendingHistorySyncRequested = pendingCount < 0 || pendingCount > 0;
    Serial.print("[history] fast upload OK sessionId=");
    Serial.println(sessionId);
    return true;
  }

  fastHistoryUploadRequested = false;
  pendingHistorySyncRequested = true;
  Serial.print("[history] fast upload FAIL sessionId=");
  Serial.println(sessionId);
  Serial.print("[history] pending sync fallback enabled sessionId=");
  Serial.println(sessionId);
  return false;
}

bool storageSyncPendingHistoryToFirebase(unsigned int maxUploads) {
  if (!mounted) {
    Serial.println("[storage] Cannot sync pending history, LittleFS is not mounted");
    return false;
  }

  if (maxUploads == 0) {
    maxUploads = 1;
  }

  const int pending = storageCountPendingHistory();
  if (pending < 0) {
    return false;
  }
  Serial.print("[history] pending count before sync=");
  Serial.println(pending);

  if (!networkIsConnected()) {
    pendingHistorySyncRequested = pending > 0;
    Serial.print("[storage] Pending sync total=");
    Serial.print(pending);
    Serial.println(" queued=0 failed=0 save=SKIP WiFi offline");
    return pending == 0;
  }
  if (pending == 0) {
    pendingHistorySyncRequested = false;
    Serial.println("[storage] Pending sync total=0 queued=0 failed=0 remaining=0 save=OK");
    return true;
  }

  unsigned int attemptedCount = 0;
  unsigned int uploadedCount = 0;
  unsigned int failedCount = 0;
  bool cycleSaveOk = true;
  while (attemptedCount < maxUploads) {
    File root = LittleFS.open(HISTORY_DIR);
    if (!root || !root.isDirectory()) {
      return false;
    }

    String path;
    DynamicJsonDocument doc(SESSION_DOC_CAPACITY);
    File file = root.openNextFile();
    while (file) {
      if (!isHistorySessionFile(file)) {
        file.close();
        file = root.openNextFile();
        continue;
      }

      if (!readSessionFile(file, doc)) {
        file.close();
        root.close();
        return false;
      }
      if (isPendingHistoryEntry(doc.as<JsonObjectConst>())) {
        path = file.path();
        file.close();
        break;
      }
      file.close();
      file = root.openNextFile();
    }
    root.close();

    if (path.length() == 0) {
      break;
    }

    JsonObject entry = doc.as<JsonObject>();
    attemptedCount++;
    const char* sessionId = entry["sessionId"] | entry["id"] | "";
    Serial.print("[history] Pending sync upload sessionId=");
    Serial.print(sessionId[0] == '\0' ? "(unknown)" : sessionId);
    Serial.print(" attempt=");
    Serial.print(attemptedCount);
    Serial.print("/");
    Serial.println(maxUploads);

    entry["syncStatus"] = "SYNCED";
    entry["pendingSync"] = false;
    applySyncMetadata(entry);
    const bool pushed = firebasePushCompletedSession(entry);
    Serial.print("[history] Firebase push ");
    Serial.print(pushed ? "OK" : "FAIL");
    Serial.print(" sessionId=");
    Serial.println(sessionId[0] == '\0' ? "(unknown)" : sessionId);
    if (pushed) {
      const bool saved = writeSessionDocument(path.c_str(), entry);
      cycleSaveOk = cycleSaveOk && saved;
      if (saved) {
        uploadedCount++;
      } else {
        failedCount++;
      }
      Serial.print(saved
        ? "[history] pendingSync=false syncStatus=SYNCED sessionId="
        : "[history] Local sync mark failed; session file remains pending sessionId=");
      Serial.println(sessionId[0] == '\0' ? "(unknown)" : sessionId);
      if (!saved) {
        break;
      }
    } else {
      failedCount++;
      Serial.print("[history] pendingSync=true syncStatus=PENDING sessionId=");
      Serial.println(sessionId[0] == '\0' ? "(unknown)" : sessionId);
      break;
    }
  }

  const int remaining = pending - static_cast<int>(uploadedCount);
  pendingHistorySyncRequested = remaining > 0;
  Serial.print("[history] sync cycle uploaded=");
  Serial.print(uploadedCount);
  Serial.print(" failed=");
  Serial.print(failedCount);
  Serial.print(" remaining=");
  Serial.println(remaining);
  Serial.print("[storage] Pending sync total=");
  Serial.print(pending);
  Serial.print(" queued=");
  Serial.print(uploadedCount);
  Serial.print(" failed=");
  Serial.print(failedCount);
  Serial.print(" remaining=");
  Serial.print(remaining);
  Serial.print(" save=");
  Serial.println(cycleSaveOk ? "OK" : "FAIL");
  return failedCount == 0 && cycleSaveOk;
}
