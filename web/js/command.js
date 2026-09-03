import { auth } from "./firebase-config.js";
import { authenticatedApi } from "./cloud-api.js";
import { getCurrentDevice } from "./user-state.js";

const LOCAL_FETCH_TIMEOUT_MS = 1500;
let lastHistoryReadState = { kind: "ok", message: "" };

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

function normalizeCloudHistory(raw, source = "cloud-api", deviceId = "") {
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
  const cachedIp = localStorage.getItem(`sem_esp_ip_${uid}`);
  return cachedIp ? `http://${cachedIp}/history` : "";
}

export async function importCompletedSessionsForCurrentUser(user = auth.currentUser) {
  const uid = typeof user === "string" ? user : user?.uid;
  if (!uid) {
    console.warn("[History Import] skipped: authenticated user is not available");
    return 0;
  }
  // The backend atomically assigns unowned offline sessions to the current
  // authenticated user when /api/history is read.
  return 0;
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

export async function loadDeviceHistory(uid) {
  setHistoryReadState("ok");
  const currentDevice = await getCurrentDevice(uid).catch(() => null);
  const deviceId = currentDevice?.id || "";
  try {
    const cloud = await authenticatedApi(auth.currentUser, "/api/history");
    return normalizeCloudHistory(
      Object.fromEntries((cloud.sessions || []).map(session => [session.sessionId || session.id, session])),
      "cloud-api",
      deviceId,
    ).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  } catch (error) {
    // LittleFS is a recovery fallback only. Do not merge it into a successful
    // cloud response because a history item deleted from the cloud could then
    // appear again while the ESP32 is reachable on the LAN.
    setHistoryReadState("unavailable", error.message);
    return fetchLocalHistory(uid, deviceId);
  }
}
