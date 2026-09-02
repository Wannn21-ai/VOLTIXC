import { auth, db, ref, get, set } from "./firebase-config.js";
import { getCurrentDevice } from "./user-state.js";

const LOCAL_FETCH_TIMEOUT_MS = 1500;
let lastHistoryReadState = { kind: "ok", message: "" };

function isPermissionDenied(error) {
  return error?.code === "PERMISSION_DENIED" || error?.code === "database/permission-denied";
}

function setHistoryReadState(kind, message = "") {
  lastHistoryReadState = { kind, message };
}

export function getHistoryReadState() {
  return { ...lastHistoryReadState };
}

function toTimestampMs(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1000000000000 ? n : n * 1000;
}

function formatDate(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleDateString("id-ID");
}

function formatCost(value) {
  if (typeof value === "string") return value;
  const n = Number(value || 0);
  return `Rp ${Math.round(n).toLocaleString("id-ID")}`;
}

function formatDuration(value) {
  if (typeof value === "string" && value.includes(":")) return value;
  const secs = Math.max(0, Number(value || 0));
  const h = String(Math.floor(secs / 3600)).padStart(2, "0");
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(secs % 60)).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function historyIdentity(session) {
  if (session.id) return `sid:${session.id}`;
  if (session.sessionId) return `sid:${session.sessionId}`;
  if (session.timestamp) return `ts:${Math.round(session.timestamp / 1000)}:${session.name || ""}`;
  return `key:${session._key || Math.random().toString(36).slice(2)}`;
}

function normalizeFirebaseHistory(raw, source = "firebase", deviceId = "") {
  if (!raw) return [];
  return Object.entries(raw)
    .filter(([, val]) => val && typeof val === "object")
    .map(([key, val]) => ({
      ...val,
      _key: key,
      _source: source,
      id: val.id || val.sessionId || key,
      sessionId: val.sessionId || val.id || key,
      deviceId: val.deviceId || deviceId,
      duration: formatDuration(val.durationSec ?? val.duration),
      cost: val.cost ?? val.costText ?? 0,
      costText: val.costText || formatCost(val.cost),
      timestamp: toTimestampMs(val.endTime || val.timestamp || val.startTime)
    }));
}

function normalizeLocalHistory(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => {
    const timestamp = toTimestampMs(entry.timestamp) ||
      toTimestampMs(entry.end_ts) ||
      toTimestampMs(entry.start_ts);
    const keySeed = entry.sessionId || entry.end_ts || entry.start_ts || index;
    return {
      ...entry,
      _key: `local_${keySeed}`,
      _source: "local",
      id: entry.id || entry.sessionId || String(keySeed),
      sessionId: entry.sessionId || entry.id || String(keySeed),
      name: entry.name || "Device",
      duration: formatDuration(entry.durationSec ?? entry.duration),
      power: Number(entry.power || 0),
      energy: Number(entry.energy ?? entry.kwh ?? 0),
      cost: entry.costText || formatCost(entry.cost),
      date: entry.date || formatDate(timestamp),
      timestamp,
      pendingSync: entry.pendingSync !== false
    };
  });
}

async function getEspHistoryUrl(uid, deviceId) {
  if (deviceId) {
    try {
      const snap = await get(ref(db, `devices/${deviceId}/live/system`));
      const sys = snap.exists() ? snap.val() : {};
      const ip = sys.ip || sys.localIp || "";
      if (ip) {
        localStorage.setItem(`sem_esp_ip_${uid}`, ip);
        return `http://${ip}/history`;
      }
    } catch {}
  }

  const cachedIp = localStorage.getItem(`sem_esp_ip_${uid}`);
  return cachedIp ? `http://${cachedIp}/history` : "";
}

function normalizeCompletedSession(session, sessionId, deviceId, uid) {
  const timestamp = toTimestampMs(session.endTime || session.timestamp || session.startTime) || Date.now();
  const sourcePath = `/devices/${deviceId}/completedSessions/${sessionId}`;
  return {
    ...session,
    id: session.id || sessionId,
    sessionId: session.sessionId || session.id || sessionId,
    deviceId: session.deviceId || deviceId,
    name: session.name || "Device",
    duration: formatDuration(session.durationSec ?? session.duration),
    power: Number(session.powerAvg ?? session.power ?? 0),
    energy: Number(session.energyKwh ?? session.energy ?? 0),
    cost: Number(session.cost || 0),
    costText: session.costText || formatCost(session.cost),
    date: session.date || formatDate(timestamp),
    timestamp,
    syncStatus: "SYNCED",
    pendingSync: false,
    createdFrom: session.createdFrom || "ESP32",
    copiedAt: Date.now(),
    uid,
    sourcePath
  };
}

const activeImports = new Map();

async function importCompletedSessions(uid) {
  let currentDevice;
  try {
    currentDevice = await getCurrentDevice(uid);
  } catch {
    return 0;
  }
  if (!currentDevice) return 0;

  const deviceId = currentDevice.id;
  try {
    const finalHistorySnap = await get(ref(db, `devices/${deviceId}/history`));
    if (finalHistorySnap.exists()) return 0;

    const queueSnap = await get(ref(db, `devices/${deviceId}/completedSessions`));
    const sessions = queueSnap.val() || {};

    let copied = 0;
    for (const [key, session] of Object.entries(sessions)) {
      if (!session || typeof session !== "object") continue;
      const sessionId = String(session.id || session.sessionId || key);
      if (!sessionId) continue;

      const userHistoryRef = ref(db, `users/${uid}/history/${sessionId}`);
      const existing = await get(userHistoryRef);
      if (existing.exists()) continue;

      await set(userHistoryRef, normalizeCompletedSession(session, sessionId, deviceId, uid));
      copied++;
    }

    return copied;
  } catch (e) {
    if (!isPermissionDenied(e)) console.warn("[History Import] skipped:", e?.message || e);
    return 0;
  }
}

export async function importCompletedSessionsForCurrentUser(user = auth.currentUser) {
  const uid = typeof user === "string" ? user : user?.uid;
  if (!uid) {
    console.warn("[History Import] skipped: Firebase Auth currentUser is not available");
    return 0;
  }

  if (activeImports.has(uid)) return activeImports.get(uid);
  const task = importCompletedSessions(uid).finally(() => activeImports.delete(uid));
  activeImports.set(uid, task);
  return task;
}

async function fetchLocalHistory(uid, deviceId) {
  const url = await getEspHistoryUrl(uid, deviceId);
  if (!url) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) return [];
    return normalizeLocalHistory(await res.json());
  } catch (e) {
    console.warn("[History] Local ESP32 history unavailable:", e?.message || e);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHistoryPath(path, source, deviceId = "") {
  try {
    const snap = await get(ref(db, path));
    return {
      sessions: snap.exists() ? normalizeFirebaseHistory(snap.val(), source, deviceId) : [],
      denied: false
    };
  } catch (e) {
    if (!isPermissionDenied(e)) console.warn(`[History] ${source} unavailable:`, e?.message || e);
    return { sessions: [], denied: isPermissionDenied(e) };
  }
}

export async function loadDeviceHistory(uid) {
  setHistoryReadState("ok");
  let currentDevice = null;
  let deviceLookupDenied = false;
  try {
    currentDevice = await getCurrentDevice(uid);
  } catch (error) {
    if (isPermissionDenied(error)) {
      deviceLookupDenied = true;
      setHistoryReadState("permission", "Access denied for this device history");
    }
  }

  const deviceId = currentDevice?.id || "";
  const [local, finalHistory, completedSessions, userHistory] = await Promise.all([
    fetchLocalHistory(uid, deviceId),
    deviceId
      ? fetchHistoryPath(`devices/${deviceId}/history`, "device-history", deviceId)
      : Promise.resolve({ sessions: [], denied: false }),
    deviceId
      ? fetchHistoryPath(`devices/${deviceId}/completedSessions`, "completed-sessions", deviceId)
      : Promise.resolve({ sessions: [], denied: false }),
    fetchHistoryPath(`users/${uid}/history`, "user-history", deviceId)
  ]);

  const noHistory = local.length === 0 &&
    finalHistory.sessions.length === 0 &&
    completedSessions.sessions.length === 0 &&
    userHistory.sessions.length === 0;
  if (!deviceId && !deviceLookupDenied && noHistory) {
    setHistoryReadState("no-device", "Pair a device to view its history");
  } else if (noHistory && (deviceLookupDenied || finalHistory.denied || userHistory.denied)) {
    setHistoryReadState("permission", "Access denied for this device history");
  }

  if (deviceId && finalHistory.sessions.length === 0) {
    await importCompletedSessionsForCurrentUser(uid);
  }

  const merged = new Map();
  local.forEach(session => merged.set(historyIdentity(session), session));
  userHistory.sessions.forEach(session => merged.set(historyIdentity(session), session));
  completedSessions.sessions.forEach(session => merged.set(historyIdentity(session), session));
  finalHistory.sessions.forEach(session => merged.set(historyIdentity(session), session));

  return [...merged.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}
