# ESP32 Device Authentication Lab Checklist

## Scope And Safety

This checklist enables device authentication only from the ignored local
`firmware/include/credentials.h` file. The committed default remains
`VOLTIX_DEVICE_AUTH_ENABLED=0`.

Authentication failure must only pause cloud access. Relay, session, overload,
PZEM/load detection, and LittleFS-first completed-session behavior must remain
available under their existing local-safe behavior.

Never commit or print a real device secret, custom token, ID token, refresh
token, service-account value, private key, pepper, populated `.env.local`, or
populated `credentials.h`.

## Private Local Opt-In

1. Copy `firmware/include/credentials.h.example` to the ignored
   `firmware/include/credentials.h` if the private file does not already exist.
2. Keep WiFi and Firebase values private.
3. Set these auth values only in the ignored file:

   ```cpp
   #define VOLTIX_DEVICE_AUTH_ENABLED 1
   #define VOLTIX_TOKEN_BROKER_URL "https://<reviewed-host>/api/device-token"
   #define VOLTIX_DEVICE_SECRET "<private-device-secret>"
   #define VOLTIX_DEVICE_CREDENTIAL_VERSION 1
   #define VOLTIX_TOKEN_BROKER_ROOT_CA R"PEM(<reviewed-pem-root-ca>)PEM"
   #define VOLTIX_IDENTITY_TOOLKIT_ROOT_CA R"PEM(<reviewed-pem-root-ca>)PEM"
   #define VOLTIX_SECURE_TOKEN_ROOT_CA R"PEM(<reviewed-pem-root-ca>)PEM"
   #define VOLTIX_FIREBASE_RTDB_ROOT_CA R"PEM(<reviewed-pem-root-ca>)PEM"
   ```

The broker URL must use HTTPS. Auth fails closed when a required value or
reviewed root CA is missing. There is no lab-insecure TLS opt-in.

## Exact Lab Run

1. Deploy or run the existing token broker endpoint without changing its
   behavior.
2. From the repository root, confirm the broker flow still passes:

   ```powershell
   npm.cmd run smoke:device-token
   npm.cmd run test:token-broker
   npm.cmd run test:device-auth-lab
   ```

3. Create or update the ignored private firmware config as described above.
4. Build and upload:

   ```powershell
   C:\Users\dspas\.platformio\penv\Scripts\platformio.exe run -d firmware
   C:\Users\dspas\.platformio\penv\Scripts\platformio.exe run -d firmware -t upload
   ```

5. Open Serial Monitor at `115200`. Confirm the expected redacted shape:

   ```text
   [auth] enabled=true authenticated=true expiresInSec=<n> lastStatus=200 lastError=none
   [firebase] PATCH /devices/esp32-voltix-001/live.json status=200 OK
   [firebase] GET /devices/esp32-voltix-001/commands/current.json status=200 OK
   ```

6. Confirm authenticated config reads and live patches succeed with production
   rules. Do not seed an actionable command during the auth-only proof.
7. Confirm relay boot default, local OFF control, session/load validation,
   overload behavior, and PZEM readings remain unchanged.
8. Complete one controlled session. Confirm LittleFS saves first, then confirm
   pending device-scoped history starts syncing only after auth succeeds.

## Failure And Bounded Retry Checks

- [ ] Wrong or revoked credential produces only a generic auth failure.
- [ ] Missing root CA or auth value produces `configuration_missing`.
- [ ] NTP not ready produces `time_not_ready` without sending credentials.
- [ ] Identity Toolkit failure prints only a redacted status such as
      `[auth] identity exchange HTTP 400`, never its response body or tokens.
- [ ] An RTDB `401` triggers one refresh and one RTDB retry only.
- [ ] A repeated `401` produces `rtdb_unauthorized_after_retry` and local
      operation continues.
- [ ] Serial contains no secret, token, API key, URL query, CA, private key,
      service-account value, or pepper.
- [ ] Failed cloud history sync remains pending in LittleFS.

## Restore

1. Set `VOLTIX_DEVICE_AUTH_ENABLED` back to `0` in the ignored private file or
   remove the private auth values.
2. Rebuild/upload only if the lab device must return to disabled-auth firmware.
3. Confirm `git status --short --ignored` shows private files as ignored and no
   secret-bearing file is staged.
