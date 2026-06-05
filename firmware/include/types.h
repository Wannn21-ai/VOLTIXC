#pragma once

enum class SystemMode {
  BOOT,
  ONLINE,
  OFFLINE,
  SETUP,
  TRANSITION
};

enum class SessionState {
  IDLE,
  WAITING_LOAD,
  MONITORING,
  OVERLOAD,
  FINISHING,
  FINISHED
};

enum class EndReason {
  NONE,
  USER_STOP,
  LOAD_REMOVED,
  LOAD_REMOVED_AFTER_POWER_LOSS,
  OVERLOAD,
  NO_LOAD_DETECTED,
  POWER_LOSS_RECOVERY
};

enum class OfflineEntryReason {
  AUTO_NO_WIFI,
  MANUAL_BOOT_10S,
  MANUAL_CAPTIVE_PORTAL
};

const char* systemModeToString(SystemMode mode);
const char* sessionStateToString(SessionState state);
const char* endReasonToString(EndReason reason);
const char* offlineEntryReasonToString(OfflineEntryReason reason);
