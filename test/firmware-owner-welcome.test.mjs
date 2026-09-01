import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stateHeader = await readFile("firmware/include/state.h", "utf8");
const networkSource = await readFile("firmware/src/network.cpp", "utf8");
const firebaseSource = await readFile("firmware/src/firebase_sync.cpp", "utf8");
const displaySource = await readFile("firmware/src/display.cpp", "utf8");
const mainSource = await readFile("firmware/src/main.cpp", "utf8");
const webUserState = await readFile("web/js/user-state.js", "utf8");

test("pairing stores the authenticated account display name without a fake fallback", () => {
  assert.match(webUserState, /ownerDisplayName = typeof user\.displayName === "string"/);
  assert.match(webUserState, /user\.displayName\.trim\(\)\.slice\(0, 80\)/);
  assert.match(webUserState, /ownerProfile[\s\S]*uid: user\.uid,[\s\S]*displayName: ownerDisplayName,[\s\S]*pairingCode: code/);
  assert.doesNotMatch(webUserState, /ownerDisplayName[^;]*(?:VOLTIX User|User)/);
  assert.match(firebaseSource, /firebaseSyncOwnerBinding\(\)/);
  assert.match(firebaseSource, /pairingCode != appConfig\.pairingCode/);
  assert.match(firebaseSource, /cacheOwnerBinding\(ownerUid\.c_str\(\), displayName\.c_str\(\)\)/);
});

test("owner binding and display name persist in the existing voltix namespace", () => {
  assert.match(stateHeader, /bool paired;/);
  assert.match(stateHeader, /char ownerUid\[64\];/);
  assert.match(stateHeader, /char ownerDisplayName\[81\];/);
  assert.match(networkSource, /PREF_KEY_PAIRED\[\] = "paired"/);
  assert.match(networkSource, /PREF_KEY_OWNER_UID\[\] = "owner_uid"/);
  assert.match(networkSource, /PREF_KEY_OWNER_DISPLAY_NAME\[\] = "owner_name"/);
  assert.match(networkSource, /prefs\.putBool\(PREF_KEY_PAIRED, true\)/);
  assert.match(networkSource, /prefs\.getString\(PREF_KEY_OWNER_DISPLAY_NAME/);
});

test("boot welcome is local-only, bounded, and below recovery priority", () => {
  const recoveryIndex = mainSource.indexOf("sessionRecoveryBegin();");
  const welcomeIndex = mainSource.indexOf("displayShowOwnerWelcome(appConfig.ownerDisplayName);");
  assert.equal(recoveryIndex >= 0 && recoveryIndex < welcomeIndex, true);
  assert.match(mainSource, /!sessionRecoveryIsActive\(\)[\s\S]*appConfig\.paired[\s\S]*appConfig\.ownerDisplayName\[0\] != '\\0'/);
  assert.match(mainSource, /delay\(Config::OWNER_WELCOME_DURATION_MS\)/);
  assert.match(displaySource, /MAX_WELCOME_NAME_CHARS = 20/);
  assert.match(displaySource, /drawCenteredText\("Welcome Owner"/);
  assert.match(displaySource, /length <= 10 \? 2 : 1/);
  assert.match(displaySource, /if \(!appConfig\.paired\) \{\s*drawLine\(4, "Fetching code\.\.\."\)/);
});

test("WiFi reset preserves owner cache while System Reset clears its namespace", () => {
  const clearWifiStart = networkSource.indexOf("void clearWiFiCredentials()");
  const hasWifiStart = networkSource.indexOf("bool hasSavedWiFiCredentials()", clearWifiStart);
  const clearWifiSource = networkSource.slice(clearWifiStart, hasWifiStart);
  const systemResetStart = networkSource.indexOf("void systemReset()");
  const menuForwardDeclarations = networkSource.indexOf("void updateTwoButtonMenu()", systemResetStart);
  const systemResetSource = networkSource.slice(systemResetStart, menuForwardDeclarations);

  assert.match(clearWifiSource, /prefs\.remove\(PREF_KEY_WIFI_SSID\)/);
  assert.match(clearWifiSource, /prefs\.remove\(PREF_KEY_WIFI_PASS\)/);
  assert.doesNotMatch(clearWifiSource, /PREF_KEY_OWNER_/);
  assert.match(systemResetSource, /prefs\.clear\(\)/);
});
