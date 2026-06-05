#pragma once

#include <Arduino.h>
#include "types.h"

enum class StartValidationResult {
  NONE,
  VERIFIED,
  REJECTED_NO_LOAD
};

void sessionBegin();
bool sessionStart(const char* deviceName);
void sessionSetRemoteContext(const char* uid, const char* sessionId);
void sessionStop(EndReason reason);
void sessionUpdate();
bool sessionIsActive();
bool sessionConsumeStartValidationResult(StartValidationResult& result);
void sessionRecoveryBegin();
void sessionRecoveryUpdate();
bool sessionRecoveryIsActive();
const char* sessionRecoveryStatus();
bool sessionWriteCheckpoint();
bool sessionReadCheckpointJson(String& out);
bool sessionClearCheckpoint();
bool offlineModeEnter(OfflineEntryReason reason);
bool offlineModeStartNextAttempt(bool firstAttempt);
bool offlineModeExitManualLockAndTryOnline();
void offlineModeUpdate();
bool offlineModeIsActive();
bool offlineModeIsManualLocked();
bool offlineModeBlocksAutoOnline();
bool offlineModeShowTryingOnline();
bool offlineModeCanStartNextAttempt();
bool offlineModeShowNoLoadPrompt();
bool offlineModeShowFinishedSummary();
bool offlineModeHandleOnlineRestored();
