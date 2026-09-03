import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(
  new URL("../firmware/src/main.cpp", import.meta.url),
  "utf8",
);
const mqttCloudSource = await readFile(
  new URL("../firmware/src/mqtt_cloud_sync.cpp", import.meta.url),
  "utf8",
);

test("command polling uses completion-based state-aware cooldowns", () => {
  assert.match(mainSource, /IDLE_COMMAND_POLL_COOLDOWN_MS = 750UL/);
  assert.match(mainSource, /MONITORING_COMMAND_POLL_COOLDOWN_MS = 500UL/);
  assert.match(mainSource, /WAITING_LOAD_COMMAND_POLL_COOLDOWN_MS = 1000UL/);

  const intervalStart = mainSource.indexOf("static unsigned long commandPollIntervalMs()");
  const intervalEnd = mainSource.indexOf("\nstatic unsigned long sensorUpdateIntervalMs", intervalStart);
  const intervalSource = mainSource.slice(intervalStart, intervalEnd);
  for (const state of ["WAITING_LOAD", "MONITORING", "OVERLOAD", "FINISHING"]) {
    assert.match(intervalSource, new RegExp(`SessionState::${state}`));
  }
  assert.match(intervalSource, /return WAITING_LOAD_COMMAND_POLL_COOLDOWN_MS/);
  assert.match(intervalSource, /return MONITORING_COMMAND_POLL_COOLDOWN_MS/);
  assert.match(intervalSource, /return IDLE_COMMAND_POLL_COOLDOWN_MS/);

  const pollStart = mainSource.indexOf("static bool pollCommandIfDue");
  const pollEnd = mainSource.indexOf("\nstatic void serviceLocalRealtimeTasks", pollStart);
  const pollSource = mainSource.slice(pollStart, pollEnd);
  assert.equal(
    pollSource.indexOf("mqttCloudSyncUpdate()") <
      pollSource.indexOf("lastCloudCommandCompletedMs = millis()"),
    true,
  );
  assert.doesNotMatch(pollSource, /lastCloudCommandCompletedMs = now/);
});

test("online loop services local realtime tasks before command and cloud work", () => {
  const loopStart = mainSource.indexOf("void loop()");
  const loopSource = mainSource.slice(loopStart);
  const localServiceIndex = loopSource.indexOf("serviceLocalRealtimeTasks(recoveryActive)");
  const transitionFlushIndex = loopSource.indexOf(
    "flushSessionTransitionPriority(onlineServicesAllowed)",
    localServiceIndex,
  );
  const displayIndex = loopSource.indexOf("displayUpdate()", transitionFlushIndex);
  const commandPollIndex = loopSource.indexOf(
    "pollCommandIfDue(onlineServicesAllowed, recoveryActive)",
    transitionFlushIndex,
  );

  assert.equal(localServiceIndex >= 0, true);
  assert.equal(localServiceIndex < transitionFlushIndex, true);
  assert.equal(transitionFlushIndex < displayIndex, true);
  assert.equal(displayIndex < commandPollIndex, true);
  assert.equal(
    commandPollIndex <
      loopSource.indexOf("storageSyncPendingHistoryToCloud(AUTO_HISTORY_SYNC_MAX_UPLOADS)"),
    true,
  );
  assert.equal(commandPollIndex < loopSource.indexOf("mqttCloudPublishLocalConfig()"), true);
});

test("local tasks gate command polls and background work without post-work repoll", () => {
  const pollStart = mainSource.indexOf("static bool pollCommandIfDue");
  const pollEnd = mainSource.indexOf("\nstatic void serviceLocalRealtimeTasks", pollStart);
  const pollSource = mainSource.slice(pollStart, pollEnd);
  assert.match(pollSource, /localRealtimeTasksDue\(recoveryActive\)/);
  assert.match(pollSource, /logCommandPollSkipped\("local tasks due"\)/);
  assert.match(pollSource, /logCommandPollSkipped\("cooldown active"\)/);

  const loopStart = mainSource.indexOf("void loop()");
  const loopSource = mainSource.slice(loopStart);
  assert.match(loopSource, /const bool localTasksDueAfterCommand = localRealtimeTasksDue\(recoveryActive\)/);
  assert.match(loopSource, /const bool waitingLoad = sessionData\.state == SessionState::WAITING_LOAD/);
  assert.match(loopSource, /commandPollRan &&\s+!waitingLoad[\s\S]*mqttStateSyncUpdate\(\)/);
  assert.match(loopSource, /commandPollRan &&\s+!localTasksDueAfterCommand/);
  assert.doesNotMatch(loopSource, /firebase/);
});

test("WAITING_LOAD validates immediately after each fast sensor update", () => {
  assert.match(mainSource, /WAITING_LOAD_TASK_INTERVAL_MS = 250UL/);
  const serviceStart = mainSource.indexOf("static void serviceLocalRealtimeTasks");
  const serviceEnd = mainSource.indexOf("\nstatic void printLiveData()", serviceStart);
  const serviceSource = mainSource.slice(serviceStart, serviceEnd);
  assert.match(
    serviceSource,
    /sensorUpdated && sessionData\.state == SessionState::WAITING_LOAD/,
  );
  assert.match(serviceSource, /if \(validateAfterSensor \|\|[\s\S]*sessionUpdate\(\)/);
});

test("command queue and local task timing diagnostics are present", () => {
  assert.match(mqttCloudSource, /START received millis=/);
  assert.match(mqttCloudSource, /STOP received millis=/);
  assert.match(mqttCloudSource, /Expired command ignored/);
  assert.match(mainSource, /sensor update millis=/);
  assert.match(mainSource, /session update millis=/);
  assert.match(mainSource, /skipped command poll reason=/);
});
