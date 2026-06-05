import {
  requireAuth, renderShell, fillUserInfo,
  startStatusWatcher, loadAndApplySettings, showToast
} from "./auth-guard.js";
import { db, ref, get, update, FIREBASE_CONFIGURED } from "./firebase-config.js";
import {
  claimPairingCode, getCurrentDevice, readableFirebaseError
} from "./user-state.js";

const user = await requireAuth();
renderShell("device", "DEVICE");
fillUserInfo(user);
startStatusWatcher();
await loadAndApplySettings(user.uid);

const pairingPanel = document.getElementById("pairing-panel");
const devicePanel = document.getElementById("device-panel");
const pairingCode = document.getElementById("pairing-code");
const pairingError = document.getElementById("pairing-error");
const pairButton = document.getElementById("btn-pair-device");

function showPairingError(message) {
  pairingError.textContent = message;
  pairingError.style.display = "block";
}

function hidePairingError() {
  pairingError.style.display = "none";
}

async function renderDeviceState() {
  const currentDevice = await getCurrentDevice(user.uid);
  if (!currentDevice) {
    devicePanel.style.display = "none";
    pairingPanel.style.display = "block";
    return;
  }

  pairingPanel.style.display = "none";
  devicePanel.style.display = "block";
  document.getElementById("device-id").textContent = currentDevice.id;
  document.getElementById("device-role").textContent = currentDevice.role || "member";
  document.getElementById("device-name").textContent =
    currentDevice.nickname || "VOLTIX Device";

  try {
    const snapshot = await get(ref(db, `devices/${currentDevice.id}`));
    const device = snapshot.exists() ? snapshot.val() || {} : {};
    document.getElementById("device-name").textContent =
      currentDevice.nickname || device.name || "VOLTIX Device";
    document.getElementById("device-firmware").textContent =
      device.firmwareVersion || "Not reported";
    document.getElementById("device-status").textContent =
      device.paired === false ? "Pairing pending" : "Paired";
  } catch (error) {
    document.getElementById("device-status").textContent =
      readableFirebaseError(error, "Status unavailable");
  }
}

pairingCode.addEventListener("input", () => {
  pairingCode.value = pairingCode.value.replace(/\D/g, "").slice(0, 6);
  hidePairingError();
});

pairButton.addEventListener("click", async () => {
  hidePairingError();
  const code = pairingCode.value.trim();
  if (!/^\d{6}$/.test(code)) {
    showPairingError("Enter the 6-digit code shown on the device.");
    return;
  }
  if (!FIREBASE_CONFIGURED) {
    showPairingError("Pairing is unavailable in local visual mode.");
    return;
  }

  pairButton.disabled = true;
  pairButton.textContent = "Pairing...";
  try {
    const claimed = await claimPairingCode(user, code);
    showToast(`Device "${claimed.nickname}" paired successfully`, "success");
    await renderDeviceState();
  } catch (error) {
    console.warn("[Pairing] Claim failed:", error?.code || error?.message || error);
    showPairingError(readableFirebaseError(error, error?.message || "Pairing failed."));
  } finally {
    pairButton.disabled = false;
    pairButton.textContent = "Pair Device";
  }
});

pairingCode.addEventListener("keydown", event => {
  if (event.key === "Enter") pairButton.click();
});

try {
  await renderDeviceState();
} catch (error) {
  pairingPanel.style.display = "block";
  showPairingError(readableFirebaseError(error, "Device state could not be loaded."));
}
