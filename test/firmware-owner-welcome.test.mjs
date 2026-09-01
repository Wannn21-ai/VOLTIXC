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

test("WiFi reset preserves owner cache and System Reset prepares fresh onboarding", () => {
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
  const requestIndex = systemResetSource.indexOf("deviceAuthRequestPairingCode(");
  const cacheIndex = systemResetSource.indexOf("firebaseStorePairingCode(");
  const localClearIndex = systemResetSource.indexOf("prefs.clear()");
  assert.equal(releaseIndex >= 0 && releaseIndex < localClearIndex, true);
  assert.equal(releaseIndex < requestIndex && requestIndex < cacheIndex && cacheIndex < localClearIndex, true);
  assert.match(systemResetSource, /Reset aborted: remote ownership unchanged[\s\S]*return;/);
  assert.match(systemResetSource, /persistPendingSystemReset\(true\)[\s\S]*Reset waiting for saved WiFi connection/);
  assert.match(systemResetSource, /startSetupPortal\("system reset requires WiFi"\)/);
  assert.match(systemResetSource, /Fresh pairing code cached for post-reset onboarding/);
  assert.match(systemResetSource, /prefs\.clear\(\)/);
  assert.match(systemResetSource, /if \(!preferencesCleared\)[\s\S]*return;/);
});

test("temporary pairing code survives software restart but remains expiry bounded", () => {
  assert.match(firebaseSource, /PREF_NAMESPACE_PAIRING = "pair_cache"/);
  assert.match(firebaseSource, /PREF_KEY_PAIRING_EXPIRES = "expires"/);
  assert.match(firebaseSource, /loadCachedPairingCode\(\)/);
  assert.match(firebaseSource, /esp_reset_reason\(\) == ESP_RST_SW/);
  assert.match(firebaseSource, /currentTrustedUnixMs\(nowUnixMs\)/);
  assert.match(firebaseSource, /firebaseStorePairingCode\(const char\* code, uint64_t expiresAt\)/);
  assert.match(firebaseSource, /prefs\.putULong64\(PREF_KEY_PAIRING_EXPIRES, expiresAt\)/);
  assert.match(firebaseSource, /void firebaseClearPairingCode\(\)[\s\S]*prefs\.clear\(\)/);
  assert.match(mainSource, /Cached pairing code expired[\s\S]*firebaseClearPairingCode\(\)/);

  const cachedCodePriority = displaySource.indexOf("!appConfig.paired && appConfig.pairingCode[0] != '\\0'");
  const portalPriority = displaySource.indexOf("if (networkIsPortalActive())", cachedCodePriority);
  assert.equal(cachedCodePriority >= 0 && cachedCodePriority < portalPriority, true);
  assert.match(displaySource, /networkIsPortalActive\(\) \? "AP: Voltix-Setup" : "Enter in web app"/);
});

test("unpaired boot and captive portal completion bypass the mode menu", () => {
  const networkBeginStart = networkSource.indexOf("void networkBegin()");
  const networkUpdateStart = networkSource.indexOf("void networkUpdate()", networkBeginStart);
  const networkBeginSource = networkSource.slice(networkBeginStart, networkUpdateStart);
  const recoveryIndex = networkBeginSource.indexOf("sessionRecoveryIsActive()");
  const onboardingIndex = networkBeginSource.indexOf("!appConfig.paired || autoOnlineAfterPortal");
  const menuIndex = networkBeginSource.indexOf("enterBootChoiceMenu()");

  assert.equal(recoveryIndex >= 0 && recoveryIndex < onboardingIndex, true);
  assert.equal(onboardingIndex < menuIndex, true);
  assert.match(networkBeginSource, /loadSavedWiFiCredentials[\s\S]*startWiFiConnection/);
  assert.match(networkBeginSource, /startSetupPortal\(systemResetPending[\s\S]*"unpaired onboarding"\)/);
  assert.match(networkSource, /saveWiFiCredentials\(ssid, password\);\s*markAutoOnlineAfterPortal\(\)/);
  assert.match(networkSource, /Captive portal complete; connecting directly ONLINE/);
  assert.match(networkSource, /connected && systemResetPending && !systemResetInProgress[\s\S]*systemReset\(\)/);
  assert.match(networkSource, /if \(systemResetPending\)[\s\S]*System Reset Pending/);
});
