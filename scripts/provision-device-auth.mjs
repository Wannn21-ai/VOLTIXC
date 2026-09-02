import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEVICE_AUTH_HASH_ALG,
  computeDeviceSecretHash,
  parseCredentialVersion,
  requireEnv,
  requireLabDeviceId,
} from "./lib/device-auth-lab.mjs";

const REQUIRED_ENV = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_DATABASE_URL",
  "DEVICE_AUTH_PEPPER",
  "DEVICE_SECRET",
  "CREDENTIAL_VERSION",
];

export async function getAdminDatabase(env) {
  const { cert, getApps, initializeApp } = await import("firebase-admin/app");
  const { getDatabase } = await import("firebase-admin/database");
  const appName = "voltix-device-auth-provisioner";
  let app = getApps().find((candidate) => candidate.name === appName);
  if (!app) {
    app = initializeApp({
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID.trim(),
        clientEmail: env.FIREBASE_CLIENT_EMAIL.trim(),
        privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
      databaseURL: env.FIREBASE_DATABASE_URL.trim(),
    }, appName);
  }
  return getDatabase(app);
}

export async function runProvision({
  env = process.env,
  apply = false,
  getDatabase = getAdminDatabase,
  log = console.log,
} = {}) {
  requireEnv(env, REQUIRED_ENV);
  const deviceId = requireLabDeviceId(env.DEVICE_ID);
  const credentialVersion = parseCredentialVersion(env.CREDENTIAL_VERSION);
  const secretHash = computeDeviceSecretHash(
    env.DEVICE_AUTH_PEPPER,
    deviceId,
    credentialVersion,
    env.DEVICE_SECRET
  );

  let database;
  try {
    database = await getDatabase(env);
  } catch {
    throw new Error("Firebase Admin initialization failed.");
  }

  let snapshot;
  try {
    snapshot = await database.ref(`/devices/${deviceId}`).get();
  } catch {
    throw new Error("Lab device lookup failed.");
  }
  if (!snapshot.exists()) throw new Error("Lab device record does not exist.");

  const device = snapshot.val();
  const hashMatches = device?.deviceAuth?.hashAlg === DEVICE_AUTH_HASH_ALG &&
    device.deviceAuth.credentialVersion === credentialVersion &&
    device.deviceAuth.secretHash === secretHash;

  if (!apply) {
    const hashStatus = hashMatches ? "matches existing record" : "would update record";
    log(`[provision] Dry run passed for ${deviceId}; hash ${hashStatus}; no RTDB write performed.`);
    return { applied: false, hashMatches };
  }

  try {
    await database.ref(`/devices/${deviceId}/deviceAuth`).update({
      enabled: true,
      revoked: false,
      credentialVersion,
      hashAlg: DEVICE_AUTH_HASH_ALG,
      secretHash,
    });
  } catch {
    throw new Error("deviceAuth provisioning write failed.");
  }
  log(`[provision] deviceAuth provisioned for ${deviceId}; secret/hash redacted.`);
  return { applied: true, hashMatches };
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runProvision({ apply: process.argv.includes("--apply") }).catch((error) => {
    console.error(`[provision] Failed closed: ${error.message}`);
    process.exitCode = 1;
  });
}
