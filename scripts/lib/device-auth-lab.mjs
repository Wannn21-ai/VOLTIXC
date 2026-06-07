import { createHash } from "node:crypto";

export const LAB_DEVICE_ID = "esp32-voltix-001";
export const DEVICE_AUTH_HASH_ALG = "sha256-pepper-v1";

export function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

export function parseCredentialVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("CREDENTIAL_VERSION must be a positive safe integer.");
  }
  return version;
}

export function requireLabDeviceId(value) {
  const deviceId = value?.trim() || LAB_DEVICE_ID;
  if (deviceId !== LAB_DEVICE_ID) {
    throw new Error(`This lab workflow is restricted to ${LAB_DEVICE_ID}.`);
  }
  return deviceId;
}

export function computeDeviceSecretHash(
  pepper,
  deviceId,
  credentialVersion,
  deviceSecret
) {
  return createHash("sha256")
    .update(`${pepper}:${deviceId}:${credentialVersion}:${deviceSecret}`, "utf8")
    .digest("hex");
}

export function tokenFingerprint(token) {
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("Expected token was missing or malformed.");
  }
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}

export function validateBrokerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TOKEN_BROKER_URL must be a valid URL.");
  }

  const localHttp = url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("TOKEN_BROKER_URL must use HTTPS unless it targets localhost.");
  }
  return url.toString();
}

export function validateDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FIREBASE_DATABASE_URL must be a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("FIREBASE_DATABASE_URL must use HTTPS.");
  }
  return url.toString().replace(/\/+$/, "");
}

export async function readJsonResponse(response, expectedStatus, label) {
  if (response.status !== expectedStatus) {
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
}

export async function fetchSafely(fetchImpl, url, options, label) {
  try {
    return await fetchImpl(url, options);
  } catch {
    throw new Error(`${label} network request failed.`);
  }
}
