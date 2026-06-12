import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(
  new URL("../firmware/src/main.cpp", import.meta.url),
  "utf8",
);
const firebaseSource = await readFile(
  new URL("../firmware/src/firebase_sync.cpp", import.meta.url),
  "utf8",
);
const storageSource = await readFile(
  new URL("../firmware/src/storage.cpp", import.meta.url),
  "utf8",
);

test("LittleFS cleanup deletes completed session files without clearing active checkpoint", () => {
  const clearStart = storageSource.indexOf("int storageClearCompletedHistory()");
  const clearEnd = storageSource.indexOf("\nbool storageMarkSessionQueued", clearStart);
  const clearSource = storageSource.slice(clearStart, clearEnd);

  assert.match(storageSource, /int storageDeleteCompletedSession\(const char\* sessionId\)/);
  assert.match(storageSource, /makeHistoryPath\(sessionId, path, sizeof\(path\)\)/);
  assert.match(clearSource, /isHistorySessionFile\(file\)/);
  assert.match(clearSource, /LittleFS\.remove\(path\)/);
  assert.doesNotMatch(clearSource, /ACTIVE_SESSION_PATH/);
});

test("firmware consumes cleanup requests, ACKs, then clears current request", () => {
  const pollStart = firebaseSource.indexOf("HistoryCleanupPollResult firebasePollHistoryCleanup()");
  const pollEnd = firebaseSource.indexOf("\nbool firebasePushCompletedSession", pollStart);
  const pollSource = firebaseSource.slice(pollStart, pollEnd);
  const ackStart = firebaseSource.indexOf("static bool acknowledgeHistoryCleanup(");
  const ackEnd = firebaseSource.indexOf("\nstatic bool pushHistoryPayload", ackStart);
  const ackSource = firebaseSource.slice(ackStart, ackEnd);

  assert.match(pollSource, /DELETE_HISTORY_SESSION/);
  assert.match(pollSource, /storageDeleteCompletedSession\(sessionId\)/);
  assert.match(pollSource, /DELETE_ALL_HISTORY/);
  assert.match(pollSource, /storageClearCompletedHistory\(\)/);
  assert.match(pollSource, /sessionIsActive\(\)[\s\S]*skipped reason=active session/);
  assert.doesNotMatch(pollSource, /commands\/current/);
  assert.equal(ackSource.indexOf("historyCleanupLastAckJsonPath()") < ackSource.indexOf("historyCleanupCurrentJsonPath()"), true);
  assert.match(ackSource, /httpRequest\("PUT", currentPath\.c_str\(\), "null"/);
});

test("requested auto-sync does not depend on command polling and cleanup runs first", () => {
  const schedulerStart = mainSource.indexOf("const bool requestedHistorySyncDue");
  const schedulerEnd = mainSource.indexOf("\n  storageUpdate()", schedulerStart);
  const schedulerSource = mainSource.slice(schedulerStart, schedulerEnd);
  const requestedStart = schedulerSource.indexOf("if (requestedHistorySyncDue)");
  const requestedEnd = schedulerSource.indexOf("\n    if (requestedHistorySyncEvaluated)", requestedStart);
  const requestedSource = schedulerSource.slice(requestedStart, requestedEnd);

  assert.doesNotMatch(requestedSource, /commandPollRan/);
  assert.match(requestedSource, /waitingLoad[\s\S]*auto-sync skipped reason=WAITING_LOAD/);
  assert.equal(requestedSource.indexOf("firebasePollHistoryCleanup()") < requestedSource.indexOf("storageSyncPendingHistoryToFirebase"), true);
  assert.match(schedulerSource, /if \(requestedHistorySyncEvaluated\)/);
});
