#include "sensor.h"
#include "config.h"
#include "state.h"

#include <Arduino.h>
#include <PZEM004Tv30.h>
#include <math.h>

static PZEM004Tv30 pzem(Serial2, Config::PZEM_RX_PIN, Config::PZEM_TX_PIN);

static float safeRead(float value) {
  return isnan(value) ? 0.0f : value;
}

void sensorBegin() {
  Serial2.begin(9600, SERIAL_8N1, Config::PZEM_RX_PIN, Config::PZEM_TX_PIN);
  Serial.println("[sensor] PZEM004T initialized on Serial2");
}

void sensorUpdate() {
  const float voltage = pzem.voltage();
  const float current = pzem.current();
  const float power = pzem.power();
  const float energy = pzem.energy();
  const float frequency = pzem.frequency();
  const float powerFactor = pzem.pf();

  const bool coreValid = !isnan(voltage) && !isnan(current) && !isnan(power);

  sensorData.voltage = safeRead(voltage);
  sensorData.current = safeRead(current);
  sensorData.power = safeRead(power);
  sensorData.energy = safeRead(energy);
  sensorData.frequency = safeRead(frequency);
  sensorData.powerFactor = safeRead(powerFactor);
  sensorData.valid = coreValid;
  sensorData.loadDetected = coreValid &&
    (sensorData.current >= appConfig.loadCurrentThresholdA &&
     sensorData.power >= appConfig.loadPowerThresholdW);
  sensorData.lastReadMs = millis();

  if (!coreValid) {
    Serial.println("[sensor] Invalid PZEM reading");
  }
}

bool sensorAcInputPresent() {
  return sensorData.valid && sensorData.voltage >= Config::AC_PRESENT_MIN_VOLTAGE;
}
