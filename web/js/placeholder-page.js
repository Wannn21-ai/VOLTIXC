import {
  requireAuth, renderShell, fillUserInfo,
  startStatusWatcher, loadAndApplySettings
} from "./auth-guard.js";
import { getCurrentDevice, readableFirebaseError } from "./user-state.js";

const user = await requireAuth();
const page = document.body.dataset.page;
const title = document.body.dataset.title;

renderShell(page, title.toUpperCase());
fillUserInfo(user);
startStatusWatcher();
await loadAndApplySettings(user.uid);

if (document.body.dataset.skipDevicePlaceholder !== "true") {
  try {
    const currentDevice = await getCurrentDevice(user.uid);
    if (!currentDevice) {
      document.getElementById("placeholder-title").textContent = "No device paired yet";
      document.getElementById("placeholder-sub").textContent =
        "Pair your VOLTIX device to start monitoring.";
    }
  } catch (error) {
    document.getElementById("placeholder-title").textContent = "Device access unavailable";
    document.getElementById("placeholder-sub").textContent = readableFirebaseError(error);
  }
}
