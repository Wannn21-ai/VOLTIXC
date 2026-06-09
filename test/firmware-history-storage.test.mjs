import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const storageSource = await readFile(
  new URL("../firmware/src/storage.cpp", import.meta.url),
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

test("pending sync uploads one entry and only persists successful sync metadata", () => {
  const syncFunction = storageSource.slice(
    storageSource.indexOf("bool storageSyncPendingHistoryToFirebase()"),
  );
  assert.match(syncFunction, /firebasePushCompletedSession\(entry\)/);
  assert.match(syncFunction, /if \(pushed\) \{\s+saved = writeSessionDocument/);
  assert.match(syncFunction, /Serial\.println\(" budget=one"\)/);
  assert.match(syncFunction, /break;/);
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
