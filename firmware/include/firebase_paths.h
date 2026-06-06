#pragma once

#include <Arduino.h>

namespace FirebasePaths {

// Final schema segments. These helpers intentionally omit the REST ".json"
// suffix so callers can choose the transport in a later integration sprint.
static constexpr const char* DEVICE_ROOT_PREFIX = "/devices/";
static constexpr const char* LIVE_ROOT_SUFFIX = "/live";
static constexpr const char* LIVE_SYSTEM_SUFFIX = "/live/system";
static constexpr const char* LIVE_DEVICE_SUFFIX = "/live/device";
static constexpr const char* CONFIG_SUFFIX = "/config";
static constexpr const char* COMMAND_SUFFIX = "/command";
static constexpr const char* HISTORY_SUFFIX = "/history/";
static constexpr const char* COMPLETED_SESSIONS_SUFFIX = "/completedSessions/";

String pathDeviceRoot(const String& deviceId);
String pathLiveRoot(const String& deviceId);
String pathLiveSystem(const String& deviceId);
String pathLiveDevice(const String& deviceId);
String pathDeviceConfig(const String& deviceId);
String pathDeviceCommand(const String& deviceId);
String pathDeviceHistory(const String& deviceId, const String& historyId);
String pathCompletedSession(const String& deviceId, const String& sessionId);

}  // namespace FirebasePaths
