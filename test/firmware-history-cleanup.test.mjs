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

test("DELETE_ALL_HISTORY deletes only completed sessions at or before beforeTs", () => {
  const clearStart = storageSource.indexOf("int storageClearCompletedHistoryBefore(uint64_t beforeTs)");
  const clearEnd = storageSource.indexOf("\nbool storageMarkSessionQueued", clearStart);
  const clearSource = storageSource.slice(clearStart, clearEnd);

  assert.match(storageSource, /int storageDeleteCompletedSession\(const char\* sessionId\)/);
  assert.match(storageSource, /readCompletedSessionTimestampMs\(JsonObjectConst entry, uint64_t& timestampMs\)/);
  for (const field of ["timestamp", "endTime", "end_ts", "startTime", "start_ts"]) {
    assert.match(storageSource, new RegExp(`"${field}"`));
  }
  assert.match(storageSource, /parsed < 100000000000ULL[\s\S]*parsed \*= 1000ULL/);
  assert.match(storageSource, /makeHistoryPath\(sessionId, path, sizeof\(path\)\)/);
  assert.match(clearSource, /isHistorySessionFile\(file\)/);
  assert.match(clearSource, /sessionTimestampMs > beforeTs/);
  assert.match(clearSource, /LittleFS\.remove\(path\)/);
  assert.doesNotMatch(clearSource, /ACTIVE_SESSION_PATH/);
});

test("DELETE_ALL_HISTORY keeps completed sessions newer than beforeTs", () => {
  const clearStart = storageSource.indexOf("int storageClearCompletedHistoryBefore(uint64_t beforeTs)");
  const clearEnd = storageSource.indexOf("\nbool storageMarkSessionQueued", clearStart);
  const clearSource = storageSource.slice(clearStart, clearEnd);

  assert.match(clearSource, /sessionTimestampMs > beforeTs[\s\S]*keeping local sessionId=/);
  assert.match(clearSource, /reason=after beforeTs/);
  assert.equal(clearSource.indexOf("sessionTimestampMs > beforeTs") < clearSource.indexOf("LittleFS.remove(path)"), true);
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
  assert.match(pollSource, /parseCleanupBeforeTs\(doc\["beforeTs"\], beforeTs\)/);
  assert.match(pollSource, /storageClearCompletedHistoryBefore\(beforeTs\)/);
  assert.match(pollSource, /skipped reason=invalid beforeTs/);
  assert.match(pollSource, /sessionIsActive\(\)[\s\S]*skipped reason=active session/);
  assert.doesNotMatch(pollSource, /commands\/current/);
  assert.equal(ackSource.indexOf("historyCleanupLastAckJsonPath()") < ackSource.indexOf("historyCleanupCurrentJsonPath()"), true);
  assert.match(ackSource, /httpRequest\("PUT", currentPath\.c_str\(\), "null"/);
});

test("cleanup poll runs while FINISHED or IDLE without commandPollRan", () => {
  const schedulerStart = mainSource.indexOf("const bool requestedHistorySyncDue");
  const schedulerEnd = mainSource.indexOf("\n  storageUpdate()", schedulerStart);
  const schedulerSource = mainSource.slice(schedulerStart, schedulerEnd);
  const cleanupStart = schedulerSource.indexOf("if ((cleanupPollDue || cleanupRequiredBeforeHistorySync)");
  const cleanupEnd = schedulerSource.indexOf("\n    if (requestedHistorySyncDue)", cleanupStart);
  const cleanupSource = schedulerSource.slice(cleanupStart, cleanupEnd);

  assert.match(mainSource, /HISTORY_CLEANUP_POLL_INTERVAL_MS = 5000UL/);
  assert.match(cleanupSource, /cleanupPollDue \|\| cleanupRequiredBeforeHistorySync/);
  assert.match(cleanupSource, /sessionIsActive\(\)[\s\S]*firebasePollHistoryCleanup\(\)/);
  assert.doesNotMatch(cleanupSource, /commandPollRan/);
  assert.doesNotMatch(cleanupSource, /storagePendingHistorySyncRequested/);
});

test("cleanup poll does not require pending history sync", () => {
  const schedulerStart = mainSource.indexOf("const bool requestedHistorySyncDue");
  const schedulerEnd = mainSource.indexOf("\n  storageUpdate()", schedulerStart);
  const schedulerSource = mainSource.slice(schedulerStart, schedulerEnd);
  const cleanupStart = schedulerSource.indexOf("if ((cleanupPollDue || cleanupRequiredBeforeHistorySync)");
  const cleanupEnd = schedulerSource.indexOf("\n    if (requestedHistorySyncDue)", cleanupStart);
  const cleanupSource = schedulerSource.slice(cleanupStart, cleanupEnd);

  assert.match(cleanupSource, /cleanupPollDue/);
  assert.doesNotMatch(cleanupSource, /requestedHistorySyncDue/);
  assert.doesNotMatch(cleanupSource, /storagePendingHistorySyncRequested/);
});

test("late DELETE_ALL_HISTORY processing keeps a newly completed session", () => {
  const pollStart = firebaseSource.indexOf("HistoryCleanupPollResult firebasePollHistoryCleanup()");
  const pollEnd = firebaseSource.indexOf("\nbool firebasePushCompletedSession", pollStart);
  const pollSource = firebaseSource.slice(pollStart, pollEnd);
  const clearStart = storageSource.indexOf("int storageClearCompletedHistoryBefore(uint64_t beforeTs)");
  const clearEnd = storageSource.indexOf("\nbool storageMarkSessionQueued", clearStart);
  const clearSource = storageSource.slice(clearStart, clearEnd);

  assert.match(pollSource, /delete all beforeTs=/);
  assert.match(pollSource, /storageClearCompletedHistoryBefore\(beforeTs\)/);
  assert.match(clearSource, /sessionTimestampMs > beforeTs[\s\S]*reason=after beforeTs/);
});

test("pending sync after STOP runs after cleanup and can upload a newer kept session", () => {
  const schedulerStart = mainSource.indexOf("const bool requestedHistorySyncDue");
  const schedulerEnd = mainSource.indexOf("\n  storageUpdate()", schedulerStart);
  const schedulerSource = mainSource.slice(schedulerStart, schedulerEnd);
  const requestedStart = schedulerSource.indexOf("if (requestedHistorySyncDue)");
  const requestedEnd = schedulerSource.indexOf("\n    if (requestedHistorySyncEvaluated)", requestedStart);
  const requestedSource = schedulerSource.slice(requestedStart, requestedEnd);
  const cleanupIndex = schedulerSource.indexOf("firebasePollHistoryCleanup()");
  const syncIndex = schedulerSource.indexOf("storageSyncPendingHistoryToFirebase");

  assert.doesNotMatch(requestedSource, /commandPollRan/);
  assert.match(requestedSource, /waitingLoad[\s\S]*auto-sync skipped reason=WAITING_LOAD/);
  assert.equal(cleanupIndex >= 0 && cleanupIndex < syncIndex, true);
  assert.match(storageSource, /sessionTimestampMs > beforeTs[\s\S]*reason=after beforeTs/);
  assert.match(storageSource, /pendingHistorySyncRequested = pendingCount < 0 \|\| pendingCount > 0/);
  assert.match(schedulerSource, /if \(requestedHistorySyncEvaluated\)/);
});

test("history cleanup diagnostics cover polling, request, bounded delete, and skips", () => {
  for (const text of [
    "[history-cleanup] poll started",
    "[history-cleanup] current request found type=",
    "[history-cleanup] delete all beforeTs=",
    "[history-cleanup] skipped reason=invalid beforeTs",
  ]) {
    assert.match(firebaseSource, new RegExp(text.replaceAll("[", "\\[").replaceAll("]", "\\]")));
  }
  for (const text of [
    "reason=after beforeTs",
    "[history-cleanup] deleted local sessionId=",
    "[history-cleanup] delete all local count=",
  ]) {
    assert.match(storageSource, new RegExp(text.replaceAll("[", "\\[").replaceAll("]", "\\]")));
  }
  assert.match(mainSource, /\[history-cleanup\] skipped reason=active session/);
  assert.match(mainSource, /\[history-cleanup\] skipped reason=waiting load/);
});
