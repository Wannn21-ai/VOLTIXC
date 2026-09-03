"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { verifyWebUser } = require("../backend/auth.js");
const { parsePayload, parseTopic, storeMessage } = require("../backend/worker.js");
const { createHandler: createCommandHandler } = require("../api/device-command.js");
const { createHandler: createHistoryHandler } = require("../api/history.js");
const {
  createHandler: createSettingsHandler,
  sanitizeSettings,
} = require("../api/settings.js");

function makeResponse() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("device command requires authentication and publishes a short-lived MQTT command", async () => {
  const unauthorized = makeResponse();
  await createCommandHandler({ verifyUser: async () => null })(
    { method: "POST", body: { type: "START" }, headers: {} },
    unauthorized,
  );
  assert.equal(unauthorized.statusCode, 401);

  let published;
  const response = makeResponse();
  const now = 1_800_000_000_000;
  await createCommandHandler({
    verifyUser: async () => ({ uid: "account-a" }),
    now: () => now,
    makeId: () => "fixed-id",
    publish: async (...args) => { published = args; },
  })(
    { method: "POST", body: { type: "START", sessionId: "S001" }, headers: {} },
    response,
  );

  assert.equal(response.statusCode, 202);
  assert.equal(published[0], "voltix/device01/command");
  assert.deepEqual(published[2], { qos: 1, retain: false });
  assert.equal(published[1].uid, "account-a");
  assert.equal(published[1].id, "cmd_fixed-id");
  assert.equal(published[1].expiresAt - published[1].issuedAt, 15_000);
});

test("Firebase Auth token expiry is classified as unauthenticated", async () => {
  const user = await verifyWebUser(
    { headers: { authorization: "Bearer expired.token" } },
    { auth: { verifyIdToken: async () => {
      const error = new Error("expired");
      error.code = "auth/id-token-expired";
      throw error;
    } } },
  );
  assert.equal(user, null);
});

test("worker validates topic/payload and acknowledges history only after storage", async () => {
  assert.deepEqual(parseTopic("voltix/device01/history"), {
    deviceId: "device01",
    channel: "history",
  });
  assert.equal(parseTopic("voltix/device01/command"), null);
  assert.equal(parsePayload(Buffer.from("not-json")), null);

  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ kind: "query", sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  const client = {
    publish(topic, payload, options) {
      calls.push({ kind: "publish", topic, payload, options });
    },
  };
  const stored = await storeMessage(
    pool,
    client,
    "voltix/device01/history",
    Buffer.from(JSON.stringify({ deviceId: "device01", sessionId: "S001", uid: "account-a" })),
  );
  assert.equal(stored, true);
  assert.equal(calls[0].kind, "query");
  assert.equal(calls[1].kind, "publish");
  assert.equal(calls[1].topic, "voltix/device01/history/ack");
  assert.deepEqual(calls[1].options, { qos: 1, retain: false });
  assert.match(calls[1].payload, /"sessionId":"S001"/);
});

test("settings allowlist is persisted and device config is retained", async () => {
  assert.deepEqual(sanitizeSettings({ tariff: 1500, admin: true }), { tariff: 1500 });
  let published;
  const pool = {
    async query() { return { rows: [{ settings: { tariff: 1500, theme: "dark" } }] }; },
  };
  const response = makeResponse();
  await createSettingsHandler({
    verifyUser: async () => ({ uid: "account-a" }),
    pool,
    now: () => 1234,
    publish: async (...args) => { published = args; },
  })({ method: "PUT", body: { tariff: 1500, admin: true }, headers: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(published[0], "voltix/device01/config");
  assert.deepEqual(published[2], { qos: 1, retain: true });
  assert.equal(published[1].admin, undefined);
});

test("history GET atomically assigns unowned offline sessions to current account", async () => {
  const queries = [];
  const connection = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT session_id/.test(sql)) {
        return { rows: [{ session_id: "offline-1", payload: {}, received_at: "2026-09-03" }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() { queries.push({ sql: "RELEASE" }); },
  };
  const response = makeResponse();
  await createHistoryHandler({
    verifyUser: async () => ({ uid: "account-a" }),
    pool: { connect: async () => connection },
  })({ method: "GET", headers: {} }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.sessions[0].sessionId, "offline-1");
  assert.match(queries[0].sql, /BEGIN/);
  assert.match(queries[1].sql, /user_uid IS NULL/);
  assert.deepEqual(queries[1].params, ["account-a", "device01"]);
  assert.match(queries[3].sql, /COMMIT/);
});

test("history POST cannot overwrite a session owned by another account", async () => {
  const response = makeResponse();
  await createHistoryHandler({
    verifyUser: async () => ({ uid: "account-b" }),
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
  })(
    { method: "POST", body: { sessionId: "owned-session" }, headers: {} },
    response,
  );
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, { error: "session_owned_by_another_user" });
});
