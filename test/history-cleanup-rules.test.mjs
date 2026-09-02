import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

for (const rulesFile of ["../firebase/database.rules.json"]) {
  test(`${rulesFile} protects device history cleanup requests`, async () => {
    const rules = JSON.parse(await readFile(new URL(rulesFile, import.meta.url), "utf8"));
    const cleanup = rules.rules.devices.$deviceId.historyCleanup;

    assert.match(cleanup.current[".read"], /deviceId/);
    assert.match(cleanup.current[".write"], /deviceRole/);
    assert.match(cleanup.current[".write"], /!newData\.exists\(\)/);
    assert.match(cleanup.current[".validate"], /DELETE_HISTORY_SESSION/);
    assert.match(cleanup.current[".validate"], /sessionIds/);
    assert.match(cleanup.current[".validate"], /DELETE_ALL_HISTORY/);
    assert.match(cleanup.current[".validate"], /beforeTs/);
    assert.match(cleanup.lastAck[".write"], /deviceId/);
  });
}
