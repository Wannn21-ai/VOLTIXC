# End-to-end Firebase device test

This checklist validates the shared VOLTIX device without changing relay,
session, overload, history, or recovery behavior.

## Test identity

- Use the disposable device ID `esp32-voltix-001` or another explicitly
  isolated test ID.
- Provision only `/devices/{deviceId}/deviceAuth` with the trusted Admin helper.
- Never put the raw device secret, server pepper, Admin key, ID token, or refresh
  token in RTDB, firmware logs, screenshots, or commits.

## Prepare data

Use `firebase/e2e-device-test-seed.example.json` as a shape reference. The
device record needs a valid `config` object and protected `deviceAuth` metadata.
Web users need only normal Firebase Auth email/password accounts; no per-user
device index is required.

## Verify hardware authentication

1. Run `npm.cmd run test:token-broker` and
   `npm.cmd run test:device-auth-lab`.
2. Provision the derived credential with
   `npm.cmd run provision:device-auth -- --apply`.
3. Run `npm.cmd run smoke:device-token`.
4. Confirm the token subject is `device:{deviceId}` and claims contain the
   matching `deviceId`, `deviceRole: "hardware"`, and `credentialVersion`.
5. Confirm a wrong secret, revoked record, or mismatched version returns a
   generic unauthorized response.

## Verify device and web paths

- ESP32 can read `/devices/{deviceId}/config`.
- ESP32 can write `/devices/{deviceId}/live`.
- ESP32 can read and clear `/devices/{deviceId}/commands/current`.
- ESP32 can write `/devices/{deviceId}/commands/lastAck`.
- A signed-in web user can read live/config/history and write a command.
- Anonymous clients and hardware tokens for another device ID are denied.
- `/devices/{deviceId}/deviceAuth` remains unreadable to browser and hardware
  clients.

## Verify history projection

1. Stop a real or controlled test session.
2. Confirm the ESP32 saves it to LittleFS first.
3. Confirm it uploads to the device history/completed-session queue.
4. Sign in as user A and confirm the web copies the record to
   `/users/{userA.uid}/history`.
5. Sign in as user B and confirm the same shared device is accessible while
   user B's history remains under `/users/{userB.uid}/history`.
6. Interrupt Firebase during upload and confirm the LittleFS record stays
   pending for later sync.

## Safety regression

- ONLINE/OFFLINE mode selection remains unchanged except the existing one-shot
  direct ONLINE entry after captive-portal Wi-Fi save.
- Relay, overload, load validation, monitoring transitions, history cleanup,
  checkpoint, and recovery behavior remain unchanged.
- A reboot does not create a session; an existing checkpoint follows the
  existing recovery flow.
