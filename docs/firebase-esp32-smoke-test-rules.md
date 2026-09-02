# DEV-Only ESP32 Firebase RTDB Smoke-Test Rules

> **Temporary hardware test mode only.** Use this procedure only with the
> disposable device ID `esp32-voltix-001` in a disposable or explicitly
> approved development Firebase project. Restore production rules immediately
> after testing.

The current ESP32 uses Firebase RTDB REST with a Web API key but no
authenticated device token. The production-oriented rules in
[`../firebase/database.rules.json`](../firebase/database.rules.json) therefore
correctly reject its requests with `401 AUTH_REQUIRED`. Local operation and
LittleFS history must continue safely when that happens.

This guide temporarily enables hardware smoke testing. It does not change the
production Auth model and is not product-grade device authentication.

## Safety Boundaries

- Do not edit or replace the committed production default
  `firebase/database.rules.json`.
- Do not merge the DEV-only example into production rules.
- Do not deploy the DEV-only example to a production project or a project
  containing real user data.
- Do not use broad root-level or wildcard public `.read` or `.write` rules.
- Do not put database secrets, service-account credentials, permanent device
  tokens, real UIDs, or other secrets in firmware.
- Keep relay/session behavior unchanged. Begin with the relay OFF and a safe
  test load.
- Every completed session must be saved to LittleFS before its cloud history
  write is considered successful.
- The ESP32 remains device-scoped. The logged-in web user owns the copy into
  `/users/{currentUser.uid}/history`.

## What The Example Allows

[`../firebase/database.rules.esp32-smoke-test.example.json`](../firebase/database.rules.esp32-smoke-test.example.json)
is a complete, standalone temporary ruleset. It is deny-by-default everywhere
except the following paths for the exact disposable device ID
`esp32-voltix-001`:

| Path | Unauthenticated ESP32 access | Authenticated web access |
| --- | --- | --- |
| `/devices/esp32-voltix-001/config` | Read | Read; owner write |
| `/devices/esp32-voltix-001/live` | Write | Production member read access |
| `/devices/esp32-voltix-001/command` | Read | Production owner/operator write access |
| `/devices/esp32-voltix-001/commands/current` | Read and clear after processing | Owner/operator write access |
| `/devices/esp32-voltix-001/commands/lastAck` | Write acknowledgement | Member read access |
| `/devices/esp32-voltix-001/history` | Write final cloud history | Member read access |
| `/devices/esp32-voltix-001/completedSessions` | Write transitional dual-write | Member read access |

The example also retains authenticated, UID-scoped `/users/{uid}` access needed
for the signed-in dashboard and history import. It does not grant temporary
public access to `/users` or other devices.

Because RTDB rules are not an overlay/merge format, publishing the example
temporarily replaces the active ruleset. All paths not listed above, including
every other device ID remains denied while it is active.
Normal shared-device authorization should be tested only after
production rules are restored.

The fallback `commands/current` delete is temporarily public because the
current firmware clears that path after processing. Other writes remain
owner/operator-only. This exception is one reason the example must never remain
deployed.

## Prepare

- [ ] Confirm the Firebase project is disposable or explicitly approved for
      this temporary test.
- [ ] Confirm the only hardware device under test is
      `esp32-voltix-001`.
- [ ] Confirm the signed-in disposable test account is already linked to
      `esp32-voltix-001`; do not run production traffic while temporary rules are active.
- [ ] Record the project name, tester, start time, and planned restore time.
- [ ] Save/export the currently published RTDB rules for comparison.
- [ ] Confirm the repository production rules file is unchanged:

  ```powershell
  git diff -- firebase/database.rules.json
  ```

- [ ] Keep the relay OFF before publishing temporary rules or rebooting the
      ESP32.

## Temporarily Publish The DEV Rules

1. Open Firebase Console for the approved development project.
2. Go to **Realtime Database > Rules**.
3. Copy the complete contents of
   `firebase/database.rules.esp32-smoke-test.example.json` into the editor.
4. Verify the only literal device ID is `esp32-voltix-001`, root access remains
   false, and there is no public wildcard device rule.
5. Publish the temporary rules.
6. Record the publish time and begin the smoke test immediately.

Do not copy these rules into `firebase/database.rules.json`. Do not leave the
Firebase Console unattended while temporary rules are active.

## Hardware Smoke-Test Checklist

- [ ] Reboot or reconnect the ESP32 and capture redacted serial logs.
- [ ] Confirm config read succeeds:

  ```text
  GET /devices/esp32-voltix-001/config.json status=200 OK
  ```

- [ ] Confirm live telemetry write succeeds:

  ```text
  PATCH /devices/esp32-voltix-001/live.json status=200 OK
  ```

- [ ] Confirm primary command polling succeeds:

  ```text
  GET /devices/esp32-voltix-001/commands/current.json status=200 OK
  ```

- [ ] Sign in to the web dashboard with Firebase Auth.
- [ ] From the web dashboard, issue a safe Start command and verify it writes
      only to `/devices/esp32-voltix-001/commands/current`.
- [ ] Confirm serial reports fresh command age/relay latency and applies the
      existing Start validation flow.
- [ ] Stop the test session through the existing safe flow.
- [ ] Confirm serial/storage evidence shows the completed session was saved to
      LittleFS before either cloud history write.
- [ ] Confirm the device writes the final session to
      `/devices/esp32-voltix-001/history/{sessionId}` and/or the transitional
      `/devices/esp32-voltix-001/completedSessions/{sessionId}` path.
- [ ] Confirm the logged-in web app copies the completed-session queue item to
      `/users/{currentUser.uid}/history/{sessionId}` without placing a UID in
      firmware.

If any unexpected relay/session behavior occurs, stop the test and restore
production rules. Do not change firmware behavior as part of this procedure.

## Restore Production Rules

1. Open **Realtime Database > Rules** in Firebase Console.
2. Replace the temporary rules with the complete contents of
   `firebase/database.rules.json`.
3. Publish and record the restore time.
4. Compare the active rules with `firebase/database.rules.json`.

Restore verification checklist:

- [ ] Confirm no public rule for `esp32-voltix-001` remains active.
- [ ] Reboot or reconnect the ESP32.
- [ ] Confirm unauthenticated firmware requests again return the expected
      production result, for example:

  ```text
  GET /devices/esp32-voltix-001/config.json status=401 AUTH_REQUIRED (local operation continues)
  PATCH /devices/esp32-voltix-001/live.json status=401 AUTH_REQUIRED (local operation continues)
  GET /devices/esp32-voltix-001/command.json status=401 AUTH_REQUIRED (local operation continues)
  GET /devices/esp32-voltix-001/commands/current.json status=401 AUTH_REQUIRED (local operation continues)
  ```

- [ ] Confirm local monitoring remains available and pending cloud sync data
      remains safe in LittleFS.
- [ ] Confirm authenticated web access follows the production shared-device
      rules again.
- [ ] Keep redacted hardware-test notes, results, and timestamps.
- [ ] Confirm production rules were not changed in the worktree:

  ```powershell
  git diff --exit-code -- firebase/database.rules.json
  ```

## Product-Grade Follow-Up

The final solution is authenticated device access, such as a short-lived custom
token carrying a verified `auth.token.deviceId`, or a trusted backend proxy.
Temporary public device-path access is only a bridge for hardware smoke
testing.
