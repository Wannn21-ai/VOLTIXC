"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  bearerToken,
  createHandler,
  missingServerEnvVars,
} = require("../api/mqtt-web-config.js");

const COMPLETE_ENV = Object.freeze({
  FIREBASE_PROJECT_ID: "test-project",
  FIREBASE_CLIENT_EMAIL: "firebase@example.test",
  FIREBASE_PRIVATE_KEY: "not-a-real-private-key",
  FIREBASE_DATABASE_URL: "https://example.test",
  MQTT_WEB_USERNAME: "limited-web-user",
  MQTT_WEB_PASSWORD: "not-a-real-password",
});

function makeResponse() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("MQTT web config fails closed when server env is incomplete", async () => {
  assert.deepEqual(missingServerEnvVars({}), [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    "FIREBASE_DATABASE_URL",
    "MQTT_WEB_USERNAME",
    "MQTT_WEB_PASSWORD",
  ]);
  const response = makeResponse();
  await createHandler({ env: {} })({ method: "GET", headers: {} }, response);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: "mqtt_config_unavailable" });
});

test("MQTT web config requires a valid Bearer token", async () => {
  assert.equal(bearerToken("Basic invalid"), "");
  assert.equal(bearerToken("Bearer valid.token-value_1"), "valid.token-value_1");

  const response = makeResponse();
  await createHandler({ env: COMPLETE_ENV })(
    { method: "GET", headers: {} },
    response,
  );
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: "authentication_required" });
});

test("verified Firebase user receives only scoped connection configuration", async () => {
  let verifiedToken = "";
  const response = makeResponse();
  const handler = createHandler({
    env: COMPLETE_ENV,
    getAdminServices: async () => ({
      auth: {
        async verifyIdToken(token, checkRevoked) {
          verifiedToken = token;
          assert.equal(checkRevoked, true);
          return { uid: "user-1" };
        },
      },
    }),
  });

  await handler({
    method: "GET",
    headers: { authorization: "Bearer firebase.id.token" },
  }, response);

  assert.equal(verifiedToken, "firebase.id.token");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Cache-Control"], "no-store, private");
  assert.deepEqual(response.body, {
    host: "ed7655203a9e419493d52c0b8771c836.s1.eu.hivemq.cloud",
    port: 8884,
    path: "/mqtt",
    deviceId: "device01",
    username: COMPLETE_ENV.MQTT_WEB_USERNAME,
    password: COMPLETE_ENV.MQTT_WEB_PASSWORD,
  });
});

test("revoked or invalid Firebase token is rejected without MQTT config", async () => {
  const response = makeResponse();
  const handler = createHandler({
    env: COMPLETE_ENV,
    getAdminServices: async () => ({
      auth: { verifyIdToken: async () => { throw new Error("invalid"); } },
    }),
  });

  await handler({
    method: "GET",
    headers: { authorization: "Bearer invalid.token" },
  }, response);
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: "authentication_required" });
});
