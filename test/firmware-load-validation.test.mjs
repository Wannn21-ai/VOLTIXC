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
  assert.match(configSource, /LOAD_SETTLE_MS = 500UL/);
  assert.match(configSource, /LOAD_DETECT_TIMEOUT_MS = 2500UL/);
  assert.match(configSource, /LOAD_DETECT_STABLE_SAMPLES = 1/);
});

test("START load validation preserves current and power threshold checks", () => {
  assert.match(
    sessionSource,
    /sensorData\.current >= appConfig\.loadCurrentThresholdA[\s\S]*sensorData\.power >= appConfig\.loadPowerThresholdW/,
  );
});

test("START load validation accepts detected load before timeout rejection", () => {
  const detectIndex = validationSource.indexOf("isLoadAboveStartThreshold()");
  const verifyIndex = validationSource.indexOf("verifyLoadAndStartMonitoring()");
  const timeoutIndex = validationSource.indexOf("elapsedMs >= timeoutMs");
  const rejectIndex = validationSource.indexOf("cancelLoadValidationNoHistory()");

  assert.equal(detectIndex >= 0, true);
  assert.equal(detectIndex < verifyIndex, true);
  assert.equal(verifyIndex < timeoutIndex, true);
  assert.equal(timeoutIndex < rejectIndex, true);
});

test("START load validation logs actionable sensor diagnostics", () => {
  for (const field of [
    "elapsedMs=",
    "current=",
    "power=",
    "loadDetected=",
    "stableSamples=",
    "timeoutMs=",
  ]) {
    assert.match(validationSource, new RegExp(field));
  }
});
