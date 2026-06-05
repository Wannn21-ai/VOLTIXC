import {
  requireAuth, renderShell, fillUserInfo, showToast,
  startStatusWatcher, loadAndApplySettings
} from "./auth-guard.js";
import { db, ref, set, onValue } from "./firebase-config.js";
import { loadDeviceHistory } from "./local-history.js";

const user = await requireAuth();
renderShell("history", "HISTORY");
fillUserInfo(user);
startStatusWatcher();
const uid = user.uid;

await loadAndApplySettings(uid);

const historyRef = ref(db, `users/${uid}/history`);
const listEl = document.getElementById("history-list");
const countEl = document.getElementById("history-count");
const searchInput = document.getElementById("search-input");
const deviceFilter = document.getElementById("filter-device");
const modeFilter = document.getElementById("filter-mode");
const statusFilter = document.getElementById("filter-status");
const dateFilter = document.getElementById("filter-date");
const sortSelect = document.getElementById("sort-history");
const resetFiltersBtn = document.getElementById("btn-reset-filters");
const btnExportAll = document.getElementById("btn-export-all");
const btnDeleteAll = document.getElementById("btn-delete-all");

let historyData = [];
let refreshToken = 0;

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

function energyOf(session) {
  return toNumber(firstValue(session, ["energy", "energyKwh", "sessionEnergy", "kwh"]));
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
    if (/rp/i.test(raw) && /^\d{1,3}(\.\d{3})+$/.test(compact)) {
      return toNumber(compact.replaceAll(".", ""));
    }
  }
  return toNumber(raw);
}

function powerOf(session) {
  return toNumber(firstValue(session, ["avgPower", "powerAvg", "power", "maxPower", "powerMax"]));
}

function durationSeconds(session) {
  const value = firstValue(session, ["durationSec", "elapsedSec", "duration"]);
  if (typeof value === "string" && value.includes(":")) {
    const parts = value.split(":").map(Number);
    if (parts.every(Number.isFinite)) {
      return parts.reduce((total, part) => total * 60 + part, 0);
    }
  }
  return Math.max(0, toNumber(value));
}

function timestampOf(session) {
  const raw = toNumber(firstValue(session, ["timestamp", "endTime", "end_ts", "startTime", "start_ts"]));
  if (raw > 0) return raw > 1000000000000 ? raw : raw * 1000;
  const parsed = Date.parse(firstValue(session, ["dateTime", "date"]) || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function modeOf(session) {
  const explicit = String(firstValue(session, ["modePath", "mode"]) || "").toLowerCase();
  const start = String(firstValue(session, ["modeStart", "startMode"]) || "").toLowerCase();
  const end = String(firstValue(session, ["modeEnd", "endMode"]) || "").toLowerCase();
  const combined = `${explicit} ${start} ${end}`.replace(/[_>→-]+/g, " ");

  if ((start.includes("online") && end.includes("offline")) || /online(?:\s+to)?\s+offline/.test(combined)) return "online-offline";
  if ((start.includes("offline") && end.includes("online")) || /offline(?:\s+to)?\s+online/.test(combined)) return "offline-online";
  if (combined.includes("offline")) return "offline";
  if (combined.includes("online")) return "online";
  return "";
}

function statusOf(session) {
  const text = String(firstValue(session, ["endReason", "status", "tag"]) || "").toLowerCase();
  if (/overload/.test(text)) return "overload";
  if (/device.*removed|removed|unplug|load.*removed/.test(text)) return "device-removed";
  if (/power.*loss|lost.*power|blackout/.test(text)) return "power-loss";
  if (/offline.*monitor|offline/.test(text)) return "offline-monitoring";
  if (/stop.*app|app.*stop|manual|user.*stop/.test(text)) return "stop-app";
  if (!text && modeOf(session) === "offline") return "offline-monitoring";
  return text ? "other" : "";
}

function labelFor(value) {
  const labels = {
    "online": "Online",
    "offline": "Offline",
    "online-offline": "Online → Offline",
    "offline-online": "Offline → Online",
    "stop-app": "Stop by App",
    "device-removed": "Device Removed",
    "overload": "Overload",
    "power-loss": "Power Loss",
    "offline-monitoring": "Offline Monitoring",
  };
  return labels[value] || "Completed";
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));
  const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatCost(value) {
  return `Rp ${Math.round(value || 0).toLocaleString("id-ID")}`;
}

function formatDateTime(session) {
  const timestamp = timestampOf(session);
  if (timestamp) {
    return new Date(timestamp).toLocaleString("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }
  return firstValue(session, ["dateTime", "date"]) || "—";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]);
}

function renderSummary() {
  const totalDuration = historyData.reduce((sum, session) => sum + durationSeconds(session), 0);
  const totalEnergy = historyData.reduce((sum, session) => sum + energyOf(session), 0);
  const totalCost = historyData.reduce((sum, session) => sum + costOf(session), 0);
  const powers = historyData.map(powerOf).filter(value => value > 0);
  const averagePower = powers.length
    ? powers.reduce((sum, value) => sum + value, 0) / powers.length
    : 0;

  document.getElementById("summary-sessions").textContent = historyData.length;
  document.getElementById("summary-duration").textContent = formatDuration(totalDuration);
  document.getElementById("summary-energy").textContent = totalEnergy.toFixed(3);
  document.getElementById("summary-cost").textContent = formatCost(totalCost);
  document.getElementById("summary-power").textContent = averagePower.toFixed(0);
}

function buildDeviceFilter() {
  const selected = deviceFilter.value;
  const names = [...new Set(historyData.map(session => session.name || "Device"))]
    .sort((a, b) => a.localeCompare(b));

  deviceFilter.innerHTML = '<option value="all">All Devices</option>';
  names.forEach(name => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    deviceFilter.appendChild(option);
  });
  deviceFilter.value = names.includes(selected) ? selected : "all";
}

function matchesDateRange(session) {
  if (dateFilter.value === "all") return true;
  const timestamp = timestampOf(session);
  if (!timestamp) return false;

  const now = new Date();
  if (dateFilter.value === "today") {
    const date = new Date(timestamp);
    return date.toDateString() === now.toDateString();
  }

  const days = Number(dateFilter.value);
  return timestamp >= now.getTime() - days * 86400000;
}

function filteredSessions() {
  const search = searchInput.value.toLowerCase().trim();
  const data = historyData.filter(session => {
    const name = String(session.name || "Device");
    if (search && !name.toLowerCase().includes(search)) return false;
    if (deviceFilter.value !== "all" && name !== deviceFilter.value) return false;
    if (modeFilter.value !== "all" && modeOf(session) !== modeFilter.value) return false;
    if (statusFilter.value !== "all" && statusOf(session) !== statusFilter.value) return false;
    return matchesDateRange(session);
  });

  const sorters = {
    newest: (a, b) => timestampOf(b) - timestampOf(a),
    oldest: (a, b) => timestampOf(a) - timestampOf(b),
    energy: (a, b) => energyOf(b) - energyOf(a),
    cost: (a, b) => costOf(b) - costOf(a),
    duration: (a, b) => durationSeconds(b) - durationSeconds(a),
  };
  return data.sort(sorters[sortSelect.value] || sorters.newest);
}

function render() {
  renderSummary();
  const data = filteredSessions();
  countEl.textContent = `${data.length} of ${historyData.length} session${historyData.length !== 1 ? "s" : ""}`;

  if (data.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">◷</div>
        <div class="empty-state-title">No sessions found</div>
        <div class="empty-state-sub">Adjust the filters or start monitoring a device from the Dashboard</div>
      </div>`;
    return;
  }

  listEl.innerHTML = data.map(session => {
    const mode = modeOf(session);
    const status = statusOf(session);
    const statusClass = status === "overload" || status === "power-loss" ? "red" : "amber";
    return `
      <article class="history-card" data-key="${escapeHtml(session._key)}">
        <div>
          <div class="history-card-name">${escapeHtml(session.name || "Device")}</div>
          <div class="history-card-meta">
            <div class="history-meta-item">Duration<span>${formatDuration(durationSeconds(session))}</span></div>
            <div class="history-meta-item">Power<span>${powerOf(session).toFixed(0)} W</span></div>
            <div class="history-meta-item">Energy<span>${energyOf(session).toFixed(3)} kWh</span></div>
            <div class="history-meta-item">Cost<span>${escapeHtml(formatCost(costOf(session)))}</span></div>
          </div>
          <div class="history-tags">
            ${mode ? `<span class="history-tag">${escapeHtml(labelFor(mode))}</span>` : ""}
            <span class="history-tag ${statusClass}">${escapeHtml(labelFor(status))}</span>
            ${session.pendingSync === true ? '<span class="history-tag amber">Pending Sync</span>' : ""}
          </div>
        </div>
        <div class="history-card-actions">
          <div>
            <div class="history-date">${escapeHtml(formatDateTime(session))}</div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
              <button class="btn btn-icon btn-export" data-key="${escapeHtml(session._key)}" title="Export CSV">↓</button>
              <button class="btn btn-danger btn-delete" data-key="${escapeHtml(session._key)}" title="Delete">✕</button>
            </div>
          </div>
        </div>
      </article>`;
  }).join("");
}

async function refreshHistory() {
  const token = ++refreshToken;
  historyData = await loadDeviceHistory(uid);
  if (token !== refreshToken) return;
  buildDeviceFilter();
  render();
}

onValue(historyRef, refreshHistory);
await refreshHistory();

[searchInput, deviceFilter, modeFilter, statusFilter, dateFilter, sortSelect].forEach(control => {
  control.addEventListener(control === searchInput ? "input" : "change", render);
});

resetFiltersBtn.addEventListener("click", () => {
  searchInput.value = "";
  deviceFilter.value = "all";
  modeFilter.value = "all";
  statusFilter.value = "all";
  dateFilter.value = "all";
  sortSelect.value = "newest";
  render();
});

listEl.addEventListener("click", async event => {
  if (event.target.classList.contains("btn-export")) {
    event.stopPropagation();
    const session = historyData.find(item => item._key === event.target.dataset.key);
    if (session) exportSingleCSV(session);
    return;
  }

  if (event.target.classList.contains("btn-delete")) {
    event.stopPropagation();
    const key = event.target.dataset.key;
    const session = historyData.find(item => item._key === key);
    if (session?._source === "local") {
      showToast("Local ESP32 history tetap disimpan di LittleFS", "error");
      return;
    }
    if (!confirm("Delete this session?")) return;
    try {
      await set(ref(db, `users/${uid}/history/${key}`), null);
      showToast("Session deleted", "");
    } catch {
      showToast("Failed to delete", "error");
    }
    return;
  }

  const card = event.target.closest(".history-card");
  if (!card) return;
  const session = historyData.find(item => item._key === card.dataset.key);
  sessionStorage.setItem(`sem_selected_key_${uid}`, card.dataset.key);
  if (session) sessionStorage.setItem(`sem_selected_session_${uid}`, JSON.stringify(session));
  window.location.href = "history-detail.html";
});

btnExportAll.addEventListener("click", () => {
  if (historyData.length === 0) {
    showToast("No data to export", "error");
    return;
  }
  let csv = "Name,Duration,Power (W),Energy (kWh),Cost,Date\n";
  historyData.forEach(session => {
    csv += `${session.name},${formatDuration(durationSeconds(session))},${powerOf(session)},${energyOf(session)},${costOf(session)},${formatDateTime(session)}\n`;
  });
  downloadCSV(csv, "sem_all_history.csv");
  showToast("Exported successfully ✓", "success");
});

btnDeleteAll.addEventListener("click", async () => {
  if (historyData.length === 0) {
    showToast("Nothing to delete", "error");
    return;
  }
  if (!confirm("Delete ALL history? This cannot be undone.")) return;
  try {
    await set(historyRef, null);
    showToast("All history deleted", "");
  } catch {
    showToast("Failed to delete", "error");
  }
});

function exportSingleCSV(session) {
  const csv = `Name,Duration,Power (W),Energy (kWh),Cost,Date\n${session.name},${formatDuration(durationSeconds(session))},${powerOf(session)},${energyOf(session)},${costOf(session)},${formatDateTime(session)}`;
  downloadCSV(csv, `${session.name}_session.csv`);
  showToast(`Exported ${session.name} ✓`, "success");
}

function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
