import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  clampRefreshInterval,
  createMetersUpdateScheduler,
} from "../web/js/dashboard-live-update.js";

const dashboardSource = await readFile(
  new URL("../web/js/dashboard.js", import.meta.url),
  "utf8",
);

test("dashboard refresh interval is clamped to a responsive range", () => {
  assert.equal(clampRefreshInterval(undefined), 3000);
  assert.equal(clampRefreshInterval("invalid"), 3000);
  assert.equal(clampRefreshInterval(250), 1000);
  assert.equal(clampRefreshInterval(2500), 2500);
  assert.equal(clampRefreshInterval(30000), 5000);
});

test("meter scheduler debounces bursts into one update", async () => {
  let updateCount = 0;
  let nextTimerId = 0;
  const timers = new Map();
  const delays = [];
  const scheduler = createMetersUpdateScheduler(
    async () => { updateCount++; },
    {
      setTimeoutFn: (callback, delay) => {
        delays.push(delay);
        const id = ++nextTimerId;
        timers.set(id, async () => {
          timers.delete(id);
          return callback();
        });
        return id;
      },
      clearTimeoutFn: id => timers.delete(id),
    },
  );

  scheduler.schedule();
  scheduler.schedule();
  scheduler.schedule();

  assert.equal(timers.size, 1);
  assert.equal(delays.every(delay => delay === 150), true);
  await [...timers.values()][0]();
  assert.equal(updateCount, 1);
});

test("meter scheduler queues one rerun while update is active", async () => {
  let releaseFirst;
  let updateCount = 0;
  let nextTimerId = 0;
  const timers = new Map();
  const scheduler = createMetersUpdateScheduler(
    async () => {
      updateCount++;
      if (updateCount === 1) {
        await new Promise(resolve => { releaseFirst = resolve; });
      }
    },
    {
      setTimeoutFn: callback => {
        const id = ++nextTimerId;
        timers.set(id, async () => {
          timers.delete(id);
          return callback();
        });
        return id;
      },
      clearTimeoutFn: id => timers.delete(id),
    },
  );

  scheduler.schedule();
  const firstRun = [...timers.values()][0]();
  scheduler.schedule();
  scheduler.schedule();
  releaseFirst();
  await firstRun;

  assert.equal(timers.size, 1);
  await [...timers.values()][0]();
  assert.equal(updateCount, 2);
});

test("all dashboard live listeners schedule an immediate meter update", () => {
  for (const path of ["system", "device", "session"]) {
    const listenerStart = dashboardSource.indexOf(`onValue(ref(db, \`\${liveBase}/${path}\`)`);
    const nextListener = dashboardSource.indexOf("onValue(ref(db,", listenerStart + 1);
    const listenerSource = dashboardSource.slice(
      listenerStart,
      nextListener >= 0 ? nextListener : dashboardSource.indexOf("// ================================================================", listenerStart),
    );
    assert.equal(listenerStart >= 0, true);
    assert.match(listenerSource, /scheduleMetersUpdate\(\)/);
  }
});

test("fallback interval is clamped and uses the guarded scheduler", () => {
  assert.match(dashboardSource, /clampRefreshInterval\(settings\.refreshInterval\)/);
  assert.match(dashboardSource, /setInterval\(scheduleMetersUpdate, refreshIntervalMs\)/);
  assert.doesNotMatch(dashboardSource, /setInterval\(updateMeters/);
});

test("idle display keeps voltage live and zeros session measurements", () => {
  const displayStart = dashboardSource.indexOf("function updateDisplay()");
  const displayEnd = dashboardSource.indexOf("\nfunction formatDurationSeconds", displayStart);
  const displaySource = dashboardSource.slice(displayStart, displayEnd);

  assert.match(displaySource, /sessionInactive = !firebaseRelay && !firebaseSessionActive/);
  assert.match(displaySource, /valVoltage\.textContent = voltage\.toFixed\(1\)/);
  assert.match(displaySource, /shownCurrent = sessionInactive \? 0 : current/);
  assert.match(displaySource, /shownPower = sessionInactive \? 0 : firebasePower/);
  assert.match(displaySource, /shownEnergy = sessionInactive[\s\S]*\? 0/);
  assert.match(displaySource, /shownCost = sessionInactive[\s\S]*\? 0/);
});

test("STOP handling resets the display in the same meter update", () => {
  const stopBranchStart = dashboardSource.indexOf(
    "if (systemOnline && isRunning && activeDevice && !firebaseRelay && !firebaseSessionActive)",
  );
  const stopBranchEnd = dashboardSource.indexOf("// â", stopBranchStart);
  const stopBranchSource = dashboardSource.slice(stopBranchStart, stopBranchEnd);

  assert.match(stopBranchSource, /await resetMonitoring\(\);\s+updateDisplay\(\);/);
});
