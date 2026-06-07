import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = await readFile("firmware/include/device_auth_config.h", "utf8");
const credentialsExample = await readFile(
  "firmware/include/credentials.h.example",
  "utf8"
);
const authSource = await readFile("firmware/src/device_auth.cpp", "utf8");
const firebaseSource = await readFile("firmware/src/firebase_sync.cpp", "utf8");
const mainSource = await readFile("firmware/src/main.cpp", "utf8");
const checklist = await readFile(
  "docs/firmware-device-auth-lab-checklist.md",
  "utf8"
);

test("committed device auth remains disabled and fail-closed", () => {
  assert.match(config, /#define VOLTIX_DEVICE_AUTH_ENABLED 0/);
  assert.match(credentialsExample, /#define VOLTIX_DEVICE_AUTH_ENABLED 0/);
  assert.match(authSource, /configuration_missing/);
  assert.match(authSource, /broker_https_required/);
});

test("auth endpoints use reviewed CA configuration without insecure TLS", () => {
  assert.match(config, /VOLTIX_TOKEN_BROKER_ROOT_CA/);
  assert.match(config, /VOLTIX_IDENTITY_TOOLKIT_ROOT_CA/);
  assert.match(config, /VOLTIX_SECURE_TOKEN_ROOT_CA/);
  assert.match(config, /VOLTIX_FIREBASE_RTDB_ROOT_CA/);
  assert.match(authSource, /client\.setCACert\(rootCa\)/);
  assert.doesNotMatch(authSource, /setInsecure/);
});

test("boot auth, RAM refresh, authenticated RTDB, and bounded retry are wired", () => {
  assert.match(mainSource, /timeSyncBegin\(\);\s+firebaseAuthenticateDevice\(\);/);
  assert.match(authSource, /securetoken\.googleapis\.com\/v1\/token/);
  assert.match(authSource, /application\/x-www-form-urlencoded/);
  assert.match(authSource, /time_not_ready/);
  assert.match(authSource, /identity_mismatch/);
  assert.match(authSource, /token_refresh_identity_mismatch/);
  assert.match(firebaseSource, /deviceAuthAppendAuthQuery/);
  assert.match(firebaseSource, /bounded refresh and retry once/);
  assert.match(firebaseSource, /deviceAuthHandleRtdbUnauthorized\(statusCode, true\)/);
});

test("lab checklist documents private opt-in, redaction, and local safety", () => {
  assert.match(checklist, /ignored local/);
  assert.match(checklist, /VOLTIX_DEVICE_AUTH_ENABLED 1/);
  assert.match(checklist, /npm\.cmd run smoke:device-token/);
  assert.match(checklist, /LittleFS saves first/);
  assert.match(checklist, /There is no lab-insecure TLS opt-in/);
});
