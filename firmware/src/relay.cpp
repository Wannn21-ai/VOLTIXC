#include "relay.h"
#include "config.h"

#include <Arduino.h>

static bool relayOn = false;
static unsigned long lastRelayToggleMs = 0;
static constexpr unsigned long RELAY_MIN_TOGGLE_INTERVAL_MS = 350UL;

static int relayLevelFor(bool on) {
  if (Config::RELAY_ACTIVE_LOW) {
    return on ? LOW : HIGH;
  }
  return on ? HIGH : LOW;
}

void relayForceOffEarly() {
  pinMode(Config::RELAY_PIN, OUTPUT);
  digitalWrite(Config::RELAY_PIN, relayLevelFor(false));
  relayOn = false;
  lastRelayToggleMs = 0;
  Serial.println("[boot] Relay forced OFF early");
}

void relayBegin() {
  pinMode(Config::RELAY_PIN, OUTPUT);
  digitalWrite(Config::RELAY_PIN, relayLevelFor(false));
  relayOn = false;
  lastRelayToggleMs = 0;
  Serial.println("[relay] Initialized, default OFF");
}

void relaySet(bool on) {
  if (relayOn == on) {
    Serial.println("[relay] unchanged, skip");
    return;
  }

  const unsigned long now = millis();
  if (on && lastRelayToggleMs > 0 && now - lastRelayToggleMs < RELAY_MIN_TOGGLE_INTERVAL_MS) {
    Serial.println("[relay] suppressed rapid toggle");
    return;
  }

  relayOn = on;
  digitalWrite(Config::RELAY_PIN, relayLevelFor(on));
  lastRelayToggleMs = now;
  Serial.print("[relay] ");
  Serial.println(on ? "ON" : "OFF");
}

bool relayIsOn() {
  return relayOn;
}
