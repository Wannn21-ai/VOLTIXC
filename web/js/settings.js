import {
  requireAuth, renderShell, fillUserInfo, showToast,
  startStatusWatcher, applyTheme, applyLanguage,
  loadAndApplySettings, tr
} from "./auth-guard.js";
import { auth, db, ref, set, get, update } from "./firebase-config.js";
import { updateProfile } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { loadDeviceHistory } from "./local-history.js";
import {
  deleteAllPathsForSessions, cleanupRequestForAll, deleteFirebasePaths
} from "./history-delete.js";
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
const SETTINGS_PATH = `users/${uid}/settings`;
const HISTORY_PATH  = `users/${uid}/history`;

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

function sanitizeForFirebase(obj) {
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

async function saveSettingsToFirebase(partial) {
  const payload  = sanitizeForFirebase(partial);
  const merged   = sanitizeForFirebase({ ...settings, ...payload });
  const freshRef = ref(db, SETTINGS_PATH);
  let savedOk    = false;

  try {
    await update(freshRef, payload);
    savedOk = true;
    console.log("[SEM] Settings saved via update():", payload);
  } catch (updateErr) {
    console.warn("[SEM] update() gagal, fallback ke set():", updateErr.message);
    try {
      await set(freshRef, merged);
      savedOk = true;
      console.log("[SEM] Settings saved via set() fallback");
    } catch (setErr) {
      console.error("[SEM] set() juga gagal:", setErr.message);
      throw setErr;
    }
  }

  if (savedOk) {
    settings = merged;
    localStorage.setItem(`sem_settings_${uid}`, JSON.stringify(settings));
  }
}

async function syncSharedConfigToSettings() {
  if (!currentDevice) return;
  try {
    const snap = await get(ref(db, `devices/${currentDevice.id}/config`));
    if (!snap.exists()) return;
    const shared = snap.val() || {};
    const sharedThreshold = Number(shared.overloadThreshold ?? shared.threshold);
    const sharedTariff = Number(shared.electricityCostPerKwh ?? shared.tariff ?? shared.tarif);
    const next = { ...settings };
    if (Number.isFinite(sharedThreshold) && sharedThreshold > 0) next.overloadThreshold = sharedThreshold;
    if (Number.isFinite(sharedTariff) && sharedTariff > 0) next.tariff = sharedTariff;
    if (shared.currency) next.currency = shared.currency;
    ["overloadWarningPercent", "loadPowerThreshold", "loadCurrentThreshold",
     "loadRemovedDelaySec", "offlineTimeoutSec", "checkpointIntervalSec"].forEach(key => {
      const value = Number(shared[key]);
      if (Number.isFinite(value) && value > 0) next[key] = value;
    });
    if (JSON.stringify(next) === JSON.stringify(settings)) return;

    settings = next;
    localStorage.setItem(`sem_settings_${uid}`, JSON.stringify(settings));
    await update(ref(db, SETTINGS_PATH), {
      overloadThreshold: settings.overloadThreshold,
      tariff: settings.tariff
    });
  } catch (e) {
    console.warn("[SEM] Gagal sync config global ke settings:", e);
  }
}

function cleanupStorageKey(deviceId) {
  return `sem_pending_history_cleanup_${uid}_${deviceId || ""}`;
}

async function queueDeviceCleanup(cleanupRequest, cloudDeleted = true) {
  if (!cleanupRequest) {
    showToast(tr("historyCloudDeletedNoCleanup"), "error");
    return false;
  }
  await set(ref(db, cleanupRequest.path), cleanupRequest.payload);
  const cleanupDeviceId = cleanupRequest.path.split("/")[1] || currentDevice?.id;
  const requestId = cleanupRequest.payload.requestId;
  if (cleanupDeviceId) {
    sessionStorage.setItem(cleanupStorageKey(cleanupDeviceId), requestId);
  }
  showToast(cloudDeleted ? tr("historyCloudDeletedCleanupPending") : tr("historyDeviceCleanupPending"), "");
  return true;
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
    await saveSettingsToFirebase({ currency, tariff, overloadThreshold: threshold });
    try {
      if (currentDevice) await update(ref(db, `devices/${currentDevice.id}/config`), {
        tariff,
        currency,
        overloadThreshold: threshold,
        overloadWarningPercent: settings.overloadWarningPercent,
        loadPowerThreshold: settings.loadPowerThreshold,
        loadCurrentThreshold: settings.loadCurrentThreshold,
        loadRemovedDelaySec: settings.loadRemovedDelaySec,
        offlineTimeoutSec: settings.offlineTimeoutSec,
        checkpointIntervalSec: settings.checkpointIntervalSec
      });
      await update(ref(db, SETTINGS_PATH), { overloadThreshold: threshold, tariff });
    } catch (e) {
      console.warn("[SEM] Gagal sync config device:", e);
    }
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
    await saveSettingsToFirebase({ theme, language });
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
    await saveSettingsToFirebase(partial);
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
    const snap = await get(ref(db, HISTORY_PATH));
    if (!snap.exists()) { showToast(tr("settingsExportNoData"), "error"); return; }
    const history = Object.values(snap.val()).sort((a, b) => b.timestamp - a.timestamp);
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

    const activeDeviceId = currentDevice?.id || "";
    const deletePaths = deleteAllPathsForSessions(historyData, activeDeviceId);
    const cleanupRequest = cleanupRequestForAll(historyData, activeDeviceId, uid);

    if (deletePaths.length === 0 && !cleanupRequest) {
      showToast(tr("historyResolveDeviceFail"), "error");
      return;
    }
    if (!confirm(tr("historyDeleteAllConfirm"))) return;

    const result = await deleteFirebasePaths(deletePaths, path => set(ref(db, path), null));

    if (result.permissionDenied) {
      showToast(tr("historyDeleteDenied"), "error");
    } else if (result.successCount > 0 || deletePaths.length === 0) {
      await queueDeviceCleanup(cleanupRequest, result.successCount > 0);
      showToast(tr("settingsDeleteSuccess"), "success");
    } else {
      showToast(tr("settingsDeleteFailed"), "error");
    }
  } catch (e) {
    console.error("[SEM] Gagal hapus semua history:", e);
    showToast(tr("settingsDeleteFailed"), "error"); return;
  } finally {
    btn.disabled = false;
  }
});
