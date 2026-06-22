import {
  requireAuth, renderShell, fillUserInfo, showToast,
  startStatusWatcher, loadAndApplySettings, tr
} from "./auth-guard.js";
import { db, ref, get } from "./firebase-config.js";
import { loadDeviceHistory } from "./local-history.js";

const user = await requireAuth();
renderShell("history", "SESSION DETAIL");
fillUserInfo(user);
startStatusWatcher();
const uid = user.uid;
const settings = await loadAndApplySettings(uid);

const selectedKey = sessionStorage.getItem(`sem_selected_key_${uid}`);
const cachedSession = (() => {
  try { return JSON.parse(sessionStorage.getItem(`sem_selected_session_${uid}`)); }
  catch { return null; }
})();

const detailReport = document.getElementById("detail-report");
const detailEmpty = document.getElementById("detail-empty");
const btnExport = document.getElementById("btn-export");
let selectedSession = null;

function firstValue(session, keys) {
  for (const key of keys) {
    const value = session?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function numeric(session, keys) {
  return toNumber(firstValue(session, keys));
}

function costOf(session) {
  const raw = firstValue(session, ["costRaw", "sessionCost", "totalCost", "cost"]);
  if (typeof raw === "string") {
    const compact = raw.replace(/[^0-9.,-]/g, "");
    if (compact.includes(".") && compact.includes(",")) {
      const decimalSeparator = compact.lastIndexOf(".") > compact.lastIndexOf(",") ? "." : ",";
      const thousandsSeparator = decimalSeparator === "." ? "," : ".";
      return toNumber(compact.replaceAll(thousandsSeparator, "").replace(decimalSeparator, "."));
    }
    if (/rp/i.test(raw) && /^\d{1,3}(\.\d{3})+$/.test(compact)) return toNumber(compact.replaceAll(".", ""));
  }
  return toNumber(raw);
}

function durationSeconds(session) {
  const value = firstValue(session, ["durationSec", "elapsedSec", "seconds", "duration"]);
  if (typeof value === "string" && value.includes(":")) {
    const parts = value.split(":").map(Number);
    if (parts.every(Number.isFinite)) return parts.reduce((total, part) => total * 60 + part, 0);
  }
  return Math.max(0, toNumber(value));
}

function timestampMs(value) {
  if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value.trim())) return 0;
  const number = Number(value || 0);
  return number > 0 ? (number > 1000000000000 ? number : number * 1000) : 0;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));
  const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatDate(value) {
  const timestamp = timestampMs(value);
  if (timestamp) return new Date(timestamp).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
  return value || "—";
}

function formatNumber(value, decimals = 1, fallback = "—") {
  return value > 0 ? value.toFixed(decimals) : fallback;
}

function formatCost(value, tariffAvailable = true) {
  if (!tariffAvailable) return "—";
  return settings.currency === "USD"
    ? `$ ${value.toFixed(2)}`
    : `Rp ${Math.round(value).toLocaleString("id-ID")}`;
}

function modeInfo(session) {
  const explicit = String(firstValue(session, ["modePath", "mode"]) || "").toLowerCase();
  const start = String(firstValue(session, ["modeStart", "startMode"]) || "").toLowerCase();
  const end = String(firstValue(session, ["modeEnd", "endMode"]) || "").toLowerCase();
  const combined = `${explicit} ${start} ${end}`.replace(/[_>→-]+/g, " ");
  if ((start.includes("online") && end.includes("offline")) || /online(?:\s+to)?\s+offline/.test(combined)) return { key: "online-offline", label: tr("historyOnlineToOffline") };
  if ((start.includes("offline") && end.includes("online")) || /offline(?:\s+to)?\s+online/.test(combined)) return { key: "offline-online", label: tr("historyOfflineToOnline") };
  if (combined.includes("offline")) return { key: "offline", label: "Offline" };
  if (combined.includes("online")) return { key: "online", label: "Online" };
  return { key: "", label: tr("detailModeUnknown") };
}

function reasonInfo(session) {
  const raw = String(firstValue(session, ["endReason", "status", "tag", "stopReason"]) || "");
  const text = raw.toLowerCase();
  if (/overload/.test(text)) return { key: "overload", label: "Overload" };
  if (/device.*removed|removed|unplug|load.*removed/.test(text)) return { key: "device-removed", label: tr("historyDeviceRemoved") };
  if (/power.*loss|lost.*power|blackout/.test(text)) return { key: "power-loss", label: tr("historyPowerLoss") };
  if (/offline.*monitor/.test(text)) return { key: "offline-monitoring", label: tr("historyOfflineMonitoring") };
  if (/stop.*app|app.*stop|manual|user.*stop/.test(text)) return { key: "stop-app", label: tr("historyStopByApp") };
  return { key: "", label: raw || tr("historyCompleted") };
}

function syncInfo(session) {
  const raw = String(firstValue(session, ["syncStatus"]) || "").toLowerCase();
  if (session.pendingSync === true || raw.includes("pending")) return { key: "pending", label: tr("detailPendingSync") };
  if (session.synced === true || raw.includes("sync")) return { key: "synced", label: tr("historySynced") };
  return { key: "", label: tr("historySyncUnknown") };
}

function overloadInfo(session) {
  const value = firstValue(session, ["overload", "wasOverload", "overloadStatus"]);
  return value === true || String(value).toLowerCase() === "true" || reasonInfo(session).key === "overload";
}

function humanize(value, fallback = "—") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value)
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, character => character.toUpperCase());
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]);
}

function metricCard(label, value, unit = "", accent = "") {
  return `<div class="detail-report-card ${accent}">
    <div class="detail-report-label">${escapeHtml(label)}</div>
    <div class="detail-report-value">${escapeHtml(value)}${unit ? `<span>${escapeHtml(unit)}</span>` : ""}</div>
  </div>`;
}

function metadataRow(label, value) {
  return `<div class="detail-metadata-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderSession(session) {
  selectedSession = session;
  const name = firstValue(session, ["name", "deviceName"]) || "Device";
  const dateTime = formatDate(firstValue(session, ["endTime", "timestamp", "end_ts", "dateTime", "date"]));
  const duration = durationSeconds(session);
  const energy = numeric(session, ["energyKwh", "energy", "sessionEnergy", "kwh"]);
  const cost = costOf(session);
  const avgPower = numeric(session, ["powerAvg", "avgPower", "averagePower", "power"]);
  const maxPower = numeric(session, ["powerMax", "maxPower", "peakPower"]);
  const avgVoltage = numeric(session, ["voltageAvg", "avgVoltage", "voltage"]);
  const minVoltage = numeric(session, ["voltageMin", "minVoltage"]);
  const maxVoltage = numeric(session, ["voltageMax", "maxVoltage"]);
  const avgCurrent = numeric(session, ["currentAvg", "avgCurrent", "current"]);
  const maxCurrent = numeric(session, ["currentMax", "maxCurrent"]);
  const pf = numeric(session, ["pfAvg", "avgPowerFactor", "powerFactorAvg", "pf", "powerFactor"]);
  const frequency = numeric(session, ["frequencyAvg", "avgFrequency", "frequency", "freq"]);
  const apparentStored = numeric(session, ["apparentAvg", "avgApparentPower", "apparentPowerAvg", "apparent", "apparentPower"]);
  const apparent = apparentStored || (avgVoltage > 0 && avgCurrent > 0 ? avgVoltage * avgCurrent : 0);
  const threshold = numeric(session, ["threshold", "overloadThreshold"]);
  const mode = modeInfo(session);
  const reason = reasonInfo(session);
  const sync = syncInfo(session);
  const tariff = numeric(session, ["tariff", "electricityCostPerKwh"]) || Number(settings.tariff || 0);
  const tariffAvailable = tariff > 0;
  const sessionId = firstValue(session, ["sessionId", "id", "_key"]) || "-";
  const deviceId = firstValue(session, ["deviceId"]) || "-";
  const ownerUid = firstValue(session, ["uid"]) || "-";
  const pendingSync = session.pendingSync === true ? tr("yes") : session.pendingSync === false ? tr("no") : tr("commonUnknown");
  const source = humanize(firstValue(session, ["createdFrom", "_source", "source"]), tr("commonUnknown"));
  const syncedAt = formatDate(firstValue(session, ["syncedAt", "syncedTimestamp"]));
  const endReasonCode = firstValue(session, ["endReason", "status", "tag", "stopReason"]) || "COMPLETED";

  document.getElementById("detail-device-name").textContent = name;
  document.getElementById("detail-date").textContent = dateTime;
  document.getElementById("detail-header-name").textContent = name;
  document.getElementById("detail-header-date").textContent = dateTime;
  document.getElementById("detail-header-tags").innerHTML = `
    <span class="detail-tag ${reason.key === "overload" ? "red" : "amber"}">${escapeHtml(reason.label)}</span>
    <span class="detail-tag">${escapeHtml(mode.label)}</span>
    <span class="detail-tag ${sync.key === "synced" ? "green" : "amber"}">${escapeHtml(sync.label)}</span>`;

  document.getElementById("detail-summary-grid").innerHTML = [
    metricCard(tr("dashboardDuration"), formatDuration(duration), "", "cyan"),
    metricCard(tr("detailEnergyTotal"), energy.toFixed(3), "kWh", "green"),
    metricCard(tr("detailCostTotal"), formatCost(cost), "", "amber"),
    metricCard(tr("historyAveragePower"), formatNumber(avgPower, 1), "W"),
    metricCard(tr("detailMaxPower"), formatNumber(maxPower, 1), "W", "red"),
  ].join("");

  const voltageRange = minVoltage || maxVoltage
    ? `${formatNumber(minVoltage, 1)} / ${formatNumber(maxVoltage, 1)} V`
    : "—";
  document.getElementById("detail-reading-grid").innerHTML = [
    metricCard(tr("detailVoltageAverage"), formatNumber(avgVoltage, 1), "V", "cyan"),
    metricCard(tr("detailVoltageRange"), voltageRange),
    metricCard(tr("detailCurrentAverage"), formatNumber(avgCurrent, 2), "A", "green"),
    metricCard(tr("detailCurrentMax"), formatNumber(maxCurrent, 2), "A"),
    metricCard(tr("detailPowerAverage"), formatNumber(avgPower, 1), "W", "amber"),
    metricCard(tr("detailPowerMax"), formatNumber(maxPower, 1), "W", "red"),
    metricCard(tr("detailPowerFactorAverage"), formatNumber(pf, 2)),
    metricCard(tr("detailFrequencyAverage"), formatNumber(frequency, 1), "Hz"),
    metricCard(tr("detailApparentPowerAverage"), formatNumber(apparent, 1), "VA"),
    metricCard(tr("detailOverloadThreshold"), formatNumber(threshold, 0), "W"),
  ].join("");

  const startTime = formatDate(firstValue(session, ["startTime", "start_ts", "sessionStartTs"]));
  const endTime = formatDate(firstValue(session, ["endTime", "end_ts", "timestamp"]));
  const startMode = humanize(firstValue(session, ["modeStart", "startMode"]), mode.label);
  const endMode = humanize(firstValue(session, ["modeEnd", "endMode"]), mode.label);
  const relayFinal = firstValue(session, ["relayFinal", "finalRelayState", "relay"]);
  const relayLabel = relayFinal === true || String(relayFinal).toLowerCase() === "on"
    ? "ON"
    : relayFinal === false || String(relayFinal).toLowerCase() === "off"
      ? "OFF"
      : "—";
  document.getElementById("detail-metadata").innerHTML = [
    metadataRow(tr("detailSessionId"), sessionId),
    metadataRow(tr("deviceId"), deviceId),
    metadataRow(tr("detailOwnerUid"), ownerUid),
    metadataRow(tr("detailStartTime"), startTime),
    metadataRow(tr("detailEndTime"), endTime),
    metadataRow(tr("detailStartMode"), startMode),
    metadataRow(tr("detailEndMode"), endMode),
    metadataRow(tr("detailEndReason"), `${reason.label} / ${endReasonCode}`),
    metadataRow(tr("detailOverloadStatus"), overloadInfo(session) ? tr("detailOverloadDetected") : tr("detailNoOverload")),
    metadataRow(tr("detailRelayFinal"), relayLabel),
    metadataRow(tr("detailSyncStatus"), sync.label),
    metadataRow(tr("detailPendingSync"), pendingSync),
    metadataRow(tr("detailCreatedFrom"), source),
    metadataRow(tr("detailSyncedAt"), syncedAt),
  ].join("");

  const hours = [1, 5, 8, 24];
  document.getElementById("detail-projection-intro").textContent = avgPower > 0
    ? tr("detailProjectionIntro", { name, power: avgPower.toFixed(1) })
    : tr("detailProjectionUnavailable");
  document.getElementById("detail-projection-grid").innerHTML = hours.map(hour => {
    const projectedEnergy = avgPower > 0 ? avgPower * hour / 1000 : 0;
    const projectedCost = projectedEnergy * tariff;
    return `<div class="detail-projection-card">
      <div class="detail-projection-hours">${hour === 1 ? tr("detailHour", { count: hour }) : tr("detailHours", { count: hour })}</div>
      <div class="detail-projection-energy">${avgPower > 0 ? projectedEnergy.toFixed(3) : "—"} kWh</div>
      <div class="detail-projection-cost">${avgPower > 0 ? formatCost(projectedCost, tariffAvailable) : "—"}</div>
    </div>`;
  }).join("");

  detailReport.style.display = "block";
}

function showEmpty() {
  detailEmpty.style.display = "flex";
  detailReport.style.display = "none";
  btnExport.style.display = "none";
}

async function loadSelectedSession() {
  if (!selectedKey) return null;
  if (cachedSession?._key === selectedKey) return cachedSession;

  const allHistory = await loadDeviceHistory(uid);
  const finalFirst = allHistory.find(item => item._key === selectedKey);
  if (finalFirst) return finalFirst;

  const snapshot = await get(ref(db, `users/${uid}/history/${selectedKey}`));
  return snapshot.exists() ? { ...snapshot.val(), _key: selectedKey } : null;
}

try {
  const session = await loadSelectedSession();
  if (session) renderSession(session);
  else showEmpty();
} catch (error) {
  console.warn("[History Detail] Unable to load selected session:", error);
  showEmpty();
}

btnExport.addEventListener("click", () => {
  if (!selectedSession) return;
  const fields = [
    ["Name", firstValue(selectedSession, ["name", "deviceName"]) || "Device"],
    ["Duration", formatDuration(durationSeconds(selectedSession))],
    ["Energy (kWh)", numeric(selectedSession, ["energyKwh", "energy", "sessionEnergy", "kwh"])],
    ["Cost", costOf(selectedSession)],
    ["Average Power (W)", numeric(selectedSession, ["powerAvg", "avgPower", "averagePower", "power"])],
    ["Max Power (W)", numeric(selectedSession, ["powerMax", "maxPower", "peakPower"])],
    ["Mode", modeInfo(selectedSession).label],
    ["End Reason", reasonInfo(selectedSession).label],
    ["Sync Status", syncInfo(selectedSession).label],
  ];
  const csv = `Field,Value\n${fields.map(([key, value]) => `"${key}","${String(value).replaceAll('"', '""')}"`).join("\n")}`;
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${firstValue(selectedSession, ["name", "deviceName"]) || "session"}_detail.csv`;
  link.click();
  URL.revokeObjectURL(url);
  showToast(tr("detailExported"), "success");
});
