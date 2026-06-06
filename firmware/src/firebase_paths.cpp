#include "firebase_paths.h"

namespace FirebasePaths {

String pathDeviceRoot(const String& deviceId) {
  return String(DEVICE_ROOT_PREFIX) + deviceId;
}

String pathLiveRoot(const String& deviceId) {
  return pathDeviceRoot(deviceId) + LIVE_ROOT_SUFFIX;
}

String pathLiveSystem(const String& deviceId) {
  return pathDeviceRoot(deviceId) + LIVE_SYSTEM_SUFFIX;
}

String pathLiveDevice(const String& deviceId) {
  return pathDeviceRoot(deviceId) + LIVE_DEVICE_SUFFIX;
}

String pathDeviceConfig(const String& deviceId) {
  return pathDeviceRoot(deviceId) + CONFIG_SUFFIX;
}

String pathDeviceCommand(const String& deviceId) {
  return pathDeviceRoot(deviceId) + COMMAND_SUFFIX;
}

String pathDeviceHistory(const String& deviceId, const String& historyId) {
  return pathDeviceRoot(deviceId) + HISTORY_SUFFIX + historyId;
}

String pathCompletedSession(const String& deviceId, const String& sessionId) {
  return pathDeviceRoot(deviceId) + COMPLETED_SESSIONS_SUFFIX + sessionId;
}

}  // namespace FirebasePaths
