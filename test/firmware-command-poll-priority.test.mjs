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

test("command polling uses 500ms online and 250ms active intervals", () => {
  assert.match(mainSource, /COMMAND_POLL_INTERVAL_MS = 500UL/);
  assert.match(mainSource, /ACTIVE_COMMAND_POLL_INTERVAL_MS = 250UL/);

  const intervalStart = mainSource.indexOf("static unsigned long commandPollIntervalMs()");
  const intervalEnd = mainSource.indexOf("\nstatic bool pollCommandIfDue", intervalStart);
  const intervalSource = mainSource.slice(intervalStart, intervalEnd);
  for (const state of [
    "WAITING_LOAD",
    "MONITORING",
    "OVERLOAD",
    "FINISHING",
    "FINISHED",
  ]) {
    assert.match(intervalSource, new RegExp(`SessionState::${state}`));
  }
  assert.match(intervalSource, /return ACTIVE_COMMAND_POLL_INTERVAL_MS/);
  assert.match(intervalSource, /return COMMAND_POLL_INTERVAL_MS/);
});

test("online loop polls commands before local and optional Firebase work", () => {
  const loopStart = mainSource.indexOf("void loop()");
  const loopSource = mainSource.slice(loopStart);
  const priorityPollIndex = loopSource.indexOf(
    "bool commandPollRan = pollCommandIfDue(onlineServicesAllowed)",
  );

  assert.equal(priorityPollIndex >= 0, true);
  assert.equal(priorityPollIndex < loopSource.indexOf("storageUpdate()"), true);
  assert.equal(
    priorityPollIndex <
      loopSource.indexOf("storageSyncPendingHistoryToFirebase(AUTO_HISTORY_SYNC_MAX_UPLOADS)"),
    true,
  );
  assert.equal(priorityPollIndex < loopSource.indexOf("firebasePushDeviceConfig()"), true);
  assert.equal(priorityPollIndex < loopSource.indexOf("firebaseReadConfig()"), true);
  assert.equal(priorityPollIndex < loopSource.indexOf("firebasePublishLive()", priorityPollIndex), true);

  const recoveryPublishIndex = loopSource.indexOf(
    "firebasePublishLive()",
    loopSource.indexOf("if (recoveryCompletedOnline)"),
  );
  assert.equal(priorityPollIndex < recoveryPublishIndex, true);
});

test("blocking Firebase background work is followed by another due command poll", () => {
  const markerIndex = mainSource.indexOf("if (backgroundFirebaseWorkRan)");
  const postWorkSource = mainSource.slice(markerIndex, markerIndex + 180);
  assert.equal(markerIndex >= 0, true);
  assert.match(postWorkSource, /pollCommandIfDue\(onlineServicesAllowed\)/);

  for (const operation of [
    "storageSyncPendingHistoryToFirebase(AUTO_HISTORY_SYNC_MAX_UPLOADS)",
    "firebasePushDeviceConfig()",
    "firebaseReadConfig()",
    "firebasePublishLive()",
  ]) {
    const operationIndex = mainSource.indexOf(operation, mainSource.indexOf("if (onlineServicesAllowed)"));
    const workRanIndex = mainSource.indexOf("backgroundFirebaseWorkRan = true", operationIndex);
    assert.equal(operationIndex >= 0, true);
    assert.equal(workRanIndex > operationIndex, true);
  }
});

test("command poll and command HTTP timing diagnostics are present", () => {
  assert.match(firebaseSource, /command poll started millis=/);
  assert.match(firebaseSource, /command poll completed millis=/);
  assert.match(firebaseSource, /command HTTP duration millis=/);
  assert.match(firebaseSource, /accepted ageMs=/);
});
