# Token Broker Skeleton

## Status And Scope

`POST /api/device-token` is a production-shaped, fail-closed Node/Vercel
endpoint skeleton for future ESP32 device authentication. It validates the
request boundary, checks server configuration, and then deliberately returns
`501 Not Implemented` because credential verification and token signing are not
implemented yet.

This skeleton does not change firmware, web behavior, Firebase rules, device
queue/history ownership, relay/session/overload behavior, or hardware
assumptions. It must not be treated as a deployed production authentication
service.

The broker is the only component that may eventually hold Firebase Admin
credentials. An ESP32 must never store a Firebase service-account JSON/private
key. A service-account key would let extracted firmware credentials bypass
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

The skeleton accepts only these three fields. `deviceId` must be 3-64
characters and contain only letters, numbers, `_`, or `-`. `deviceSecret` must
be a string between 16 and 4096 characters. `credentialVersion` must be a
positive safe integer.

Planned successful response after the missing security components are
implemented and reviewed:

```json
{
  "customToken": "firebase-custom-token",
  "expiresInSec": 3600
}
```

`expiresInSec` describes the custom-token sign-in window. Firmware must later
use the `expiresIn` returned by Firebase Identity Toolkit when scheduling ID
token refresh.

Current safe responses:

| Status | Error | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | Body or fields are malformed or unexpected. |
| `405` | `method_not_allowed` | Method is not `POST`. |
| `503` | `broker_unavailable` | Required server configuration is missing. |
| `501` | `credential_verification_not_implemented` | The fail-closed credential verifier blocked issuance. |
| `500` | `internal_error` | An unexpected server error occurred. |

Responses are intentionally generic and set `Cache-Control: no-store`. The
endpoint never logs request bodies, device secrets, credentials, or tokens.

## Required Server Environment

Set these only in the backend hosting provider's protected environment:

```text
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
```

For multiline private keys, hosting providers commonly store newlines as
escaped `\n`; the future Admin SDK initialization must normalize that value
without printing it. Missing or blank required variables return a generic
`503 broker_unavailable`. Never prefix these variables with a browser-exposed
public environment convention.

Do not commit `.env`, `.env.local`, service-account JSON, private keys, raw
device secrets, custom tokens, ID tokens, or refresh tokens.

## Credential Verification Boundary

`verifyDeviceCredential(deviceId, deviceSecret, credentialVersion)` currently
always returns:

```json
{
  "verified": false,
  "reason": "not_implemented"
}
```

There is no demo mode and no default-allow path. Before enabling token signing,
the verifier must use a reviewed private credential store and confirm all of
the following:

- The device exists.
- `deviceAuth.enabled === true`.
- The stored credential version matches.
- A protected secret hash matches using a constant-time comparison.
- The device is not revoked.

The production broker must also add HTTPS enforcement, body-size limits, rate
limits, replay protection, credential rotation, revocation, and redacted audit
events. Raw secrets must never be stored in a client-readable RTDB path.

## Broker-Controlled Claims

The caller cannot submit or override claims. After verification, the broker
will derive them from its trusted device and ownership record:

```json
{
  "deviceId": "esp32-voltix-001",
  "deviceRole": "hardware",
  "ownerUid": "trusted-owner-record-uid",
  "credentialVersion": 1
}
```

The token subject should use a hardware namespace such as
`device:esp32-voltix-001`, never a human user's Firebase Auth UID. `ownerUid`
is metadata from the trusted broker record, not permission for firmware to
write `/users/{uid}/history`. One ESP32 may still be shared by multiple user
accounts, and the logged-in web app remains responsible for projecting the
device completed-session queue into `/users/{currentUser.uid}/history`.

## Future Firmware Integration

No firmware behavior changes in this sprint. A later reviewed integration will:

1. Provision a unique, rotatable device credential without a service-account
   key.
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

The tests use placeholder values only. With all required environment variables
present, a valid request must still receive `501` until the verifier and signer
are intentionally implemented. See
[`device-token-broker-pseudocode.md`](device-token-broker-pseudocode.md) and
[`esp32-production-device-auth-plan.md`](esp32-production-device-auth-plan.md)
for the broader design and rollout gates.
