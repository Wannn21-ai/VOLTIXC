# Firmware Device Authentication Scaffold

## Status And Safety Boundary

The ESP32 firmware contains an opt-in device-auth client scaffold based on the
proven token broker E2E flow:

```text
ESP32 -> token broker -> custom token
      -> Identity Toolkit -> ID token
      -> authenticated RTDB REST
```

It is disabled by default with `VOLTIX_DEVICE_AUTH_ENABLED=0`. With the default
configuration, existing firmware behavior remains unchanged: RTDB REST uses the
current unauthenticated path, Firebase may return `401 AUTH_REQUIRED`, and
local operation continues safely.

This scaffold does not change relay/session/overload behavior, PZEM/load
detection, command semantics, Firebase paths/rules, or LittleFS-first completed
session handling.

## Private Local Configuration

Copy [`../firmware/include/credentials.h.example`](../firmware/include/credentials.h.example)
to ignored `firmware/include/credentials.h`. Keep the committed defaults
disabled and empty:

```cpp
#define VOLTIX_DEVICE_AUTH_ENABLED 0
#define VOLTIX_TOKEN_BROKER_URL ""
#define VOLTIX_DEVICE_SECRET ""
#define VOLTIX_DEVICE_CREDENTIAL_VERSION 1
#define VOLTIX_TOKEN_BROKER_ROOT_CA ""
#define VOLTIX_IDENTITY_TOOLKIT_ROOT_CA ""
#define VOLTIX_FIREBASE_RTDB_ROOT_CA ""
```

Never commit the broker URL, device secret, tokens, private keys, service
account values, peppers, WiFi credentials, or a populated credentials header.
Root CA certificates are public, but must still be reviewed and maintained.

Before enabling auth locally:

1. Confirm the live token-broker E2E smoke test succeeds.
2. Provision the exact device credential/version for
   `esp32-voltix-001`.
3. Set the reviewed HTTPS broker URL and unique device secret locally.
4. Set reviewed PEM root CA certificates for the broker, Identity Toolkit, and
   Firebase RTDB.
5. Change only the ignored local definition to
   `VOLTIX_DEVICE_AUTH_ENABLED=1`.

If any required value or CA certificate is missing, the firmware fails closed
with `configuration_missing` and skips authenticated cloud requests. Device
auth never sends credentials using `WiFiClientSecure::setInsecure()`.

## Runtime State

`DeviceAuthState` tracks:

```text
enabled
authenticated
authRefreshInProgress
idToken
refreshToken
expiresAtMs
lastAuthAttemptMs
lastAuthHttpStatus
lastAuthError
```

The custom token exists only long enough to exchange it. Tokens and the device
secret are never printed. ID and refresh tokens remain in volatile memory only;
they are not written to LittleFS or Preferences.

The scaffold currently tracks the refresh token but performs bounded broker
re-sign-in when a token expires or RTDB returns `401`. A future reviewed change
may add direct Secure Token refresh.

## RTDB Request Behavior

All existing RTDB calls continue through the central Firebase REST helper.

- Auth disabled: preserve the existing URL and request behavior.
- Auth enabled with a valid token: append `?auth=<ID_TOKEN>`.
- Auth enabled without a valid token: attempt broker sign-in once; on failure,
  skip the cloud request, apply a bounded retry backoff, and continue local
  operation.
- Authenticated RTDB `401`: clear auth state, re-sign-in once, and retry the
  original request once.
- Retry failure: stop retrying, mark auth unavailable, and continue local
  operation.

There is no unbounded retry loop. Existing pending LittleFS history remains
pending when cloud sync fails.

## Redacted Diagnostics

The existing Serial `status` command now includes:

```text
[auth] enabled=<true|false> authenticated=<true|false> expiresInSec=<n> lastStatus=<status> lastError=<generic>
```

Diagnostics never print the broker URL, secret, custom token, ID token, refresh
token, API key, or CA contents.

## Verification

Default disabled build:

```powershell
C:\Users\dspas\.platformio\penv\Scripts\platformio.exe run -d firmware
```

Before any later live opt-in, re-check:

- relay remains OFF at boot;
- failed auth does not interrupt a session;
- completed sessions save to LittleFS before cloud sync;
- failed cloud sync remains pending;
- Serial output contains no secrets or tokens.
