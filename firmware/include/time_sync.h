#pragma once

#include <Arduino.h>

bool timeSyncBegin();
bool timeIsSynced();
String getDateString();
String getTimeString();
uint64_t getUnixMs();
