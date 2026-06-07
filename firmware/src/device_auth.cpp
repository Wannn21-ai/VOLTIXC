#include "device_auth.h"

#include "config.h"
#include "credentials.h"
#include "device_auth_config.h"
#include "network.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

namespace {
constexpr unsigned long AUTH_HTTP_TIMEOUT_MS = 8000UL;
constexpr unsigned long AUTH_RETRY_BACKOFF_MS = 30000UL;
constexpr unsigned long TOKEN_REFRESH_MARGIN_SEC = 300UL;

DeviceAuthState authState;

bool configured(const char* value) {
  return value != nullptr && value[0] != '\0';
}

void clearTokens(const char* error, int statusCode) {
  authState.idToken = "";
  authState.refreshToken = "";
  authState.expiresAtMs = 0;
  authState.authenticated = false;
  authState.lastAuthHttpStatus = statusCode;
  authState.lastAuthError = error;
}

bool tokenStillValid() {
  if (!authState.authenticated || authState.idToken.length() == 0) {
    return false;
  }
  return static_cast<long>(authState.expiresAtMs - millis()) > 0;
}

bool authConfigurationComplete() {
  if (!configured(VOLTIX_TOKEN_BROKER_URL) ||
      !configured(VOLTIX_DEVICE_SECRET) ||
      !configured(VOLTIX_TOKEN_BROKER_ROOT_CA) ||
      !configured(VOLTIX_IDENTITY_TOOLKIT_ROOT_CA) ||
      !configured(VOLTIX_FIREBASE_RTDB_ROOT_CA) ||
      !configured(FIREBASE_API_KEY) ||
      VOLTIX_DEVICE_CREDENTIAL_VERSION < 1) {
    clearTokens("configuration_missing", 0);
    return false;
  }
  const String brokerUrl = VOLTIX_TOKEN_BROKER_URL;
  if (!brokerUrl.startsWith("https://")) {
    clearTokens("broker_https_required", 0);
    return false;
  }
  return true;
}

int postJson(
  const String& url,
  const char* rootCa,
  const String& payload,
  String& response
) {
  WiFiClientSecure client;
  client.setCACert(rootCa);

  HTTPClient http;
  if (!http.begin(client, url)) {
    return -1;
  }
  http.setTimeout(AUTH_HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  const int statusCode = http.POST(payload);
  response = http.getString();
  http.end();
  return statusCode;
}

bool exchangeCustomToken(const String& customToken) {
  StaticJsonDocument<768> requestDoc;
  requestDoc["token"] = customToken;
  requestDoc["returnSecureToken"] = true;
  String requestPayload;
  serializeJson(requestDoc, requestPayload);

  const String url =
    String("https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=") +
    FIREBASE_API_KEY;
  String response;
  const int statusCode = postJson(
    url,
    VOLTIX_IDENTITY_TOOLKIT_ROOT_CA,
    requestPayload,
    response
  );
  authState.lastAuthHttpStatus = statusCode;
  if (statusCode < 200 || statusCode >= 300) {
    clearTokens("identity_exchange_failed", statusCode);
    return false;
  }

  DynamicJsonDocument responseDoc(4096);
  if (deserializeJson(responseDoc, response) ||
      !responseDoc["idToken"].is<const char*>() ||
      !responseDoc["refreshToken"].is<const char*>()) {
    clearTokens("identity_response_invalid", statusCode);
    return false;
  }

  unsigned long expiresInSec = 0;
  if (responseDoc["expiresIn"].is<const char*>()) {
    expiresInSec = strtoul(responseDoc["expiresIn"].as<const char*>(), nullptr, 10);
  } else if (responseDoc["expiresIn"].is<unsigned long>()) {
    expiresInSec = responseDoc["expiresIn"].as<unsigned long>();
  }
  if (expiresInSec <= TOKEN_REFRESH_MARGIN_SEC) {
    clearTokens("identity_expiry_invalid", statusCode);
    return false;
  }

  authState.idToken = responseDoc["idToken"].as<const char*>();
  authState.refreshToken = responseDoc["refreshToken"].as<const char*>();
  authState.expiresAtMs =
    millis() + (expiresInSec - TOKEN_REFRESH_MARGIN_SEC) * 1000UL;
  authState.authenticated = true;
  authState.lastAuthError = "none";
  return true;
}

bool signInThroughBroker() {
  StaticJsonDocument<512> requestDoc;
  requestDoc["deviceId"] = Config::DEVICE_ID;
  requestDoc["deviceSecret"] = VOLTIX_DEVICE_SECRET;
  requestDoc["credentialVersion"] = VOLTIX_DEVICE_CREDENTIAL_VERSION;
  String requestPayload;
  serializeJson(requestDoc, requestPayload);

  String response;
  const int statusCode = postJson(
    VOLTIX_TOKEN_BROKER_URL,
    VOLTIX_TOKEN_BROKER_ROOT_CA,
    requestPayload,
    response
  );
  authState.lastAuthHttpStatus = statusCode;
  if (statusCode < 200 || statusCode >= 300) {
    clearTokens("broker_request_failed", statusCode);
    return false;
  }

  DynamicJsonDocument responseDoc(2048);
  if (deserializeJson(responseDoc, response) ||
      !responseDoc["customToken"].is<const char*>()) {
    clearTokens("broker_response_invalid", statusCode);
    return false;
  }

  String customToken = responseDoc["customToken"].as<const char*>();
  const bool exchanged = exchangeCustomToken(customToken);
  customToken = "";
  response = "";
  responseDoc.clear();
  return exchanged;
}
}  // namespace

void deviceAuthBegin() {
  authState = DeviceAuthState();
  authState.enabled = VOLTIX_DEVICE_AUTH_ENABLED != 0;
  authState.lastAuthError = authState.enabled ? "not_authenticated" : "disabled";
  Serial.print("[auth] enabled=");
  Serial.println(authState.enabled ? "true" : "false");
}

bool deviceAuthIsEnabled() {
  return authState.enabled;
}

bool deviceAuthEnsureAuthenticated(bool forceRefresh) {
  if (!authState.enabled) {
    return false;
  }
  if (!forceRefresh && tokenStillValid()) {
    return true;
  }
  if (authState.authRefreshInProgress) {
    return false;
  }
  if (!forceRefresh &&
      authState.lastAuthAttemptMs > 0 &&
      millis() - authState.lastAuthAttemptMs < AUTH_RETRY_BACKOFF_MS) {
    return false;
  }
  if (!networkIsConnected()) {
    clearTokens("wifi_offline", -1);
    return false;
  }
  authState.lastAuthAttemptMs = millis();
  if (!authConfigurationComplete()) {
    return false;
  }

  authState.authRefreshInProgress = true;
  const bool authenticated = signInThroughBroker();
  authState.authRefreshInProgress = false;
  Serial.print("[auth] sign-in ");
  Serial.println(authenticated ? "OK" : "FAIL (local operation continues)");
  return authenticated;
}

String deviceAuthAppendAuthQuery(const String& url) {
  if (!authState.enabled || !tokenStillValid()) {
    return url;
  }
  return url + (url.indexOf('?') >= 0 ? "&auth=" : "?auth=") + authState.idToken;
}

void deviceAuthHandleRtdbUnauthorized(int statusCode) {
  if (!authState.enabled) {
    return;
  }
  clearTokens("rtdb_unauthorized", statusCode);
}

void deviceAuthPrintStatus() {
  unsigned long expiresInSec = 0;
  if (tokenStillValid()) {
    expiresInSec = (authState.expiresAtMs - millis()) / 1000UL;
  }
  Serial.print("[auth] enabled=");
  Serial.print(authState.enabled ? "true" : "false");
  Serial.print(" authenticated=");
  Serial.print(authState.authenticated ? "true" : "false");
  Serial.print(" expiresInSec=");
  Serial.print(expiresInSec);
  Serial.print(" lastStatus=");
  Serial.print(authState.lastAuthHttpStatus);
  Serial.print(" lastError=");
  Serial.println(authState.lastAuthError);
}

const DeviceAuthState& deviceAuthGetState() {
  return authState;
}
