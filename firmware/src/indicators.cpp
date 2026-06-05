#include "indicators.h"
#include "config.h"

#include <Arduino.h>

static void writeSafeDefaults() {
  pinMode(Config::WIFI_LED_PIN, OUTPUT);
  pinMode(Config::GREEN_LED_PIN, OUTPUT);
  pinMode(Config::RED_LED_PIN, OUTPUT);
  pinMode(Config::BUZZER_PIN, OUTPUT);

  digitalWrite(Config::WIFI_LED_PIN, LOW);
  digitalWrite(Config::GREEN_LED_PIN, LOW);
  digitalWrite(Config::RED_LED_PIN, LOW);
  digitalWrite(Config::BUZZER_PIN, LOW);
}

void indicatorsForceSafeEarly() {
  writeSafeDefaults();
  Serial.println("[boot] Indicators forced safe early");
}

void indicatorsBegin() {
  writeSafeDefaults();
  Serial.println("[indicators] Initialized");
}

void indicatorsUpdate() {
}

void indicatorsBeep(unsigned int durationMs) {
  Serial.print("[indicators] Beep requested ms=");
  Serial.println(durationMs);
}

void indicatorsSetWifi(bool connected) {
  digitalWrite(Config::WIFI_LED_PIN, connected ? HIGH : LOW);
}

void indicatorsSetStatus(bool active, bool fault) {
  digitalWrite(Config::GREEN_LED_PIN, active ? HIGH : LOW);
  digitalWrite(Config::RED_LED_PIN, fault ? HIGH : LOW);
}
