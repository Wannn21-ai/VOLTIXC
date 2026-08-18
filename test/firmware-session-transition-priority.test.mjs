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
  const helperStart = mainSource.indexOf("static bool pollCommandIfDue");
  const helperEnd = mainSource.indexOf("\nstatic void printLiveData()", helperStart);
  const helperSource = mainSource.slice(helperStart, helperEnd);
  const pollIndex = helperSource.indexOf("firebasePollCommand()");
  const flushIndex = helperSource.indexOf("flushSessionTransitionPriority(onlineServicesAllowed)", pollIndex);
  const ackIndex = helperSource.indexOf("firebaseFlushTransitionAck()", flushIndex);
  const loopStart = mainSource.indexOf("void loop()");
  const loopSource = mainSource.slice(loopStart);
  const priorityPollIndex = loopSource.indexOf("pollCommandIfDue(onlineServicesAllowed)");
  const historyIndex = loopSource.indexOf("storageSyncPendingHistoryToFirebase(AUTO_HISTORY_SYNC_MAX_UPLOADS)");

  assert.equal(pollIndex >= 0, true);
  assert.equal(pollIndex < flushIndex, true);
  assert.equal(flushIndex < ackIndex, true);
  assert.equal(priorityPollIndex < historyIndex, true);

  const flushStart = mainSource.indexOf("static void flushSessionTransitionPriority");
  const flushEnd = mainSource.indexOf("\nstatic void printLiveData()", flushStart);
  const flushSource = mainSource.slice(flushStart, flushEnd);
  assert.equal(flushSource.indexOf("displayShowStatus()") < flushSource.indexOf("firebasePublishLive()"), true);
  assert.match(flushSource, /OLED refreshed after/);
  assert.match(flushSource, /live published after/);
});

test("online restore command polling also flushes transition before ACK", () => {
  const reconnectStart = mainSource.indexOf("if (onlineRestoredThisLoop)");
  const reconnectEnd = mainSource.indexOf("\n  wasWifiConnected = wifiConnected", reconnectStart);
  const reconnectSource = mainSource.slice(reconnectStart, reconnectEnd);
  assert.match(
    reconnectSource,
    /serviceLocalRealtimeTasks\(recoveryActive\)[\s\S]*pollCommandIfDue\(onlineServicesAllowed, recoveryActive, true\)/,
  );

  const helperStart = mainSource.indexOf("static bool pollCommandIfDue");
  const helperEnd = mainSource.indexOf("\nstatic void printLiveData()", helperStart);
  const helperSource = mainSource.slice(helperStart, helperEnd);
  assert.equal(
    helperSource.indexOf("flushSessionTransitionPriority(onlineServicesAllowed)") <
      helperSource.indexOf("firebaseFlushTransitionAck()"),
    true,
  );
});

test("transition ACKs are deferred until main priority flush", () => {
  const pendingStartStart = firebaseSource.indexOf("static bool publishPendingStartAckIfReady()");
  const pendingStartEnd = firebaseSource.indexOf("\nstatic bool readCommandTimestamp", pendingStartStart);
  const pendingStartSource = firebaseSource.slice(pendingStartStart, pendingStartEnd);
  assert.match(pendingStartSource, /transitionAckRequested = true/);
  assert.doesNotMatch(pendingStartSource, /firebaseAckCommand\(\)/);

  const stopStart = firebaseSource.indexOf("if (commandTypeIsStop(type))");
  const stopEnd = firebaseSource.indexOf("\n  setAck(id, type, \"ERROR\"", stopStart);
  const stopSource = firebaseSource.slice(stopStart, stopEnd);
  assert.match(stopSource, /sessionStop\(EndReason::USER_STOP\)/);
  assert.match(stopSource, /transitionAckRequested = true/);
  assert.doesNotMatch(stopSource, /firebaseAckCommand\(\)/);
});

test("STOP can preempt WAITING_LOAD before the next load validation sample", () => {
  const loopStart = mainSource.indexOf("void loop()");
  const serviceIndex = mainSource.indexOf("serviceLocalRealtimeTasks(recoveryActive)", loopStart);
  const preemptSource = mainSource.slice(loopStart, serviceIndex);

  assert.match(preemptSource, /sessionData\.state == SessionState::WAITING_LOAD/);
  assert.match(preemptSource, /pollCommandIfDue\(\s*onlineServicesAllowed,\s*recoveryActive,\s*false,\s*true\s*\)/);

  const pollStart = mainSource.indexOf("static bool pollCommandIfDue");
  const pollEnd = mainSource.indexOf("\nstatic void serviceLocalRealtimeTasks", pollStart);
  const pollSource = mainSource.slice(pollStart, pollEnd);
  assert.match(pollSource, /allowWaitingLoadPreemption/);
  assert.match(pollSource, /!allowWaitingLoadPreemption && localRealtimeTasksDue\(recoveryActive\)/);
});

test("STOP during WAITING_LOAD aborts validation and clears runtime session", () => {
  const stopStart = sessionSource.indexOf("void sessionStop(EndReason reason)");
  const stopEnd = sessionSource.indexOf("\nvoid sessionUpdate()", stopStart);
  const stopSource = sessionSource.slice(stopStart, stopEnd);

  assert.match(stopSource, /sessionData\.state == SessionState::WAITING_LOAD/);
  assert.match(stopSource, /cancelLoadValidationNoHistory\(reason\)/);

  const clearStart = sessionSource.indexOf("static void clearSessionRuntime");
  const clearEnd = sessionSource.indexOf("\nstatic unsigned long currentLoadValidationTimeoutMs", clearStart);
  const clearSource = sessionSource.slice(clearStart, clearEnd);
  assert.match(clearSource, /relaySet\(false\)/);
  assert.match(clearSource, /sessionData\.state = SessionState::IDLE/);
  assert.match(clearSource, /sessionData\.sessionId\[0\] = '\\0'/);
  assert.match(clearSource, /storageClearActiveSessionCheckpoint\(\)/);
});

test("primary commands/current rejects stale commands before START or STOP execution", () => {
  assert.match(firebaseSource, /static bool primaryCommandIsStale\(uint64_t updatedAt\)/);
  const pollStart = firebaseSource.indexOf("void firebasePollCommand()");
  const startBranch = firebaseSource.indexOf("if (commandTypeIsStart(type))", pollStart);
  const preActionSource = firebaseSource.slice(pollStart, startBranch);
  assert.match(preActionSource, /!hasCommandTimestamp \|\| primaryCommandIsStale\(commandUpdatedAt\)/);
  assert.match(preActionSource, /Stale command ignored/);
  assert.match(preActionSource, /commands\/current\.json", "null"/);
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
