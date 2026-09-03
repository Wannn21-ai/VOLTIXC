import {
  requireAuth, renderShell, fillUserInfo, showToast,
  startStatusWatcher, applyTheme, applyLanguage,
  loadAndApplySettings, tr
} from "./auth-guard.js";
import { auth } from "./firebase-config.js";
import { updateProfile } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { authenticatedApi } from "./cloud-api.js";
import { loadDeviceHistory } from "./local-history.js";
import { getCurrentDevice, readableFirebaseError } from "./user-state.js";

const user = await requireAuth();
renderShell("settings", "SETTINGS");
fillUserInfo(user);
startStatusWatcher();
const uid = user.uid;
let currentDevice = null;
try {
  currentDevice = await getCurrentDevice(uid);
} catch (error) {
  console.warn("[Settings] Current device unavailable:", readableFirebaseError(error));
}

// ================= CONSTANTS =================
// FIX: Deklarasikan USD_RATE di ATAS segalanya supaya tidak terjadi
// "Cannot access before initialization" saat applyToUI() → updateConvertedPreview()
const USD_RATE      = 16500;

// ================= DEFAULTS =================
const DEFAULTS = {
  currency: "IDR", tariff: 1444.70,
  overloadThreshold: 2000,
  overloadWarningPercent: 99,
  loadPowerThreshold: 1,
  loadCurrentThreshold: 0.02,
  loadRemovedDelaySec: 2,
  offlineTimeoutSec: 300,
  checkpointIntervalSec: 30,
  theme: "dark", language: "en",
  notifDevice: true, notifDisconnect: true,
  notifSession: true, notifOverload: true,
  refreshInterval: 3000
};
let settings = { ...DEFAULTS };

// ================= HELPER FUNCTIONS =================
// FIX: Definisikan semua fungsi SEBELUM dipanggil, termasuk applyToUI
// dan updateConvertedPreview, supaya tidak ada referensi ke fungsi/const
// yang belum diinisialisasi.

function sanitizeSettingsPayload(obj) {
  const clean = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined && val !== null) clean[key] = val;
  }
  return clean;
}

function highlightThemeBtn(theme) {
  document.querySelectorAll(".theme-btn").forEach(btn =>
    btn.classList.toggle("active", btn.dataset.theme === theme));
}

function updateConvertedPreview() {
  const currencyEl = document.getElementById("currency");
  const tariffEl   = document.getElementById("tariff");
  const el         = document.getElementById("tariff-converted");
  if (!el || !currencyEl || !tariffEl) return;
  const currency = currencyEl.value;
  const tariff   = parseFloat(tariffEl.value);
  if (isNaN(tariff) || tariff <= 0) { el.textContent = ""; return; }
  el.textContent = currency === "IDR"
    ? `≈ $ ${(tariff / USD_RATE).toFixed(4)} / kWh`
    : `≈ Rp ${Math.round(tariff * USD_RATE).toLocaleString("id-ID")} / kWh`;
}

function applyToUI() {
  const el = id => document.getElementById(id);
  if (el("currency"))           el("currency").value           = settings.currency          ?? "IDR";
  if (el("tariff"))             el("tariff").value             = settings.tariff            ?? 1444.70;
  if (el("overload-threshold")) el("overload-threshold").value = settings.overloadThreshold ?? 2000;
  if (el("language"))           el("language").value           = settings.language          ?? "en";
  if (el("notif-device"))       el("notif-device").checked     = settings.notifDevice       ?? true;
  if (el("notif-disconnect"))   el("notif-disconnect").checked = settings.notifDisconnect   ?? true;
  if (el("notif-session"))      el("notif-session").checked    = settings.notifSession      ?? true;
  if (el("notif-overload"))     el("notif-overload").checked   = settings.notifOverload     ?? true;
  if (el("refresh-interval"))   el("refresh-interval").value  = settings.refreshInterval   ?? 3000;
  if (el("display-name"))       el("display-name").value      = user.displayName || "";
  if (el("display-email"))      el("display-email").value     = user.email || "";
  highlightThemeBtn(settings.theme || "dark");
  updateConvertedPreview();
}

function setBtnLoading(btnId, loading, originalText) {
  const btn  = document.getElementById(btnId);
  const span = btn?.querySelector("span");
  if (!btn) return;
  btn.disabled = loading;
  if (span) span.textContent = loading ? tr("saving") : originalText;
}

async function saveSettingsToCloud(partial) {
  const payload  = sanitizeSettingsPayload(partial);
  const merged   = sanitizeSettingsPayload({ ...settings, ...payload });
  await authenticatedApi(user, "/api/settings", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  settings = merged;
  localStorage.setItem(`sem_settings_${uid}`, JSON.stringify(settings));
}

async function syncSharedConfigToSettings() {
  settings = await loadAndApplySettings(uid);
}

// ================= LOAD SETTINGS =================
// Baru load & apply SETELAH semua fungsi di atas terdefinisi
try {
  settings = await loadAndApplySettings(uid);
} catch (e) {
  console.error("[SEM] loadAndApplySettings gagal:", e);
  try {
    const cached = JSON.parse(localStorage.getItem(`sem_settings_${uid}`));
    if (cached) settings = { ...DEFAULTS, ...cached };
  } catch {}
  applyTheme(settings.theme);
  applyLanguage(settings.language);
}

applyToUI();
await syncSharedConfigToSettings();
applyToUI();

// ================= EVENT LISTENERS =================

document.getElementById("currency").addEventListener("change", function () {
  const tariffEl = document.getElementById("tariff");
  const cur      = parseFloat(tariffEl.value);
  if (!isNaN(cur) && cur > 0) {
    tariffEl.value = this.value === "USD"
      ? (cur / USD_RATE).toFixed(4)
      : Math.round(cur * USD_RATE);
  }
  updateConvertedPreview();
});
document.getElementById("tariff").addEventListener("input", updateConvertedPreview);

// ── Save Pricing + Threshold ──
document.getElementById("btn-save-settings").addEventListener("click", async () => {
  const currency  = document.getElementById("currency").value;
  const tariff    = parseFloat(document.getElementById("tariff").value);
  const threshold = parseFloat(document.getElementById("overload-threshold").value);

  if (isNaN(tariff)    || tariff    <= 0) { showToast(tr("settingsValidTariff"),    "error"); return; }
  if (isNaN(threshold) || threshold <= 0) { showToast(tr("settingsValidThreshold"), "error"); return; }

  const span = document.querySelector("#btn-save-settings span");
  const originalText = span?.textContent || "Save Settings";
  setBtnLoading("btn-save-settings", true, originalText);

  try {
    await saveSettingsToCloud({ currency, tariff, overloadThreshold: threshold });
    showToast(tr("settingsSaved"), "success");
  } catch (e) {
    console.error("[SEM] Gagal simpan pricing settings:", e);
    showToast(tr("settingsSaveFailed"), "error");
  } finally {
    setBtnLoading("btn-save-settings", false, originalText);
  }
});

// ── Save Profile ──
document.getElementById("btn-save-profile").addEventListener("click", async () => {
  const name = document.getElementById("display-name").value.trim();
  if (!name) { showToast(tr("settingsNameRequired"), "error"); return; }

  const span = document.querySelector("#btn-save-profile span");
  const originalText = span?.textContent || "Update Profile";
  setBtnLoading("btn-save-profile", true, originalText);

  try {
    await updateProfile(auth.currentUser, { displayName: name });
    fillUserInfo(auth.currentUser);
    showToast(tr("settingsProfileUpdated"), "success");
  } catch (e) {
    console.error("[SEM] Gagal update profile:", e);
    showToast(tr("settingsProfileFailed"), "error");
  } finally {
    setBtnLoading("btn-save-profile", false, originalText);
  }
});

// ── Save Appearance ──
document.getElementById("btn-save-appearance").addEventListener("click", async () => {
  const activeThemeBtn = document.querySelector(".theme-btn.active");
  const theme    = activeThemeBtn?.dataset.theme || "dark";
  const language = document.getElementById("language").value;

  const span = document.querySelector("#btn-save-appearance span");
  const originalText = span?.textContent || "Save Appearance";
  setBtnLoading("btn-save-appearance", true, originalText);

  try {
    await saveSettingsToCloud({ theme, language });
    localStorage.setItem(`sem_theme_${uid}`, theme);
    applyTheme(theme);
    applyLanguage(language);
    showToast(tr("settingsAppearanceUpdated"), "success");
  } catch (e) {
    console.error("[SEM] Gagal simpan appearance:", e);
    showToast(tr("settingsAppearanceFailed"), "error");
  } finally {
    setBtnLoading("btn-save-appearance", false, originalText);
  }
});

document.querySelectorAll(".theme-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    highlightThemeBtn(btn.dataset.theme);
    applyTheme(btn.dataset.theme);
  });
});

// ── Save Notifications ──
document.getElementById("btn-save-notif").addEventListener("click", async () => {
  const partial = {
    notifDevice:     document.getElementById("notif-device").checked,
    notifDisconnect: document.getElementById("notif-disconnect").checked,
    notifSession:    document.getElementById("notif-session").checked,
    notifOverload:   document.getElementById("notif-overload").checked,
    refreshInterval: parseInt(document.getElementById("refresh-interval").value)
  };
  if (isNaN(partial.refreshInterval)) partial.refreshInterval = 3000;

  const span = document.querySelector("#btn-save-notif span");
  const originalText = span?.textContent || "Save Preferences";
  setBtnLoading("btn-save-notif", true, originalText);

  try {
    await saveSettingsToCloud(partial);
    showToast(tr("settingsPreferencesSaved"), "success");
  } catch (e) {
    console.error("[SEM] Gagal simpan notifikasi:", e);
    showToast(tr("settingsPreferencesFailed"), "error");
  } finally {
    setBtnLoading("btn-save-notif", false, originalText);
  }
});

// ── Export All History ──
document.getElementById("btn-export-all").addEventListener("click", async () => {
  const btn = document.getElementById("btn-export-all");
  btn.disabled = true;
  try {
    const history = await loadDeviceHistory(uid);
    if (history.length === 0) { showToast(tr("settingsExportNoData"), "error"); return; }
    let csv = "Name,Duration,Power (W),Energy (kWh),Cost,Date\n";
    history.forEach(s => { csv += `${s.name},${s.duration},${s.power},${s.energy},${s.cost},${s.date}\n`; });
    const blob = new Blob([csv], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "sem_all_history.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`${tr("settingsExportSuccess")} (${history.length})`, "success");
  } catch (e) {
    console.error("[SEM] Gagal export history:", e);
    showToast(tr("settingsExportNoData"), "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Delete All History ──
document.getElementById("btn-delete-all").addEventListener("click", async () => {
  const btn = document.getElementById("btn-delete-all");
  btn.disabled = true;

  try {
    const historyData = await loadDeviceHistory(uid);
    if (historyData.length === 0) {
      showToast(tr("historyNothingDelete"), "error");
      return;
    }

    if (!confirm(tr("historyDeleteAllConfirm"))) return;
    await authenticatedApi(user, "/api/history", {
      method: "DELETE",
      body: JSON.stringify({ all: true }),
    });
    showToast(tr("settingsDeleteSuccess"), "success");
  } catch (e) {
    console.error("[SEM] Gagal hapus semua history:", e);
    showToast(tr("settingsDeleteFailed"), "error"); return;
  } finally {
    btn.disabled = false;
  }
});
