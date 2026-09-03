import { FIREBASE_CONFIGURED } from "./firebase-config.js";

export const DEFAULT_USER_SETTINGS = Object.freeze({
  currency: "IDR",
  tariff: 1444.70,
  overloadThreshold: 2000,
  overloadWarningPercent: 99,
  loadPowerThreshold: 1,
  loadCurrentThreshold: 0.02,
  loadRemovedDelaySec: 2,
  offlineTimeoutSec: 300,
  checkpointIntervalSec: 30,
  theme: "dark",
  language: "en",
  notifications: {
    deviceConnected: true,
    deviceDisconnected: true,
    sessionSaved: true,
    overload: true,
    refreshIntervalMs: 3000
  }
});

export const SHARED_DEVICE_ID = "device01";

export async function ensureInitialUserState(user) {
  if (!FIREBASE_CONFIGURED || !user?.uid) return { initialized: false, localVisualMode: true };
  return { initialized: false, localVisualMode: false };
}

export async function getCurrentDevice(uid) {
  if (!FIREBASE_CONFIGURED || !uid) return null;
  return { id: SHARED_DEVICE_ID, nickname: "VOLTIX Device" };
}

export function readableFirebaseError(error, fallback = "Cloud request failed.") {
  const code = error?.code || "";
  if (code === "PERMISSION_DENIED" || code === "database/permission-denied") {
    return "Access denied. Check your account permissions.";
  }
  if (code === "auth/network-request-failed") return "Network error. Check your connection.";
  return fallback;
}
