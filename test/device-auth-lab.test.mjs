import test from "node:test";
import assert from "node:assert/strict";

import {
  DEVICE_AUTH_HASH_ALG,
  computeDeviceSecretHash,
  validateBrokerUrl,
  validateDatabaseUrl,
} from "../scripts/lib/device-auth-lab.mjs";
import { runProvision } from "../scripts/provision-device-auth.mjs";
import { runSmoke } from "../scripts/smoke-device-token.mjs";

const DEVICE_SECRET = "example-device-secret-not-real";
const PEPPER = "example-server-pepper-not-real";
const OWNER_UID = "example-owner-uid";

const PROVISION_ENV = {
  FIREBASE_PROJECT_ID: "example-project",
  FIREBASE_CLIENT_EMAIL: "broker@example.invalid",
  FIREBASE_PRIVATE_KEY: "not-a-real-private-key",
  FIREBASE_DATABASE_URL: "https://example.invalid",
  DEVICE_AUTH_PEPPER: PEPPER,
  DEVICE_SECRET,
  CREDENTIAL_VERSION: "1",
  OWNER_UID,
};

const SMOKE_ENV = {
  TOKEN_BROKER_URL: "https://broker.example.invalid/api/device-token",
  DEVICE_SECRET,
  CREDENTIAL_VERSION: "1",
  FIREBASE_API_KEY: "example-web-api-key-not-real",
  FIREBASE_DATABASE_URL: "https://example.invalid",
};

function createDatabaseMock(deviceAuth) {
  const writes = [];
  return {
    writes,
    database: {
      ref(path) {
        return {
          async get() {
            return {
              exists: () => true,
              val: () => ({
                ownerUid: OWNER_UID,
                members: {
                  [OWNER_UID]: { role: "owner" },
                },
                deviceAuth,
              }),
            };
          },
          async update(value) {
            writes.push({ path, value });
          },
        };
      },
    },
  };
}

function jsonResponse(status, body) {
  return {
    status,
    async json() {
      return body;
    },
  };
}

test("lab URL validation permits HTTPS and localhost HTTP only", () => {
  assert.equal(
    validateBrokerUrl("http://127.0.0.1:3000/api/device-token"),
    "http://127.0.0.1:3000/api/device-token"
  );
  assert.equal(
    validateBrokerUrl("https://broker.example.invalid/api/device-token"),
    "https://broker.example.invalid/api/device-token"
  );
  assert.throws(() => validateBrokerUrl("http://broker.example.invalid/api/device-token"));
  assert.equal(
    validateDatabaseUrl("https://example.invalid/"),
    "https://example.invalid"
  );
  assert.throws(() => validateDatabaseUrl("http://example.invalid"));
});

test("provisioning fails before Admin access when env is missing", async () => {
  let accessed = false;
  await assert.rejects(
    runProvision({
      env: {},
      getDatabase: async () => {
        accessed = true;
      },
    }),
    /Missing required environment variables/
  );
  assert.equal(accessed, false);
});

test("provisioning dry run verifies ownership without writing", async () => {
  const mock = createDatabaseMock();
  const logs = [];

  const result = await runProvision({
    env: PROVISION_ENV,
    getDatabase: async () => mock.database,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result, { applied: false, hashMatches: false });
  assert.deepEqual(mock.writes, []);
  assert.equal(logs.join(" ").includes(DEVICE_SECRET), false);
  assert.equal(logs.join(" ").includes(PEPPER), false);
});

test("provisioning apply writes only derived deviceAuth fields", async () => {
  const mock = createDatabaseMock();
  const logs = [];

  const result = await runProvision({
    env: PROVISION_ENV,
    apply: true,
    getDatabase: async () => mock.database,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result, { applied: true, hashMatches: false });
  assert.deepEqual(mock.writes, [{
    path: "/devices/esp32-voltix-001/deviceAuth",
    value: {
      enabled: true,
      revoked: false,
      credentialVersion: 1,
      hashAlg: DEVICE_AUTH_HASH_ALG,
      secretHash: computeDeviceSecretHash(
        PEPPER,
        "esp32-voltix-001",
        1,
        DEVICE_SECRET
      ),
    },
  }]);
  assert.equal(JSON.stringify(mock.writes).includes(DEVICE_SECRET), false);
  assert.equal(logs.join(" ").includes(DEVICE_SECRET), false);
});

test("provisioning dry run verifies an existing peppered hash without printing it", async () => {
  const secretHash = computeDeviceSecretHash(
    PEPPER,
    "esp32-voltix-001",
    1,
    DEVICE_SECRET
  );
  const mock = createDatabaseMock({
    credentialVersion: 1,
    hashAlg: DEVICE_AUTH_HASH_ALG,
    secretHash,
  });
  const logs = [];

  const result = await runProvision({
    env: PROVISION_ENV,
    getDatabase: async () => mock.database,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result, { applied: false, hashMatches: true });
  assert.match(logs.join(" "), /hash matches existing record/);
  assert.equal(logs.join(" ").includes(secretHash), false);
});

test("provisioning redacts Admin initialization failures", async () => {
  await assert.rejects(
    runProvision({
      env: PROVISION_ENV,
      getDatabase: async () => {
        throw new Error(`leaked ${PROVISION_ENV.FIREBASE_PRIVATE_KEY}`);
      },
    }),
    (error) => {
      assert.equal(error.message, "Firebase Admin initialization failed.");
      assert.equal(error.message.includes(PROVISION_ENV.FIREBASE_PRIVATE_KEY), false);
      return true;
    }
  );
});

test("smoke workflow fails before requests when env is missing", async () => {
  let requested = false;
  await assert.rejects(
    runSmoke({
      env: {},
      fetchImpl: async () => {
        requested = true;
      },
    }),
    /Missing required environment variables/
  );
  assert.equal(requested, false);
});

test("smoke workflow exchanges tokens, reads config, and redacts output", async () => {
  const customToken = "mock-custom-token-value-long";
  const idToken = "mock-id-token-value-long-enough";
  const requests = [];
  const logs = [];
  const responses = [
    jsonResponse(200, { customToken, expiresInSec: 3600 }),
    jsonResponse(200, {
      idToken,
      expiresIn: "3600",
      localId: "device:esp32-voltix-001",
    }),
    jsonResponse(200, { currency: "IDR" }),
  ];

  const result = await runSmoke({
    env: SMOKE_ENV,
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), options });
      return responses.shift();
    },
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result, { success: true });
  assert.equal(requests.length, 3);
  assert.equal(requests[0].options.body.includes(DEVICE_SECRET), true);
  assert.equal(requests[1].options.body.includes(customToken), true);
  assert.equal(requests[2].url.includes(idToken), true);
  const output = logs.join("\n");
  assert.equal(output.includes(DEVICE_SECRET), false);
  assert.equal(output.includes(customToken), false);
  assert.equal(output.includes(idToken), false);
  assert.match(output, /live patch skipped/);
});

test("smoke live patch requires opt-in and writes harmless marker only", async () => {
  const requests = [];
  const responses = [
    jsonResponse(200, { customToken: "mock-custom-token-value-long" }),
    jsonResponse(200, {
      idToken: "mock-id-token-value-long-enough",
      localId: "device:esp32-voltix-001",
    }),
    jsonResponse(200, {}),
    jsonResponse(200, {}),
  ];

  await runSmoke({
    env: SMOKE_ENV,
    livePatch: true,
    now: () => 1780000000000,
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), options });
      return responses.shift();
    },
    log: () => {},
  });

  assert.equal(requests.length, 4);
  assert.match(requests[3].url, /\/live\/tokenBrokerSmoke\.json\?/);
  assert.deepEqual(JSON.parse(requests[3].options.body), {
    checkedAt: 1780000000000,
    source: "token-broker-e2e",
  });
});

test("smoke network errors are redacted before reporting", async () => {
  await assert.rejects(
    runSmoke({
      env: SMOKE_ENV,
      fetchImpl: async () => {
        throw new Error(`request leaked ${DEVICE_SECRET}`);
      },
    }),
    (error) => {
      assert.equal(error.message, "Token broker network request failed.");
      assert.equal(error.message.includes(DEVICE_SECRET), false);
      return true;
    }
  );
});

test("smoke rejects an unexpected Firebase Auth device identity", async () => {
  const responses = [
    jsonResponse(200, { customToken: "mock-custom-token-value-long" }),
    jsonResponse(200, {
      idToken: "mock-id-token-value-long-enough",
      localId: "device:some-other-device",
    }),
  ];

  await assert.rejects(
    runSmoke({
      env: SMOKE_ENV,
      fetchImpl: async () => responses.shift(),
      log: () => {},
    }),
    /unexpected device identity/
  );
});
