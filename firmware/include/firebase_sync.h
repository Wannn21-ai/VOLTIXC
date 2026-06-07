#pragma once

#include <ArduinoJson.h>
#include "state.h"

void firebaseBegin();
void firebasePrintAuthStatus();
void firebasePublishLive();
void firebaseReadConfig();
bool firebasePushDeviceConfig();
void firebasePollCommand();
void firebaseAckCommand();
bool firebasePushCompletedSession(const CompletedSessionSnapshot& snapshot);
bool firebasePushCompletedSession(JsonObject entry);
