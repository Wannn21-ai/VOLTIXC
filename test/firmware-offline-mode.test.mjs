import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [configSource, displaySource, networkSource, sessionSource, stateHeader, storageSource] =
  await Promise.all([
    readSource("../firmware/include/config.h"),
    readSource("../firmware/src/display.cpp"),
    readSource("../firmware/src/network.cpp"),
    readSource("../firmware/src/session.cpp"),
    readSource("../firmware/include/state.h"),
    readSource("../firmware/src/storage.cpp"),
  ]);

function functionSource(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  const end = nextSignature ? source.indexOf(nextSignature, start) : source.length;
  assert.notEqual(start, -1, `missing ${signature}`);
  assert.notEqual(end, -1, `missing boundary ${nextSignature}`);
  return source.slice(start, end);
}

test("offline confirmation enters existing WAITING_LOAD validation with relay ON", () => {
  const enterSource = functionSource(
    sessionSource,
    "bool offlineModeEnter(OfflineEntryReason reason)",
    "\nbool offlineModeExitManualLockAndTryOnline()",
  );
  const startSource = functionSource(
    sessionSource,
    "bool sessionStart(const char* deviceName)",
    "\nvoid sessionSetRemoteContext",
  );

  assert.match(networkSource, /offlineModeEnter\(OfflineEntryReason::MANUAL_MENU\)/);
  assert.match(enterSource, /offlineModeStartNextAttempt\(true\)/);
  assert.match(startSource, /sessionData\.state = SessionState::WAITING_LOAD/);
  assert.match(startSource, /relaySet\(true\)/);
  assert.doesNotMatch(startSource, /storageAppendCompletedSession/);
});

test("monitoring begins only after stable load validation and OLED labels offline monitoring", () => {
  const validationSource = functionSource(
    sessionSource,
    "static void handleLoadValidation()",
    "\nvoid sessionBegin()",
  );
  assert.match(validationSource, /LOAD_DETECT_MIN_VALID_SAMPLES/);
  assert.match(validationSource, /LOAD_DETECT_STABLE_SAMPLES/);
  assert.match(validationSource, /verifyLoadAndStartMonitoring\(\)/);
  assert.match(sessionSource, /sessionData\.state = SessionState::MONITORING/);
  const monitoringDisplaySource = functionSource(
    displaySource,
    "void renderMonitoring()",
    "\nvoid renderFinished()",
  );
  assert.match(monitoringDisplaySource, /sessionData\.startMode == SystemMode::OFFLINE/);
  assert.match(monitoringDisplaySource, /"OFFLINE MONITORING"/);
  assert.match(displaySource, /"Load Validation"/);
});

test("no-load validation cancels without history and returns relay OFF", () => {
  const cancelSource = functionSource(
    sessionSource,
    "static void cancelLoadValidationNoHistory",
    "\nstatic void handleLoadValidation()",
  );
  assert.match(cancelSource, /clearSessionRuntime\(reason\)/);
  assert.match(cancelSource, /offlineNoLoadPrompt = true/);
  assert.match(sessionSource, /clearSessionRuntime[\s\S]*relaySet\(false\)/);
  assert.doesNotMatch(cancelSource, /storageAppendCompletedSession/);
});

test("load removal uses configured stabilization and finalizes through sessionStop once", () => {
  const updateSource = functionSource(
    sessionSource,
    "void sessionUpdate()",
    "\nbool sessionIsActive()",
  );
  assert.match(updateSource, /appConfig\.loadRemovedDelaySec/);
  assert.match(updateSource, /loadRemovedSinceMs/);
  assert.match(updateSource, /isLoadBelowNoLoadThreshold\(\)/);
  assert.match(updateSource, /sessionStop\(reason\)/);
  assert.doesNotMatch(updateSource, /storageAppendCompletedSession/);

  const stopSource = functionSource(sessionSource, "void sessionStop(EndReason reason)", "\nvoid sessionUpdate()");
  assert.equal((stopSource.match(/storageAppendCompletedSession\(snapshot\)/g) || []).length, 1);
  assert.equal(stopSource.indexOf("relaySet(false)") < stopSource.indexOf("storageAppendCompletedSession(snapshot)"), true);
});

test("power loss pauses totals and checkpoints the last valid monitoring sample", () => {
  assert.match(sessionSource, /runtimePowerLossPaused/);
  assert.match(sessionSource, /powerLossPausedDurationMs/);
  assert.match(sessionSource, /captureLastValidMonitoringSample/);
  assert.match(sessionSource, /AC loss stabilized; checkpoint retained for same-session recovery/);
  for (const field of [
    "lastValidVoltage",
    "lastValidCurrent",
    "lastValidPower",
    "lastValidFrequency",
    "lastValidPowerFactor",
  ]) {
    assert.match(stateHeader, new RegExp(field));
    assert.match(storageSource, new RegExp(`checkpoint\\.${field}`));
  }
  const checkpointWriteSource = functionSource(
    storageSource,
    "bool storageWriteActiveSessionCheckpoint",
    "\nbool storageReadActiveSessionCheckpoint",
  );
  assert.match(checkpointWriteSource, /writeSessionDocument\(ACTIVE_SESSION_PATH/);
  assert.doesNotMatch(checkpointWriteSource, /LittleFS\.open\(ACTIVE_SESSION_PATH, "w"\)/);
});

test("recovery requires stable samples and resumes the same checkpoint session", () => {
  const recoverySource = functionSource(
    sessionSource,
    "void sessionRecoveryUpdate()",
    "\nbool sessionRecoveryIsActive()",
  );
  assert.match(recoverySource, /RECOVERY_SAMPLE_INTERVAL_MS/);
  assert.match(recoverySource, /LOAD_DETECT_MIN_VALID_SAMPLES/);
  assert.match(recoverySource, /LOAD_DETECT_STABLE_SAMPLES/);
  assert.match(recoverySource, /restoreSessionFromCheckpoint\(recoveryCheckpoint, SessionState::MONITORING\)/);
  assert.match(sessionSource, /strlcpy\(sessionData\.sessionId, checkpoint\.sessionId/);
  assert.match(recoverySource, /finalizeRecoveredNoLoad\(\)/);
});

test("recovered no-load history is idempotent and failed saves retain the checkpoint", () => {
  const finalizeSource = functionSource(
    sessionSource,
    "static void finalizeRecoveredNoLoad()",
    "\nstatic float positiveThresholdOrDefault",
  );
  assert.match(finalizeSource, /LOAD_REMOVED_AFTER_POWER_LOSS/);
  assert.match(finalizeSource, /if \(saved\)[\s\S]*storageClearActiveSessionCheckpoint\(\)/);
  assert.match(finalizeSource, /Local save failed; active checkpoint retained/);
  const stopSource = functionSource(sessionSource, "void sessionStop(EndReason reason)", "\nvoid sessionUpdate()");
  assert.match(stopSource, /Local save failed[\s\S]*RecoveryState::FAILED/);
  assert.match(stopSource, /Active checkpoint retained; new sessions blocked until recovery/);
  assert.match(storageSource, /if \(LittleFS\.exists\(path\)\)[\s\S]*Session already in history[\s\S]*return true/);
});

test("mode switching is available while idle and rejected while session or recovery is busy", () => {
  assert.match(networkSource, /enterRuntimeModeChoiceMenu/);
  assert.match(networkSource, /systemMode == SystemMode::ONLINE/);
  assert.match(networkSource, /Mode selection closed: active validation, monitoring, or recovery/);
  assert.match(sessionSource, /OFFLINE -> ONLINE rejected session=/);
  assert.match(sessionSource, /ONLINE -> OFFLINE rejected session=/);
  assert.match(sessionSource, /reason == OfflineEntryReason::MANUAL_MENU/);
});

test("relay polarity and recovery failure safety remain explicit", () => {
  assert.match(configSource, /RELAY_ACTIVE_LOW = true/);
  assert.match(sessionSource, /Validation timeout; relay OFF and checkpoint retained/);
  assert.match(sessionSource, /recoveryState == RecoveryState::FAILED/);
});
