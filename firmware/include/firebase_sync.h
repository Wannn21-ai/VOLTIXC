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
void firebaseAckCommand();
bool firebasePushCompletedSession(const CompletedSessionSnapshot& snapshot);
bool firebasePushCompletedSession(JsonObject entry);
