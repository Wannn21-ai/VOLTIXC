import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const firebaseSource = await readFile(
  new URL("../firmware/src/firebase_sync.cpp", import.meta.url),
  "utf8",
);
const mainSource = await readFile(
  new URL("../firmware/src/main.cpp", import.meta.url),
  "utf8",
);

test("blocked config pushes use a ten minute revision-aware cooldown", () => {
  assert.match(
    firebaseSource,
    /CONFIG_PUSH_BLOCKED_COOLDOWN_MS = 10UL \* 60UL \* 1000UL/,
  );
  assert.match(firebaseSource, /configPushBlockedRevision != appConfig\.configRevision/);
  assert.match(
    firebaseSource,
    /millis\(\) - configPushBlockedAtMs >= CONFIG_PUSH_BLOCKED_COOLDOWN_MS/,
  );
  assert.match(firebaseSource, /configPushBlockedRevision = appConfig\.configRevision/);
});

test("401 and rules denial start cooldown while local config remains pending", () => {
  const pushStart = firebaseSource.indexOf("bool firebasePushDeviceConfig()");
  const pushEnd = firebaseSource.indexOf("\nbool firebaseDeviceConfigPushBlocked()", pushStart);
  const pushSource = firebaseSource.slice(pushStart, pushEnd);

  assert.match(pushSource, /pathUnauthorized \|\| statusCode == 401 \|\| statusCode == 403/);
  assert.match(pushSource, /startConfigPushCooldown\(\)/);
  assert.match(firebaseSource, /Push blocked, cooldown started/);
  assert.match(pushSource, /local config remains pending/);
  const deniedBranch = pushSource.slice(
    pushSource.indexOf("} else if (pathUnauthorized"),
    pushSource.indexOf("\n  return ok;"),
  );
  assert.doesNotMatch(deniedBranch, /appConfig\.configPendingSync = false/);
});

test("config push cooldown is checked before HTTP and optional config sync", () => {
  const pushStart = firebaseSource.indexOf("bool firebasePushDeviceConfig()");
  const pushEnd = firebaseSource.indexOf("\nbool firebaseDeviceConfigPushBlocked()", pushStart);
  const pushSource = firebaseSource.slice(pushStart, pushEnd);
  assert.equal(
    pushSource.indexOf("configPushCooldownActive()") <
      pushSource.indexOf("httpRequest("),
    true,
  );

  const schedulerStart = mainSource.indexOf("if (onlineServicesAllowed)");
  const schedulerSource = mainSource.slice(schedulerStart);
  assert.match(
    schedulerSource,
    /!firebaseDeviceConfigPushBlocked\(\)[\s\S]*firebasePushDeviceConfig\(\)/,
  );
  assert.equal(
    schedulerSource.indexOf("pollCommandIfDue(onlineServicesAllowed)") <
      schedulerSource.indexOf("firebasePushDeviceConfig()"),
    true,
  );
});
