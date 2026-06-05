#include "time_sync.h"

#include <Arduino.h>
#include <stdint.h>
#include <sys/time.h>
#include <time.h>

static constexpr int MIN_VALID_YEAR = 2023;
static bool ntpStarted = false;
static bool timeSynced = false;
static bool syncLogged = false;
static bool fallbackLogged = false;

static bool readLocalTime(struct tm& timeInfo) {
  if (!ntpStarted) {
    return false;
  }

  if (!getLocalTime(&timeInfo, 0)) {
    return false;
  }

  return (timeInfo.tm_year + 1900) >= MIN_VALID_YEAR;
}

static void formatDate(const struct tm& timeInfo, char* out, size_t outSize) {
  snprintf(out, outSize, "%04d-%02d-%02d",
           timeInfo.tm_year + 1900,
           timeInfo.tm_mon + 1,
           timeInfo.tm_mday);
}

static void formatTime(const struct tm& timeInfo, char* out, size_t outSize) {
  snprintf(out, outSize, "%02d:%02d:%02d",
           timeInfo.tm_hour,
           timeInfo.tm_min,
           timeInfo.tm_sec);
}

static void logFallbackOnce() {
  if (!fallbackLogged) {
    fallbackLogged = true;
    Serial.println("[time] NTP failed, using millis fallback");
  }
}

static void logSyncedOnce(const struct tm& timeInfo) {
  if (syncLogged) {
    return;
  }

  syncLogged = true;
  char dateBuffer[11];
  char timeBuffer[9];
  formatDate(timeInfo, dateBuffer, sizeof(dateBuffer));
  formatTime(timeInfo, timeBuffer, sizeof(timeBuffer));
  Serial.print("[time] NTP synced: ");
  Serial.print(dateBuffer);
  Serial.print(" ");
  Serial.println(timeBuffer);
}

bool timeSyncBegin() {
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com", "id.pool.ntp.org");
  ntpStarted = true;
  timeSynced = false;
  syncLogged = false;
  fallbackLogged = false;
  Serial.println("[time] syncing NTP...");
  timeIsSynced();
  return true;
}

bool timeIsSynced() {
  if (timeSynced) {
    return true;
  }

  struct tm timeInfo;
  if (!readLocalTime(timeInfo)) {
    return false;
  }

  timeSynced = true;
  logSyncedOnce(timeInfo);
  return true;
}

String getDateString() {
  if (!timeIsSynced()) {
    logFallbackOnce();
    return "-";
  }

  struct tm timeInfo;
  if (!readLocalTime(timeInfo)) {
    time_t now = time(nullptr);
    localtime_r(&now, &timeInfo);
  }
  logSyncedOnce(timeInfo);

  char buffer[11];
  formatDate(timeInfo, buffer, sizeof(buffer));
  return String(buffer);
}

String getTimeString() {
  if (!timeIsSynced()) {
    logFallbackOnce();
    return "-";
  }

  struct tm timeInfo;
  if (!readLocalTime(timeInfo)) {
    time_t now = time(nullptr);
    localtime_r(&now, &timeInfo);
  }
  logSyncedOnce(timeInfo);

  char buffer[9];
  formatTime(timeInfo, buffer, sizeof(buffer));
  return String(buffer);
}

uint64_t getUnixMs() {
  if (!timeIsSynced()) {
    logFallbackOnce();
    return static_cast<uint64_t>(millis());
  }

  struct tm timeInfo;
  if (!readLocalTime(timeInfo)) {
    time_t now = time(nullptr);
    localtime_r(&now, &timeInfo);
  }
  logSyncedOnce(timeInfo);

  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (static_cast<uint64_t>(tv.tv_sec) * 1000ULL) +
         (static_cast<uint64_t>(tv.tv_usec) / 1000ULL);
}
