import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteAllPathsForSessions,
  deleteFirebasePaths,
  deletePathsForSession,
} from "../web/js/history-delete.js";

test("single delete creates both device history child paths", () => {
  assert.deepEqual(
    deletePathsForSession({
      _source: "device-history",
      deviceId: "device-1",
      sessionId: "session-1",
    }),
    [
      "devices/device-1/history/session-1",
      "devices/device-1/completedSessions/session-1",
    ],
  );
});

test("single delete key falls back through id and _key", () => {
  assert.deepEqual(
    deletePathsForSession({ _source: "completed-sessions", id: "id-1" }, "device-1"),
    [
      "devices/device-1/history/id-1",
      "devices/device-1/completedSessions/id-1",
    ],
  );
  assert.deepEqual(
    deletePathsForSession({ _source: "user-history", _key: "key-1" }, "device-1"),
    [
      "devices/device-1/history/key-1",
      "devices/device-1/completedSessions/key-1",
    ],
  );
});

test("delete all creates only child session paths and never parent paths", () => {
  const paths = deleteAllPathsForSessions([
    { _source: "device-history", deviceId: "device-1", sessionId: "session-1" },
    { _source: "completed-sessions", deviceId: "device-1", sessionId: "session-2" },
  ]);

  assert.deepEqual(paths, [
    "devices/device-1/history/session-1",
    "devices/device-1/completedSessions/session-1",
    "devices/device-1/history/session-2",
    "devices/device-1/completedSessions/session-2",
  ]);
  assert.equal(paths.includes("devices/device-1/history"), false);
  assert.equal(paths.includes("devices/device-1/completedSessions"), false);
});

test("local-only sessions are skipped", () => {
  assert.deepEqual(
    deleteAllPathsForSessions([
      { _source: "local", deviceId: "device-1", sessionId: "local-1" },
    ]),
    [],
  );
});

test("missing user history path does not affect device delete paths", () => {
  const paths = deleteAllPathsForSessions([
    { _source: "user-history", deviceId: "device-1", sessionId: "session-1" },
  ]);

  assert.equal(paths.some(path => path.startsWith("users/")), false);
  assert.deepEqual(paths, [
    "devices/device-1/history/session-1",
    "devices/device-1/completedSessions/session-1",
  ]);
});

test("missing mirror path does not prevent a successful delete", async () => {
  const attempted = [];
  const result = await deleteFirebasePaths(
    [
      "devices/device-1/history/session-1",
      "devices/device-1/completedSessions/session-1",
    ],
    async path => {
      attempted.push(path);
      // Firebase set(path, null) also resolves when the child does not exist.
    },
  );

  assert.equal(result.successCount, 2);
  assert.equal(result.permissionDenied, false);
  assert.deepEqual(attempted, [
    "devices/device-1/history/session-1",
    "devices/device-1/completedSessions/session-1",
  ]);
});
