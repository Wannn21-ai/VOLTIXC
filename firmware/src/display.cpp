#include "display.h"
#include "config.h"
#include "network.h"
#include "relay.h"
#include "session.h"
#include "state.h"

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <Wire.h>
#include <string.h>
#include <vector>
#include <string>

// Forward declarations for functions from network.cpp
bool networkIsMenuActive();
void networkGetMenuDetails(String& title, std::vector<std::string>& options, int& selected);

namespace {
constexpr int SCREEN_WIDTH = 128;
constexpr int SCREEN_HEIGHT = 64;
constexpr int OLED_RESET = -1;
constexpr unsigned long DISPLAY_INTERVAL_MS = 500UL;
constexpr unsigned long BUTTON_DISPLAY_INTERVAL_MS = 200UL;
constexpr unsigned long BUTTON_FEEDBACK_MS = 1200UL;
constexpr unsigned long ROTATION_STATUS_MS = 5000UL;
constexpr unsigned long ROTATION_BRANDING_MS = 3000UL;
constexpr size_t MAX_LINE_CHARS = 21;
constexpr size_t MAX_WELCOME_NAME_CHARS = 20;
constexpr size_t BUTTON_LABEL_CHARS = 22;

enum class RotationContext {
  NONE,
  IDLE,
  SETUP,
  OFFLINE_READY,
  OFFLINE_NO_LOAD
};

Adafruit_SSD1306 oled(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
bool oledReady = false;
unsigned long lastDisplayMs = 0;
unsigned long rotationStartedAtMs = 0;
RotationContext rotationContext = RotationContext::NONE;
bool buttonHoldVisible = false;
unsigned long buttonHoldDurationMs = 0;
unsigned long lastButtonHoldDisplayMs = 0;
uint8_t buttonHoldProgressPercent = 0;
char buttonHoldReleaseAction[BUTTON_LABEL_CHARS] = "";
bool buttonFeedbackVisible = false;
unsigned long buttonFeedbackUntilMs = 0;
char buttonFeedbackMessage[BUTTON_LABEL_CHARS] = "";

void drawLine(uint8_t line, const char* text) {
  oled.setCursor(0, line * 10);
  oled.print(text);
}

void drawCenteredText(const char* text, int16_t y, uint8_t textSize) {
  int16_t x1;
  int16_t y1;
  uint16_t width;
  uint16_t height;
  const char* safeText = text != nullptr ? text : "";

  oled.setTextSize(textSize);
  oled.getTextBounds(safeText, 0, y, &x1, &y1, &width, &height);
  const int16_t x = (SCREEN_WIDTH - static_cast<int16_t>(width)) / 2 - x1;
  oled.setCursor(x < 0 ? 0 : x, y);
  oled.print(safeText);
}

void trimText(const char* input, char* output, size_t outputSize) {
  if (outputSize == 0) {
    return;
  }

  const char* source = (input != nullptr && input[0] != '\0') ? input : Config::DEFAULT_DEVICE_NAME;
  const size_t maxTextChars = min(outputSize - 1, MAX_LINE_CHARS);
  size_t i = 0;
  while (i < maxTextChars && source[i] != '\0') {
    output[i] = source[i];
    i++;
  }

  if (source[i] != '\0' && maxTextChars > 0) {
    output[maxTextChars - 1] = '~';
    output[maxTextChars] = '\0';
  } else {
    output[i] = '\0';
  }
}

void formatDuration(unsigned long totalSeconds, char* output, size_t outputSize) {
  const unsigned long hours = totalSeconds / 3600UL;
  const unsigned long minutes = (totalSeconds % 3600UL) / 60UL;
  const unsigned long seconds = totalSeconds % 60UL;

  if (hours > 99UL) {
    snprintf(output, outputSize, "%lu:%02lu:%02lu", hours, minutes, seconds);
  } else {
    snprintf(output, outputSize, "%02lu:%02lu:%02lu", hours, minutes, seconds);
  }
}

void startScreen() {
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);
}

void finishScreen() {
  oled.display();
}

void copyDisplayText(const char* input, char* output, size_t outputSize) {
  if (outputSize == 0) {
    return;
  }

  snprintf(output, outputSize, "%s", input != nullptr ? input : "");
}

bool screenAllowsButtonOverlay() {
  return !sessionRecoveryIsActive() && sessionData.state != SessionState::OVERLOAD;
}

void resetRotation() {
  rotationContext = RotationContext::NONE;
  rotationStartedAtMs = 0;
}

bool shouldShowBranding(RotationContext context) {
  const unsigned long now = millis();
  if (rotationContext != context) {
    rotationContext = context;
    rotationStartedAtMs = now;
    return false;
  }

  const unsigned long cycleMs = ROTATION_STATUS_MS + ROTATION_BRANDING_MS;
  const unsigned long elapsedMs = (now - rotationStartedAtMs) % cycleMs;
  return elapsedMs >= ROTATION_STATUS_MS;
}

bool brandingBaseAllowed() {
  return !sessionIsActive() &&
         !relayIsOn() &&
         !sensorData.loadDetected &&
         !sessionRecoveryIsActive() &&
         sessionData.state != SessionState::OVERLOAD &&
         sessionData.state != SessionState::MONITORING &&
         sessionData.state != SessionState::WAITING_LOAD &&
         sessionData.state != SessionState::FINISHING;
}

bool idleBrandingAllowed() {
  return sessionData.state == SessionState::IDLE && brandingBaseAllowed();
}

void formatProgressBar(uint8_t percent, char* output, size_t outputSize) {
  const uint8_t safePercent = percent > 100 ? 100 : percent;
  const uint8_t filled = (safePercent * 10U + 50U) / 100U;
  size_t pos = 0;

  if (outputSize == 0) {
    return;
  }

  output[pos++] = '[';
  for (uint8_t i = 0; i < 10 && pos + 2 < outputSize; i++) {
    output[pos++] = i < filled ? '#' : '-';
  }
  if (pos + 1 < outputSize) {
    output[pos++] = ']';
  }
  output[pos] = '\0';
}

void renderButtonHold() {
  char line[32];
  char progress[16];

  startScreen();
  drawLine(0, "BUTTON HOLD");
  snprintf(line, sizeof(line), "Time: %lu.%lus", buttonHoldDurationMs / 1000UL, (buttonHoldDurationMs % 1000UL) / 100UL);
  drawLine(1, line);
  drawLine(2, buttonHoldReleaseAction);
  formatProgressBar(buttonHoldProgressPercent, progress, sizeof(progress));
  drawLine(4, progress);
  finishScreen();
}

void renderButtonFeedback() {
  startScreen();
  drawLine(1, buttonFeedbackMessage);
  finishScreen();
}

void renderBranding() {
  startScreen();
  drawCenteredText("VOLTIX", 18, 2);
  drawCenteredText("Energy Anywhere", 42, 1);
  finishScreen();
}

void renderIdle() {
  startScreen();
  if (appConfig.pairingCode[0] != '\0') {
    drawCenteredText("Pairing Code", 5, 1);
    oled.drawLine(0, 16, SCREEN_WIDTH, 16, SSD1306_WHITE);
    drawCenteredText(appConfig.pairingCode, 28, 3);
    drawCenteredText(
      networkIsPortalActive() ? "AP: Voltix-Setup" : "Enter in web app",
      55,
      1
    );
  } else {
    drawLine(0, "Voltix Ready");
    drawLine(2, Config::DEVICE_ID);
    if (!appConfig.paired) {
      drawLine(4, "Fetching code...");
    }
  }
  finishScreen();
}

void renderWaitingLoad() {
  if (offlineModeIsActive()) {
    startScreen();
    drawLine(0, offlineModeIsManualLocked() ? "Offline Manual" : "Offline Mode");
    drawLine(1, "Relay: ON");
    drawLine(2, "Load Validation");
    finishScreen();
    return;
  }

  char deviceName[24];
  trimText(sessionData.deviceName, deviceName, sizeof(deviceName));

  startScreen();
  drawLine(0, deviceName);
  drawLine(2, "Waiting Load");
  drawLine(4, "Connect device");
  finishScreen();
}

void renderOfflineNoLoad() {
  startScreen();
  drawLine(0, "No Load Detected");
  drawLine(1, "Relay OFF");
  drawLine(2, "BOOT 1s Next");
  finishScreen();
}

void renderOfflineReady() {
  startScreen();
  if (offlineModeIsManualLocked()) {
    drawLine(0, "Offline Manual Idle");
    drawLine(1, "Relay OFF");
    drawLine(2, "BOOT 1s Next");
  } else {
    drawLine(0, "Offline Auto");
    drawLine(1, "Reconnecting...");
    drawLine(2, "BOOT 1s Next");
  }
  finishScreen();
}

void renderTryingOnline() {
  startScreen();
  drawLine(0, "Trying Online");
  drawLine(1, "WiFi reconnect...");
  finishScreen();
}

void renderMonitoring() {
  char deviceName[24];
  char line[32];
  char duration[16];

  trimText(sessionData.deviceName, deviceName, sizeof(deviceName));
  formatDuration(sessionData.durationMs / 1000UL, duration, sizeof(duration)); // Durasi dalam detik

  startScreen();
  drawLine(0, sessionData.startMode == SystemMode::OFFLINE ? "OFFLINE MONITORING" : deviceName);
  snprintf(line, sizeof(line), "V:%.1f I:%.3fA", sensorData.voltage, sensorData.current);
  drawLine(1, line);
  snprintf(line, sizeof(line), "P:%.1fW", sensorData.power);
  drawLine(2, line);
  snprintf(line, sizeof(line), "E:%.6fkWh", sessionData.energyKwh);
  drawLine(3, line);
  snprintf(line, sizeof(line), "Rp:%.2f", sessionData.cost);
  drawLine(4, line);
  snprintf(line, sizeof(line), "T:%s", duration);
  drawLine(5, line);
  finishScreen();
}

void renderFinished() {
  char deviceName[24];
  char line[32];
  char duration[16];

  trimText(sessionData.deviceName, deviceName, sizeof(deviceName));
  formatDuration(sessionData.durationMs / 1000UL, duration, sizeof(duration));

  startScreen();
  drawLine(0, sessionData.endReason == EndReason::OVERLOAD ? "OVERLOAD" : "Finished");
  drawLine(1, deviceName);
  snprintf(line, sizeof(line), "E:%.6fkWh", sessionData.energyKwh);
  drawLine(2, line);
  snprintf(line, sizeof(line), "Rp:%.2f", sessionData.cost);
  drawLine(3, line);
  snprintf(line, sizeof(line), "T:%s", duration);
  drawLine(4, line);
  finishScreen();
}

void renderOverload() {
  char line[32];

  startScreen();
  drawLine(0, "OVERLOAD");
  drawLine(1, "Power too high");
  snprintf(line, sizeof(line), "P:%.1fW", sensorData.power);
  drawLine(3, line);
  snprintf(line, sizeof(line), "Limit:%.1fW", appConfig.overloadThresholdW);
  drawLine(4, line);
  finishScreen();
}

void renderSetupPortal() {
  startScreen();
  drawLine(0, "Voltix Setup");
  drawLine(1, "AP: Voltix-Setup");
  drawLine(2, "IP: 192.168.4.1");
  drawLine(3, "Open in browser");
  finishScreen();
}

void renderRecovery() {
  startScreen();
  drawLine(0, "Voltix Recovery");
  if (strcmp(sessionRecoveryStatus(), "sensor_validation_failed") == 0) {
    drawLine(1, "Sensor unavailable");
    drawLine(2, "Relay OFF");
    drawLine(3, "Checkpoint safe");
  } else if (strcmp(sessionRecoveryStatus(), "finalize_failed") == 0) {
    drawLine(1, "History save failed");
    drawLine(2, "Relay OFF");
    drawLine(3, "Checkpoint safe");
  } else {
    drawLine(1, "Checking session");
    drawLine(2, "Please wait");
  }
  finishScreen();
}

void renderScreen() {
  if (!oledReady) {
    return;
  }

  if (networkIsMenuActive()) {
    String title;
    std::vector<std::string> options;
    int selected;
    networkGetMenuDetails(title, options, selected);
    displayShowMenu(title.c_str(), options, selected);
    resetRotation();
    return;
  }

  if (sessionRecoveryIsActive()) {
    resetRotation();
    renderRecovery();
    return;
  }

  if (sessionData.state == SessionState::OVERLOAD) {
    resetRotation();
    renderOverload();
    return;
  }

  if (buttonHoldVisible && screenAllowsButtonOverlay()) {
    resetRotation();
    renderButtonHold();
    return;
  }

  if (buttonFeedbackVisible) {
    if (millis() < buttonFeedbackUntilMs && screenAllowsButtonOverlay()) {
      resetRotation();
      renderButtonFeedback();
      return;
    }
    buttonFeedbackVisible = false;
  }

  if (offlineModeShowTryingOnline()) {
    resetRotation();
    renderTryingOnline();
    return;
  }

  if (sessionData.state == SessionState::MONITORING) {
    // Tidak perlu resetRotation di sini, karena renderMonitoring akan selalu dipanggil
    renderMonitoring();
    return;
  }

  if (sessionData.state == SessionState::WAITING_LOAD) {
    resetRotation();
    renderWaitingLoad();
    return; // Pastikan ini diproses sebelum offlineModeShowFinishedSummary
  }

  if (offlineModeShowFinishedSummary()) {
    resetRotation();
    renderFinished();
    return;
  }

  if (!appConfig.paired && appConfig.pairingCode[0] != '\0') {
    resetRotation();
    renderIdle();
    return;
  }

  if (networkIsPortalActive()) {
    if (brandingBaseAllowed() && shouldShowBranding(RotationContext::SETUP)) {
      renderBranding();
    } else {
      if (!brandingBaseAllowed()) {
        resetRotation();
      }
      renderSetupPortal();
    }
    return;
  }

  if (offlineModeShowNoLoadPrompt()) {
    if (brandingBaseAllowed() && shouldShowBranding(RotationContext::OFFLINE_NO_LOAD)) {
      renderBranding();
    } else {
      if (!brandingBaseAllowed()) {
        resetRotation();
      }
      renderOfflineNoLoad();
    }
    return;
  }

  if (offlineModeIsActive() &&
      !sessionIsActive()) {
    if (brandingBaseAllowed() && shouldShowBranding(RotationContext::OFFLINE_READY)) {
      renderBranding();
    } else {
      if (!brandingBaseAllowed()) {
        resetRotation();
      }
      renderOfflineReady();
    }
    return;
  }

  switch (sessionData.state) {
    case SessionState::IDLE:
      if (idleBrandingAllowed() && shouldShowBranding(RotationContext::IDLE)) { // Branding hanya saat idle dan tidak ada sesi
        renderBranding();
      } else {
        if (!idleBrandingAllowed()) {
          resetRotation(); // Reset rotasi jika kondisi branding tidak terpenuhi
        }
        renderIdle();
      }
      break;
    case SessionState::FINISHING:
    case SessionState::FINISHED:
      resetRotation();
      renderFinished();
      break;
    default:
      resetRotation();
      renderIdle();
      break;
  }
}
}

void displayBegin() {
  Serial.println("[display] OLED init start");
  Serial.print("[display] Wire.begin SDA=");
  Serial.print(Config::OLED_SDA_PIN);
  Serial.print(" SCL=");
  Serial.println(Config::OLED_SCL_PIN);
  Wire.begin(Config::OLED_SDA_PIN, Config::OLED_SCL_PIN);
  Serial.println("[display] Wire initialized");

  Serial.print("[display] SSD1306 begin address=0x");
  Serial.println(Config::OLED_ADDRESS, HEX);
  oledReady = oled.begin(SSD1306_SWITCHCAPVCC, Config::OLED_ADDRESS);
  if (!oledReady) {
    Serial.println("[display] SSD1306 init failed");
    return;
  }

  Serial.println("[display] SSD1306 initialized");
  startScreen();
  drawLine(0, "Voltix");
  drawLine(2, "Booting...");
  finishScreen();
  lastDisplayMs = millis();
  Serial.println("[display] Boot screen rendered");
}

void displayUpdate() {
  const unsigned long now = millis();
  const unsigned long intervalMs = buttonHoldVisible ? BUTTON_DISPLAY_INTERVAL_MS : DISPLAY_INTERVAL_MS;
  if (now - lastDisplayMs < intervalMs) {
    return;
  }

  lastDisplayMs = now;
  renderScreen();
}

void displayShowBoot() {
  if (!oledReady) {
    Serial.println("[display] Boot screen skipped, OLED not ready");
    return;
  }

  startScreen();
  drawLine(0, "Voltix");
  drawLine(2, "Booting...");
  finishScreen();
}

void displayShowOwnerWelcome(const char* displayName) {
  if (!oledReady || displayName == nullptr || displayName[0] == '\0') {
    return;
  }

  char visibleName[MAX_WELCOME_NAME_CHARS + 1];
  size_t length = 0;
  while (length < MAX_WELCOME_NAME_CHARS && displayName[length] != '\0') {
    visibleName[length] = displayName[length];
    length++;
  }
  if (displayName[length] != '\0') {
    visibleName[MAX_WELCOME_NAME_CHARS - 1] = '~';
    length = MAX_WELCOME_NAME_CHARS;
  }
  visibleName[length] = '\0';

  startScreen();
  drawCenteredText("Welcome Owner", 8, 1);
  oled.drawLine(0, 22, SCREEN_WIDTH, 22, SSD1306_WHITE);
  drawCenteredText(visibleName, 34, length <= 10 ? 2 : 1);
  finishScreen();
  lastDisplayMs = millis();
  Serial.println("[display] Owner welcome rendered");
}

void displayShowStatus() {
  renderScreen();
}

void displayShowButtonHold(unsigned long heldMs, const char* releaseAction, uint8_t progressPercent) {
  if (!oledReady) {
    return;
  }

  const unsigned long now = millis();
  buttonHoldVisible = true;
  buttonFeedbackVisible = false;
  buttonHoldDurationMs = heldMs;
  buttonHoldProgressPercent = progressPercent > 100 ? 100 : progressPercent;
  copyDisplayText(releaseAction, buttonHoldReleaseAction, sizeof(buttonHoldReleaseAction));

  if (now - lastButtonHoldDisplayMs < BUTTON_DISPLAY_INTERVAL_MS) {
    return;
  }

  lastButtonHoldDisplayMs = now;
  lastDisplayMs = now;
  renderScreen();
}

void displayClearButtonHold() {
  buttonHoldVisible = false;
  lastButtonHoldDisplayMs = 0;
  if (!oledReady) {
    return;
  }

  lastDisplayMs = millis();
  renderScreen();
}

void displayShowButtonFeedback(const char* message) {
  if (!oledReady) {
    return;
  }

  buttonHoldVisible = false;
  buttonFeedbackVisible = true;
  buttonFeedbackUntilMs = millis() + BUTTON_FEEDBACK_MS;
  copyDisplayText(message, buttonFeedbackMessage, sizeof(buttonFeedbackMessage));
  lastDisplayMs = millis();
  renderScreen();
}

void displayShowMenu(const char* title, const std::vector<std::string>& options, int selectedOption) {
  if (!oledReady) {
    return;
  }
  startScreen();
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.println(title);
  oled.drawLine(0, 10, SCREEN_WIDTH, 10, SSD1306_WHITE);

  int y = 15;
  for (size_t i = 0; i < options.size(); ++i) {
    oled.setCursor(10, y);
    if (i == (size_t)selectedOption) {
      oled.print("> ");
    } else {
      oled.print("  ");
    }
    oled.println(options[i].c_str());
    y += 10;
  }
  finishScreen();
}

void displayClear() {
  if (!oledReady) {
    return;
  }
  oled.clearDisplay();
  oled.display();
}

void displayShowMessage(const char* title, const char* message, int size) {
  if (!oledReady) {
    return;
  }
  startScreen();
  if (title != nullptr && title[0] != '\0') {
    // Menggunakan ukuran 2 untuk judul agar lebih terlihat
    drawCenteredText(title, 10, 2);
  }
  if (message != nullptr && message[0] != '\0') {
    // Parameter 'size' diabaikan untuk menjaga tampilan UI yang konsisten.
    drawCenteredText(message, 35, 1);
  }
  finishScreen();
}
