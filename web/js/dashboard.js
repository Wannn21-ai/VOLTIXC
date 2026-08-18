import {
  requireAuth, renderShell, fillUserInfo, setSystemStatus,
  showToast, applyTheme, updateChartColors, startStatusWatcher,
  loadAndApplySettings, isEspOnlineStatus, tr
} from "./auth-guard.js";
import { db, ref, onValue, set, push, get } from "./firebase-config.js";
import { loadDeviceHistory } from "./local-history.js";
import { getCurrentDevice, readableFirebaseError } from "./user-state.js";
import { clampRefreshInterval, createMetersUpdateScheduler } from "./dashboard-live-update.js";

// ================= INIT =================
const user = await requireAuth();
renderShell("dashboard", "DASHBOARD");
fillUserInfo(user);
startStatusWatcher();
const uid = user.uid;
let selectedDevice = null;
try {
  selectedDevice = await getCurrentDevice(uid);
  if (!selectedDevice) document.getElementById("no-device-state").style.display = "block";
} catch (error) {
  document.getElementById("no-device-state").style.display = "block";
  document.querySelector("#no-device-state .empty-state-title").textContent = tr("deviceAccessUnavailable");
  document.querySelector("#no-device-state .empty-state-sub").textContent = readableFirebaseError(error);
}

// ================= FIREBASE PATHS =================
const historyRef  = ref(db, `users/${uid}/history`);
const settingsRef = ref(db, `users/${uid}/settings`);

// ================= SETTINGS =================
const SETTING_DEFAULTS = {
  currency: "IDR", tariff: 1444.70, overloadThreshold: 2000,
  overloadWarningPercent: 99,
  loadPowerThreshold: 1,
  loadCurrentThreshold: 0.02,
  loadRemovedDelaySec: 2,
  offlineTimeoutSec: 300,
  checkpointIntervalSec: 30,
  notifDevice: true, notifDisconnect: true, notifSession: true,
  notifOverload: true, refreshInterval: 3000, theme: "dark", language: "en"
};
let settings = { ...SETTING_DEFAULTS };
settings = await loadAndApplySettings(uid);

// Refresh settings tiap 10 detik
setInterval(async () => {
  try {
    const snap = await get(settingsRef);
    const remote = snap.exists() ? { ...SETTING_DEFAULTS, ...snap.val() } : { ...settings };
    const appConfigSnap = selectedDevice
      ? await get(ref(db, `devices/${selectedDevice.id}/config`))
      : null;
    if (appConfigSnap?.exists()) {
      const shared = appConfigSnap.val() || {};
      const sharedThreshold = Number(shared.overloadThreshold ?? shared.threshold);
      const sharedTariff = Number(shared.electricityCostPerKwh ?? shared.tariff ?? shared.tarif);
      if (Number.isFinite(sharedThreshold) && sharedThreshold > 0) remote.overloadThreshold = sharedThreshold;
      if (Number.isFinite(sharedTariff) && sharedTariff > 0) remote.tariff = sharedTariff;
      if (shared.currency) remote.currency = shared.currency;
      ["overloadWarningPercent", "loadPowerThreshold", "loadCurrentThreshold",
       "loadRemovedDelaySec", "offlineTimeoutSec", "checkpointIntervalSec"].forEach(key => {
        const value = Number(shared[key]);
        if (Number.isFinite(value) && value > 0) remote[key] = value;
      });
    }
    if (JSON.stringify(remote) !== JSON.stringify(settings)) {
      settings = remote;
      localStorage.setItem(`sem_settings_${uid}`, JSON.stringify(settings));
      applyTheme(settings.theme);
      startMetersInterval();
    }
  } catch {}
}, 10000);

// ================= CONSTANTS =================
const STALE_THRESHOLD = 15;
const DEVICE_OFFLINE_TIMEOUT_MS = STALE_THRESHOLD * 1000;
const SystemMode = Object.freeze({
  ONLINE: "ONLINE",
  OFFLINE: "OFFLINE",
  TRANSITION: "TRANSITION"
});
const SessionState = Object.freeze({
  IDLE: "IDLE",
  WAITING_LOAD: "WAITING_LOAD",
  MONITORING: "MONITORING",
  OVERLOAD: "OVERLOAD",
  FINISHED: "FINISHED"
});

// ================= STATE — FIREBASE DATA =================
let voltage = 0, current = 0, firebasePower = 0, firebaseTimestamp = 0;
let firebaseSystemReceivedAtMs = 0;
let firebaseHeartbeatMs = 0;
let firebaseTelemetryAtMs = 0;
let firebasePF = 0, firebaseFreq = 0, firebaseApparent = 0;
let firebaseEnergy = 0, firebaseCost = 0;
let firebaseOverload = false;
let firebaseRelay    = false;
let firebaseOffline  = false;
let firebaseSessionActive = false;
let firebaseSessionStartTs = 0;
let firebaseElapsedSec = 0;
let firebaseSessionId = "";
let firebaseSessionUid = "";
let firebaseSystemMode = null;
let firebaseSessionState = null;
let firebasePendingSync = 0;
let systemInternet   = false;
let firebaseDeviceConnected = null;
let firebaseLiveDeviceAvailable = false;
let firebaseWifiStatus = "";
let firebaseActiveSsid = "";
let firebaseFirmwareVersion = "";
let deviceNameFromEsp = "—";  // Device name dari ESP32 (untuk offline mode)

// ================= STATE — WEB =================
let systemMode = SystemMode.OFFLINE;
let sessionState = SessionState.IDLE;
let systemOnline = false;
let deviceOnline = false;
let loadDetected = false;
let liveDataFresh = false;
let prevDeviceConnected = false;
let prevOverload        = false;
let prevRelayState      = false;
let prevSystemOnline    = false;
let isRunning    = false;
let startTime    = null;
let timerInterval = null;
let sessionSaved = false;
let activeDevice = null;
let waitingForName = false;
let metersInterval = null;
let energyBaseline  = 0;
let sessionCount    = 0;
let lastknownEnergy = 0;
let offlineSessionStartEnergy = null;
const metersUpdateScheduler = createMetersUpdateScheduler(() => updateMeters());
const scheduleMetersUpdate = () => metersUpdateScheduler.schedule();

// ── BUG 1 FIX: pendingDeviceName moved to MODULE scope ──────────
// Was declared inside updateMeters() (local), so btnSaveDev handler
// could never read/write the same variable. Now shared correctly.
let pendingDeviceName = null;
let pendingSessionId = null;
let pendingStartCommandAt = null;
let pendingRelayConfirmed = false;
let pendingUiState = "";

// ================= STATE — OFFLINE TRACKING =================
let offlineDetectedAt       = null;
let offlineBannerShown      = false;
let reconnectToastShown     = false;

// ================= RELAY COMMAND =================
function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function sendRelayCommand(type, payload = {}) {
  if (!selectedDevice?.id) {
    showToast(tr("pairDeviceToMonitor"), "error");
    return false;
  }

  try {
    const on = type === "START";
    const commandTimestamp = Date.now();
    const command = {
      ...payload,
      id: makeId("cmd"),
      type,
      uid,
      createdAt: commandTimestamp,
      updatedAt: commandTimestamp
    };
    await set(ref(db, `devices/${selectedDevice.id}/commands/current`), command);
    console.log(`[Relay] Command ${on ? "ON" : "OFF"} → Firebase`);
    return true;
  } catch (e) {
    console.warn("[Relay] Command rejected:", e?.message || e);
    showToast(readableFirebaseError(e, "Failed to send device command"), "error");
    return false;
  }
}

// ================= STORAGE =================
async function getHistory() {
  return loadDeviceHistory(uid);
}

async function pushHistory(entry) {
  try { await push(historyRef, entry); }
  catch (e) { console.error("[History] pushHistory gagal:", e); }
}

async function getSessionCount() {
  return (await getHistory()).length;
}

// ================= ELEMENTS =================
const valVoltage      = document.getElementById("val-voltage");
const valCurrent      = document.getElementById("val-current");
const valPower        = document.getElementById("val-power");
const valEnergy       = document.getElementById("val-energy");
const valCost         = document.getElementById("val-cost");
const subEnergyKwh    = document.getElementById("sub-energy-kwh");
const valDeviceName   = document.getElementById("val-device-name");
const subDuration     = document.getElementById("sub-duration");
const subTariff       = document.getElementById("sub-tariff");
const subWebStatus    = document.getElementById("sub-web-status");
const valSessionCount = document.getElementById("val-session-count");
const activeDevLabel  = document.getElementById("active-device-label");
const badgeStatus     = document.getElementById("badge-device-status");
const deviceTabsEl    = document.getElementById("device-tabs");
const btnStop         = document.getElementById("btn-stop");
const fab             = document.getElementById("fab-add");
const modalAdd        = document.getElementById("modal-add-device");
const inputDevName    = document.getElementById("input-device-name");
const btnCancelDev    = document.getElementById("btn-cancel-device");
const btnSaveDev      = document.getElementById("btn-save-device");
const gaugeVoltage    = document.getElementById("gauge-voltage");
const gaugeCurrent    = document.getElementById("gauge-current");
const overloadBanner  = document.getElementById("overload-banner");
const valRelayStatus  = document.getElementById("val-relay-status");
const valModeStatus   = document.getElementById("val-mode-status");
const valDeviceLinkStatus = document.getElementById("val-device-link-status");
const valSessionStatus = document.getElementById("val-session-status");
const valSessionHelper = document.getElementById("val-session-helper");
const valRelayHelper = document.getElementById("val-relay-helper");
const valModeHelper = document.getElementById("val-mode-helper");
const valLinkHelper = document.getElementById("val-link-helper");
const heroDeviceName = document.getElementById("hero-device-name");
const heroConnectionState = document.getElementById("hero-connection-state");
const heroSessionState = document.getElementById("hero-session-state");
const heroRelayState = document.getElementById("hero-relay-state");
const heroModeState = document.getElementById("hero-mode-state");
const heroStateText = document.getElementById("hero-state-text");
const btnStartInline = document.getElementById("btn-start-inline");

// ================================================================
// BANNER: OFFLINE ESP32
// ================================================================
let offlineBannerEl = document.getElementById("offline-banner");
if (!offlineBannerEl) {
  offlineBannerEl = document.createElement("div");
  offlineBannerEl.id = "offline-banner";
  offlineBannerEl.style.cssText = `
    display:none; align-items:center; gap:12px;
    background:rgba(255,171,0,0.08); border:1px solid rgba(255,171,0,0.35);
    border-radius:var(--radius-md); padding:14px 20px; margin-bottom:20px;
    color:var(--amber); font-size:13px; font-weight:500;`;
  offlineBannerEl.innerHTML = `
    <span style="font-size:18px;">⚠</span>
    <div style="flex:1;">
      <div style="font-weight:600;margin-bottom:2px;" id="offline-banner-title">
        Status ESP32
      </div>
      <div style="font-size:12px;color:var(--text-muted);" id="offline-banner-sub">
        Menunggu koneksi...
      </div>
    </div>
    <span id="offline-duration-badge" style="
      font-family:var(--font-display);font-size:11px;font-weight:700;
      background:rgba(255,171,0,0.15);border:1px solid rgba(255,171,0,0.3);
      padding:3px 10px;border-radius:20px;white-space:nowrap;"></span>`;

  const ob = document.getElementById("overload-banner");
  if (ob?.parentNode) ob.parentNode.insertBefore(offlineBannerEl, ob.nextSibling);
  else document.querySelector(".page-content")?.prepend(offlineBannerEl);
}

let offlineDurationInterval = null;

function showOfflineBanner(firstDetectedAt) {
  hideOfflineBanner();
}

function hideOfflineBanner() {
  offlineBannerEl.style.display = "none";
  offlineBannerShown = false;
  if (offlineDurationInterval) {
    clearInterval(offlineDurationInterval);
    offlineDurationInterval = null;
  }
}

// ================================================================
// BANNER: MODE STATUS & PENDING OFFLINE SESSIONS
// ================================================================
let modeStatusBanner = document.getElementById("mode-status-banner");
if (!modeStatusBanner) {
  modeStatusBanner = document.createElement("div");
  modeStatusBanner.id = "mode-status-banner";
  modeStatusBanner.style.cssText = `
    display:none; align-items:center; justify-content:space-between; gap:12px;
    background:rgba(255,171,0,0.08); border:1px solid rgba(255,171,0,0.3);
    border-radius:var(--radius-md); padding:12px 16px; margin-bottom:14px;
    color:var(--amber); font-size:12px; font-weight:600;`;
  modeStatusBanner.innerHTML = `
    <span id="mode-status-text">⚠ Mode: OFFLINE • Relay: ON</span>
    <span id="pending-sync-badge" style="display:none;
      background:rgba(255,171,0,0.2);border:1px solid rgba(255,171,0,0.4);
      padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;">
      0 Pending
    </span>`;

  const ob = document.getElementById("overload-banner");
  if (ob?.parentNode) ob.parentNode.insertBefore(modeStatusBanner, ob);
  else document.querySelector(".page-content")?.prepend(modeStatusBanner);
}

function updateModeStatusBanner(explicitOfflineMode, relayOn, pendingCount = 0) {
  if (explicitOfflineMode && relayOn) {
    modeStatusBanner.style.display = "flex";
    const textEl = document.getElementById("mode-status-text");
    const badgeEl = document.getElementById("pending-sync-badge");
    if (textEl) textEl.textContent = tr("dashboardOfflineModeBanner");
    if (badgeEl) {
      badgeEl.style.display = pendingCount > 0 ? "inline-block" : "none";
      badgeEl.textContent = tr("dashboardPendingSync", { count: pendingCount });
    }
  } else {
    modeStatusBanner.style.display = "none";
  }
}

// ================================================================
// BANNER: RELAY READY
// ================================================================
let relayBanner = document.getElementById("relay-banner");
if (!relayBanner) {
  relayBanner = document.createElement("div");
  relayBanner.id = "relay-banner";
  relayBanner.style.cssText = `
    display:none; align-items:center; justify-content:space-between; gap:12px;
    background:rgba(0,229,255,0.08); border:1px solid rgba(0,229,255,0.3);
    border-radius:var(--radius-md); padding:14px 20px; margin-bottom:20px;
    color:var(--cyan); font-size:13px; font-weight:500;`;
  relayBanner.innerHTML = `
    <span id="relay-banner-text">${tr("dashboardRelayReady")}</span>`;

  const ob = document.getElementById("overload-banner");
  if (ob?.parentNode) ob.parentNode.insertBefore(relayBanner, ob.nextSibling);
  else document.querySelector(".page-content")?.prepend(relayBanner);
}

function setRelayBanner(show) {
  relayBanner.style.display = show ? "flex" : "none";
}

// ================================================================
// BANNER: OFFLINE SESSION ACTIVE
// ================================================================
let offlineSessionBanner = document.getElementById("offline-session-banner");
if (!offlineSessionBanner) {
  offlineSessionBanner = document.createElement("div");
  offlineSessionBanner.id = "offline-session-banner";
  offlineSessionBanner.style.cssText = `
    display:none; align-items:center; gap:12px;
    background:rgba(0,229,255,0.05); border:1px solid rgba(0,229,255,0.2);
    border-radius:var(--radius-md); padding:14px 20px; margin-bottom:20px;
    color:var(--cyan); font-size:13px;`;
  offlineSessionBanner.innerHTML = `
    <span style="font-size:18px;">📡</span>
    <div>
      <div style="font-weight:600;margin-bottom:2px;" id="offline-session-title">
        ${tr("dashboardOfflineSessionTitle")}
      </div>
      <div style="font-size:12px;color:var(--text-muted);" id="offline-session-sub">
        ${tr("dashboardOfflineSessionSub")}
      </div>
    </div>`;

  const ob = document.getElementById("overload-banner");
  if (ob?.parentNode) ob.parentNode.insertBefore(offlineSessionBanner, ob.nextSibling);
  else document.querySelector(".page-content")?.prepend(offlineSessionBanner);
}

function setOfflineSessionBanner(show, deviceName = "—") {
  offlineSessionBanner.style.display = show ? "flex" : "none";
  if (show && deviceName && deviceName !== "—") {
    const titleEl = document.getElementById("offline-session-title");
    const subEl = document.getElementById("offline-session-sub");
    if (titleEl) titleEl.textContent = tr("dashboardOfflineSessionNamed", { device: deviceName });
    if (subEl) subEl.textContent = tr("dashboardOfflineSessionLocal");
  }
}

// ================= CHART OPTIONS =================
function chartTickColor() {
  return getComputedStyle(document.documentElement).getPropertyValue("--chart-tick").trim() || "#666";
}
function chartGridColor() {
  return getComputedStyle(document.documentElement).getPropertyValue("--chart-grid").trim() || "rgba(255,255,255,0.04)";
}
function makeChartOpts(extra = {}) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: chartTickColor(), font: { size: 10 } }, grid: { color: chartGridColor() }, ...extra.x },
      y: { ticks: { color: chartTickColor(), font: { size: 10 } }, grid: { color: chartGridColor() }, ...extra.y }
    }
  };
}
const lineChart = new Chart(document.getElementById("chart-line"), {
  type: "line",
  data: { labels: [], datasets: [{ label: "Power (W)", data: [],
    borderColor: "#ffab00", backgroundColor: "rgba(255,171,0,0.08)",
    tension: 0.4, fill: true, pointRadius: 3, pointBackgroundColor: "#ffab00" }] },
  options: makeChartOpts()
});
const barChart = new Chart(document.getElementById("chart-bar"), {
  type: "bar",
  data: { labels: [], datasets: [{ label: "Device Usage (kWh)", data: [],
    backgroundColor: "rgba(0,229,255,0.6)", borderColor: "#00e5ff",
    borderWidth: 1, borderRadius: 4 }] },
  options: makeChartOpts()
});
const pieChart = new Chart(document.getElementById("chart-pie"), {
  type: "doughnut",
  data: { labels: [], datasets: [{ data: [],
    backgroundColor: ["#00e5ff","#00e676","#ffab00","#ff1744","#7c4dff","#ff6d00"],
    borderWidth: 0 }] },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: true, position: "bottom",
      labels: { color: chartTickColor(), font: { size: 10 }, boxWidth: 10, padding: 12 } } }
  }
});

// ================= HELPERS =================
const symbol     = () => settings.currency === "USD" ? "$" : "Rp";
const formatCost = v  => {
  const value = Number(v) || 0;
  if (settings.currency === "USD") return `$ ${value.toFixed(2)}`;
  return `Rp ${value.toLocaleString("id-ID", { maximumFractionDigits: 1 })}`;
};
const formatWh = kwh => {
  const wh = Math.max(0, (Number(kwh) || 0) * 1000);
  return wh.toLocaleString("id-ID", { maximumFractionDigits: wh < 10 ? 1 : 0 });
};

function getSessionEnergy() {
  return Math.max(0, lastknownEnergy - energyBaseline);
}
function getSessionCost() {
  return getSessionEnergy() * settings.tariff;
}
function enumValue(enumMap, value) {
  return Object.values(enumMap).includes(value) ? value : null;
}
function deriveSystemMode() {
  const fromEsp = enumValue(SystemMode, firebaseSystemMode);
  if (!systemOnline) return SystemMode.OFFLINE;
  if (fromEsp && fromEsp !== SystemMode.OFFLINE) return fromEsp;
  return SystemMode.ONLINE;
}
function deriveSessionState(webOverload) {
  const hasSessionContext = isRunning || !!activeDevice || firebaseSessionActive || !!pendingDeviceName;
  const fromEsp = enumValue(SessionState, firebaseSessionState);
  if ([SessionState.WAITING_LOAD, SessionState.MONITORING, SessionState.OVERLOAD].includes(fromEsp)) return fromEsp;
  if (hasSessionContext && fromEsp) return fromEsp;
  if (hasSessionContext && (webOverload || firebaseOverload)) return SessionState.OVERLOAD;
  if (pendingDeviceName || waitingForName) return SessionState.WAITING_LOAD;
  if ((isRunning || firebaseSessionActive) && deviceOnline) return SessionState.MONITORING;
  if (activeDevice && !firebaseRelay && !firebaseSessionActive) return SessionState.FINISHED;
  return SessionState.IDLE;
}

function generateUniqueName(base, usedNames) {
  if (!usedNames.includes(base)) return base;
  let c = 2;
  while (usedNames.includes(`${base} ${c}`)) c++;
  return `${base} ${c}`;
}
function setGauge(el, val, min, max) {
  if (!el) return;
  el.style.strokeDashoffset = 232 - Math.max(0, Math.min(1, (val - min) / (max - min))) * 232;
}
function clearDisplay() {
  if (valVoltage) valVoltage.textContent = "0";
  if (valCurrent) valCurrent.textContent = "0.00";
  if (valPower)   valPower.textContent   = "0";
  if (valEnergy)  valEnergy.textContent  = "0";
  if (subEnergyKwh) subEnergyKwh.textContent = "0.00000 kWh";
  if (valCost)    valCost.textContent    = formatCost(0);
  setGauge(gaugeVoltage, 0, 190, 240);
  setGauge(gaugeCurrent, 0, 0, 16);
}
function sessionHasLiveMeasurements() {
  return systemOnline &&
    liveDataFresh &&
    (isRunning ||
      firebaseSessionActive ||
      [SessionState.WAITING_LOAD, SessionState.MONITORING, SessionState.OVERLOAD].includes(sessionState));
}
function updateDisplay() {
  if (!systemOnline || !liveDataFresh) {
    clearDisplay();
    return;
  }
  const monitoring = isRunning && !!activeDevice;
  const sessionInactive = !sessionHasLiveMeasurements();
  const shownCurrent = sessionInactive ? 0 : current;
  const shownPower = sessionInactive ? 0 : firebasePower;
  const shownEnergy = sessionInactive
    ? 0
    : monitoring ? getSessionEnergy() : Math.max(0, firebaseEnergy);
  const shownCost = sessionInactive
    ? 0
    : monitoring ? getSessionCost() : Math.max(0, firebaseCost || shownEnergy * settings.tariff);
  if (valVoltage) valVoltage.textContent = voltage.toFixed(1);
  if (valCurrent) valCurrent.textContent = shownCurrent.toFixed(2);
  if (valPower)   valPower.textContent   = shownPower.toFixed(0);
  if (valEnergy)  valEnergy.textContent  = formatWh(shownEnergy);
  if (subEnergyKwh) subEnergyKwh.textContent = `${shownEnergy.toFixed(5)} kWh`;
  if (valCost)    valCost.textContent    = formatCost(shownCost);
  setGauge(gaugeVoltage, voltage, 190, 240);
  setGauge(gaugeCurrent, shownCurrent, 0, 16);
  const elPF   = document.getElementById("val-pf");
  const elFreq = document.getElementById("val-freq");
  const elApp  = document.getElementById("val-apparent");
  if (elPF)   elPF.textContent   = firebasePF > 0 ? firebasePF.toFixed(2) : "—";
  if (elFreq) elFreq.textContent = firebaseFreq > 0 ? firebaseFreq.toFixed(1) : "—";
  if (elApp)  elApp.textContent  = firebaseApparent > 0 ? firebaseApparent.toFixed(0) : "—";
}
function formatDurationSeconds(totalSeconds = 0) {
  const secs = Math.max(0, Number(totalSeconds) || 0);
  const h = String(Math.floor(secs / 3600)).padStart(2, "0");
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(secs % 60)).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
function getDuration() {
  return formatDurationSeconds(firebaseElapsedSec);
}
function updateTimer() {
  if (subDuration) subDuration.textContent = tr("dashboardDurationValue", { duration: getDuration() });
}
function setDeviceBadge(state) {
  if (!badgeStatus) return;
  const map = {
    connected: ["badge online",  `● ${tr("dashboardConnected")}`],
    live:      ["badge online",  `● ${tr("dashboardLive")}`],
    overload:  ["badge offline", `⚠ ${tr("dashboardOverload")}`],
    starting:  ["badge idle",    tr("dashboardStarting")],
    stopping:  ["badge idle",    tr("dashboardStopping")],
    finished:  ["badge online",  tr("dashboardSaved")],
    noLoad:    ["badge idle",    tr("dashboardNoLoad")],
    idle:      ["badge idle",    `● ${tr("dashboardReady")}`],
    offline:   ["badge offline", "● Offline"],
    unknown:   ["badge unknown", `● ${tr("commonUnknown")}`]
  };
  const [cls, txt] = map[state] || map.unknown;
  badgeStatus.className = cls;
  badgeStatus.textContent = txt;
}
function setHeroStatus(el, value, state) {
  if (!el) return;
  el.textContent = value;
  el.className = state ? `status-${state}` : "";
}
function setPanelPill(el, value, state) {
  if (!el) return;
  el.textContent = value;
  el.className = state ? `panel-state status-${state}` : "panel-state";
}
function setHelper(el, text) {
  if (el) el.textContent = text;
}
function visualStateText(visualState) {
  const copy = {
    idle: tr("dashboardReady"),
    starting: tr("dashboardWaitingLoad"),
    monitoring: tr("dashboardMonitoring"),
    stopping: tr("dashboardStopping"),
    finished: tr("dashboardSaved"),
    offline: tr("dashboardOffline"),
    overload: tr("dashboardOverload"),
  };
  return copy[visualState] || copy.idle;
}
function dashboardVisualState() {
  if (!systemOnline) return "offline";
  if (pendingUiState === "stopping") return "stopping";
  if (pendingDeviceName || waitingForName || sessionState === SessionState.WAITING_LOAD) return "starting";
  if (sessionState === SessionState.OVERLOAD) return "overload";
  if (isRunning || firebaseSessionActive || sessionState === SessionState.MONITORING) return "monitoring";
  if (sessionState === SessionState.FINISHED) return "finished";
  return "idle";
}
function applyActionState() {
  const starting = pendingUiState === "starting" || !!pendingDeviceName || waitingForName;
  const stopping = pendingUiState === "stopping";
  const stopAvailable = isRunning ||
    !!activeDevice ||
    !!pendingDeviceName ||
    firebaseSessionActive ||
    [SessionState.WAITING_LOAD, SessionState.MONITORING, SessionState.OVERLOAD].includes(sessionState);
  if (fab) {
    fab.disabled = starting || stopping || isRunning || !systemOnline;
    fab.title = starting
      ? tr("dashboardStartWaitingTitle")
      : stopping
        ? tr("dashboardStopSavingTitle")
        : !systemOnline
          ? tr("dashboardEspOnlineRequiredTitle")
          : tr("dashboardStartTitle");
    fab.setAttribute("aria-label", fab.title);
  }
  if (btnStartInline) {
    btnStartInline.disabled = starting || stopping || isRunning || !systemOnline;
    btnStartInline.textContent = starting
      ? tr("dashboardStarting")
      : stopping
        ? tr("dashboardSaving")
        : isRunning
          ? tr("dashboardMonitoringActive")
          : tr("dashboardStart");
    btnStartInline.title = starting
      ? tr("dashboardStartWaitingTitle")
      : stopping
        ? tr("dashboardStopSavingTitle")
        : !systemOnline
          ? tr("dashboardEspOnlineRequiredTitle")
          : tr("dashboardStartTitle");
    btnStartInline.setAttribute("aria-label", btnStartInline.title);
  }
  if (btnSaveDev) {
    btnSaveDev.disabled = starting || stopping;
  }
  if (btnStop) {
    btnStop.style.display = stopAvailable ? "inline-flex" : "none";
    btnStop.disabled = stopping || !stopAvailable;
  }
}
function updateHeroStatuses(systemOnline) {
  const mode = systemMode || SystemMode.TRANSITION;
  const visualState = dashboardVisualState();
  const sessionLabels = {
    starting: "STARTING",
    monitoring: "MONITORING",
    stopping: "STOPPING",
    finished: "FINISHED",
    offline: "OFFLINE",
    overload: "OVERLOAD",
    idle: firebaseTimestamp > 0 && !firebaseRelay && !firebaseSessionActive ? "NO LOAD" : "IDLE",
  };
  const sessionHelpers = {
    starting: tr("dashboardSessionStartingHelp"),
    monitoring: tr("dashboardSessionMonitoringHelp"),
    stopping: tr("dashboardSessionStoppingHelp"),
    finished: tr("dashboardSessionFinishedHelp"),
    offline: tr("dashboardSessionOfflineHelp"),
    overload: tr("dashboardSessionOverloadHelp"),
    idle: tr("dashboardSessionIdleHelp"),
  };
  const healthyState = visualState === "monitoring" || visualState === "finished";
  const warningState = visualState === "offline" || visualState === "overload";
  const panelState = healthyState ? "online" : warningState ? "offline" : "transition";
  const deviceLabel = activeDevice?.name || pendingDeviceName || selectedDevice?.name || deviceNameFromEsp || tr("noActiveDevice");
  const hasHeartbeat = firebaseHeartbeatMs > 0;
  const connectionLabel = systemOnline ? "Online" : hasHeartbeat ? "Offline" : tr("dashboardWaiting");
  const relayPanelLabel = systemOnline
    ? (firebaseRelay ? "Relay ON" : "Relay OFF")
    : (firebaseRelay ? "Last known: ON" : "Last known: OFF");
  const relayStatusLabel = systemOnline ? (firebaseRelay ? "ON" : "OFF") : "UNKNOWN";
  const relayStateClass = systemOnline ? (firebaseRelay ? "online" : "offline") : "transition";
  if (heroDeviceName) heroDeviceName.textContent = deviceLabel;
  if (heroStateText) heroStateText.textContent = visualStateText(visualState);
  setPanelPill(
    heroConnectionState,
    connectionLabel,
    systemOnline ? "online" : hasHeartbeat ? "offline" : "transition"
  );
  setPanelPill(heroSessionState, visualStateText(visualState), panelState);
  setPanelPill(heroRelayState, relayPanelLabel, relayStateClass);
  setPanelPill(
    heroModeState,
    mode === SystemMode.ONLINE ? "Online" : mode === SystemMode.OFFLINE ? "Offline" : tr("dashboardTransition"),
    mode === SystemMode.ONLINE ? "online" : mode === SystemMode.OFFLINE ? "offline" : "transition"
  );
  setHeroStatus(
    valSessionStatus,
    sessionLabels[visualState] || "IDLE",
    healthyState
      ? "online"
      : warningState
        ? "offline"
        : "transition"
  );
  setHeroStatus(valRelayStatus, relayStatusLabel, relayStateClass);
  setHeroStatus(
    valModeStatus,
    mode,
    mode === SystemMode.ONLINE ? "online" : mode === SystemMode.OFFLINE ? "offline" : "transition"
  );
  setHeroStatus(
    valDeviceLinkStatus,
    systemOnline ? "ONLINE" : hasHeartbeat ? "OFFLINE" : "WAITING",
    systemOnline ? "online" : hasHeartbeat ? "offline" : "transition"
  );
  setHelper(valSessionHelper, sessionHelpers[visualState] || sessionHelpers.idle);
  setHelper(
    valRelayHelper,
    systemOnline
      ? (firebaseRelay ? tr("dashboardRelayOnHelp") : tr("dashboardRelayOffHelp"))
      : "Physical relay state is unknown while ESP32 is offline."
  );
  setHelper(
    valModeHelper,
    mode === SystemMode.ONLINE ? tr("dashboardModeOnlineHelp") :
      mode === SystemMode.OFFLINE ? tr("dashboardModeOfflineHelp") : tr("dashboardModeTransitionHelp")
  );
  setHelper(
    valLinkHelper,
    systemOnline ? (liveDataFresh ? tr("dashboardLinkFresh") : tr("dashboardLinkWaitingFresh")) :
      firebaseTimestamp > 0 ? tr("dashboardLinkLastKnown") : tr("dashboardLinkWaitingFirst")
  );
  applyActionState();
}
async function updateSessionCount() {
  sessionCount = await getSessionCount();
  if (valSessionCount) valSessionCount.textContent = sessionCount;
}

// ================= OVERLOAD BANNER =================
function setOverloadBanner(active) {
  if (!overloadBanner) return;
  overloadBanner.style.display = active ? "flex" : "none";
  if (active) overloadBanner.textContent =
    tr("dashboardOverloadBanner", { threshold: settings.overloadThreshold });
}

// ================= DEVICE TABS =================
async function renderDeviceTabs() {
  if (!deviceTabsEl) return;
  deviceTabsEl.innerHTML = "";
  const history = await getHistory();
  const names   = [...new Set(history.map(h => h.name))];
  names.forEach(name => {
    const btn = document.createElement("button");
    btn.className = `device-tab${activeDevice?.name === name ? " active" : ""}`;
    btn.textContent = name;
    deviceTabsEl.appendChild(btn);
  });
}

// ================= SAVE SESSION =================
async function saveSession() {
  if (sessionSaved || !activeDevice) return;
  const sessEnergy = getSessionEnergy();
  const sessCost   = getSessionCost();
  await pushHistory({
    name:      activeDevice.name,
    duration:  getDuration(),
    power:     parseFloat(firebasePower.toFixed(1)),
    energy:    parseFloat(sessEnergy.toFixed(3)),
    cost:      formatCost(sessCost),
    costRaw:   sessCost,
    date:      new Date().toLocaleDateString("id-ID"),
    timestamp: Date.now()
  });
  sessionSaved = true;
  await updateSessionCount();
  await updateBarPie();
  if (settings.notifSession)
    showToast(`Sesi "${activeDevice.name}" tersimpan ✓`, "success");
}

// ================= RESET MONITORING =================
async function resetMonitoring() {
  clearInterval(timerInterval);
  timerInterval   = null;
  startTime       = null;
  isRunning       = false;
  sessionSaved    = false;
  sessionState    = SessionState.IDLE;
  energyBaseline  = 0;
  activeDevice    = null;
  lastknownEnergy = 0;
  offlineSessionStartEnergy = null;
  pendingDeviceName = null;
  pendingSessionId = null;
  pendingStartCommandAt = null;
  pendingRelayConfirmed = false;
  pendingUiState = "";
  if (subDuration)    subDuration.textContent    = tr("dashboardDurationValue", { duration: "00:00:00" });
  if (valDeviceName)  valDeviceName.textContent  = "—";
  if (activeDevLabel) activeDevLabel.textContent = tr("noActiveDevice");
  if (btnStop) {
    btnStop.disabled = false;
    btnStop.style.display = "none";
  }
  setDeviceBadge("idle");
  setOverloadBanner(false);
  applyActionState();
  renderDeviceTabs();
}

// ================= START MONITORING =================
let deviceConnectTime   = null;
let deviceConnectEnergy = 0;

async function startMonitoring(name) {
  activeDevice    = { id: pendingSessionId || makeId("sess"), name };
  startTime       = deviceConnectTime   || Date.now();
  energyBaseline  = (deviceConnectEnergy !== undefined && deviceConnectEnergy > 0)
                    ? deviceConnectEnergy
                    : firebaseEnergy;
  lastknownEnergy = energyBaseline;
  isRunning       = true;
  sessionSaved    = false;
  sessionState    = SessionState.MONITORING;
  offlineSessionStartEnergy = null;
  pendingSessionId = null;
  pendingStartCommandAt = null;
  pendingRelayConfirmed = false;
  pendingUiState = "";

  if (valDeviceName)  valDeviceName.textContent  = name;
  if (activeDevLabel) activeDevLabel.textContent = tr("dashboardMonitoringLabel", { name });
  if (btnStop) {
    btnStop.disabled = false;
    btnStop.style.display = "inline-flex";
  }
  setDeviceBadge("connected");
  applyActionState();
  clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 1000);
  renderDeviceTabs();

  const retroMs  = Date.now() - startTime;
  const retroMin = Math.round(retroMs / 60000);
  if (retroMin >= 1)
    showToast(tr("dashboardMonitoringStartedRetro", { name, minutes: retroMin }), "success");
  else
    showToast(tr("dashboardMonitoringStarted", { name }), "success");
}

function getEspStartTimeMs() {
  if (firebaseElapsedSec > 0) return Date.now() - firebaseElapsedSec * 1000;
  if (firebaseSessionStartTs > 0) return firebaseSessionStartTs * 1000;
  return null;
}

async function alignActiveSessionFromEsp() {
  if (!systemOnline || !firebaseRelay || !firebaseSessionActive) return false;
  if (firebaseSessionUid && firebaseSessionUid !== uid) return false;
  if (!isRunning && !activeDevice && !deviceOnline) return false;

  const espStartTime = getEspStartTimeMs();
  const espName = deviceNameFromEsp && deviceNameFromEsp !== "—"
    ? deviceNameFromEsp
    : activeDevice?.name || pendingDeviceName || "Device";
  const espId = firebaseSessionId || activeDevice?.id || pendingSessionId || makeId("sess");

  if (!isRunning || !activeDevice) {
    activeDevice = { id: espId, name: espName };
    startTime = espStartTime || Date.now();
    energyBaseline = 0;
    lastknownEnergy = firebaseEnergy;
    isRunning = true;
    sessionSaved = false;
    pendingDeviceName = null;
    pendingSessionId = null;
    pendingStartCommandAt = null;
    pendingRelayConfirmed = false;
    pendingUiState = "";
    clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
    if (valDeviceName)  valDeviceName.textContent  = activeDevice.name;
    if (activeDevLabel) activeDevLabel.textContent = tr("dashboardMonitoringLabel", { name: activeDevice.name });
    if (btnStop) {
      btnStop.disabled = false;
      btnStop.style.display = "inline-flex";
    }
    applyActionState();
    await renderDeviceTabs();
    return true;
  }

  activeDevice = { id: espId, name: activeDevice.name || espName };
  if (espStartTime && (!startTime || Math.abs(startTime - espStartTime) > 2000)) {
    startTime = espStartTime;
  }
  lastknownEnergy = firebaseEnergy;
  return true;
}

// ================= CHART UPDATE =================
async function updateBarPie() {
  const history  = await getHistory();
  const byDevice = {};
  history.forEach(s => {
    if (!byDevice[s.name]) byDevice[s.name] = { energy: 0 };
    byDevice[s.name].energy += s.energy;
  });
  const names    = Object.keys(byDevice);
  const energies = names.map(n => parseFloat(byDevice[n].energy.toFixed(3)));
  barChart.data.labels = names; barChart.data.datasets[0].data = energies; barChart.update();
  pieChart.data.labels = names; pieChart.data.datasets[0].data = energies; pieChart.update();
}

// ================= MODAL — BERI NAMA DEVICE =================
let namingReminderTimeout = null;

async function openModalAuto() {
  waitingForName = true;
  const history   = await getHistory();
  const usedNames = history.map(h => h.name);
  document.querySelector("#modal-add-device .modal-title")
    .textContent = tr("dashboardAutoModalTitle");
  document.querySelector("#modal-add-device .modal-sub")
    .textContent = tr("dashboardAutoModalSub");
  inputDevName.value = "";
  inputDevName.dataset.usedNames = JSON.stringify(usedNames);
  modalAdd.classList.add("open");
  setTimeout(() => inputDevName.focus(), 100);
  clearTimeout(namingReminderTimeout);
  namingReminderTimeout = setTimeout(() => {
    if (waitingForName) {
      const elapsed = deviceConnectTime
        ? Math.round((Date.now() - deviceConnectTime) / 1000) : "?";
      showToast(tr("dashboardDeviceNameReminder", { seconds: elapsed }), "error");
    }
  }, 30000);
}

async function openModalManual() {
  if (!systemOnline) {
    showToast(tr("dashboardStartOnlineOnly"), "error");
    return;
  }
  if (pendingUiState === "starting" || pendingDeviceName) {
    showToast(tr("dashboardStartAlreadyPending"), "");
    return;
  }
  if (isRunning && !deviceOnline) {
    showToast(tr("dashboardAlreadyMonitoring", { name: activeDevice.name }), "error");
    return;
  }
  waitingForName = false;
  const history   = await getHistory();
  const usedNames = history.map(h => h.name);
  document.querySelector("#modal-add-device .modal-title")
    .textContent = tr("dashboardManualModalTitle");
  document.querySelector("#modal-add-device .modal-sub")
    .textContent = tr("dashboardManualModalSub");
  inputDevName.value = "";
  inputDevName.dataset.usedNames = JSON.stringify(usedNames);
  modalAdd.classList.add("open");
  setTimeout(() => inputDevName.focus(), 100);
}

// ── BUG 1 FIX: Single btnSaveDev listener ────────────────────────
// Original code had TWO addEventListener calls on btnSaveDev:
//   1st: called startMonitoring(name) directly
//   2nd: called sendRelayCommand(true) and set pendingDeviceName
// Both fired on every click, causing a race condition (relay command
// AND immediate startMonitoring ran simultaneously).
// Fix: ONE handler that checks waitingForName to decide the path.
btnSaveDev.addEventListener("click", async () => {
  const usedNames = JSON.parse(inputDevName.dataset.usedNames || "[]");
  let name = inputDevName.value.trim();
  if (!name) name = generateUniqueName("Device", usedNames);
  else name = generateUniqueName(name, usedNames);
  if (name.length > 24) { showToast(tr("dashboardNameTooLong"), "error"); return; }
  closeModal();

  if (waitingForName) {
    // Auto-open path: device already connected, start monitoring directly
    await startMonitoring(name);
  } else {
    // Manual FAB path: turn relay ON first, wait for device detection
    // pendingDeviceName is read in updateMeters when device comes online
    // State migration point: IDLE -> WAITING_LOAD until ESP32 reports load.
    showToast(tr("dashboardTurnRelayOn", { name }), "");
    pendingDeviceName = name;
    pendingSessionId = makeId("sess");
    pendingStartCommandAt = Date.now();
    pendingRelayConfirmed = false;
    pendingUiState = "starting";
    sessionState = SessionState.WAITING_LOAD;
    applyActionState();
    const sent = await sendRelayCommand("START", {
      sessionId: pendingSessionId,
      deviceName: pendingDeviceName,
      tariff: settings.tariff,
      overloadThreshold: settings.overloadThreshold
    });
    if (!sent) {
      pendingDeviceName = null;
      pendingSessionId = null;
      pendingStartCommandAt = null;
      pendingRelayConfirmed = false;
      pendingUiState = "";
      sessionState = SessionState.IDLE;
      applyActionState();
    }
  }
});

function closeModal() {
  modalAdd.classList.remove("open");
  inputDevName.value = "";
  waitingForName = false;
  clearTimeout(namingReminderTimeout);
  applyActionState();
}

fab.addEventListener("click", openModalManual);
btnStartInline?.addEventListener("click", openModalManual);
btnCancelDev.addEventListener("click", closeModal);
modalAdd.addEventListener("click", e => {
  if (e.target === modalAdd && !waitingForName) closeModal();
});
inputDevName.addEventListener("keydown", e => {
  if (e.key === "Enter") btnSaveDev.click();
});

// ================= STOP SESSION =================
if (btnStop) {
  btnStop.addEventListener("click", async () => {
    const stopAvailable = isRunning ||
      !!activeDevice ||
      !!pendingDeviceName ||
      firebaseSessionActive ||
      [SessionState.WAITING_LOAD, SessionState.MONITORING, SessionState.OVERLOAD].includes(sessionState);
    if (!stopAvailable) {
      showToast(tr("dashboardNoSession"), "error"); return;
    }
    console.log("[SESSION] Stop requested");
    const sent = await sendRelayCommand("STOP", {
      sessionId: activeDevice?.id || pendingSessionId || firebaseSessionId || "",
      reason: "USER_STOP"
    });
    if (!sent) return;
    console.log("[SESSION] Stop command sent");
    // State migration point: MONITORING -> FINISHED; ESP32 keeps the source of truth.
    sessionState = SessionState.FINISHED;
    pendingUiState = "stopping";
    if (btnStop) btnStop.disabled = true;
    updateHeroStatuses(systemOnline);
    showToast(tr("dashboardStopToast"), "");
  });
}

// ================= FIREBASE LIVE LISTENERS =================
function timestampSeconds(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return timestamp > 1000000000000 ? Math.floor(timestamp / 1000) : timestamp;
}

function epochMillis(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  if (timestamp > 1000000000000) return timestamp;
  if (timestamp > 1500000000) return timestamp * 1000;
  return 0;
}

function liveTimestampSeconds(finalTimestamp, legacyTimestamp) {
  if (finalTimestamp !== undefined && finalTimestamp !== null) {
    return timestampSeconds(finalTimestamp);
  }
  const legacy = Number(legacyTimestamp || 0);
  if (!Number.isFinite(legacy) || legacy <= 0) return 0;
  return legacy < 1500000000 ? 0 : timestampSeconds(legacy);
}

function relayIsOn(value) {
  return value === true || String(value || "").toUpperCase() === "ON";
}

function updateLiveEnergyCheckpoint() {
  if (firebaseSessionState !== SessionState.WAITING_LOAD &&
      current >= settings.loadCurrentThreshold &&
      firebasePower >= settings.loadPowerThreshold &&
      firebaseEnergy > 0) {
    lastknownEnergy = firebaseEnergy;
  }
}

function showLiveReadError(error) {
  const state = document.getElementById("no-device-state");
  if (!state) return;
  state.style.display = "block";
  state.querySelector(".empty-state-title").textContent = tr("dashboardLiveUnavailable");
  state.querySelector(".empty-state-sub").textContent = readableFirebaseError(error);
}

if (selectedDevice) {
  const liveBase = `devices/${selectedDevice.id}/live`;

  onValue(ref(db, `${liveBase}/system`), snapshot => {
    firebaseSystemReceivedAtMs = Date.now();
    const sys = snapshot.val() || {};
    firebaseWifiStatus = String(sys.wifiStatus || "");
    firebaseActiveSsid = String(sys.activeSsid || "");
    firebaseFirmwareVersion = String(sys.firmwareVersion || "");
    systemInternet = isEspOnlineStatus(sys);
    firebaseHeartbeatMs =
      epochMillis(sys.lastSeen) ||
      epochMillis(sys.lastSeenAt) ||
      epochMillis(sys.timestampUnixMs) ||
      epochMillis(sys.timestamp);
    firebaseTimestamp = firebaseHeartbeatMs > 0
      ? Math.floor(firebaseHeartbeatMs / 1000)
      : liveTimestampSeconds(sys.timestampUnixMs, sys.timestamp);
    firebaseRelay = relayIsOn(sys.relayState ?? sys.relay);
    firebaseOffline = sys.offline === true || String(sys.mode || sys.systemMode || "").toUpperCase() === "OFFLINE";
    firebaseSessionActive = sys.sessionActive ?? firebaseSessionActive;
    firebaseSessionStartTs = sys.sessionStartTs !== undefined
      ? timestampSeconds(sys.sessionStartTs)
      : firebaseSessionStartTs;
    firebaseElapsedSec = Number(sys.elapsedSec ?? firebaseElapsedSec);
    firebaseSessionId = sys.sessionId || firebaseSessionId;
    firebaseSessionUid = sys.uid || firebaseSessionUid;
    firebaseSystemMode = sys.mode || sys.systemMode || null;
    firebaseSessionState = sys.sessionState || firebaseSessionState;
    firebasePendingSync = Number(sys.pendingSync ?? firebasePendingSync);
    deviceNameFromEsp = sys.deviceName || deviceNameFromEsp;
    updateTimer();
    scheduleMetersUpdate();
  }, showLiveReadError);

  onValue(ref(db, `${liveBase}/device`), snapshot => {
    const dev = snapshot.val() || {};
    firebaseLiveDeviceAvailable = snapshot.exists();
    firebaseDeviceConnected = typeof dev.connected === "boolean" ? dev.connected : null;
    voltage          = Number(dev.voltage || 0);
    current          = Number(dev.current || 0);
    firebasePower    = Number(dev.power || 0);
    firebaseApparent = Number(dev.apparent ?? dev.apparentPower ?? 0);
    firebasePF       = Number(dev.pf ?? dev.powerFactor ?? 0);
    firebaseFreq     = Number(dev.frequency || 0);
    firebaseEnergy   = Number(dev.energy ?? dev.energyKwh ?? 0);
    firebaseCost     = Number(dev.cost || 0);
    firebaseTelemetryAtMs =
      epochMillis(dev.timestamp) ||
      epochMillis(dev.timestampUnixMs) ||
      epochMillis(dev.lastSeen) ||
      firebaseHeartbeatMs;
    firebaseElapsedSec = Number(dev.duration ?? firebaseElapsedSec ?? 0);
    firebaseOverload = dev.overload === true;
    updateTimer();
    updateLiveEnergyCheckpoint();
    scheduleMetersUpdate();
  }, showLiveReadError);

  // Transitional firmware still publishes active-session metadata here.
  onValue(ref(db, `${liveBase}/session`), snapshot => {
    const session = snapshot.val() || {};
    firebaseSessionActive = session.active ?? firebaseSessionActive;
    firebaseSessionStartTs = timestampSeconds(session.startTs ?? session.sessionStartTs ?? firebaseSessionStartTs);
    firebaseElapsedSec = Number(session.elapsedSec ?? session.duration ?? firebaseElapsedSec);
    firebaseSessionId = session.sessionId || session.id || firebaseSessionId;
    firebaseSessionUid = session.uid || firebaseSessionUid;
    firebaseSessionState = session.sessionState || firebaseSessionState;
    deviceNameFromEsp = session.deviceName || session.name || deviceNameFromEsp;
    updateTimer();
    scheduleMetersUpdate();
  }, error => {
    if (error?.code !== "PERMISSION_DENIED" && error?.code !== "database/permission-denied") {
      console.warn("[Dashboard] Transitional live session unavailable:", error?.message || error);
    }
  });
}

// ================================================================
// MAIN LOOP
// ── BUG 1 FIX: declared as async so await calls inside are valid ──
// Original was a plain function; any await inside silently returned
// a Promise that was never caught, breaking the entire update cycle.
// ================================================================
async function updateMeters() {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const diff = Math.abs(now - firebaseTimestamp);

  // ── Hitung systemOnline ──────────────────────────────────
  const heartbeatAgeMs = firebaseHeartbeatMs > 0 ? nowMs - firebaseHeartbeatMs : Number.POSITIVE_INFINITY;
  const telemetryAgeMs = firebaseTelemetryAtMs > 0 ? nowMs - firebaseTelemetryAtMs : Number.POSITIVE_INFINITY;
  const espTimestampFresh = heartbeatAgeMs >= 0 && heartbeatAgeMs <= DEVICE_OFFLINE_TIMEOUT_MS;
  const telemetryFresh = telemetryAgeMs >= 0 && telemetryAgeMs <= DEVICE_OFFLINE_TIMEOUT_MS;
  liveDataFresh = espTimestampFresh && telemetryFresh;
  systemOnline = espTimestampFresh;
  deviceOnline = systemOnline && firebaseDeviceConnected !== false;
  loadDetected = deviceOnline &&
    liveDataFresh &&
    firebaseSessionState !== SessionState.WAITING_LOAD &&
    current >= settings.loadCurrentThreshold &&
    firebasePower >= settings.loadPowerThreshold;

  const webOverload = (isRunning || firebaseSessionActive || !!pendingDeviceName) &&
    loadDetected && firebasePower >= settings.overloadThreshold;
  systemMode = deriveSystemMode();
  sessionState = deriveSessionState(webOverload);

  // The dashboard hero/status cards are the only offline indicator now.
  hideOfflineBanner();
  if (systemOnline) {
    offlineDetectedAt = null;
    offlineBannerShown = false;
  } else if (!offlineDetectedAt) {
    offlineDetectedAt = Date.now();
    reconnectToastShown = false;
  }

  // ── Offline session banner ──────────────────────────────
  // Tampilkan banner saat ESP32 dalam mode offline dengan relay ON
  const explicitOfflineNoInternet = firebaseOffline && !systemInternet;
  setOfflineSessionBanner(explicitOfflineNoInternet && firebaseRelay, deviceNameFromEsp);
  
  // ── Mode status banner ────────────────────────────────
  // Tampilkan badge mode offline dengan jumlah sesi pending sync
  updateModeStatusBanner(explicitOfflineNoInternet, firebaseRelay, firebasePendingSync);

  // ── Update status bar ──────────────────────────────────
  setSystemStatus(systemOnline);
  updateHeroStatuses(systemOnline);
  if (systemOnline) {
    if (subWebStatus) subWebStatus.textContent = liveDataFresh
      ? tr("dashboardWebOnline")
      : tr("dashboardWebOnlineWaiting");
  } else if (firebaseTimestamp > 0) {
    if (subWebStatus) subWebStatus.textContent = diff < 60
      ? tr("dashboardWebOfflineSeconds", { seconds: diff }) : tr("dashboardWebOfflineMinutes", { minutes: Math.round(diff / 60) });
  } else {
    if (subWebStatus) subWebStatus.textContent = tr("dashboardWebWaitingEsp");
  }
  if (subTariff) subTariff.textContent =
    tr("dashboardTariff", { symbol: symbol(), tariff: settings.tariff.toLocaleString("id-ID") });

  // ── Relay banner ────────────────────────────────────────
  const showRelayBanner = systemOnline && !firebaseRelay && !isRunning;
  setRelayBanner(showRelayBanner);

  // ── Relay baru ON (ESP32 konfirmasi) ───────────────────
  if (!prevRelayState && firebaseRelay && systemOnline) {
    setRelayBanner(false);
  }
  if (pendingDeviceName && firebaseRelay) pendingRelayConfirmed = true;
  prevRelayState = firebaseRelay;

  const pendingStartExpired = pendingStartCommandAt && Date.now() - pendingStartCommandAt > 20000;
  if (systemOnline && pendingDeviceName && !firebaseRelay && !firebaseSessionActive &&
      (pendingRelayConfirmed || pendingStartExpired)) {
    showToast(tr("dashboardLoadNotDetected", { name: pendingDeviceName }), "error");
    pendingDeviceName = null;
    pendingSessionId = null;
    pendingStartCommandAt = null;
    pendingRelayConfirmed = false;
    pendingUiState = "";
    sessionState = SessionState.IDLE;
    setDeviceBadge("noLoad");
    updateHeroStatuses(systemOnline);
  }

  if (systemOnline && firebaseRelay && firebaseSessionActive) {
    const resumed = await alignActiveSessionFromEsp();
    if (resumed && prevSystemOnline === false && reconnectToastShown) {
      console.log(`[Transfer] ESP32 session aligned: E=${firebaseEnergy.toFixed(4)} kWh`);
    }
  }

  if (systemOnline && isRunning && activeDevice && !firebaseRelay && !firebaseSessionActive) {
    if (settings.notifSession)
      showToast(
        pendingUiState === "stopping"
          ? tr("dashboardSessionSavedSynced", { name: activeDevice.name })
          : tr("dashboardSessionEndedEsp", { name: activeDevice.name }),
        "success"
      );
    await resetMonitoring();
    updateDisplay();
    await updateSessionCount();
    await updateBarPie();
    prevSystemOnline = systemOnline;
    prevDeviceConnected = false;
    return;
  }

  // ── Device baru terdeteksi ─────────────────────────────
  const sessionDeviceOnline = loadDetected && (firebaseSessionActive || isRunning || !!pendingDeviceName);
  if (!prevDeviceConnected && sessionDeviceOnline) {
    // State migration point: WAITING_LOAD -> MONITORING.
    deviceConnectTime   = Date.now();
    deviceConnectEnergy = firebaseEnergy;
    lastknownEnergy     = firebaseEnergy;
    if (!isRunning) {
      if (pendingDeviceName) {
        // Manual FAB path: relay was turned on, name was pre-set
        const name = pendingDeviceName;
        pendingDeviceName = null;
        pendingUiState = "";
        await startMonitoring(name);
      } else if (!waitingForName) {
        // Auto-detect path: device plugged in without FAB
        if (settings.notifDevice)
          showToast(tr("dashboardDeviceDetected"), "success");
        openModalAuto();
      }
    }
  }

  // ── Transfer data offline → online ────────────────────
  // Saat esp32 reconnect dari offline mode, data akan disinkron
  if (systemOnline && prevSystemOnline === false) {
    await updateSessionCount();
    await updateBarPie();
    await renderDeviceTabs();
    if (isRunning && activeDevice) {
    if (firebaseEnergy > 0) {
      lastknownEnergy = firebaseEnergy;
      console.log(`[Transfer] Offline→Online: E=${firebaseEnergy.toFixed(4)} kWh`);
      showToast(
        tr("dashboardEspOnlineSynced", { energy: firebaseEnergy.toFixed(4) }),
        "success"
      );
    } else {
      showToast(tr("dashboardEspOnlineMode", { mode: firebaseOffline ? "OFFLINE" : "ONLINE" }), "success");
    }
    }
  }

  prevSystemOnline = systemOnline;

  // ── Device dicabut ─────────────────────────────────────
  if (prevDeviceConnected && !deviceOnline && systemOnline) {
    deviceConnectTime   = null;
    deviceConnectEnergy = 0;
    if (waitingForName) {
      closeModal();
      showToast(tr("dashboardDeviceUnpluggedBeforeName"), "error");
    } else if (isRunning && activeDevice) {
      if (settings.notifDisconnect)
        showToast(tr("dashboardDeviceUnpluggedWaitHistory", { name: activeDevice.name }), "");
      await resetMonitoring();
    }
  }
  prevDeviceConnected = sessionDeviceOnline;

  // ── Overload ───────────────────────────────────────────
  if (webOverload && !prevOverload) {
    // State migration point: MONITORING -> OVERLOAD.
    if (settings.notifOverload)
      showToast(tr("dashboardOverloadToast", { power: firebasePower.toFixed(0), threshold: settings.overloadThreshold }), "error");
    setDeviceBadge("overload");
    setOverloadBanner(true);
  }
  if (!webOverload && prevOverload) {
    if (isRunning && deviceOnline) setDeviceBadge("connected");
    setOverloadBanner(false);
  }
  prevOverload = webOverload;

  // ── Update UI ──────────────────────────────────────────
  const passiveLiveAvailable = systemOnline && firebaseLiveDeviceAvailable;
  if (!systemOnline) { setDeviceBadge("offline"); return; }
  if (!activeDevice && !passiveLiveAvailable) { clearDisplay(); setDeviceBadge("idle"); return; }
  if (activeDevice && !deviceOnline) { setDeviceBadge("offline"); clearDisplay(); return; }
  if (!activeDevice) {
    const passiveName = selectedDevice?.nickname || selectedDevice?.name ||
      (deviceNameFromEsp !== "—" ? deviceNameFromEsp : "Paired Device");
    if (valDeviceName) valDeviceName.textContent = passiveName;
    if (activeDevLabel) activeDevLabel.textContent = tr("dashboardLiveTelemetryLabel", { name: passiveName });
  }
  if (!webOverload) {
    const visualState = dashboardVisualState();
    setDeviceBadge(["starting", "stopping", "finished"].includes(visualState)
      ? visualState
      : activeDevice ? "connected" : "live");
  }
  updateDisplay();

  // ── Update chart power over time ──────────────────────
  const t = new Date().toLocaleTimeString("id-ID", {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  lineChart.data.labels.push(t);
  lineChart.data.datasets[0].data.push(firebasePower);
  if (lineChart.data.labels.length > 20) {
    lineChart.data.labels.shift();
    lineChart.data.datasets[0].data.shift();
  }
  lineChart.update();
}

function startMetersInterval() {
  if (metersInterval) clearInterval(metersInterval);
  const refreshIntervalMs = clampRefreshInterval(settings.refreshInterval);
  metersInterval = setInterval(scheduleMetersUpdate, refreshIntervalMs);
}

// ================================================================
// INIT
// ================================================================
updateChartColors(lineChart, barChart, pieChart);
pieChart.options.plugins.legend.labels.color = chartTickColor();
pieChart.update("none");
await renderDeviceTabs();
await updateSessionCount();
await updateBarPie();
startMetersInterval();
scheduleMetersUpdate();
