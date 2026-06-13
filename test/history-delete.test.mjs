import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  cleanupRequestForAll,
  cleanupRequestForSession,
  deleteAllPathsForSessions,
  deleteFirebasePaths,
  deletePathsForSession,
} from "../web/js/history-delete.js";

const historyPageSource = await readFile(
  new URL("../web/js/history.js", import.meta.url),
  "utf8",
);

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

test("single delete creates a device cleanup request", () => {
  assert.deepEqual(
    cleanupRequestForSession(
      { deviceId: "device-1", sessionId: "session-1" },
      "",
      "user-1",
      { requestId: "cleanup-1", createdAt: 1234 },
    ),
    {
      path: "devices/device-1/historyCleanup/current",
      payload: {
        type: "DELETE_HISTORY_SESSION",
        requestId: "cleanup-1",
        sessionIds: ["session-1"],
        requestedBy: "user-1",
        createdAt: 1234,
      },
    },
  );
});

test("delete all creates a device cleanup request with cutoff timestamp", () => {
  assert.deepEqual(
    cleanupRequestForAll(
      [{ _source: "local", deviceId: "device-1", sessionId: "local-1" }],
      "device-1",
      "user-1",
      { requestId: "cleanup-all-1", createdAt: 5678 },
    ),
    {
      path: "devices/device-1/historyCleanup/current",
      payload: {
        type: "DELETE_ALL_HISTORY",
        requestId: "cleanup-all-1",
        beforeTs: 5678,
        requestedBy: "user-1",
        createdAt: 5678,
      },
    },
  );
});

test("history page queues device cleanup after Firebase mirror deletion", () => {
  const singleStart = historyPageSource.indexOf('if (event.target.classList.contains("btn-delete"))');
  const singleEnd = historyPageSource.indexOf("\n  const card =", singleStart);
  const singleSource = historyPageSource.slice(singleStart, singleEnd);
  const allStart = historyPageSource.indexOf('btnDeleteAll.addEventListener("click"');
  const allEnd = historyPageSource.indexOf("\nfunction exportSingleCSV", allStart);
  const allSource = historyPageSource.slice(allStart, allEnd);

  assert.equal(singleSource.indexOf("deleteFirebasePaths") < singleSource.indexOf("queueDeviceCleanup"), true);
  assert.equal(allSource.indexOf("deleteFirebasePaths") < allSource.indexOf("queueDeviceCleanup"), true);
});
