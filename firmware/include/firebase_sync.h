#pragma once

#include <ArduinoJson.h>
#include "state.h"

enum class HistoryCleanupPollResult {
  NO_REQUEST,
  PROCESSED,
  FAILED,
  SKIPPED_UNSAFE
};

void firebaseBegin();
bool firebaseAuthenticateDevice();
void firebasePrintAuthStatus();
void firebasePublishLive();
void firebaseReadConfig();
bool firebasePushDeviceConfig();
bool firebaseDeviceConfigPushBlocked();
bool firebaseFetchPairingCode();
bool firebasePairingCodeExpired();
void firebaseClearPairingCode();
bool firebaseSyncOwnerBinding();
void firebasePollCommand();
bool firebaseCommandTransitionPending();
bool firebaseTransitionAckRequested();
void firebaseFlushTransitionAck();
void firebaseAckCommand(const char* path);
HistoryCleanupPollResult firebasePollHistoryCleanup();
bool firebasePushCompletedSession(const CompletedSessionSnapshot& snapshot);
bool firebasePushCompletedSession(JsonObject entry);
