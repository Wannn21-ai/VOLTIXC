"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const handler = require("../api/device-token");

function createResponse() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function validBody() {
  return {
    deviceId: "esp32-voltix-001",
    deviceSecret: "example-device-secret-not-real",
    credentialVersion: 1,
  };
}

async function withServerEnv(values, callback) {
  const original = {};
  for (const name of handler.REQUIRED_SERVER_ENV_VARS) {
    original[name] = process.env[name];
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }

  try {
    await callback();
  } finally {
    for (const name of handler.REQUIRED_SERVER_ENV_VARS) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
}

test("rejects methods other than POST", async () => {
  const response = createResponse();

  await handler({ method: "GET" }, response);

  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, "POST");
  assert.deepEqual(response.body, { error: "method_not_allowed" });
});

test("rejects malformed request bodies", async () => {
  const invalidBodies = [
    null,
    "{",
    { deviceId: "bad id", deviceSecret: "long-enough-secret", credentialVersion: 1 },
    { deviceId: "esp32-voltix-001", deviceSecret: "short", credentialVersion: 1 },
    { deviceId: "esp32-voltix-001", deviceSecret: "long-enough-secret", credentialVersion: 0 },
    { ...validBody(), ownerUid: "caller-controlled" },
  ];

  for (const body of invalidBodies) {
    const response = createResponse();
    await handler({ method: "POST", body }, response);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { error: "invalid_request" });
  }
});

test("fails closed when required server environment is missing", async () => {
  await withServerEnv({}, async () => {
    const response = createResponse();
    await handler({ method: "POST", body: validBody() }, response);

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: "broker_unavailable" });
  });
});

test("credential verification placeholder never default-allows", async () => {
  const result = await handler.verifyDeviceCredential(
    "esp32-voltix-001",
    "example-device-secret-not-real",
    1
  );

  assert.deepEqual(result, { verified: false, reason: "not_implemented" });
});

test("configured skeleton returns 501 without echoing the device secret", async () => {
  const env = {
    FIREBASE_PROJECT_ID: "example-project",
    FIREBASE_CLIENT_EMAIL: "broker@example.invalid",
    FIREBASE_PRIVATE_KEY: "not-a-real-private-key",
  };

  await withServerEnv(env, async () => {
    const requestBody = validBody();
    const response = createResponse();
    await handler({ method: "POST", body: requestBody }, response);

    assert.equal(response.statusCode, 501);
    assert.deepEqual(response.body, {
      error: "credential_verification_not_implemented",
    });
    assert.equal(JSON.stringify(response.body).includes(requestBody.deviceSecret), false);
    assert.equal(response.headers["Cache-Control"], "no-store");
  });
});

test("custom claims are derived from a trusted device record", () => {
  assert.deepEqual(handler.buildCustomClaims({
    deviceId: "esp32-voltix-001",
    ownerUid: "firebase-owner-uid",
    credentialVersion: 3,
  }), {
    deviceId: "esp32-voltix-001",
    deviceRole: "hardware",
    ownerUid: "firebase-owner-uid",
    credentialVersion: 3,
  });
});
