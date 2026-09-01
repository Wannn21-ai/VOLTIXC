import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stateHeader = await readFile("firmware/include/state.h", "utf8");
const networkSource = await readFile("firmware/src/network.cpp", "utf8");
const deviceAuthSource = await readFile("firmware/src/device_auth.cpp", "utf8");
const firebaseSource = await readFile("firmware/src/firebase_sync.cpp", "utf8");
const displaySource = await readFile("firmware/src/display.cpp", "utf8");
const mainSource = await readFile("firmware/src/main.cpp", "utf8");
const webUserState = await readFile("web/js/user-state.js", "utf8");

test("web claims through the trusted endpoint instead of protected RTDB paths", () => {
  assert.match(webUserState, /fetch\("\/api\/claim-device"/);
  assert.match(webUserState, /"Authorization": `Bearer \$\{idToken\}`/);
  const claimStart = webUserState.indexOf("export async function claimPairingCode");
  const errorStart = webUserState.indexOf("export function readableFirebaseError", claimStart);
  const claimSource = webUserState.slice(claimStart, errorStart);
  assert.doesNotMatch(claimSource, /pairingCodes\//);
  assert.doesNotMatch(claimSource, /update\(ref\(db/);
});

test("firmware obtains pairing codes only through the credentialed backend", () => {
  assert.match(deviceAuthSource, /deviceAuthRequestPairingCode/);
  assert.match(deviceAuthSource, /"device-pairing-code"/);
  assert.match(deviceAuthSource, /requestDoc\["deviceSecret"\] = VOLTIX_DEVICE_SECRET/);
  assert.doesNotMatch(firebaseSource, /pairingCodes\.json\?orderBy/);
  assert.match(firebaseSource, /deviceAuthRequestPairingCode\(code, sizeof\(code\), expiresAt\)/);
  assert.match(firebaseSource, /PAIRING_REQUEST_MAX_BACKOFF_MS = 60000UL/);
  assert.match(firebaseSource, /firebasePairingCodeExpired\(\)/);
  assert.match(mainSource, /firebaseFetchPairingCode\(\)[\s\S]*displayShowStatus\(\)/);
});

test("owner binding is read, cached, and clears the temporary pairing code", () => {
  assert.match(firebaseSource, /firebaseSyncOwnerBinding\(\)/);
  assert.match(firebaseSource, /paired\.json/);
  assert.match(firebaseSource, /pairedResponse != "true"/);
  assert.match(firebaseSource, /ownerProfile\.json/);
  assert.match(firebaseSource, /cacheOwnerBinding\(ownerUid\.c_str\(\), displayName\.c_str\(\)\)/);
  assert.match(firebaseSource, /if \(cached\) \{\s*firebaseClearPairingCode\(\)/);
  assert.match(mainSource, /firebaseSyncOwnerBinding\(\)[\s\S]*displayShowOwnerWelcome\(appConfig\.ownerDisplayName\)/);
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

test("WiFi reset preserves owner cache and System Reset is remote-first", () => {
  const clearWifiStart = networkSource.indexOf("void clearWiFiCredentials()");
  const hasWifiStart = networkSource.indexOf("bool hasSavedWiFiCredentials()", clearWifiStart);
  const clearWifiSource = networkSource.slice(clearWifiStart, hasWifiStart);
  const systemResetStart = networkSource.indexOf("void systemReset()");
  const menuForwardDeclarations = networkSource.indexOf("void updateTwoButtonMenu()", systemResetStart);
  const systemResetSource = networkSource.slice(systemResetStart, menuForwardDeclarations);

  assert.match(clearWifiSource, /prefs\.remove\(PREF_KEY_WIFI_SSID\)/);
  assert.match(clearWifiSource, /prefs\.remove\(PREF_KEY_WIFI_PASS\)/);
  assert.doesNotMatch(clearWifiSource, /PREF_KEY_OWNER_/);
  const releaseIndex = systemResetSource.indexOf("deviceAuthReleaseOwnership()");
  const localClearIndex = systemResetSource.indexOf("prefs.clear()");
  assert.equal(releaseIndex >= 0 && releaseIndex < localClearIndex, true);
  assert.match(systemResetSource, /appConfig\.paired \|\| appConfig\.pairingCode\[0\] != '\\0'/);
  assert.match(systemResetSource, /Reset aborted: remote ownership unchanged[\s\S]*return;/);
  assert.match(systemResetSource, /ownership release requires online backend[\s\S]*return;/);
  assert.match(systemResetSource, /prefs\.clear\(\)/);
});
