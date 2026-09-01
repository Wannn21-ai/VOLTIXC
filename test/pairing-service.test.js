"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const deviceToken = require("../api/device-token");
const pairingCodeApi = require("../api/device-pairing-code");
const claimDeviceApi = require("../api/claim-device");
const releaseDeviceApi = require("../api/release-device");

const NOW = 1780000000000;
const SERVER_ENV = {
  FIREBASE_PROJECT_ID: "example-project",
  FIREBASE_CLIENT_EMAIL: "broker@example.invalid",
  FIREBASE_PRIVATE_KEY: "not-a-real-private-key",
  FIREBASE_DATABASE_URL: "https://example.invalid",
  DEVICE_AUTH_PEPPER: "example-server-pepper-not-real",
};
const DEVICE_BODY = {
  deviceId: "esp32-voltix-001",
  deviceSecret: "example-device-secret-not-real",
  credentialVersion: 1,
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createDatabase(initialRoot) {
  let root = clone(initialRoot);
  let transactionQueue = Promise.resolve();

  return {
    ref(path) {
      assert.equal(path, "/");
      return {
        transaction(updateFunction) {
          const operation = transactionQueue.then(() => {
            const next = updateFunction(clone(root));
            if (next === undefined) {
              return { committed: false, snapshot: { val: () => clone(root) } };
            }
            root = clone(next);
            return { committed: true, snapshot: { val: () => clone(root) } };
          });
          transactionQueue = operation.catch(() => {});
          return operation;
        },
      };
    },
    value() {
      return clone(root);
    },
  };
}

function provisionedDevice(overrides = {}) {
  return {
    name: "Workshop Meter",
    paired: false,
    deviceAuth: {
      enabled: true,
      revoked: false,
      credentialVersion: DEVICE_BODY.credentialVersion,
      hashAlg: "sha256-pepper-v1",
      secretHash: deviceToken.computeDeviceSecretHash(
        DEVICE_BODY.deviceId,
        DEVICE_BODY.credentialVersion,
        DEVICE_BODY.deviceSecret,
        SERVER_ENV.DEVICE_AUTH_PEPPER
      ),
    },
    ...overrides,
  };
}

function createResponse() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(statusCode) { this.statusCode = statusCode; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(handler, body, headers = {}) {
  const response = createResponse();
  await handler({ method: "POST", body, headers }, response);
  return response;
}

function adminServices(database, users = {}) {
  return {
    database,
    auth: {
      async verifyIdToken(token) {
        if (!users[token]) throw new Error("invalid token");
        return { uid: users[token].uid };
      },
      async getUser(uid) {
        const user = Object.values(users).find((candidate) => candidate.uid === uid);
        if (!user) throw new Error("missing user");
        return { uid, displayName: user.displayName };
      },
    },
  };
}

function pairingHandler(database, randomStart = 123456) {
  let nextCode = randomStart;
  return pairingCodeApi.createHandler({
    env: SERVER_ENV,
    getAdminServices: async () => adminServices(database),
    now: () => NOW,
    randomInt: () => nextCode++,
  });
}

test("valid device gets a six digit short-lived pairing code", async () => {
  const database = createDatabase({ devices: { [DEVICE_BODY.deviceId]: provisionedDevice() } });
  const response = await invoke(pairingHandler(database), DEVICE_BODY);

  assert.equal(response.statusCode, 200);
  assert.match(response.body.code, /^\d{6}$/);
  assert.equal(response.body.expiresAt, NOW + 10 * 60 * 1000);
  assert.deepEqual(database.value().pairingCodes[response.body.code], {
    deviceId: DEVICE_BODY.deviceId,
    createdAt: NOW,
    expiresAt: NOW + 10 * 60 * 1000,
    used: false,
  });
});

test("invalid device credential is rejected without creating a code", async () => {
  const database = createDatabase({ devices: { [DEVICE_BODY.deviceId]: provisionedDevice() } });
  const response = await invoke(pairingHandler(database), {
    ...DEVICE_BODY,
    deviceSecret: "wrong-device-secret-not-real",
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: "invalid_device_credential" });
  assert.equal(database.value().pairingCodes, undefined);
});

test("active code is reused", async () => {
  const database = createDatabase({
    devices: { [DEVICE_BODY.deviceId]: provisionedDevice() },
    pairingCodes: {
      "123456": { deviceId: "other-device", createdAt: NOW, expiresAt: NOW + 1000, used: false },
      "654321": { deviceId: DEVICE_BODY.deviceId, createdAt: NOW, expiresAt: NOW + 5000, used: false },
    },
  });
  const response = await invoke(pairingHandler(database), DEVICE_BODY);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { code: "654321", expiresAt: NOW + 5000 });
  assert.equal(Object.keys(database.value().pairingCodes).length, 2);
});

test("active collision is skipped when reserving a new code", async () => {
  const database = createDatabase({
    devices: { [DEVICE_BODY.deviceId]: provisionedDevice() },
    pairingCodes: {
      "123456": { deviceId: "other-device", createdAt: NOW, expiresAt: NOW + 1000, used: false },
    },
  });
  const response = await invoke(pairingHandler(database), DEVICE_BODY);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.code, "123457");
});

test("owned device cannot request a new pairing code", async () => {
  const database = createDatabase({
    devices: { [DEVICE_BODY.deviceId]: provisionedDevice({ ownerUid: "owner-one", paired: true }) },
  });
  const response = await invoke(pairingHandler(database), DEVICE_BODY);

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, { error: "device_already_owned" });
  assert.equal(database.value().pairingCodes, undefined);
});

test("expired pairing code is rejected", async () => {
  const database = createDatabase({
    devices: { [DEVICE_BODY.deviceId]: provisionedDevice() },
    pairingCodes: {
      "123456": { deviceId: DEVICE_BODY.deviceId, createdAt: NOW - 1000, expiresAt: NOW, used: false },
    },
  });
  const services = adminServices(database, {
    "token-owner": { uid: "owner-one", displayName: "Alya" },
  });
  const handler = claimDeviceApi.createHandler({
    env: SERVER_ENV,
    getAdminServices: async () => services,
    now: () => NOW,
  });
  const response = await invoke(handler, { code: "123456" }, { authorization: "Bearer token-owner" });

  assert.equal(response.statusCode, 410);
  assert.deepEqual(response.body, { error: "expired_code" });
});

test("used pairing code is rejected", async () => {
  const database = createDatabase({
    devices: { [DEVICE_BODY.deviceId]: provisionedDevice() },
    pairingCodes: {
      "123456": { deviceId: DEVICE_BODY.deviceId, createdAt: NOW, expiresAt: NOW + 1000, used: true, usedBy: "other" },
    },
  });
  const services = adminServices(database, {
    "token-owner": { uid: "owner-one", displayName: "Alya" },
  });
  const handler = claimDeviceApi.createHandler({ env: SERVER_ENV, getAdminServices: async () => services, now: () => NOW });
  const response = await invoke(handler, { code: "123456" }, { authorization: "Bearer token-owner" });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, { error: "code_already_used" });
});

test("missing code and expired user authentication return clear errors", async () => {
  const database = createDatabase({
    devices: { [DEVICE_BODY.deviceId]: provisionedDevice() },
    pairingCodes: {},
  });
  const services = adminServices(database, {
    "token-owner": { uid: "owner-one", displayName: "Alya" },
  });
  const handler = claimDeviceApi.createHandler({ env: SERVER_ENV, getAdminServices: async () => services, now: () => NOW });

  const missing = await invoke(handler, { code: "123456" }, { authorization: "Bearer token-owner" });
  const expiredAuth = await invoke(handler, { code: "123456" }, { authorization: "Bearer expired-token" });
  assert.deepEqual([missing.statusCode, missing.body], [404, { error: "invalid_code" }]);
  assert.deepEqual([expiredAuth.statusCode, expiredAuth.body], [401, { error: "authentication_expired" }]);
});

test("successful claim atomically creates the complete owner binding", async () => {
  const database = createDatabase({
    devices: { [DEVICE_BODY.deviceId]: provisionedDevice() },
    pairingCodes: {
      "123456": { deviceId: DEVICE_BODY.deviceId, createdAt: NOW, expiresAt: NOW + 1000, used: false },
    },
  });
  const services = adminServices(database, {
    "token-owner": { uid: "owner-one", displayName: "Alya Owner" },
  });
  const handler = claimDeviceApi.createHandler({ env: SERVER_ENV, getAdminServices: async () => services, now: () => NOW });
  const response = await invoke(handler, { code: "123456" }, { authorization: "Bearer token-owner" });
  const root = database.value();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { id: DEVICE_BODY.deviceId, nickname: "Workshop Meter", role: "owner" });
  assert.equal(root.devices[DEVICE_BODY.deviceId].ownerUid, "owner-one");
  assert.equal(root.devices[DEVICE_BODY.deviceId].paired, true);
  assert.deepEqual(root.devices[DEVICE_BODY.deviceId].ownerProfile, {
    uid: "owner-one",
    displayName: "Alya Owner",
    pairingCode: "123456",
  });
  assert.deepEqual(root.devices[DEVICE_BODY.deviceId].members["owner-one"], { role: "owner", addedAt: NOW });
  assert.deepEqual(root.users["owner-one"].devices[DEVICE_BODY.deviceId], {
    role: "owner", nickname: "Workshop Meter", addedAt: NOW,
  });
  assert.equal(root.pairingCodes["123456"].used, true);
  assert.equal(root.pairingCodes["123456"].usedBy, "owner-one");
});

test("concurrent claims allow exactly one owner", async () => {
  const database = createDatabase({
    devices: { [DEVICE_BODY.deviceId]: provisionedDevice() },
    pairingCodes: {
      "123456": { deviceId: DEVICE_BODY.deviceId, createdAt: NOW, expiresAt: NOW + 1000, used: false },
    },
  });
  const services = adminServices(database, {
    "token-one": { uid: "owner-one", displayName: "Alya" },
    "token-two": { uid: "owner-two", displayName: "Bima" },
  });
  const handler = claimDeviceApi.createHandler({ env: SERVER_ENV, getAdminServices: async () => services, now: () => NOW });
  const responses = await Promise.all([
    invoke(handler, { code: "123456" }, { authorization: "Bearer token-one" }),
    invoke(handler, { code: "123456" }, { authorization: "Bearer token-two" }),
  ]);

  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
  const root = database.value();
  const ownerUid = root.devices[DEVICE_BODY.deviceId].ownerUid;
  assert.equal(["owner-one", "owner-two"].includes(ownerUid), true);
  assert.equal(Object.keys(root.devices[DEVICE_BODY.deviceId].members).length, 1);
});

test("release removes backend ownership and user indexes atomically", async () => {
  const database = createDatabase({
    devices: {
      [DEVICE_BODY.deviceId]: provisionedDevice({
        ownerUid: "owner-one",
        paired: true,
        ownerProfile: { uid: "owner-one", displayName: "Alya", pairingCode: "123456" },
        members: {
          "owner-one": { role: "owner", addedAt: NOW },
          "viewer-one": { role: "viewer", addedAt: NOW },
        },
      }),
    },
    users: {
      "owner-one": { devices: { [DEVICE_BODY.deviceId]: { role: "owner" } } },
      "viewer-one": { devices: { [DEVICE_BODY.deviceId]: { role: "viewer" } } },
    },
    pairingCodes: {
      "123456": { deviceId: DEVICE_BODY.deviceId, createdAt: NOW, expiresAt: NOW + 1000, used: true },
    },
  });
  const handler = releaseDeviceApi.createHandler({
    env: SERVER_ENV,
    getAdminServices: async () => adminServices(database),
  });
  const response = await invoke(handler, DEVICE_BODY);
  const root = database.value();

  assert.equal(response.statusCode, 200);
  assert.equal(root.devices[DEVICE_BODY.deviceId].ownerUid, undefined);
  assert.equal(root.devices[DEVICE_BODY.deviceId].paired, false);
  assert.equal(root.devices[DEVICE_BODY.deviceId].ownerProfile, undefined);
  assert.equal(root.devices[DEVICE_BODY.deviceId].members, undefined);
  assert.equal(root.users["owner-one"].devices[DEVICE_BODY.deviceId], undefined);
  assert.equal(root.users["viewer-one"].devices[DEVICE_BODY.deviceId], undefined);
  assert.equal(root.pairingCodes["123456"], undefined);
});

test("production rules deny every client direct access to pairing codes", async () => {
  const { readFile } = require("node:fs/promises");
  const rules = JSON.parse(await readFile("firebase/database.rules.json", "utf8"));
  assert.equal(rules.rules.pairingCodes.$code[".read"], false);
  assert.equal(rules.rules.pairingCodes.$code[".write"], false);
});
