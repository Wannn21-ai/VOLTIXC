#pragma once

#include <Arduino.h>

void networkBegin();
void networkUpdate();
void networkMarkBootComplete();
bool networkIsConnected();
bool networkIsPortalActive();
void networkStopPortalForOffline();
bool networkReconnectSavedWiFiFromManualOffline();
bool loadSavedWiFiCredentials(String& ssid, String& pass);
void saveWiFiCredentials(const String& ssid, const String& password);
void clearWiFiCredentials();
bool hasSavedWiFiCredentials();
void printSavedWiFiStatus();
void loadLocalConfig();
void saveLocalConfig();
