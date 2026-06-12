import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const firebaseSource = await readFile(
  new URL("../firmware/src/firebase_sync.cpp", import.meta.url),
  "utf8",
);

const liveStart = firebaseSource.indexOf("void firebasePublishLive()");
const liveEnd = firebaseSource.indexOf("\nvoid firebaseReadConfig()", liveStart);
const liveSource = firebaseSource.slice(liveStart, liveEnd);

test("relay-off live payload zeros stale electrical activity", () => {
  assert.match(liveSource, /const bool liveElectricalActive =\s+relayIsOn\(\)/);
  assert.match(liveSource, /sessionData\.state != SessionState::IDLE/);
  assert.match(liveSource, /sessionData\.state != SessionState::FINISHED/);
  assert.match(liveSource, /device\["connected"\] = liveElectricalActive && sensorData\.valid/);
  assert.match(liveSource, /device\["current"\] = liveElectricalActive \? sensorData\.current : 0\.0f/);
  assert.match(liveSource, /device\["power"\] = liveElectricalActive \? sensorData\.power : 0\.0f/);
  assert.match(liveSource, /device\["loadDetected"\] = liveElectricalActive && sensorData\.loadDetected/);
});

test("relay-off live payload preserves voltage and frequency", () => {
  assert.match(liveSource, /device\["voltage"\] = sensorData\.voltage/);
  assert.match(liveSource, /device\["frequency"\] = sensorData\.frequency/);
  assert.match(liveSource, /session\["active"\] = isSessionActiveForLive\(\)/);
});
