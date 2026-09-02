import {
  db, ref, get, update, FIREBASE_CONFIGURED
} from "./firebase-config.js";

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

export const SHARED_DEVICE_ID = "esp32-voltix-001";

function addMissingValues(target, defaults, prefix, updates) {
  for (const [key, value] of Object.entries(defaults)) {
    const currentPath = prefix ? `${prefix}/${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      addMissingValues(target?.[key] || {}, value, currentPath, updates);
    } else if (target?.[key] === undefined || target?.[key] === null) {
      updates[currentPath] = value;
    }
  }
}

export async function ensureInitialUserState(user) {
  if (!FIREBASE_CONFIGURED || !user?.uid) return { initialized: false, localVisualMode: true };

  const userRef = ref(db, `users/${user.uid}`);
  const snapshot = await get(userRef);
  const existing = snapshot.exists() ? snapshot.val() || {} : {};
  const updates = {};
  const profileDefaults = {
    displayName: user.displayName || user.email?.split("@")[0] || "VOLTIX User",
    email: user.email || "",
    createdAt: Date.now()
  };

  addMissingValues(existing.profile || {}, profileDefaults, "profile", updates);
  addMissingValues(existing.settings || {}, DEFAULT_USER_SETTINGS, "settings", updates);

  if (Object.keys(updates).length > 0) await update(userRef, updates);
  return { initialized: Object.keys(updates).length > 0, localVisualMode: false };
}

export async function getCurrentDevice(uid) {
  if (!FIREBASE_CONFIGURED || !uid) return null;
  return { id: SHARED_DEVICE_ID, nickname: "VOLTIX Device" };
}

export function readableFirebaseError(error, fallback = "Firebase request failed.") {
  const code = error?.code || "";
  if (code === "PERMISSION_DENIED" || code === "database/permission-denied") {
    return "Access denied. Check your account permissions.";
  }
  if (code === "auth/network-request-failed") return "Network error. Check your connection.";
  return fallback;
}
