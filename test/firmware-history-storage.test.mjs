import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const storageSource = await readFile(
  new URL("../firmware/src/storage.cpp", import.meta.url),
  "utf8",
);
const storageHeader = await readFile(
  new URL("../firmware/include/storage.h", import.meta.url),
  "utf8",
);
const sessionSource = await readFile(
  new URL("../firmware/src/session.cpp", import.meta.url),
  "utf8",
);
const mainSource = await readFile(
  new URL("../firmware/src/main.cpp", import.meta.url),
  "utf8",
);

test("completed history uses per-session LittleFS files", () => {
  assert.match(storageSource, /HISTORY_DIR = "\/history"/);
  assert.match(storageSource, /makeHistoryPath\(snapshot\.sessionId/);
  assert.match(storageSource, /writeSessionDocument\(path, entry\)/);
});

test("runtime history operations scan one session file at a time", () => {
  assert.match(storageSource, /root\.openNextFile\(\)/);
  assert.match(storageSource, /DynamicJsonDocument doc\(SESSION_DOC_CAPACITY\)/);
  assert.doesNotMatch(storageSource, /loadHistory\(/);
  assert.doesNotMatch(storageSource, /writeHistory\(/);
});

test("pending sync uses a bounded upload budget and only persists successful sync metadata", () => {
  const syncFunction = storageSource.slice(
    storageSource.indexOf("bool storageSyncPendingHistoryToFirebase(unsigned int maxUploads)"),
  );
  assert.match(storageHeader, /storageSyncPendingHistoryToFirebase\(unsigned int maxUploads = 1\)/);
  assert.match(syncFunction, /firebasePushCompletedSession\(entry\)/);
  assert.match(syncFunction, /if \(pushed\) \{\s+const bool saved = writeSessionDocument/);
  assert.match(syncFunction, /attemptedCount < maxUploads/);
  assert.match(syncFunction, /pendingHistorySyncRequested = remaining > 0/);
});

test("successful sessionStop requests automatic pending history sync", () => {
  const stopStart = sessionSource.indexOf("void sessionStop(EndReason reason)");
  const stopEnd = sessionSource.indexOf("\nvoid sessionUpdate()", stopStart);
  const stopSource = sessionSource.slice(stopStart, stopEnd);

  assert.match(
    stopSource,
    /const bool saved = storageAppendCompletedSession\(snapshot\)[\s\S]*if \(saved\) \{[\s\S]*storageRequestPendingHistorySync\(\)[\s\S]*pending auto-sync requested after sessionStop/,
  );
});

test("requested history auto-sync remains ahead of config after live priority", () => {
  assert.match(mainSource, /REQUESTED_HISTORY_SYNC_RETRY_MS = 2000UL/);
  assert.match(mainSource, /AUTO_HISTORY_SYNC_MAX_UPLOADS = 3/);
  const schedulerStart = mainSource.indexOf("const bool commandTransitionPending");
  const schedulerEnd = mainSource.indexOf("\n  indicatorsSetWifi", schedulerStart);
  const schedulerSource = mainSource.slice(schedulerStart, schedulerEnd);
  const autoSyncIndex = schedulerSource.indexOf('Serial.println("[history] auto-sync started")');
  const configIndex = schedulerSource.indexOf("firebasePushDeviceConfig()");
  const liveIndex = schedulerSource.indexOf("firebasePublishLive()");

  assert.equal(autoSyncIndex >= 0, true);
  assert.equal(autoSyncIndex < configIndex, true);
  assert.equal(liveIndex < autoSyncIndex, true);
  assert.match(schedulerSource, /!commandTransitionPending[\s\S]*storageSyncPendingHistoryToFirebase\(AUTO_HISTORY_SYNC_MAX_UPLOADS\)/);
});

test("manual Serial sync remains available with the default bounded cycle", () => {
  assert.match(mainSource, /strcmp\(command, "sync"\) == 0[\s\S]*storageSyncPendingHistoryToFirebase\(\)/);
});

test("legacy history is preserved when migration cannot parse it", () => {
  assert.match(storageSource, /Legacy \/history\.json preserved; migration parse failed/);
  assert.match(storageSource, /HISTORY_MIGRATION_MARKER_PATH/);
  assert.doesNotMatch(
    storageSource.slice(
      storageSource.indexOf("static void migrateLegacyHistoryIfPossible()"),
      storageSource.indexOf("static bool parseOfflineDeviceNumber"),
    ),
    /LittleFS\.remove\(LEGACY_HISTORY_PATH\)/,
  );
});
