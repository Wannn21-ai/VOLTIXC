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

const CURRENT_DEVICE_KEY_PREFIX = "voltix_current_device_";

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

  const snapshot = await get(ref(db, `users/${uid}/devices`));
  if (!snapshot.exists()) {
    localStorage.removeItem(`${CURRENT_DEVICE_KEY_PREFIX}${uid}`);
    return null;
  }

  const devices = snapshot.val() || {};
  const deviceIds = Object.keys(devices).sort((a, b) => {
    const addedA = Number(devices[a]?.addedAt || 0);
    const addedB = Number(devices[b]?.addedAt || 0);
    return addedA - addedB || a.localeCompare(b);
  });
  if (deviceIds.length === 0) return null;

  const storageKey = `${CURRENT_DEVICE_KEY_PREFIX}${uid}`;
  const cachedId = localStorage.getItem(storageKey);
  const deviceId = cachedId && devices[cachedId] ? cachedId : deviceIds[0];
  localStorage.setItem(storageKey, deviceId);
  return { id: deviceId, ...devices[deviceId] };
}

export async function claimPairingCode(user, code) {
  if (!FIREBASE_CONFIGURED) throw new Error("Pairing is unavailable in local visual mode.");
  if (!user?.uid) throw new Error("Sign in before pairing a device.");
  if (!/^\d{6}$/.test(code)) throw new Error("Enter a valid 6-digit pairing code.");

  const pairingServiceRequiredError = error => Object.assign(
    new Error("Secure rules require the trusted pairing service. Use the documented Stage A development rules only for isolated testing."),
    { code: "pairing/trusted-service-required", cause: error }
  );
  const isPermissionDenied = error =>
    error?.code === "PERMISSION_DENIED" || error?.code === "database/permission-denied";

  let pairingSnapshot;
  try {
    pairingSnapshot = await get(ref(db, `pairingCodes/${code}`));
  } catch (error) {
    if (isPermissionDenied(error)) throw pairingServiceRequiredError(error);
    throw error;
  }
  if (!pairingSnapshot.exists()) throw new Error("Pairing code is invalid.");

  const pairing = pairingSnapshot.val() || {};
  if (pairing.used === true) throw new Error("Pairing code has already been used.");
  if (!Number.isFinite(Number(pairing.expiresAt)) || Number(pairing.expiresAt) <= Date.now()) {
    throw new Error("Pairing code has expired.");
  }
  if (!pairing.deviceId) throw new Error("Pairing code does not reference a device.");

  let deviceSnapshot;
  try {
    deviceSnapshot = await get(ref(db, `devices/${pairing.deviceId}`));
  } catch (error) {
    if (isPermissionDenied(error)) throw pairingServiceRequiredError(error);
    throw error;
  }
  if (!deviceSnapshot.exists()) throw new Error("Pairing device was not found.");

  const device = deviceSnapshot.val() || {};
  if (device.paired === true || device.ownerUid) throw new Error("Device is already paired.");

  const now = Date.now();
  const nickname = device.name || "VOLTIX Device";
  const ownerDisplayName = typeof user.displayName === "string"
    ? user.displayName.trim().slice(0, 80)
    : "";
  const updates = {
    [`users/${user.uid}/devices/${pairing.deviceId}`]: {
      role: "owner",
      nickname,
      addedAt: now
    },
    [`devices/${pairing.deviceId}/ownerUid`]: user.uid,
    [`devices/${pairing.deviceId}/paired`]: true,
    [`devices/${pairing.deviceId}/name`]: nickname,
    [`devices/${pairing.deviceId}/ownerProfile`]: {
      uid: user.uid,
      displayName: ownerDisplayName,
      pairingCode: code
    },
    [`devices/${pairing.deviceId}/members/${user.uid}`]: {
      role: "owner",
      addedAt: now
    },
    [`pairingCodes/${code}/used`]: true,
    [`pairingCodes/${code}/usedBy`]: user.uid
  };

  try {
    await update(ref(db, "/"), updates);
  } catch (error) {
    if (isPermissionDenied(error)) throw pairingServiceRequiredError(error);
    throw error;
  }

  localStorage.setItem(`${CURRENT_DEVICE_KEY_PREFIX}${user.uid}`, pairing.deviceId);
  return { id: pairing.deviceId, nickname, role: "owner" };
}

export function readableFirebaseError(error, fallback = "Firebase request failed.") {
  const code = error?.code || "";
  if (code === "PERMISSION_DENIED" || code === "database/permission-denied") {
    return "Access denied. Check your account permissions.";
  }
  if (code === "auth/network-request-failed") return "Network error. Check your connection.";
  return fallback;
}
