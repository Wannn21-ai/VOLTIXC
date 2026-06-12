#pragma once

#include <ArduinoJson.h>
#include "state.h"

void firebaseBegin();
bool firebaseAuthenticateDevice();
void firebasePrintAuthStatus();
void firebasePublishLive();
void firebaseReadConfig();
bool firebasePushDeviceConfig();
bool firebaseDeviceConfigPushBlocked();
void firebasePollCommand();
bool firebaseCommandTransitionPending();
bool firebaseTransitionAckRequested();
void firebaseFlushTransitionAck();
void firebaseAckCommand();
bool firebasePushCompletedSession(const CompletedSessionSnapshot& snapshot);
bool firebasePushCompletedSession(JsonObject entry);
