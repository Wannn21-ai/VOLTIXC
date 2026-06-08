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
const storageSource = await readFile("firmware/src/storage.cpp", "utf8");
const sessionSource = await readFile("firmware/src/session.cpp", "utf8");
const relaySource = await readFile("firmware/src/relay.cpp", "utf8");
const dashboardSource = await readFile("web/js/dashboard.js", "utf8");
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
  assert.match(authSource, /identity_token_invalid/);
  assert.match(authSource, /token_refresh_identity_mismatch/);
  assert.match(authSource, /token_refresh_claims_mismatch/);
  assert.match(firebaseSource, /deviceAuthAppendAuthQuery/);
  assert.match(firebaseSource, /retrying once/);
  assert.match(firebaseSource, /deviceAuthHandleRtdbPathUnauthorized\(statusCode\)/);
});

test("Identity Toolkit exchange preserves full custom token and verifies JWT claims", () => {
  const exchangeStart = authSource.indexOf("bool exchangeCustomToken");
  const refreshStart = authSource.indexOf("bool refreshWithStoredToken");
  const exchangeSource = authSource.slice(exchangeStart, refreshStart);

  assert.equal(exchangeStart >= 0 && refreshStart > exchangeStart, true);
  assert.doesNotMatch(exchangeSource, /StaticJsonDocument<768>/);
  assert.match(exchangeSource, /buildIdentityExchangePayload/);
  assert.match(authSource, /requestPayload\.reserve\(expectedLength \+ 1\)/);
  assert.match(authSource, /requestPayload\.length\(\) == expectedLength/);
  assert.match(authSource, /identity_request_build_failed/);
  assert.match(authSource, /identity exchange HTTP/);
  assert.doesNotMatch(exchangeSource, /\["localId"\]/);
  assert.match(authSource, /\["sub"\]/);
  assert.match(authSource, /\["user_id"\]/);
  assert.match(authSource, /\["deviceId"\]/);
  assert.match(authSource, /\["deviceRole"\]/);
  assert.match(authSource, /\["credentialVersion"\]/);
});

test("auth diagnostics never print token or secret-bearing values", () => {
  const serialCalls = authSource.match(/Serial\.(?:print|println)\(([^;]+)\);/g) ?? [];
  const serialText = serialCalls.join("\n");

  assert.doesNotMatch(
    serialText,
    /customToken|idToken|refreshToken|VOLTIX_DEVICE_SECRET|response/
  );
});

test("path-level RTDB denial preserves auth and blocks repeated config pushes", () => {
  const pathDeniedStart = authSource.indexOf(
    "void deviceAuthHandleRtdbPathUnauthorized"
  );
  const printStatusStart = authSource.indexOf("void deviceAuthPrintStatus");
  const pathDeniedSource = authSource.slice(pathDeniedStart, printStatusStart);

  assert.equal(pathDeniedStart >= 0 && printStatusStart > pathDeniedStart, true);
  assert.match(pathDeniedSource, /rtdb_path_unauthorized/);
  assert.doesNotMatch(pathDeniedSource, /clearTokens|invalidateIdToken/);
  assert.match(firebaseSource, /sanitizedLogPath/);
  assert.match(firebaseSource, /auth session preserved/);
  assert.match(firebaseSource, /queryIndex/);
  assert.match(firebaseSource, /fragmentIndex/);
  assert.match(firebaseSource, /configPushBlockedByRules = true/);
  assert.match(firebaseSource, /bool\* pathUnauthorizedOut = nullptr/);
  assert.match(firebaseSource, /\*pathUnauthorizedOut = true/);
  assert.match(firebaseSource, /else if \(pathUnauthorized\)/);
  assert.match(firebaseSource, /local config remains pending/);
  assert.match(mainSource, /!firebaseDeviceConfigPushBlocked\(\)/);
  assert.doesNotMatch(authSource, /rtdb_unauthorized_after_retry/);
});

test("fresh commands outrank optional sync work and report redacted latency", () => {
  assert.match(firebaseSource, /SINGULAR_COMMAND_FALLBACK_POLL_INTERVAL_MS = 5000UL/);
  assert.match(firebaseSource, /singularCommandFallbackDisabled = true/);
  assert.match(firebaseSource, /Primary commands\/current available; singular fallback disabled/);
  assert.match(mainSource, /now - lastFirebaseCommandMs >= 500UL/);
  assert.match(mainSource, /bool commandPollRan = false/);
  assert.match(mainSource, /else if \(commandPollRan/);
  assert.match(mainSource, /const bool commandTransitionPending = firebaseCommandTransitionPending\(\)/);
  assert.match(mainSource, /!commandTransitionPending[\s\S]*firebaseReadConfig\(\)/);
  assert.match(mainSource, /!commandTransitionPending[\s\S]*storageSyncPendingHistoryToFirebase\(\)/);
  assert.match(firebaseSource, /logCommandLatency\("START"/);
  assert.match(firebaseSource, /logCommandLatency\("STOP"/);
  assert.match(firebaseSource, /const unsigned long ageAtReceiveMs = commandAgeMs/);
  assert.match(firebaseSource, /accepted ageMs=/);
  assert.match(firebaseSource, /relayLatencyMs=/);
  assert.match(firebaseSource, /Serial\.print\(" source="\)/);
  assert.match(firebaseSource, /"commands\/current"/);
  assert.match(firebaseSource, /"singular-fallback"/);
  assert.match(firebaseSource, /relayLastToggleMs\(\)/);
  assert.match(relaySource, /unsigned long relayLastToggleMs\(\)/);
  assert.match(firebaseSource, /lastLoggedStaleFinalCommandAt/);
  assert.doesNotMatch(firebaseSource, /Ignored stale final command/);
});

test("dashboard START and STOP cannot recreate the singular command node", () => {
  assert.match(dashboardSource, /devices\/\$\{selectedDevice\.id\}\/commands\/current/);
  assert.match(dashboardSource, /const commandTimestamp = Date\.now\(\)/);
  assert.match(dashboardSource, /createdAt: commandTimestamp/);
  assert.match(dashboardSource, /updatedAt: commandTimestamp/);
  assert.doesNotMatch(dashboardSource, /devices\/\$\{selectedDevice\.id\}\/command`/);
  assert.doesNotMatch(dashboardSource, /activeSession/);
  assert.doesNotMatch(dashboardSource, /singularFallback|singular fallback used/);
});

test("history final path succeeds independently and pending sync is budgeted", () => {
  assert.match(firebaseSource, /return finalOk;/);
  assert.match(firebaseSource, /legacyHistoryMirrorDisabled = true/);
  assert.match(firebaseSource, /compatibility mirror disabled/);
  assert.match(firebaseSource, /Legacy completedSessions mirror skipped/);
  assert.match(storageSource, /budget=one/);
  assert.match(storageSource, /break;/);
  assert.match(sessionSource, /queued for background cloud sync/);
  assert.doesNotMatch(sessionSource, /queued = firebasePushCompletedSession\(snapshot\)/);
});

test("lab checklist documents private opt-in, redaction, and local safety", () => {
  assert.match(checklist, /ignored local/);
  assert.match(checklist, /VOLTIX_DEVICE_AUTH_ENABLED 1/);
  assert.match(checklist, /npm\.cmd run smoke:device-token/);
  assert.match(checklist, /LittleFS saves first/);
  assert.match(checklist, /There is no lab-insecure TLS opt-in/);
});
