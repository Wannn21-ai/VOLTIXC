#pragma once

#include <Arduino.h>
#include "state.h"

bool storageBegin();
void storageUpdate();
bool storageAppendCompletedSession(const CompletedSessionSnapshot& snapshot);
bool storageWriteActiveSessionCheckpoint(const ActiveSessionCheckpoint& checkpoint);
bool storageReadActiveSessionCheckpoint(ActiveSessionCheckpoint& checkpoint);
bool storageReadActiveSessionCheckpointJson(String& out);
bool storageClearActiveSessionCheckpoint();
bool storagePrintHistoryJson(Print& output);
int storageCountHistory();
unsigned long storageNextOfflineDeviceCounterFromHistory();
bool storageClearHistory();
int storageDeleteCompletedSession(const char* sessionId);
int storageClearCompletedHistory();
bool storageMarkSessionQueued(const char* sessionId);
int storageCountPendingHistory();
void storageRequestPendingHistorySync();
bool storagePendingHistorySyncRequested();
bool storageSyncPendingHistoryToFirebase(unsigned int maxUploads = 1);
