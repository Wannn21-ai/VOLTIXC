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

  let idToken;
  try {
    idToken = await user.getIdToken();
  } catch {
    throw Object.assign(new Error("Your sign-in session has expired. Sign in again."), {
      code: "pairing/authentication_expired"
    });
  }

  let response;
  try {
    response = await fetch("/api/claim-device", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${idToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ code })
    });
  } catch {
    throw Object.assign(new Error("Pairing service is unavailable. Try again shortly."), {
      code: "pairing/backend_unavailable"
    });
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = {
      invalid_code: "Pairing code is invalid.",
      expired_code: "Pairing code has expired. Wait for a new code on the device.",
      code_already_used: "Pairing code has already been used.",
      device_already_owned: "Device is already owned by another account.",
      authentication_expired: "Your sign-in session has expired. Sign in again.",
      pairing_service_unavailable: "Pairing service is unavailable. Try again shortly."
    };
    const reason = typeof payload.error === "string"
      ? payload.error
      : "pairing_service_unavailable";
    throw Object.assign(new Error(messages[reason] || "Device pairing failed."), {
      code: `pairing/${reason}`,
      status: response.status
    });
  }

  if (!payload.id || !payload.nickname) {
    throw Object.assign(new Error("Pairing service returned an invalid response."), {
      code: "pairing/backend_unavailable"
    });
  }
  localStorage.setItem(`${CURRENT_DEVICE_KEY_PREFIX}${user.uid}`, payload.id);
  return { id: payload.id, nickname: payload.nickname, role: "owner" };
}

export function readableFirebaseError(error, fallback = "Firebase request failed.") {
  const code = error?.code || "";
  if (code === "PERMISSION_DENIED" || code === "database/permission-denied") {
    return "Access denied. Check your account permissions.";
  }
  if (code === "auth/network-request-failed") return "Network error. Check your connection.";
  if (code.startsWith("pairing/")) return error?.message || fallback;
  return fallback;
}
