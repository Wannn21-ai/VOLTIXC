import {
  requireAuth, renderShell, fillUserInfo, showToast,
  startStatusWatcher, loadAndApplySettings
} from "./auth-guard.js";
import {
  db, ref, get, DEVICE_ID, FIREBASE_CONFIGURED
} from "./firebase-config.js";

const user = await requireAuth();
const page = document.body.dataset.page;
const title = document.body.dataset.title;

renderShell(page, title.toUpperCase());
fillUserInfo(user);
startStatusWatcher();
const settings = await loadAndApplySettings(user.uid);

function setText(id, value, fallback = "—") {
  const element = document.getElementById(id);
  if (element) element.textContent = value ?? fallback;
}

function firstValue(source, keys, fallback = null) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

function numberValue(source, keys, fallback = 0) {
  const value = Number(firstValue(source, keys, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function humanize(value, fallback = "—") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value)
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, character => character.toUpperCase());
}

function formatLastSeen(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return "—";
  const millis = value > 1000000000000 ? value : value * 1000;
  return new Date(millis).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
}

async function loadDevicePage() {
  const [liveSnapshot, configSnapshot] = await Promise.all([
    get(ref(db, `devices/${DEVICE_ID}/live`)),
    get(ref(db, `devices/${DEVICE_ID}/config`)),
  ]);
  const live = liveSnapshot.val() || {};
  const system = live.system || {};
  const config = configSnapshot.val() || {};
  const timestamp = numberValue(system, ["timestamp"]);
  const online = system.internet === true && timestamp > 0 &&
    Math.floor(Date.now() / 1000) - timestamp <= 15;

  setText("device-data-mode", FIREBASE_CONFIGURED ? "Firebase read-only" : "Local visual fallback");
  setText("device-name", firstValue(system, ["deviceName", "name"], "VOLTIX Rumah"));
  setText("device-id", firstValue(system, ["deviceId", "deviceID"], DEVICE_ID));
  setText("device-pairing", firstValue(config, ["pairingStatus"], "Not Paired"));
  setText("device-owner", firstValue(config, ["ownerEmail"], user.email || "—"));
  setText("device-firmware", firstValue(system, ["firmwareVersion", "firmware", "version"], "v1.0.0"));

  setText("runtime-online", online ? "Online" : "Offline");
  setText("runtime-online-sub", online ? "Device reporting normally" : "Using latest available data");
  setText("runtime-wifi", firstValue(system, ["ssid", "wifiSsid", "activeSsid"], "—"));
  setText("runtime-wifi-sub", system.wifiConnected === true ? "WiFi connected" : "No active network reported");
  setText("runtime-mode", humanize(firstValue(system, ["mode", "systemMode"])));
  setText("runtime-relay", system.relay === true ? "ON" : "OFF");
  setText("runtime-last-seen", formatLastSeen(timestamp));

  const tariff = numberValue(config, ["electricityCostPerKwh", "tariff", "tarif"], Number(settings.tariff || 1444.7));
  const overload = numberValue(config, ["overloadThreshold", "threshold"], Number(settings.overloadThreshold || 2000));
  const warning = numberValue(config, ["overloadWarningPercent"], Number(settings.overloadWarningPercent || 99));
  const loadPower = numberValue(config, ["loadPowerThreshold"], Number(settings.loadPowerThreshold || 1));
  const loadCurrent = numberValue(config, ["loadCurrentThreshold"], Number(settings.loadCurrentThreshold || 0.02));
  const checkpoint = numberValue(config, ["checkpointIntervalSec"], Number(settings.checkpointIntervalSec || 30));
  setText("config-tariff", `Rp ${Math.round(tariff).toLocaleString("id-ID")}`);
  setText("config-overload", `${Math.round(overload).toLocaleString("en-US")} W`);
  setText("config-warning", `${warning}%`);
  setText("config-load", `${loadPower} W / ${loadCurrent} A`);
  setText("config-checkpoint", `${checkpoint} sec`);

  document.querySelectorAll("[data-safe-action]").forEach(button => {
    button.addEventListener("click", () => {
      showToast(`${button.dataset.safeAction}: coming in a future sprint`, "");
    });
  });
}

function loadMembersPage() {
  const localVisual = !FIREBASE_CONFIGURED;
  const role = localVisual ? "Local Visual" : "Owner";
  const name = user.displayName || user.email?.split("@")[0] || "Current User";
  setText("current-role", role);
  setText("sharing-status", localVisual ? "Local Preview Only" : "UI Preview · No member backend");
  setText("owner-name", name);
  setText("owner-email", user.email || "—");
  setText("owner-avatar", name.charAt(0).toUpperCase());
  setText("owner-role", role);

  const codeElement = document.getElementById("invite-code");
  const expiryElement = document.getElementById("invite-expiry");
  const copyButton = document.getElementById("btn-copy-code");
  document.getElementById("btn-generate-code").addEventListener("click", () => {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    codeElement.textContent = code;
    expiryElement.textContent = "Valid for 10 minutes in this local UI preview only.";
    copyButton.disabled = false;
    showToast("Local demo invite code generated", "success");
  });
  copyButton.addEventListener("click", async () => {
    const code = codeElement.textContent;
    if (!/^\d{6}$/.test(code)) return;
    try {
      await navigator.clipboard.writeText(code);
      showToast("Invite code copied", "success");
    } catch {
      showToast(`Invite code: ${code}`, "");
    }
  });
}

if (page === "device") {
  await loadDevicePage();
} else if (page === "members") {
  loadMembersPage();
}
