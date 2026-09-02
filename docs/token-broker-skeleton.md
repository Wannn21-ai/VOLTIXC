# Token Broker Credential Verification

## Status And Scope

`POST /api/device-token` is a fail-closed Node/Vercel endpoint for ESP32 device
authentication. It validates the request boundary, verifies a provisioned
device credential against server-side RTDB data through Firebase Admin, and
creates a Firebase custom token only after every credential check succeeds.

This implementation does not change firmware, web behavior, Firebase rules,
device queue/history ownership, relay/session/overload behavior, or hardware
assumptions.

The broker is the only component that holds Firebase Admin credentials and the
device-auth pepper. An ESP32 must never store a Firebase service-account
JSON/private key or the server pepper. Extracted Admin credentials could bypass
normal Firebase rules across the project.

## Endpoint Contract

Request:

```http
POST /api/device-token
Content-Type: application/json
```

```json
{
  "deviceId": "esp32-voltix-001",
  "deviceSecret": "provisioned-high-entropy-secret",
  "credentialVersion": 1
}
```

The endpoint accepts only these three fields. `deviceId` must be 3-64
characters and contain only letters, numbers, `_`, or `-`. `deviceSecret` must
be a string between 16 and 4096 characters. `credentialVersion` must be a
positive safe integer.

Successful response:

```json
{
  "customToken": "firebase-custom-token",
  "expiresInSec": 3600
}
```

`expiresInSec` describes the custom-token sign-in window. Firmware must later
use the `expiresIn` returned by Firebase Identity Toolkit when scheduling ID
token refresh.

| Status | Error | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | Body or fields are malformed or unexpected. |
| `401` | `invalid_device_credential` | Any unknown, disabled, revoked, mismatched, or invalid credential. |
| `405` | `method_not_allowed` | Method is not `POST`. |
| `503` | `broker_unavailable` | Required server config is missing or Admin initialization failed. |
| `500` | `internal_error` | An unexpected Admin/runtime error occurred. |

Responses are intentionally generic and set `Cache-Control: no-store`. The
endpoint never logs request bodies, device secrets, hashes, credentials, or
tokens.

## Required Server Environment

Set these only in the backend hosting provider's protected environment:

```text
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
FIREBASE_DATABASE_URL=
DEVICE_AUTH_PEPPER=
```

`FIREBASE_DATABASE_URL` is also used by the existing web build configuration,
but `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, and `DEVICE_AUTH_PEPPER`
are server-only. Never expose them through public/browser environment
conventions.

For multiline private keys, store newlines as escaped `\n`; the endpoint
normalizes them during Admin initialization without printing the value.
`DEVICE_AUTH_PEPPER` must be a high-entropy server-only value and must never be
sent to an ESP32 or stored in RTDB. Missing/blank required variables fail
closed before Firebase Admin initializes.

Do not commit `.env`, `.env.local`, service-account JSON, private keys, raw
device secrets, the pepper, custom tokens, ID tokens, or refresh tokens.

## Firebase Admin And Verification

The broker initializes one named Firebase Admin app per warm serverless runtime
and uses Admin privileges to read `/devices/{deviceId}`. It requires:

- `deviceAuth.enabled === true`.
- `deviceAuth.revoked !== true`.
- `deviceAuth.credentialVersion` exactly matches the request.
- `deviceAuth.hashAlg === "sha256-pepper-v1"`.
- `deviceAuth.secretHash` matches a freshly computed digest using a
  constant-time comparison.

All credential failures return the same generic `401`; the caller cannot learn
whether a device exists or which check failed. There is no demo/default-allow
path.

The digest is lowercase hexadecimal:

```text
sha256(`${DEVICE_AUTH_PEPPER}:${deviceId}:${credentialVersion}:${deviceSecret}`)
```

The raw secret is accepted only over the deployed HTTPS endpoint and is never
stored or returned. The production target should prevent client reads of
device-auth hashes; until separately reviewed rules hardening exists, do not
treat `secretHash` as confidential or as a substitute for protecting the raw
secret and server-only pepper.

After verification and custom-token creation succeed, the broker updates
`deviceAuth.lastTokenIssuedAt` and `deviceAuth.lastSeenAt`. Failed verification
never creates a token or updates metadata.

Future hardening still requires deployment-level HTTPS enforcement, body-size
limits, rate limiting, replay protection, credential rotation/revocation
operations, and redacted audit events.

## Safe Lab Provisioning

Generate a unique high-entropy device secret and a separate high-entropy server
pepper locally. Keep both out of shell history where possible and never commit
them. Set them in the local process environment, then compute the provisioning
hash:

```powershell
$env:DEVICE_AUTH_PEPPER="<server-only-pepper>"
$env:DEVICE_SECRET="<unique-device-secret>"
npm.cmd run hash:device-secret -- esp32-voltix-001 1
```

The helper validates its inputs and prints only the derived hash. Provision the
resulting server-side record through a trusted Admin/operator path:

```json
{
  "deviceAuth": {
    "enabled": true,
    "revoked": false,
    "credentialVersion": 1,
    "hashAlg": "sha256-pepper-v1",
    "secretHash": "<helper-output>"
  }
}
```

Clear `DEVICE_SECRET` from the shell after provisioning. Do not put the raw
secret or pepper in RTDB.

## Broker-Controlled Claims

The caller cannot submit or override claims. After verification, the broker
derives claims from the trusted device record:

```json
{
  "deviceId": "esp32-voltix-001",
  "deviceRole": "hardware",
  "credentialVersion": 1
}
```

The custom-token subject is `device:{deviceId}`, never a human user's Firebase
Auth UID. One ESP32 may be shared by multiple user accounts, and the logged-in
web app remains responsible for copying the device
completed-session queue into `/users/{currentUser.uid}/history`.

## Future Firmware Integration

No firmware behavior changes in this sprint. A later reviewed integration will:

1. Provision a unique, rotatable device credential without an Admin key.
2. Request a custom token over certificate-validated HTTPS.
3. Exchange it through Firebase Identity Toolkit using the Firebase Web API
   key.
4. Use the returned short-lived ID token only for device-scoped RTDB requests.
5. Refresh with bounded retry/backoff and preserve local operation on failure.

Authentication failure must not interrupt sessions, toggle the relay, alter
overload behavior, or discard LittleFS pending data.

## Local Verification

Run the focused tests:

```bash
npm run test:token-broker
```

The tests use mocked Firebase Admin services and placeholder values only. They
do not contact Firebase or require real credentials. See
[`token-broker-e2e-smoke-test.md`](token-broker-e2e-smoke-test.md) for the
explicit lab provisioning and live E2E workflow, and see
[`device-token-broker-pseudocode.md`](device-token-broker-pseudocode.md) and
[`esp32-production-device-auth-plan.md`](esp32-production-device-auth-plan.md)
for the broader design and rollout gates.
