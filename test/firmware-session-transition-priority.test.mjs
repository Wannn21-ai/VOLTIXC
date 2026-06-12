import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(
  new URL("../firmware/src/main.cpp", import.meta.url),
  "utf8",
);
const sessionSource = await readFile(
  new URL("../firmware/src/session.cpp", import.meta.url),
  "utf8",
);
const firebaseSource = await readFile(
  new URL("../firmware/src/firebase_sync.cpp", import.meta.url),
  "utf8",
);

test("START verification requests immediate OLED and live refresh", () => {
  const verifyStart = sessionSource.indexOf("static void verifyLoadAndStartMonitoring()");
  const verifyEnd = sessionSource.indexOf("\nstatic void cancelLoadValidationNoHistory()", verifyStart);
  const verifySource = sessionSource.slice(verifyStart, verifyEnd);

  assert.match(verifySource, /sessionData\.state = SessionState::MONITORING/);
  assert.match(verifySource, /requestTransitionRefresh\(SessionTransitionRefresh::START_VERIFIED\)/);
  assert.match(verifySource, /load verified millis=/);
});

test("STOP requests FINISHED refresh after relay OFF and local save flow", () => {
  const stopStart = sessionSource.indexOf("void sessionStop(EndReason reason)");
  const stopEnd = sessionSource.indexOf("\nvoid sessionUpdate()", stopStart);
  const stopSource = sessionSource.slice(stopStart, stopEnd);
  const relayOffIndex = stopSource.indexOf("relaySet(false)");
  const localSaveIndex = stopSource.indexOf("storageAppendCompletedSession(snapshot)");
  const finishedIndex = stopSource.indexOf("sessionData.state = SessionState::FINISHED");
  const refreshIndex = stopSource.indexOf("requestTransitionRefresh(SessionTransitionRefresh::STOP_FINISHED)");

  assert.equal(relayOffIndex >= 0, true);
  assert.equal(relayOffIndex < localSaveIndex, true);
  assert.equal(localSaveIndex < finishedIndex, true);
  assert.equal(finishedIndex < refreshIndex, true);
  assert.match(stopSource, /relay OFF millis=/);
  assert.match(stopSource, /state FINISHED millis=/);
});

test("main flushes transition OLED then live before ACK and history sync", () => {
  const loopStart = mainSource.indexOf("void loop()");
  const loopSource = mainSource.slice(loopStart);
  const pollIndex = loopSource.indexOf("firebasePollCommand()");
  const flushIndex = loopSource.indexOf("flushSessionTransitionPriority(onlineServicesAllowed)", pollIndex);
  const ackIndex = loopSource.indexOf("firebaseFlushTransitionAck()", flushIndex);
  const historyIndex = loopSource.indexOf("storageSyncPendingHistoryToFirebase(AUTO_HISTORY_SYNC_MAX_UPLOADS)", ackIndex);

  assert.equal(pollIndex >= 0, true);
  assert.equal(pollIndex < flushIndex, true);
  assert.equal(flushIndex < ackIndex, true);
  assert.equal(ackIndex < historyIndex, true);

  const flushStart = mainSource.indexOf("static void flushSessionTransitionPriority");
  const flushEnd = mainSource.indexOf("\nstatic void printLiveData()", flushStart);
  const flushSource = mainSource.slice(flushStart, flushEnd);
  assert.equal(flushSource.indexOf("displayShowStatus()") < flushSource.indexOf("firebasePublishLive()"), true);
  assert.match(flushSource, /OLED refreshed after/);
  assert.match(flushSource, /live published after/);
});

test("online restore command polling also flushes transition before ACK", () => {
  const reconnectStart = mainSource.indexOf("if (onlineServicesAllowed && !wasOnlineServicesAllowed)");
  const reconnectEnd = mainSource.indexOf("\n  if (!wifiConnected && wasWifiConnected)", reconnectStart);
  const reconnectSource = mainSource.slice(reconnectStart, reconnectEnd);
  const pollIndex = reconnectSource.indexOf("firebasePollCommand()");
  const flushIndex = reconnectSource.indexOf("flushSessionTransitionPriority(onlineServicesAllowed)");
  const ackIndex = reconnectSource.indexOf("firebaseFlushTransitionAck()");

  assert.equal(pollIndex >= 0, true);
  assert.equal(pollIndex < flushIndex, true);
  assert.equal(flushIndex < ackIndex, true);
});

test("transition ACKs are deferred until main priority flush", () => {
  const pendingStartStart = firebaseSource.indexOf("static bool publishPendingStartAckIfReady()");
  const pendingStartEnd = firebaseSource.indexOf("\nstatic bool readCommandTimestamp", pendingStartStart);
  const pendingStartSource = firebaseSource.slice(pendingStartStart, pendingStartEnd);
  assert.match(pendingStartSource, /transitionAckRequested = true/);
  assert.doesNotMatch(pendingStartSource, /firebaseAckCommand\(\)/);

  const stopStart = firebaseSource.indexOf('if (strcmp(type, "STOP") == 0)');
  const stopEnd = firebaseSource.indexOf("\n  setAck(id, type, \"ERROR\"", stopStart);
  const stopSource = firebaseSource.slice(stopStart, stopEnd);
  assert.match(stopSource, /sessionStop\(EndReason::USER_STOP\)/);
  assert.match(stopSource, /transitionAckRequested = true/);
  assert.doesNotMatch(stopSource, /firebaseAckCommand\(\)/);
});

test("transition and history timing diagnostics are present", () => {
  for (const text of [
    "START command received millis=",
    "STOP command received millis=",
  ]) {
    assert.match(firebaseSource, new RegExp(text));
  }
  for (const text of [
    "history sync started millis=",
    "history sync completed millis=",
  ]) {
    assert.match(mainSource, new RegExp(text));
  }
});
