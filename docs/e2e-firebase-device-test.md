# End-to-End Firebase Device Integration Test Plan

This plan verifies the current VOLTIX web, Firebase RTDB, and ESP32 integration
without changing runtime behavior or weakening production rules. It is a manual,
non-destructive test plan. Use placeholder identities and a disposable Firebase
project whenever seed data or temporary test access is required.

## Safety Boundaries

- Never commit `.env.local`, generated `dist/`, device credentials, database
  secrets, service-account JSON, or real UIDs.
- Never publish temporary relaxed rules to a production Firebase project.
- Do not issue `relay: "ON"`, `startSession: true`, or `stopSession: true`
  merely to test connectivity.
- Keep the relay OFF before flashing, rebooting, changing WiFi, or seeding data.
- A completed session must be saved to LittleFS before cloud synchronization.
- The ESP32 remains device-scoped and must never hardcode a user UID.
- Record unexpected behavior as a follow-up instead of changing firmware, web
  behavior, rules, or relay/session semantics during this test.

## Test Record

Record these values outside the repository before starting:

| Item | Test value |
| --- | --- |
| Test mode | A / B / C |
| Firebase project | Disposable project name or reviewed environment |
| Web commit | Commit SHA |
| Firmware commit | Commit SHA |
| Test account UID | Actual value replacing `<uid>` |
| Device ID | Actual value replacing `<deviceId>` |
| History ID | Actual value replacing `<historyId>` |
| Browser and version | |
| ESP32 serial port | |
| Start/end time | |

Capture evidence as screenshots or redacted path/value notes. Do not capture
tokens, API keys, WiFi passwords, or other credentials.

## Test Modes

### Mode A: Web-Only Seeded Data Test

This is the safest current mode. Use the Firebase Console or another trusted
administrative test tool in a disposable project to seed the relationship and
device data described in
[`../firebase/e2e-device-test-seed.example.json`](../firebase/e2e-device-test-seed.example.json).
The browser signs in as a normal Firebase Auth user and reads/writes only what
the production rules permit.

Use Mode A to verify Auth initialization, paired-device selection, final live
reads, Settings writes, final history reads, compatibility reads, empty states,
and permission messages. It does not prove that unauthenticated firmware can
write production paths.

### Mode B: Stage A Disposable Firebase Project

Use a separate disposable Firebase project when testing current firmware that
does not yet have product-grade device authentication. Any temporary rules must:

1. be scoped to one disposable `<deviceId>` and only the minimum test paths;
2. avoid global `.read` or `.write`;
3. contain no production or personal data;
4. have a planned removal time;
5. be replaced with the production-oriented rules immediately after testing.

The existing `firebase/database.rules.stage-a-pairing.example.json` supports an
isolated pairing claim test only. It is not a general firmware integration
ruleset and must not be merged into `firebase/database.rules.json`.

### Mode C: Product-Grade Device Authentication

This is the future target. The ESP32 authenticates with a verified device
identity, such as a short-lived custom token containing
`auth.token.deviceId === <deviceId>`, or sends data through a trusted backend
proxy. Mode C should prove final live, config, command, and history paths under
production rules without anonymous device writes.

## Production Rules Warning

The committed `firebase/database.rules.json` is production-oriented and
default-deny. Current firmware uses RTDB REST with a Web API key but does not yet
present the product-grade device auth claim expected by the rules. Direct ESP32
reads/writes to final config, live, command, or history paths may therefore
return permission denied. That is an expected security result, not permission
to relax production rules.

Use Mode A for safe web verification, Mode B only in a disposable project, and
Mode C once secure device auth or a trusted backend proxy exists.

## Prepare Web And Account

- [ ] Confirm the worktree contains no populated env or credential files staged
      for commit.
- [ ] Copy `.env.example` to ignored `.env.local` and fill it locally with the
      selected test project's Web App config.
- [ ] Run `npm run build:web` (`npm.cmd run build:web` on Windows when
      PowerShell script execution blocks `npm`).
- [ ] Confirm the build does not print Firebase values.
- [ ] Serve generated `dist/`, for example:

  ```bash
  python -m http.server 8766 --directory dist
  ```

- [ ] Open `http://127.0.0.1:8766/login.html`.
- [ ] Register a disposable Email/Password user or sign in to an existing test
      user.
- [ ] Record the Auth UID as the replacement for `<uid>`.
- [ ] Confirm `/users/<uid>/profile` exists with `displayName`, `email`, and a
      numeric `createdAt`.
- [ ] Confirm `/users/<uid>/settings` exists and existing values were not
      replaced unexpectedly.
- [ ] Sign out and sign in once more; confirm Auth redirects still work.

## Seed A Paired Test Device

Use the placeholder seed file as a path/value reference. Replace placeholders
only in a disposable local copy that is never committed.

- [ ] Replace `<uid>`, `<deviceId>`, and `<historyId>` with disposable values.
- [ ] Update sample timestamps to current Unix epoch milliseconds where a fresh
      live state is required.
- [ ] Merge only the intended children with Firebase Console or a trusted test
      tool. Do not import the example at the RTDB root of a project containing
      data because root import can replace unrelated data.
- [ ] Confirm `/users/<uid>/devices/<deviceId>` has `role`, `nickname`, and a
      numeric `addedAt`.
- [ ] Confirm `/devices/<deviceId>/ownerUid` equals `<uid>`.
- [ ] Confirm `/devices/<deviceId>/members/<uid>/role` is `owner`.
- [ ] Confirm `/devices/<deviceId>/config` contains every required config field.
- [ ] Confirm `/devices/<deviceId>/live/system` and `/live/device` exist.
- [ ] Confirm `/devices/<deviceId>/history/<historyId>` exists.
- [ ] Do not seed a pairing code unless the isolated pairing test is explicitly
      being run.

Provisioning-owned fields such as `ownerUid`, `paired`, and the first owner
membership cannot be created by an ordinary client under production rules.
That denial is expected. Use Firebase Console/Admin tooling only in a disposable
project, or use the future trusted pairing service.

## Web Dashboard Verification

- [ ] Reload the Dashboard after seeding the device relationship.
- [ ] Confirm the no-device state disappears and the expected nickname/device
      is selected.
- [ ] Confirm the Dashboard reads:

  ```text
  /devices/<deviceId>/live/system
  /devices/<deviceId>/live/device
  ```

- [ ] Change only harmless seeded measurement values such as `voltage`,
      `current`, or `power`; confirm the Dashboard updates.
- [ ] Confirm passive seeded live telemetry renders while the Dashboard remains
      idle; it must not create an active session, write history, or send a
      command automatically.
- [ ] Confirm final fields `timestampUnixMs`, `relayState`, `mode`,
      `wifiStatus`, `activeSsid`, and `firmwareVersion` are accepted.
- [ ] Confirm compatibility fields `timestamp`, boolean/string `relay`,
      `systemMode`, `powerFactor`, and `apparentPower` remain readable when
      tested in the disposable fixture.
- [ ] Confirm a missing optional field renders a safe default rather than
      crashing.
- [ ] Confirm there are no fatal browser console errors.
- [ ] Do not change relay/start/stop fields during this read test.

## Settings And Config Verification

- [ ] Open Settings and confirm personal values load from
      `/users/<uid>/settings`.
- [ ] Save a harmless personal setting and confirm only the expected user
      settings fields change.
- [ ] If the current Settings control supports shared device config, save one
      reviewed test value and confirm `/devices/<deviceId>/config` changes.
- [ ] Confirm the config remains complete and valid; do not seed zero, negative,
      non-numeric, or out-of-range values merely to test rejection on hardware.
- [ ] Revert the changed fixture value after recording evidence.

## Firmware Config And Live Smoke Test

Run this section only with deliberate access to the test ESP32 and a safe
electrical setup.

- [ ] Build the current firmware without source changes:

  ```bash
  pio run -d firmware
  ```

- [ ] Flash the current firmware and open Serial Monitor at `115200`.
- [ ] Confirm relay state is OFF before and after boot.
- [ ] Connect through saved WiFi or the captive portal as needed.
- [ ] Confirm Serial identifies the expected `<deviceId>`.
- [ ] Confirm config logs show the final device config path was attempted and a
      valid config was applied or a safe cached/default config was retained.
- [ ] Confirm config save reports `Local config saved` with no `KEY_TOO_LONG`
      errors, then reboot and confirm the same cached values are loaded.
- [ ] Confirm live logs/path evidence targets `/devices/<deviceId>/live` with
      final `system` and `device` children.
- [ ] If Firebase denies a write, confirm OLED/local monitoring remains usable
      and no session data is lost. `AUTH_REQUIRED (local operation continues)`
      is expected until product-grade device authentication is provisioned.
- [ ] Confirm overload behavior and thresholds remain unchanged.

## Safe Command-Path Verification

Production rules intentionally require an authenticated device claim to read
the primary command path. A permission denial from current unauthenticated
firmware is expected and must not affect local monitoring.

The authenticated owner/operator web command writer targets
`/devices/<deviceId>/commands/current`. Execute Start/Stop only with an approved
hardware safety setup; Mode A passive seeded-data verification does not require
a relay command.

- [ ] Start with the relay physically and logically OFF.
- [ ] Confirm no actionable command exists under
      `/devices/<deviceId>/commands/current`.
- [ ] If a neutral singular-fallback test is required in a disposable project,
      write this only to `/devices/<deviceId>/command`:

  ```json
  {
    "relay": "UNCHANGED",
    "startSession": false,
    "stopSession": false,
    "resetAlarm": false,
    "updatedAt": 1700000000000
  }
  ```

- [ ] Confirm the old singular timestamp produces no action or repeated logs
      after `commands/current` is available.
- [ ] Confirm no unexpected START, STOP, reset, or relay toggle occurs.
- [ ] Remove the neutral command fixture after the test.

## Completed Session And History Verification

Only run a real session with an approved safe load. Never use a relay action
solely to prove Firebase connectivity.

- [ ] Start and stop one controlled session using the existing approved flow.
- [ ] Confirm the completed record is saved to LittleFS before any cloud result.
- [ ] Confirm a failed Firebase write leaves the LittleFS record pending.
- [ ] Confirm a successful final sync creates:

  ```text
  /devices/<deviceId>/history/<historyId>
  ```

- [ ] Confirm transitional dual-write may also create:

  ```text
  /devices/<deviceId>/completedSessions/<historyId>
  ```

- [ ] Confirm the ESP32 does not write `/users/<uid>/history` or contain a
      hardcoded UID.
- [ ] Open web History and confirm final device history is displayed first.
- [ ] Confirm a duplicate final/transitional record with the same
      `id`/`sessionId` renders once.
- [ ] In a disposable fixture only, verify fallback reading from
      `completedSessions` and `/users/<uid>/history` when final history is
      absent.
- [ ] Open History Detail and confirm final fields and legacy aliases render
      without errors.
- [ ] Confirm there are no fatal browser console errors.

## Empty And Permission-State Verification

- [ ] Sign in with a disposable user that has no device relationship; confirm
      the existing no-device state is readable.
- [ ] Use a paired device with no history; confirm the clean no-history state.
- [ ] Use a user without membership to attempt a device read; confirm a readable
      access-denied state rather than a page crash.
- [ ] Serve `web/` directly with placeholders and no Firebase config; confirm
      Dashboard and History remain usable in local visual mode.

## Real Hardware Safety Checklist

- [ ] Current firmware was flashed without code changes.
- [ ] Relay is OFF at boot and does not toggle unexpectedly.
- [ ] OLED boot, setup, idle, monitoring, and error displays remain usable.
- [ ] WiFi/captive portal behavior remains usable.
- [ ] Serial logs show config/live/command/history path attempts clearly.
- [ ] Firebase denial does not stop local monitoring.
- [ ] Session stop saves LittleFS before cloud sync.
- [ ] Offline/pending records remain available after reconnect/reboot.
- [ ] Overload handling remains unchanged.
- [ ] No user UID or real credential appears in Serial output or firmware source.

## Regression Checklist

- [ ] Login and registration still work.
- [ ] No-device state still renders without fatal errors.
- [ ] Pairing panel still validates input and reports trusted-service limits.
- [ ] Device page still renders after a paired relationship exists.
- [ ] Dashboard local visual mode still works without injected Firebase config.
- [ ] Dashboard reads final live paths for a paired device.
- [ ] History reads final device history and preserves fallback reads.
- [ ] Settings save still writes only its intended user/device config paths.
- [ ] Firmware still builds without source changes.
- [ ] OLED local monitoring remains usable.
- [ ] Relay remains OFF unless an existing approved action deliberately changes
      it.

## Result And Follow-Up Template

For each failed item, record:

```text
Test item:
Expected:
Actual:
Mode (A/B/C):
Path involved:
Redacted console/Serial evidence:
Local data still safe in LittleFS?:
Relay remained safe?:
Suggested follow-up issue:
```

Do not patch behavior during this documentation run. Create a focused follow-up
issue for any discovered firmware, web, rules, or backend problem.
