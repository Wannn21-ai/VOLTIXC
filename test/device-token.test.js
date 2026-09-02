"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const broker = require("../api/device-token");

const SERVER_ENV = {
  FIREBASE_PROJECT_ID: "example-project",
  FIREBASE_CLIENT_EMAIL: "broker@example.invalid",
  FIREBASE_PRIVATE_KEY: "not-a-real-private-key",
  FIREBASE_DATABASE_URL: "https://example.invalid",
  DEVICE_AUTH_PEPPER: "example-server-pepper-not-real",
};

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

function enabledDevice(overrides = {}) {
  const body = validBody();
  return {
    deviceAuth: {
      enabled: true,
      revoked: false,
      credentialVersion: body.credentialVersion,
      hashAlg: "sha256-pepper-v1",
      secretHash: broker.computeDeviceSecretHash(
        body.deviceId,
        body.credentialVersion,
        body.deviceSecret,
        SERVER_ENV.DEVICE_AUTH_PEPPER
      ),
      ...overrides,
    },
  };
}

function createAdminMock(deviceValue = enabledDevice()) {
  const calls = { reads: [], tokens: [], updates: [] };

  const database = {
    ref(path) {
      return {
        async get() {
          calls.reads.push(path);
          return {
            exists: () => deviceValue !== null,
            val: () => deviceValue,
          };
        },
        async update(value) {
          calls.updates.push({ path, value });
        },
      };
    },
  };

  const auth = {
    async createCustomToken(uid, claims) {
      calls.tokens.push({ uid, claims });
      return "mock-custom-token";
    },
  };

  return { services: { auth, database }, calls };
}

async function invoke(handler, body = validBody(), method = "POST") {
  const response = createResponse();
  await handler({ method, body }, response);
  return response;
}

function createBroker(adminMock, env = SERVER_ENV) {
  return broker.createHandler({
    env,
    getAdminServices: async () => adminMock.services,
    now: () => 1780000000000,
  });
}

test("rejects methods other than POST", async () => {
  const response = await invoke(broker, undefined, "GET");

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
    { ...validBody(), unexpectedField: "caller-controlled" },
  ];

  for (const body of invalidBodies) {
    const response = await invoke(broker, body);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { error: "invalid_request" });
  }
});

test("fails closed before Admin initialization when server env is missing", async () => {
  let initialized = false;
  const handler = broker.createHandler({
    env: {},
    getAdminServices: async () => {
      initialized = true;
      throw new Error("must not initialize");
    },
  });

  const response = await invoke(handler);

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: "broker_unavailable" });
  assert.equal(initialized, false);
});

test("returns generic 503 when Admin initialization fails", async () => {
  const handler = broker.createHandler({
    env: SERVER_ENV,
    getAdminServices: async () => {
      throw new Error("invalid private key details must stay hidden");
    },
  });

  const response = await invoke(handler);

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: "broker_unavailable" });
});

for (const [name, deviceValue, body] of [
  ["unknown device", null, validBody()],
  ["disabled device", enabledDevice({ enabled: false }), validBody()],
  ["revoked device", enabledDevice({ revoked: true }), validBody()],
  ["version mismatch", enabledDevice({ credentialVersion: 2 }), validBody()],
  ["unsupported hash", enabledDevice({ hashAlg: "plaintext" }), validBody()],
  ["wrong secret", enabledDevice(), { ...validBody(), deviceSecret: "wrong-secret-value-not-real" }],
]) {
  test(`rejects ${name} with generic 401 and no token`, async () => {
    const adminMock = createAdminMock(deviceValue);
    const response = await invoke(createBroker(adminMock), body);

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { error: "invalid_device_credential" });
    assert.equal(adminMock.calls.tokens.length, 0);
    assert.equal(adminMock.calls.updates.length, 0);
  });
}

test("issues a custom token only after successful credential verification", async () => {
  const adminMock = createAdminMock();
  const response = await invoke(createBroker(adminMock));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    customToken: "mock-custom-token",
    expiresInSec: 3600,
  });
  assert.deepEqual(adminMock.calls.reads, ["/devices/esp32-voltix-001"]);
  assert.deepEqual(adminMock.calls.tokens, [{
    uid: "device:esp32-voltix-001",
    claims: {
      deviceId: "esp32-voltix-001",
      deviceRole: "hardware",
      credentialVersion: 1,
    },
  }]);
  assert.deepEqual(adminMock.calls.updates, [{
    path: "/devices/esp32-voltix-001/deviceAuth",
    value: {
      lastTokenIssuedAt: 1780000000000,
      lastSeenAt: 1780000000000,
    },
  }]);
});

test("does not echo or log device secrets and hashes", async () => {
  const adminMock = createAdminMock();
  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => logged.push(values);
  console.error = (...values) => logged.push(values);

  try {
    const response = await invoke(createBroker(adminMock));
    const serializedResponse = JSON.stringify(response.body);

    assert.equal(serializedResponse.includes(validBody().deviceSecret), false);
    assert.equal(serializedResponse.includes(enabledDevice().deviceAuth.secretHash), false);
    assert.deepEqual(logged, []);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("hash helper is deterministic and constant-time comparison fails closed", () => {
  const first = broker.computeDeviceSecretHash(
    "esp32-voltix-001",
    1,
    "example-device-secret-not-real",
    "example-server-pepper-not-real"
  );
  const second = broker.computeDeviceSecretHash(
    "esp32-voltix-001",
    1,
    "example-device-secret-not-real",
    "example-server-pepper-not-real"
  );

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(broker.constantTimeHashEqual(first, second), true);
  assert.equal(broker.constantTimeHashEqual("malformed", second), false);
});

test("normalizes escaped private-key newlines without logging values", () => {
  assert.equal(
    broker.normalizePrivateKey("line-one\\nline-two"),
    "line-one\nline-two"
  );
});
