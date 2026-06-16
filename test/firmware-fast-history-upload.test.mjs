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
const storageSource = await readFile(
  new URL("../firmware/src/storage.cpp", import.meta.url),
  "utf8",
);

test("STOP requests fast upload after LittleFS save and transition flush runs first", () => {
  const stopStart = sessionSource.indexOf("void sessionStop(EndReason reason)");
  const stopEnd = sessionSource.indexOf("\nvoid sessionUpdate()", stopStart);
  const stopSource = sessionSource.slice(stopStart, stopEnd);
  const saveIndex = stopSource.indexOf("storageAppendCompletedSession(snapshot)");
  const fastRequestIndex = stopSource.indexOf("storageRequestFastHistoryUpload(snapshot.sessionId)");

  assert.equal(saveIndex >= 0, true);
  assert.equal(saveIndex < fastRequestIndex, true);
  assert.match(stopSource, /storageRequestFastHistoryUpload\(snapshot\.sessionId\)/);

  const loopStart = mainSource.indexOf("void loop()");
  const loopSource = mainSource.slice(loopStart);
  assert.equal(
    loopSource.indexOf("flushSessionTransitionPriority(onlineServicesAllowed)") <
      loopSource.indexOf("storageUploadFastCompletedSession()"),
    true,
  );
});

test("fast upload runs without commandPollRan", () => {
  const schedulerStart = mainSource.indexOf("const bool requestedHistorySyncDue");
  const schedulerEnd = mainSource.indexOf("\n  storageUpdate()", schedulerStart);
  const schedulerSource = mainSource.slice(schedulerStart, schedulerEnd);
  const fastStart = schedulerSource.indexOf("if (fastHistoryUploadDue)");
  const fastEnd = schedulerSource.indexOf("\n    if (requestedHistorySyncDue)", fastStart);
  const fastSource = schedulerSource.slice(fastStart, fastEnd);

  assert.match(fastSource, /storageUploadFastCompletedSession\(\)/);
  assert.doesNotMatch(fastSource, /commandPollRan/);
});

test("fast upload runs before normal config and history background work", () => {
  const schedulerStart = mainSource.indexOf("const bool requestedHistorySyncDue");
  const schedulerEnd = mainSource.indexOf("\n  storageUpdate()", schedulerStart);
  const schedulerSource = mainSource.slice(schedulerStart, schedulerEnd);
  const fastIndex = schedulerSource.indexOf("storageUploadFastCompletedSession()");
  const normalHistoryIndex = schedulerSource.indexOf("storageSyncPendingHistoryToFirebase(AUTO_HISTORY_SYNC_MAX_UPLOADS)");
  const configIndex = schedulerSource.indexOf("firebasePushDeviceConfig()");

  assert.equal(fastIndex >= 0, true);
  assert.equal(fastIndex < normalHistoryIndex, true);
  assert.equal(fastIndex < configIndex, true);
  assert.match(schedulerSource, /fastHistoryUploadDue[\s\S]*auto-sync skipped reason=fast upload pending/);
});

test("pending fast upload defers normal command polling", () => {
  const onlineStart = mainSource.indexOf("if (onlineServicesAllowed)");
  const onlineEnd = mainSource.indexOf("\n  storageUpdate()", onlineStart);
  const onlineSource = mainSource.slice(onlineStart, onlineEnd);
  const guardIndex = onlineSource.indexOf("!storageFastHistoryUploadRequested()");
  const pollIndex = onlineSource.indexOf("pollCommandIfDue(onlineServicesAllowed, recoveryActive)");

  assert.equal(guardIndex >= 0, true);
  assert.equal(guardIndex < pollIndex, true);
  assert.match(onlineSource, /logCommandPollSkipped\("fast history upload pending"\)/);
});

test("successful fast upload marks the local session synced", () => {
  const fastStart = storageSource.indexOf("bool storageUploadFastCompletedSession()");
  const fastEnd = storageSource.indexOf("\nbool storageSyncPendingHistoryToFirebase", fastStart);
  const fastSource = storageSource.slice(fastStart, fastEnd);
  const pushIndex = fastSource.indexOf("firebasePushCompletedSession(entry)");
  const writeIndex = fastSource.indexOf("writeSessionDocument(path, entry)");
  const okIndex = fastSource.indexOf("fast upload OK sessionId=");

  assert.match(fastSource, /entry\["syncStatus"\] = "SYNCED"/);
  assert.match(fastSource, /entry\["pendingSync"\] = false/);
  assert.equal(pushIndex >= 0, true);
  assert.equal(pushIndex < writeIndex, true);
  assert.equal(writeIndex < okIndex, true);
});

test("failed fast upload keeps the local session pending for background retry", () => {
  const fastStart = storageSource.indexOf("bool storageUploadFastCompletedSession()");
  const fastEnd = storageSource.indexOf("\nbool storageSyncPendingHistoryToFirebase", fastStart);
  const fastSource = storageSource.slice(fastStart, fastEnd);

  assert.match(fastSource, /fast upload FAIL sessionId=/);
  assert.match(fastSource, /pendingHistorySyncRequested = true/);
  assert.match(fastSource, /pending sync fallback enabled sessionId=/);
});

test("cleanup request is processed before fast upload", () => {
  const schedulerStart = mainSource.indexOf("const bool requestedHistorySyncDue");
  const schedulerEnd = mainSource.indexOf("\n  storageUpdate()", schedulerStart);
  const schedulerSource = mainSource.slice(schedulerStart, schedulerEnd);

  assert.equal(
    schedulerSource.indexOf("firebasePollHistoryCleanup()") <
      schedulerSource.indexOf("storageUploadFastCompletedSession()"),
    true,
  );
  assert.match(schedulerSource, /cleanupResult != HistoryCleanupPollResult::NO_REQUEST[\s\S]*fast upload skipped reason=cleanup unavailable/);
});

test("DELETE_ALL_HISTORY beforeTs cannot delete a newer just-finished session", () => {
  assert.match(storageSource, /sessionTimestampMs > beforeTs[\s\S]*reason=after beforeTs/);
  assert.match(mainSource, /fastHistoryUploadDue[\s\S]*firebasePollHistoryCleanup\(\)[\s\S]*storageUploadFastCompletedSession\(\)/);
});
