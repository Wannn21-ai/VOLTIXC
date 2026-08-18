import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configSource = await readFile(
  new URL("../firmware/include/config.h", import.meta.url),
  "utf8",
);
const sessionSource = await readFile(
  new URL("../firmware/src/session.cpp", import.meta.url),
  "utf8",
);

const validationStart = sessionSource.indexOf("static void handleLoadValidation()");
const validationEnd = sessionSource.indexOf("\nvoid sessionBegin()", validationStart);
const validationSource = sessionSource.slice(validationStart, validationEnd);

test("START load validation uses the fast timing window", () => {
  assert.match(configSource, /LOAD_SETTLE_MS = 1000UL/);
  assert.match(configSource, /LOAD_DETECT_TIMEOUT_MS = 6000UL/);
  assert.match(configSource, /LOAD_DETECT_MIN_VALID_SAMPLES = 5/);
  assert.match(configSource, /LOAD_DETECT_STABLE_SAMPLES = 3/);
});

test("START load validation accepts current or power above configurable thresholds", () => {
  assert.match(
    sessionSource,
    /sensorData\.current >= currentThreshold \|\|[\s\S]*sensorData\.power >= powerThreshold/,
  );
  assert.match(sessionSource, /positiveThresholdOrDefault\(appConfig\.loadCurrentThresholdA, Config::LOAD_CURRENT_THRESHOLD_A\)/);
  assert.match(sessionSource, /positiveThresholdOrDefault\(appConfig\.loadPowerThresholdW, Config::LOAD_POWER_THRESHOLD_W\)/);
});

test("START load validation requires multiple fresh valid samples before monitoring", () => {
  const detectIndex = validationSource.indexOf("isLoadAboveStartThreshold()");
  const duplicateGuardIndex = validationSource.indexOf("sensorData.lastReadMs == loadValidationLastSampleReadMs");
  const validSamplesIndex = validationSource.indexOf("loadValidationValidSamples >= Config::LOAD_DETECT_MIN_VALID_SAMPLES");
  const stableSamplesIndex = validationSource.indexOf("loadValidationStableSamples >= Config::LOAD_DETECT_STABLE_SAMPLES");
  const verifyIndex = validationSource.indexOf("verifyLoadAndStartMonitoring()");
  const timeoutIndex = validationSource.indexOf("elapsedMs >= timeoutMs");
  const rejectIndex = validationSource.indexOf("cancelLoadValidationNoHistory()");

  assert.equal(detectIndex >= 0, true);
  assert.equal(duplicateGuardIndex >= 0, true);
  assert.equal(detectIndex < validSamplesIndex, true);
  assert.equal(validSamplesIndex < stableSamplesIndex, true);
  assert.equal(stableSamplesIndex < verifyIndex, true);
  assert.equal(verifyIndex < timeoutIndex, true);
  assert.equal(timeoutIndex < rejectIndex, true);
});

test("START load validation uses no-load hysteresis before resetting stable samples", () => {
  assert.match(sessionSource, /isLoadBelowNoLoadThreshold/);
  assert.match(sessionSource, /\* 0\.5f/);
  assert.match(validationSource, /else if \(noLoadSample\) \{\s+loadValidationStableSamples = 0;/);
});

test("START load validation logs actionable sensor diagnostics", () => {
  for (const field of [
    "[LOAD DETECT] Relay ON",
    "[LOAD DETECT] Settling...",
    "[LOAD DETECT] Sample ",
    "V=",
    "I=",
    "P=",
    "elapsedMs=",
    "loadDetected=",
    "stableSamples=",
    "validSamples=",
    "timeoutMs=",
    "[LOAD DETECT] Load detected",
    "[LOAD DETECT] No load detected",
    "[LOAD DETECT] Timeout -> Relay OFF",
  ]) {
    assert.match(sessionSource, new RegExp(field.replaceAll("[", "\\[").replaceAll("]", "\\]")));
  }
});
