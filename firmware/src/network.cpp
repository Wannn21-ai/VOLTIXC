#include "network.h"
#include "config.h"
#include "credentials.h"
#include "display.h"
#include "firebase_sync.h"
#include "relay.h"
#include "session.h"
#include "state.h"

#include <Arduino.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>

namespace {
constexpr size_t NVS_KEY_MAX_LENGTH = 15;
constexpr char PREF_NAMESPACE[] = "voltix";
constexpr char PREF_KEY_WIFI_SSID[] = "wifi_ssid";
constexpr char PREF_KEY_WIFI_PASS[] = "wifi_pass";
constexpr char PREF_KEY_TARIFF[] = "tariff";
constexpr char PREF_KEY_CURRENCY[] = "currency";
constexpr char PREF_KEY_OVERLOAD_THRESHOLD[] = "ovrThr";
constexpr char PREF_KEY_OVERLOAD_WARNING[] = "ovrWarn";
constexpr char PREF_KEY_LOAD_POWER[] = "ldPow";
constexpr char PREF_KEY_LOAD_CURRENT[] = "ldCur";
constexpr char PREF_KEY_LOAD_REMOVED_DELAY[] = "ldRmSec";
constexpr char PREF_KEY_OFFLINE_TIMEOUT[] = "offSec";
constexpr char PREF_KEY_CHECKPOINT_INTERVAL[] = "chkSec";
constexpr char PREF_KEY_CONFIG_REVISION[] = "cfgRev";
constexpr char PREF_KEY_CONFIG_PENDING_SYNC[] = "cfgPend";
constexpr char PREF_KEY_CONFIG_SOURCE[] = "cfgSrc";
constexpr char PREF_KEY_LEGACY_CONFIG_REVISION[] = "configRevision";
constexpr char PREF_KEY_LEGACY_CONFIG_SOURCE[] = "configSource";

static_assert(sizeof(PREF_NAMESPACE) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences namespace is too long");
static_assert(sizeof(PREF_KEY_WIFI_SSID) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
static_assert(sizeof(PREF_KEY_WIFI_PASS) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
static_assert(sizeof(PREF_KEY_TARIFF) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
static_assert(sizeof(PREF_KEY_CURRENCY) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
static_assert(sizeof(PREF_KEY_OVERLOAD_THRESHOLD) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
static_assert(sizeof(PREF_KEY_OVERLOAD_WARNING) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
static_assert(sizeof(PREF_KEY_LOAD_POWER) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
static_assert(sizeof(PREF_KEY_LOAD_CURRENT) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
static_assert(sizeof(PREF_KEY_LOAD_REMOVED_DELAY) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
static_assert(sizeof(PREF_KEY_OFFLINE_TIMEOUT) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
static_assert(sizeof(PREF_KEY_CHECKPOINT_INTERVAL) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
static_assert(sizeof(PREF_KEY_CONFIG_REVISION) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
static_assert(sizeof(PREF_KEY_CONFIG_PENDING_SYNC) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
static_assert(sizeof(PREF_KEY_CONFIG_SOURCE) - 1 <= NVS_KEY_MAX_LENGTH, "Preferences key is too long");
constexpr const char* SETUP_AP_SSID = "Voltix-Setup";
constexpr const char* SETUP_AP_PASSWORD = "12345678";
constexpr unsigned long WIFI_CONNECT_TIMEOUT_MS = 15000UL;
constexpr unsigned long WIFI_RECONNECT_INTERVAL_MS = 10000UL;
constexpr unsigned long RESTART_DELAY_MS = 1200UL;
constexpr unsigned long BOOT_NEXT_ATTEMPT_MS = 1000UL;
constexpr unsigned long BOOT_EXIT_MANUAL_MS = 3000UL;
constexpr unsigned long BOOT_CLEAR_WIFI_MS = 5000UL;
constexpr unsigned long BOOT_ENTER_OFFLINE_MS = 10000UL;
constexpr unsigned long DEBOUNCE_DELAY_MS = 200UL;
constexpr byte DNS_PORT = 53;

enum class WifiSource {
  NONE,
  SAVED,
  FALLBACK
};

enum class MenuScreen {
  NONE,
  BOOT_CHOICE,
  OFFLINE_CHOICE
};

void updateTwoButtonMenu();
void enterBootChoiceMenu();
void enterOfflineChoiceMenu();
void executeSelectedOption();

static MenuScreen currentMenu = MenuScreen::NONE;
static int selectedOption = 0;
static int optionCount = 0;

// Debouncing
static unsigned long lastOkPressMs = 0;
static unsigned long lastNavPressMs = 0;

static unsigned long lastReconnectAttemptMs = 0;
static unsigned long connectStartedAtMs = 0;
static unsigned long restartAtMs = 0;
static unsigned long bootButtonPressedAtMs = 0;
static unsigned long portalOfflineAtMs = 0;
static bool portalActive = false;
static bool wasConnecting = false;
static bool wasConnected = false;
static bool restartPending = false;
static bool portalOfflinePending = false;
static bool initialNetworkSetup = true;
static String savedWifiSsid;
static String savedWifiPassword;
static String activeWifiSsid;
static String activeWifiPassword;
static WifiSource activeWifiSource = WifiSource::NONE;
static WebServer portalServer(80);
static DNSServer dnsServer;
static const IPAddress setupIp(192, 168, 4, 1);
static const IPAddress setupGateway(192, 168, 4, 1);
static const IPAddress setupSubnet(255, 255, 255, 0);

void startWiFiConnection(const String& ssid, const String& password, WifiSource source, bool background);

String htmlEscape(const String& value) {
  String escaped = value;
  escaped.replace("&", "&amp;");
  escaped.replace("\"", "&quot;");
  escaped.replace("<", "&lt;");
  escaped.replace(">", "&gt;");
  return escaped;
}

String configRevisionText() {
  char buffer[24];
  snprintf(buffer, sizeof(buffer), "%llu", appConfig.configRevision);
  return String(buffer);
}

bool configWriteSucceeded(size_t written, const char* field, const char* key) {
  if (written > 0) {
    return true;
  }
  Serial.print("[config] Preferences write failed field=");
  Serial.print(field);
  Serial.print(" key=");
  Serial.println(key);
  return false;
}

float requestFloatOrCurrent(const char* name, float currentValue, float fallbackValue, bool allowZero = false) {
  if (!portalServer.hasArg(name)) {
    return currentValue;
  }
  const float value = portalServer.arg(name).toFloat();
  if (value > 0.0f || (allowZero && value >= 0.0f)) {
    return value;
  }
  return fallbackValue;
}

unsigned long requestULongOrCurrent(const char* name, unsigned long currentValue, unsigned long fallbackValue, bool allowZero = false) {
  if (!portalServer.hasArg(name)) {
    return currentValue;
  }
  const long rawValue = portalServer.arg(name).toInt();
  if (rawValue > 0 || (allowZero && rawValue >= 0)) {
    return static_cast<unsigned long>(rawValue);
  }
  return fallbackValue;
}

void applyPortalConfigFromRequest(bool bumpRevision) {
  appConfig.tariffPerKwh = requestFloatOrCurrent("tariff", appConfig.tariffPerKwh, Config::DEFAULT_TARIFF, true);
  if (portalServer.hasArg("currency") && portalServer.arg("currency").length() > 0) {
    strlcpy(appConfig.currency, portalServer.arg("currency").c_str(), sizeof(appConfig.currency));
  }
  appConfig.overloadThresholdW = requestFloatOrCurrent("overloadThreshold", appConfig.overloadThresholdW, Config::OVERLOAD_THRESHOLD_W);
  appConfig.overloadWarningPercent = requestFloatOrCurrent("overloadWarningPercent", appConfig.overloadWarningPercent, 90.0f);
  appConfig.loadPowerThresholdW = requestFloatOrCurrent("loadPowerThreshold", appConfig.loadPowerThresholdW, Config::LOAD_POWER_THRESHOLD_W, true);
  appConfig.loadCurrentThresholdA = requestFloatOrCurrent("loadCurrentThreshold", appConfig.loadCurrentThresholdA, Config::LOAD_CURRENT_THRESHOLD_A, true);
  appConfig.loadRemovedDelaySec = requestULongOrCurrent("loadRemovedDelaySec", appConfig.loadRemovedDelaySec, 2UL, true);
  appConfig.offlineTimeoutSec = requestULongOrCurrent("offlineTimeoutSec", appConfig.offlineTimeoutSec, 300UL, true);
  appConfig.checkpointIntervalSec = requestULongOrCurrent("checkpointIntervalSec", appConfig.checkpointIntervalSec, 30UL);

  if (bumpRevision) {
    const uint64_t millisRevision = static_cast<uint64_t>(millis());
    const uint64_t nextRevision = appConfig.configRevision + 1ULL;
    appConfig.configRevision = nextRevision > millisRevision ? nextRevision : millisRevision;
  }
  appConfig.configPendingSync = true;
  strlcpy(appConfig.configSource, "CAPTIVE_PORTAL", sizeof(appConfig.configSource));
  saveLocalConfig();
}

void syncPortalConfigIfPossible() {
  if (networkIsConnected()) {
    if (!firebasePushDeviceConfig()) {
      appConfig.configPendingSync = true;
      saveLocalConfig();
      Serial.println("[config] Config pending sync");
    }
    return;
  }

  appConfig.configPendingSync = true;
  saveLocalConfig();
  Serial.println("[config] Config pending sync");
}

void scheduleRestart() {
  restartPending = true;
  restartAtMs = millis() + RESTART_DELAY_MS;
}

bool isSessionBusyForNetwork() {
  return sessionData.state == SessionState::MONITORING ||
         sessionData.state == SessionState::WAITING_LOAD ||
         sessionIsActive() ||
         relayIsOn() ||
         sessionRecoveryIsActive();
}

bool canStartCaptivePortal(const char* reason) {
  Serial.print("[portal] Request start captive portal: reason=");
  Serial.print(reason == nullptr ? "unknown" : reason);
  Serial.print(" sessionState=");
  Serial.print(sessionStateToString(sessionData.state));
  Serial.print(" active=");
  Serial.print(sessionIsActive() ? "yes" : "no");
  Serial.print(" relay=");
  Serial.println(relayIsOn() ? "on" : "off");

  if (isSessionBusyForNetwork()) {
    Serial.print("[portal] Captive portal suppressed: active session reason=");
    Serial.println(reason == nullptr ? "unknown" : reason);
    return false;
  }

  return true;
}

void sendSetupForm() {
  String page;
  page.reserve(3600);
  page += F("<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>");
  page += F("<title>Voltix Setup</title><style>");
  page += F("body{font-family:Arial,sans-serif;margin:0;background:#f6f7f9;color:#111}");
  page += F("main{max-width:420px;margin:32px auto;padding:20px;background:#fff;border:1px solid #ddd;border-radius:8px}");
  page += F("label{display:block;margin-top:14px;font-weight:600}input{box-sizing:border-box;width:100%;padding:10px;margin-top:6px;border:1px solid #bbb;border-radius:6px;font-size:16px}");
  page += F("button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:6px;background:#111;color:#fff;font-size:16px}");
  page += F(".secondary{background:#444}.ghost{background:#0b6}small{display:block;margin-top:10px;color:#555}a{display:block;margin-top:16px;color:#333;text-align:center}</style></head><body><main>");
  page += F("<h1>Voltix Setup</h1><form id='setupForm' method='post' action='/save'>");
  page += F("<label>WiFi SSID<input name='ssid' value='");
  page += htmlEscape(savedWifiSsid);
  page += F("'></label><label>WiFi Password<input name='password' type='password' value='");
  page += htmlEscape(savedWifiPassword);
  page += F("'></label><label>Tariff<input name='tariff' type='number' step='0.01' value='");
  page += String(appConfig.tariffPerKwh, 2);
  page += F("'></label><label>Currency<input name='currency' maxlength='7' value='");
  page += htmlEscape(String(appConfig.currency));
  page += F("'></label><label>Overload Threshold (W)<input name='overloadThreshold' type='number' step='0.1' value='");
  page += String(appConfig.overloadThresholdW > 0.0f ? appConfig.overloadThresholdW : Config::OVERLOAD_THRESHOLD_W, 1);
  page += F("'></label><label>Overload Warning (%)<input name='overloadWarningPercent' type='number' step='0.1' value='");
  page += String(appConfig.overloadWarningPercent > 0.0f ? appConfig.overloadWarningPercent : 90.0f, 1);
  page += F("'></label><label>Load Power Threshold (W)<input name='loadPowerThreshold' type='number' step='0.1' value='");
  page += String(appConfig.loadPowerThresholdW, 1);
  page += F("'></label><label>Load Current Threshold (A)<input name='loadCurrentThreshold' type='number' step='0.01' value='");
  page += String(appConfig.loadCurrentThresholdA, 2);
  page += F("'></label><label>Load Removed Delay (sec)<input name='loadRemovedDelaySec' type='number' step='1' value='");
  page += String(appConfig.loadRemovedDelaySec);
  page += F("'></label><label>Offline Timeout (sec)<input name='offlineTimeoutSec' type='number' step='1' value='");
  page += String(appConfig.offlineTimeoutSec);
  page += F("'></label><label>Checkpoint Interval (sec)<input name='checkpointIntervalSec' type='number' step='1' value='");
  page += String(appConfig.checkpointIntervalSec > 0 ? appConfig.checkpointIntervalSec : 30UL);
  page += F("'></label><small>Revision ");
  page += configRevisionText();
  page += F(" source ");
  page += htmlEscape(String(appConfig.configSource));
  page += F("</small><button class='ghost' type='submit' formaction='/save-config'>Save Config</button>");
  page += F("<button type='submit'>Save WiFi + Config</button>");
  page += F("<button class='secondary' type='submit' formaction='/offline'>Lanjutkan Mode Offline</button></form>");
  page += F("<a href='/status'>Status</a><a href='/reset-wifi'>Reset WiFi</a></main></body></html>");
  portalServer.send(200, "text/html", page);
}

void sendStatus() {
  String status;
  status.reserve(520);
  status += F("{\"mode\":\"");
  status += portalActive ? F("setup_portal") : F("station");
  status += F("\",\"savedSsidExists\":\"");
  status += hasSavedWiFiCredentials() ? F("yes") : F("no");
  status += F("\",\"currentIp\":\"");
  status += portalActive ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
  status += F("\",\"systemMode\":\"");
  status += systemModeToString(systemMode);
  status += F("\",\"tariff\":");
  status += String(appConfig.tariffPerKwh, 2);
  status += F(",\"currency\":\"");
  status += htmlEscape(String(appConfig.currency));
  status += F("\",\"overloadThreshold\":");
  status += String(appConfig.overloadThresholdW, 1);
  status += F(",\"overloadWarningPercent\":");
  status += String(appConfig.overloadWarningPercent, 1);
  status += F(",\"loadPowerThreshold\":");
  status += String(appConfig.loadPowerThresholdW, 1);
  status += F(",\"loadCurrentThreshold\":");
  status += String(appConfig.loadCurrentThresholdA, 3);
  status += F(",\"configRevision\":");
  status += configRevisionText();
  status += F(",\"configPendingSync\":");
  status += appConfig.configPendingSync ? F("true") : F("false");
  status += F(",\"source\":\"");
  status += htmlEscape(String(appConfig.configSource));
  status += F("\"}");
  portalServer.send(200, "application/json", status);
}

void handleSave() {
  if (!portalServer.hasArg("ssid")) {
    portalServer.send(400, "text/plain", "Missing WiFi SSID");
    return;
  }

  const String ssid = portalServer.arg("ssid");
  const String password = portalServer.hasArg("password") ? portalServer.arg("password") : "";

  if (ssid.length() == 0) {
    portalServer.send(400, "text/plain", "WiFi SSID cannot be empty");
    return;
  }

  saveWiFiCredentials(ssid, password);
  applyPortalConfigFromRequest(true);

  Serial.print("[portal] Saved WiFi SSID=");
  Serial.println(ssid);
  Serial.print("[config] Captive config saved revision=");
  Serial.print(configRevisionText());
  Serial.print(" overload=");
  Serial.println(appConfig.overloadThresholdW, 1);
  syncPortalConfigIfPossible();
  Serial.println("[portal] Credentials saved, restarting");
  portalServer.send(200, "text/html", "<!doctype html><html><body><h1>Saved</h1><p>Voltix is restarting...</p></body></html>");
  scheduleRestart();
}

void handleSaveConfig() {
  applyPortalConfigFromRequest(true);
  Serial.print("[config] Captive config saved revision=");
  Serial.print(configRevisionText());
  Serial.print(" overload=");
  Serial.println(appConfig.overloadThresholdW, 1);
  syncPortalConfigIfPossible();
  portalServer.send(200, "text/html", "<!doctype html><html><body><h1>Config saved</h1><p>Config aktif sekarang. WiFi SSID tidak diperlukan.</p><p><a href='/'>Kembali</a></p></body></html>");
}

void handleResetWiFi() {
  clearWiFiCredentials();
  portalServer.send(200, "text/html", "<!doctype html><html><body><h1>WiFi reset</h1><p>Voltix is restarting...</p></body></html>");
  scheduleRestart();
}

void handleOffline() {
  applyPortalConfigFromRequest(true);
  Serial.print("[config] Captive config saved revision=");
  Serial.print(configRevisionText());
  Serial.print(" overload=");
  Serial.println(appConfig.overloadThresholdW, 1);
  syncPortalConfigIfPossible();
  portalServer.send(
    200,
    "text/html",
    "<!doctype html><html><body><h1>Voltix masuk Mode Offline</h1><p>Relay ON untuk deteksi beban pertama.</p></body></html>"
  );
  portalOfflinePending = true;
  portalOfflineAtMs = millis() + 100UL;
}

void redirectToSetup() {
  portalServer.sendHeader("Location", String("http://") + setupIp.toString() + "/", true);
  portalServer.send(302, "text/plain", "");
}

void startSetupPortal(const char* reason) {
  if (portalActive) {
    return;
  }
  if (!canStartCaptivePortal(reason)) {
    systemMode = SystemMode::OFFLINE;
    return;
  }

  Serial.println("[portal] Starting setup portal...");
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(setupIp, setupGateway, setupSubnet);
  WiFi.softAP(SETUP_AP_SSID, SETUP_AP_PASSWORD);

  dnsServer.start(DNS_PORT, "*", setupIp);
  portalServer.on("/", HTTP_GET, sendSetupForm);
  portalServer.on("/status", HTTP_GET, sendStatus);
  portalServer.on("/save", HTTP_POST, handleSave);
  portalServer.on("/save-config", HTTP_POST, handleSaveConfig);
  portalServer.on("/reset-wifi", HTTP_GET, handleResetWiFi);
  portalServer.on("/offline", HTTP_GET, handleOffline);
  portalServer.on("/offline", HTTP_POST, handleOffline);
  portalServer.on("/generate_204", HTTP_GET, redirectToSetup);
  portalServer.on("/fwlink", HTTP_GET, redirectToSetup);
  portalServer.onNotFound(redirectToSetup);
  portalServer.begin();

  portalActive = true;
  wasConnecting = false;
  activeWifiSource = WifiSource::NONE;
  initialNetworkSetup = false;
  systemMode = SystemMode::SETUP;

  Serial.println("[network] Starting captive portal");
  Serial.print("[portal] AP started SSID=");
  Serial.print(SETUP_AP_SSID);
  Serial.print(" IP=");
  Serial.println(WiFi.softAPIP());
  Serial.println("[portal] WebServer ready");
}

void stopSetupPortalForActiveSession() {
  dnsServer.stop();
  portalServer.stop();
  portalActive = false;
  portalOfflinePending = false;
  initialNetworkSetup = false;
  wasConnecting = false;
  systemMode = SystemMode::OFFLINE;
  Serial.println("[portal] Captive portal suppressed: active session reason=portal already active");

  if (savedWifiSsid.length() > 0) {
    startWiFiConnection(savedWifiSsid, savedWifiPassword, WifiSource::SAVED, true);
  } else {
    WiFi.mode(WIFI_STA);
    lastReconnectAttemptMs = millis();
  }
}

void startWiFiConnection(const String& ssid, const String& password, WifiSource source, bool background) {
  activeWifiSsid = ssid;
  activeWifiPassword = password;
  activeWifiSource = source;
  WiFi.mode(WIFI_STA);
  WiFi.begin(activeWifiSsid.c_str(), activeWifiPassword.c_str());
  systemMode = background || isSessionBusyForNetwork() ? SystemMode::OFFLINE : SystemMode::TRANSITION;
  lastReconnectAttemptMs = millis();
  connectStartedAtMs = millis();
  wasConnecting = true;

  if (background) {
    Serial.println("[network] Background reconnect attempt...");
  } else if (source == WifiSource::SAVED) {
    Serial.println("[network] Trying saved WiFi...");
  } else if (source == WifiSource::FALLBACK) {
    Serial.println("[network] Trying credentials.h fallback WiFi...");
  }
}

bool credentialsFallbackAvailable() {
  return WIFI_SSID != nullptr && WIFI_SSID[0] != '\0';
}

void enterBootChoiceMenu() {
  currentMenu = MenuScreen::BOOT_CHOICE;
  selectedOption = 0;
  optionCount = 2; // "Online", "Offline"
  // NOTE: Anda perlu membuat fungsi displayShowMenu di display.cpp
  displayShowMenu("Pilih Mode", {"Online", "Offline"}, selectedOption);
}

void enterOfflineChoiceMenu() {
  currentMenu = MenuScreen::OFFLINE_CHOICE;
  selectedOption = 0;
  optionCount = 2; // "Next Device", "Mode Online"
  // NOTE: Anda perlu membuat fungsi displayShowMenu di display.cpp
  displayShowMenu("Opsi Offline", {"Next Device", "Mode Online"}, selectedOption);
}

void updateTwoButtonMenu() {
  if (currentMenu == MenuScreen::NONE) {
    // Jika dalam mode offline manual dan tidak ada sesi aktif, tampilkan menu offline
    if (offlineModeIsManualLocked() && !sessionIsActive()) {
      enterOfflineChoiceMenu();
    }
    return;
  }

  const unsigned long now = millis();
  bool navPressed = false;
  bool okPressed = false;

  // Baca tombol NAV (PBM Switch) dengan debounce
  if (digitalRead(Config::BUTTON_NAV_PIN) == LOW) {
    if (now - lastNavPressMs > DEBOUNCE_DELAY_MS) {
      navPressed = true;
      lastNavPressMs = now;
    }
  } else {
    lastNavPressMs = 0;
  }

  // Baca tombol OK (PBM non-latching) dengan debounce
  if (digitalRead(Config::BUTTON_OK_PIN) == LOW) {
    if (now - lastOkPressMs > DEBOUNCE_DELAY_MS) {
      okPressed = true;
      lastOkPressMs = now;
    }
  } else {
    lastOkPressMs = 0;
  }

  if (navPressed) {
    selectedOption = (selectedOption + 1) % optionCount;
    Serial.print("[menu] Navigasi ke opsi: ");
    Serial.println(selectedOption);
    if (currentMenu == MenuScreen::BOOT_CHOICE) {
      displayShowMenu("Pilih Mode", {"Online", "Offline"}, selectedOption);
    } else if (currentMenu == MenuScreen::OFFLINE_CHOICE) {
      displayShowMenu("Opsi Offline", {"Next Device", "Mode Online"}, selectedOption);
    }
  }

  if (okPressed) {
    Serial.print("[menu] OK ditekan pada opsi: ");
    Serial.println(selectedOption);
    executeSelectedOption();
  }
}

void executeSelectedOption() {
  displayClear();

  switch (currentMenu) {
    case MenuScreen::BOOT_CHOICE:
      if (selectedOption == 0) { // Online
        displayShowMessage("Mode Online", "Mencari WiFi...");
        Serial.println("[menu] Aksi: Mulai Mode Online");
        if (loadSavedWiFiCredentials(savedWifiSsid, savedWifiPassword)) {
          startWiFiConnection(savedWifiSsid, savedWifiPassword, WifiSource::SAVED, false);
        } else {
          Serial.println("[network] Tidak ada WiFi tersimpan, mulai portal setup");
          startSetupPortal("boot no WiFi credentials");
        }
      } else { // Offline
        displayShowMessage("Mode Offline", "Menyiapkan...");
        Serial.println("[menu] Aksi: Mulai Mode Offline");
        offlineModeEnter(OfflineEntryReason::MANUAL_MENU);
      }
      break;

    case MenuScreen::OFFLINE_CHOICE: // Menu ini hanya muncul jika offlineModeIsManualLocked() && !sessionIsActive()
      if (selectedOption == 0) { // Next Device
        displayShowMessage("Offline", "Device Berikutnya...");
        Serial.println("[menu] Aksi: Device Berikutnya (Offline)");
        offlineModeStartNextAttempt(false);
      } else { // Beralih ke Mode Online
        displayShowMessage("Beralih...", "Mencoba Online");
        Serial.println("[menu] Aksi: Beralih ke Online dari Offline");
        offlineModeExitManualLockAndTryOnline(); // Ini akan mencoba menyambungkan WiFi
      }
      break;

    default:
      break;
  }
  currentMenu = MenuScreen::NONE; // Keluar dari menu setelah aksi
}
}

void networkBegin() {
  pinMode(Config::BUTTON_OK_PIN, INPUT_PULLUP);
  pinMode(Config::BUTTON_NAV_PIN, INPUT_PULLUP);
  Serial.println("[network] Menampilkan menu pilihan mode boot...");
  enterBootChoiceMenu();
}

void networkUpdate() {
  updateTwoButtonMenu();

  if (restartPending && millis() >= restartAtMs) {
    ESP.restart();
  }

  if (portalActive) {
    if (isSessionBusyForNetwork()) {
      stopSetupPortalForActiveSession();
      return;
    }
    dnsServer.processNextRequest();
    portalServer.handleClient();
    if (portalOfflinePending && millis() >= portalOfflineAtMs) {
      portalOfflinePending = false;
      offlineModeEnter(OfflineEntryReason::MANUAL_CAPTIVE_PORTAL);
      return;
    }
    systemMode = SystemMode::SETUP;
    return;
  }

  const bool connected = networkIsConnected();
  if (connected != wasConnected) {
    wasConnected = connected;
    const bool autoOnlineBlocked = connected && offlineModeBlocksAutoOnline();
    systemMode = connected && !autoOnlineBlocked ? SystemMode::ONLINE : SystemMode::OFFLINE;
    if (connected) {
      initialNetworkSetup = false;
      if (autoOnlineBlocked) {
        if (sessionData.state == SessionState::MONITORING) {
          Serial.println("[network] Manual offline lock prevents auto online during monitoring");
        }
      } else if (sessionData.state == SessionState::MONITORING || sessionData.state == SessionState::WAITING_LOAD) {
        Serial.println("[network] WiFi reconnected, continuing active session");
      } else if (activeWifiSource == WifiSource::SAVED) {
        Serial.println("[network] Saved WiFi connected");
      } else if (activeWifiSource == WifiSource::FALLBACK) {
        Serial.println("[network] Fallback WiFi connected");
      } else {
        Serial.println("[network] WiFi reconnected");
      }
      if (!autoOnlineBlocked) {
        Serial.print("[network] IP=");
        Serial.println(WiFi.localIP());
        if (sessionData.state == SessionState::MONITORING) {
          Serial.println("[session] Continuing active session after reconnect");
        }
      }
    } else {
      if (isSessionBusyForNetwork()) {
        Serial.println("[network] WiFi lost during active session, continuing OFFLINE");
        Serial.println("[portal] Captive portal suppressed: active session");
      } else {
        Serial.println("[network] WiFi lost, switching to OFFLINE");
      }
    }
  }

  if (!connected && wasConnecting && millis() - connectStartedAtMs >= WIFI_CONNECT_TIMEOUT_MS) {
    if (isSessionBusyForNetwork()) {
      Serial.println("[network] Background reconnect failed, will retry");
      wasConnecting = false;
      systemMode = SystemMode::OFFLINE;
      return;
    }

    if (activeWifiSource == WifiSource::SAVED) {
      Serial.println("[network] Saved WiFi failed");
    } else if (activeWifiSource == WifiSource::FALLBACK) {
      Serial.println("[network] Fallback WiFi failed");
    }

    if (!initialNetworkSetup) {
      Serial.println("[network] WiFi reconnect failed, will retry");
      wasConnecting = false;
      systemMode = SystemMode::OFFLINE;
      return;
    }

    initialNetworkSetup = false;
    startSetupPortal("WiFi failed");
    return;
  }

  if (!connected && !wasConnecting && millis() - lastReconnectAttemptMs >= WIFI_RECONNECT_INTERVAL_MS) {
    lastReconnectAttemptMs = millis();
    const bool background = isSessionBusyForNetwork();
    if (activeWifiSsid.length() == 0) {
      if (background) {
        Serial.println("[network] Background reconnect skipped: no saved WiFi credentials");
      } else {
        Serial.println("[network] WiFi reconnect skipped: no saved WiFi credentials");
      }
      systemMode = SystemMode::OFFLINE;
      return;
    }
    if (background) {
      Serial.println("[network] Background reconnect attempt...");
    } else {
      Serial.println("[network] Reconnecting WiFi...");
    }
    WiFi.disconnect(false, false);
    if (background && savedWifiSsid.length() > 0) {
      activeWifiSsid = savedWifiSsid;
      activeWifiPassword = savedWifiPassword;
      activeWifiSource = WifiSource::SAVED;
    }
    WiFi.begin(activeWifiSsid.c_str(), activeWifiPassword.c_str());
    connectStartedAtMs = millis();
    wasConnecting = true;
    systemMode = background ? SystemMode::OFFLINE : SystemMode::TRANSITION;
  }

  if (connected) {
    wasConnecting = false;
  }
}

bool networkIsConnected() {
  return !portalActive && WiFi.status() == WL_CONNECTED;
}

bool networkIsPortalActive() {
  return portalActive;
}

void networkStopPortalForOffline() {
  if (portalActive) {
    portalServer.stop();
    dnsServer.stop();
    portalActive = false;
    Serial.println("[portal] Captive portal stopped for offline mode");
  }

  WiFi.disconnect(false, false);
  wasConnecting = false;
  initialNetworkSetup = false;
  lastReconnectAttemptMs = millis();
  systemMode = SystemMode::OFFLINE;
}

bool networkReconnectSavedWiFiFromManualOffline() {
  Serial.println("[network] Manual offline unlocked, reconnecting saved WiFi");

  if (portalActive) {
    dnsServer.stop();
    portalServer.stop();
    portalActive = false;
    portalOfflinePending = false;
    Serial.println("[portal] Captive portal stopped for manual offline unlock");
  }

  if (networkIsConnected()) {
    return true;
  }

  if (savedWifiSsid.length() == 0 && !loadSavedWiFiCredentials(savedWifiSsid, savedWifiPassword)) {
    Serial.println("[network] WiFi reconnect skipped: no saved WiFi credentials");
    systemMode = SystemMode::OFFLINE;
    return false;
  }

  startWiFiConnection(savedWifiSsid, savedWifiPassword, WifiSource::SAVED, true);
  return true;
}

bool loadSavedWiFiCredentials(String& ssid, String& pass) {
  Preferences prefs;
  if (!prefs.begin(PREF_NAMESPACE, true)) {
    Serial.println("[network] No saved WiFi credentials");
    return false;
  }

  ssid = prefs.getString(PREF_KEY_WIFI_SSID, "");
  pass = prefs.getString(PREF_KEY_WIFI_PASS, "");
  prefs.end();

  if (ssid.length() == 0) {
    Serial.println("[network] No saved WiFi credentials");
    return false;
  }

  Serial.print("[network] Saved WiFi found: ");
  Serial.println(ssid);
  return true;
}

void saveWiFiCredentials(const String& ssid, const String& password) {
  Preferences prefs;
  if (!prefs.begin(PREF_NAMESPACE, false)) {
    Serial.println("[network] Failed to open Preferences for WiFi save");
    return;
  }

  prefs.putString(PREF_KEY_WIFI_SSID, ssid);
  prefs.putString(PREF_KEY_WIFI_PASS, password);
  prefs.end();
  savedWifiSsid = ssid;
  savedWifiPassword = password;
}

void clearWiFiCredentials() {
  Preferences prefs;
  if (!prefs.begin(PREF_NAMESPACE, false)) {
    Serial.println("[network] Failed to open Preferences for WiFi clear");
    return;
  }

  prefs.remove(PREF_KEY_WIFI_SSID);
  prefs.remove(PREF_KEY_WIFI_PASS);
  prefs.end();
  savedWifiSsid = "";
  savedWifiPassword = "";
  Serial.println("[network] saved WiFi cleared");
}

bool hasSavedWiFiCredentials() {
  Preferences prefs;
  if (!prefs.begin(PREF_NAMESPACE, true)) {
    return false;
  }
  const bool hasSsid = prefs.getString(PREF_KEY_WIFI_SSID, "").length() > 0;
  prefs.end();
  return hasSsid;
}

void printSavedWiFiStatus() {
  String ssid;
  String pass;
  const bool hasSaved = loadSavedWiFiCredentials(ssid, pass);
  Serial.print("[network] Saved WiFi: ");
  Serial.println(hasSaved ? "yes" : "no");
  if (hasSaved) {
    Serial.print("[network] Saved SSID: ");
    Serial.println(ssid);
  }
  Serial.print("[network] Fallback credentials.h SSID: ");
  Serial.println(credentialsFallbackAvailable() ? WIFI_SSID : "no");
}

void loadLocalConfig() {
  Preferences prefs;
  if (!prefs.begin(PREF_NAMESPACE, true)) {
    return;
  }

  if (prefs.isKey(PREF_KEY_TARIFF)) appConfig.tariffPerKwh = prefs.getFloat(PREF_KEY_TARIFF, appConfig.tariffPerKwh);
  if (prefs.isKey(PREF_KEY_CURRENCY)) {
    const String currency = prefs.getString(PREF_KEY_CURRENCY, appConfig.currency);
    if (currency.length() > 0) {
      strlcpy(appConfig.currency, currency.c_str(), sizeof(appConfig.currency));
    }
  }
  if (prefs.isKey(PREF_KEY_OVERLOAD_THRESHOLD)) appConfig.overloadThresholdW = prefs.getFloat(PREF_KEY_OVERLOAD_THRESHOLD, appConfig.overloadThresholdW);
  if (prefs.isKey(PREF_KEY_OVERLOAD_WARNING)) appConfig.overloadWarningPercent = prefs.getFloat(PREF_KEY_OVERLOAD_WARNING, appConfig.overloadWarningPercent);
  if (prefs.isKey(PREF_KEY_LOAD_POWER)) appConfig.loadPowerThresholdW = prefs.getFloat(PREF_KEY_LOAD_POWER, appConfig.loadPowerThresholdW);
  if (prefs.isKey(PREF_KEY_LOAD_CURRENT)) appConfig.loadCurrentThresholdA = prefs.getFloat(PREF_KEY_LOAD_CURRENT, appConfig.loadCurrentThresholdA);
  if (prefs.isKey(PREF_KEY_LOAD_REMOVED_DELAY)) appConfig.loadRemovedDelaySec = prefs.getULong(PREF_KEY_LOAD_REMOVED_DELAY, appConfig.loadRemovedDelaySec);
  if (prefs.isKey(PREF_KEY_OFFLINE_TIMEOUT)) appConfig.offlineTimeoutSec = prefs.getULong(PREF_KEY_OFFLINE_TIMEOUT, appConfig.offlineTimeoutSec);
  if (prefs.isKey(PREF_KEY_CHECKPOINT_INTERVAL)) appConfig.checkpointIntervalSec = prefs.getULong(PREF_KEY_CHECKPOINT_INTERVAL, appConfig.checkpointIntervalSec);
  if (prefs.isKey(PREF_KEY_CONFIG_REVISION)) {
    appConfig.configRevision = prefs.getULong64(PREF_KEY_CONFIG_REVISION, appConfig.configRevision);
  } else if (prefs.isKey(PREF_KEY_LEGACY_CONFIG_REVISION)) {
    appConfig.configRevision = prefs.getULong64(PREF_KEY_LEGACY_CONFIG_REVISION, appConfig.configRevision);
  }
  if (prefs.isKey(PREF_KEY_CONFIG_PENDING_SYNC)) appConfig.configPendingSync = prefs.getBool(PREF_KEY_CONFIG_PENDING_SYNC, appConfig.configPendingSync);
  if (prefs.isKey(PREF_KEY_CONFIG_SOURCE)) {
    const String source = prefs.getString(PREF_KEY_CONFIG_SOURCE, appConfig.configSource);
    if (source.length() > 0) {
      strlcpy(appConfig.configSource, source.c_str(), sizeof(appConfig.configSource));
    }
  } else if (prefs.isKey(PREF_KEY_LEGACY_CONFIG_SOURCE)) {
    const String source = prefs.getString(PREF_KEY_LEGACY_CONFIG_SOURCE, appConfig.configSource);
    if (source.length() > 0) {
      strlcpy(appConfig.configSource, source.c_str(), sizeof(appConfig.configSource));
    }
  }
  prefs.end();

  Serial.print("[config] Local config loaded tariff=");
  Serial.print(appConfig.tariffPerKwh, 2);
  Serial.print(" overload=");
  Serial.print(appConfig.overloadThresholdW, 1);
  Serial.print(" revision=");
  Serial.println(configRevisionText());
}

bool saveLocalConfig() {
  Preferences prefs;
  if (!prefs.begin(PREF_NAMESPACE, false)) {
    Serial.println("[network] Failed to open Preferences for config save");
    return false;
  }

  bool saved = true;
  saved = configWriteSucceeded(prefs.putFloat(PREF_KEY_TARIFF, appConfig.tariffPerKwh >= 0.0f ? appConfig.tariffPerKwh : Config::DEFAULT_TARIFF), "tariff", PREF_KEY_TARIFF) && saved;
  saved = configWriteSucceeded(prefs.putString(PREF_KEY_CURRENCY, appConfig.currency[0] == '\0' ? Config::DEFAULT_CURRENCY : appConfig.currency), "currency", PREF_KEY_CURRENCY) && saved;
  saved = configWriteSucceeded(prefs.putFloat(PREF_KEY_OVERLOAD_THRESHOLD, appConfig.overloadThresholdW > 0.0f ? appConfig.overloadThresholdW : Config::OVERLOAD_THRESHOLD_W), "overloadThreshold", PREF_KEY_OVERLOAD_THRESHOLD) && saved;
  saved = configWriteSucceeded(prefs.putFloat(PREF_KEY_OVERLOAD_WARNING, appConfig.overloadWarningPercent > 0.0f ? appConfig.overloadWarningPercent : 90.0f), "overloadWarningPercent", PREF_KEY_OVERLOAD_WARNING) && saved;
  saved = configWriteSucceeded(prefs.putFloat(PREF_KEY_LOAD_POWER, appConfig.loadPowerThresholdW >= 0.0f ? appConfig.loadPowerThresholdW : Config::LOAD_POWER_THRESHOLD_W), "loadPowerThreshold", PREF_KEY_LOAD_POWER) && saved;
  saved = configWriteSucceeded(prefs.putFloat(PREF_KEY_LOAD_CURRENT, appConfig.loadCurrentThresholdA >= 0.0f ? appConfig.loadCurrentThresholdA : Config::LOAD_CURRENT_THRESHOLD_A), "loadCurrentThreshold", PREF_KEY_LOAD_CURRENT) && saved;
  saved = configWriteSucceeded(prefs.putULong(PREF_KEY_LOAD_REMOVED_DELAY, appConfig.loadRemovedDelaySec), "loadRemovedDelaySec", PREF_KEY_LOAD_REMOVED_DELAY) && saved;
  saved = configWriteSucceeded(prefs.putULong(PREF_KEY_OFFLINE_TIMEOUT, appConfig.offlineTimeoutSec), "offlineTimeoutSec", PREF_KEY_OFFLINE_TIMEOUT) && saved;
  saved = configWriteSucceeded(prefs.putULong(PREF_KEY_CHECKPOINT_INTERVAL, appConfig.checkpointIntervalSec > 0 ? appConfig.checkpointIntervalSec : 30UL), "checkpointIntervalSec", PREF_KEY_CHECKPOINT_INTERVAL) && saved;
  saved = configWriteSucceeded(prefs.putULong64(PREF_KEY_CONFIG_REVISION, appConfig.configRevision), "configRevision", PREF_KEY_CONFIG_REVISION) && saved;
  saved = configWriteSucceeded(prefs.putBool(PREF_KEY_CONFIG_PENDING_SYNC, appConfig.configPendingSync), "configPendingSync", PREF_KEY_CONFIG_PENDING_SYNC) && saved;
  saved = configWriteSucceeded(prefs.putString(PREF_KEY_CONFIG_SOURCE, appConfig.configSource[0] == '\0' ? "LOCAL" : appConfig.configSource), "configSource", PREF_KEY_CONFIG_SOURCE) && saved;
  prefs.end();

  Serial.print(saved ? "[config] Local config saved tariff=" : "[config] Local config save incomplete tariff=");
  Serial.print(appConfig.tariffPerKwh, 2);
  Serial.print(" overload=");
  Serial.print(appConfig.overloadThresholdW, 1);
  Serial.print(" revision=");
  Serial.print(configRevisionText());
  Serial.print(" pendingSync=");
  Serial.println(appConfig.configPendingSync ? "true" : "false");
  return saved;
}
