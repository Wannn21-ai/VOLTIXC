#pragma once

#include <Arduino.h>

struct DeviceAuthState {
  bool enabled = false;
  bool authenticated = false;
  bool authRefreshInProgress = false;
  String idToken;
  String refreshToken;
  unsigned long expiresAtMs = 0;
  unsigned long lastAuthAttemptMs = 0;
  int lastAuthHttpStatus = 0;
  String lastAuthError = "disabled";
};

void deviceAuthBegin();
bool deviceAuthIsEnabled();
bool deviceAuthEnsureAuthenticated(bool forceRefresh = false);
String deviceAuthAppendAuthQuery(const String& url);
void deviceAuthHandleRtdbUnauthorized(int statusCode);
void deviceAuthPrintStatus();
const DeviceAuthState& deviceAuthGetState();
