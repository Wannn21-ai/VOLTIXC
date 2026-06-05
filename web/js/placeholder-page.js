import {
  requireAuth, renderShell, fillUserInfo,
  startStatusWatcher, loadAndApplySettings
} from "./auth-guard.js";

const user = await requireAuth();
const page = document.body.dataset.page;
const title = document.body.dataset.title;

renderShell(page, title.toUpperCase());
fillUserInfo(user);
startStatusWatcher();
await loadAndApplySettings(user.uid);
