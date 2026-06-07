import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchSafely,
  parseCredentialVersion,
  readJsonResponse,
  requireEnv,
  requireLabDeviceId,
  tokenFingerprint,
  validateBrokerUrl,
  validateDatabaseUrl,
  verifyDeviceIdToken,
} from "./lib/device-auth-lab.mjs";

const REQUIRED_ENV = [
  "TOKEN_BROKER_URL",
  "DEVICE_SECRET",
  "CREDENTIAL_VERSION",
  "FIREBASE_API_KEY",
  "FIREBASE_DATABASE_URL",
];

export async function runSmoke({
  env = process.env,
  livePatch = false,
  fetchImpl = fetch,
  now = Date.now,
  log = console.log,
} = {}) {
  requireEnv(env, REQUIRED_ENV);
  const deviceId = requireLabDeviceId(env.DEVICE_ID);
  const credentialVersion = parseCredentialVersion(env.CREDENTIAL_VERSION);
  const brokerUrl = validateBrokerUrl(env.TOKEN_BROKER_URL);
  const databaseUrl = validateDatabaseUrl(env.FIREBASE_DATABASE_URL);

  const brokerResponse = await fetchSafely(fetchImpl, brokerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId,
      deviceSecret: env.DEVICE_SECRET,
      credentialVersion,
    }),
  }, "Token broker");
  const brokerBody = await readJsonResponse(brokerResponse, 200, "Token broker");
  const customTokenFingerprint = tokenFingerprint(brokerBody.customToken);
  log(`[smoke] Token broker: 200; custom token fp=${customTokenFingerprint}`);

  const identityUrl = new URL(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken"
  );
  identityUrl.searchParams.set("key", env.FIREBASE_API_KEY);
  const identityResponse = await fetchSafely(fetchImpl, identityUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: brokerBody.customToken,
      returnSecureToken: true,
    }),
  }, "Identity Toolkit");
  const identityBody = await readJsonResponse(
    identityResponse,
    200,
    "Identity Toolkit"
  );
  verifyDeviceIdToken(identityBody.idToken, deviceId, credentialVersion);
  const idTokenFingerprint = tokenFingerprint(identityBody.idToken);
  log(`[smoke] Identity Toolkit: 200; ID token fp=${idTokenFingerprint}`);

  const configUrl = new URL(`${databaseUrl}/devices/${deviceId}/config.json`);
  configUrl.searchParams.set("auth", identityBody.idToken);
  const configResponse = await fetchSafely(
    fetchImpl,
    configUrl,
    { method: "GET" },
    "RTDB config read"
  );
  if (configResponse.status !== 200) {
    throw new Error(`RTDB config read failed with HTTP ${configResponse.status}.`);
  }
  log("[smoke] RTDB config read: 200");

  if (livePatch) {
    const liveUrl = new URL(
      `${databaseUrl}/devices/${deviceId}/live/tokenBrokerSmoke.json`
    );
    liveUrl.searchParams.set("auth", identityBody.idToken);
    const liveResponse = await fetchSafely(fetchImpl, liveUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkedAt: now(),
        source: "token-broker-e2e",
      }),
    }, "RTDB live patch");
    if (liveResponse.status !== 200) {
      throw new Error(`RTDB live patch failed with HTTP ${liveResponse.status}.`);
    }
    log("[smoke] RTDB live patch: 200");
  } else {
    log("[smoke] RTDB live patch skipped; pass --live-patch to opt in.");
  }

  return { success: true };
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runSmoke({ livePatch: process.argv.includes("--live-patch") }).catch((error) => {
    console.error(`[smoke] Failed closed: ${error.message}`);
    process.exitCode = 1;
  });
}
