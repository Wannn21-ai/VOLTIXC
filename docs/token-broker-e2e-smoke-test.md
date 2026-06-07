# Token Broker Lab Provisioning And E2E Smoke Test

## Purpose And Boundaries

This workflow proves the authenticated device chain before firmware changes:

```text
local secret + server pepper + RTDB deviceAuth
-> POST /api/device-token
-> Firebase custom token
-> Identity Toolkit ID token
-> production-rule RTDB config read
-> optional harmless RTDB live marker
```

It is restricted to the lab device `esp32-voltix-001`. The scripts do not
change firmware, web behavior, Firebase rules, smoke-test rules, relay/session
logic, overload behavior, or hardware assumptions.

Run this only from a trusted local machine against a reviewed Firebase project.
Never commit populated env files, device secrets, peppers, service-account
keys, custom tokens, ID tokens, refresh tokens, or real UIDs.

## Secret Ownership

| Value | Where it belongs |
| --- | --- |
| `DEVICE_AUTH_PEPPER` | Token broker and trusted provisioning process only |
| `DEVICE_SECRET` | Lab provisioning process and future device only |
| Firebase Admin env | Token broker and trusted provisioning process only |
| `FIREBASE_API_KEY` | Local smoke client; identifies project but is not authorization |
| Custom/ID tokens | Process memory for the smoke run only |

The scripts never print raw secrets or full tokens. Smoke output includes only
12-character SHA-256 token fingerprints so steps can be correlated without
revealing usable tokens.

## Prerequisites

Before provisioning, confirm these existing RTDB relationships:

```text
/devices/esp32-voltix-001/ownerUid = <ownerUid>
/devices/esp32-voltix-001/members/<ownerUid>/role = "owner"
```

The provisioning script refuses to write if either relationship is missing or
mismatched. It never creates or changes ownership/membership.

This sprint does not change Firebase rules. Do not treat `secretHash` as a
standalone secret or rely on rules alone to protect it: the committed rules may
allow the device owner to read the parent device record. The raw device secret
and server-only pepper must remain protected and high entropy. Restricting
device-auth metadata further is a separate reviewed rules-hardening task.

Install dependencies and run offline tests first:

```powershell
npm.cmd install
npm.cmd run test:token-broker
npm.cmd run test:device-auth-lab
```

## Local Environment

Set values in the current trusted shell or an ignored `.env.local` workflow.
The scripts read process environment variables directly; they do not
automatically load env files.

Provisioning requires:

```text
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
FIREBASE_DATABASE_URL
DEVICE_AUTH_PEPPER
DEVICE_SECRET
CREDENTIAL_VERSION=1
OWNER_UID
DEVICE_ID=esp32-voltix-001
```

The E2E smoke script requires:

```text
TOKEN_BROKER_URL
DEVICE_SECRET
CREDENTIAL_VERSION=1
FIREBASE_API_KEY
FIREBASE_DATABASE_URL
DEVICE_ID=esp32-voltix-001
```

`TOKEN_BROKER_URL` must use HTTPS. Plain HTTP is accepted only for explicit
`localhost` or `127.0.0.1` development URLs; there is no implicit default URL.

## Generate And Verify The Hash

The versioned hash identifier is `sha256-pepper-v1`. Its exact derivation is:

```text
sha256(`${DEVICE_AUTH_PEPPER}:${deviceId}:${credentialVersion}:${deviceSecret}`)
```

Generate the lowercase hexadecimal hash locally:

```powershell
$env:DEVICE_AUTH_PEPPER="<server-only-high-entropy-pepper>"
$env:DEVICE_SECRET="<unique-high-entropy-lab-device-secret>"
npm.cmd run hash:device-secret -- esp32-voltix-001 1
```

The helper prints only the derived hash. Re-running it with the same inputs
must return the same value. Changing the secret, pepper, device ID, or
credential version must return a different value.

Do not paste the raw secret or pepper into RTDB. Only the derived hash belongs
in `deviceAuth.secretHash`.

## Provision DeviceAuth

The provisioning script uses Firebase Admin, verifies the existing owner
relationship, computes the hash locally, and compares it with any existing
versioned `deviceAuth` hash. It writes only device-auth fields and defaults to
a read-only dry run:

```powershell
npm.cmd run provision:device-auth
```

Expected result:

```text
[provision] Dry run passed for esp32-voltix-001; hash <matches existing record|would update record>; no RTDB write performed.
```

After reviewing the target project, UID, and lab device, opt in to the write:

```powershell
npm.cmd run provision:device-auth -- --apply
```

It updates only:

```text
/devices/esp32-voltix-001/deviceAuth/enabled = true
/devices/esp32-voltix-001/deviceAuth/revoked = false
/devices/esp32-voltix-001/deviceAuth/credentialVersion = 1
/devices/esp32-voltix-001/deviceAuth/hashAlg = "sha256-pepper-v1"
/devices/esp32-voltix-001/deviceAuth/secretHash = "<computed hash>"
```

Existing metadata such as `lastTokenIssuedAt` and `lastSeenAt` is preserved.
The Admin script bypasses client rules by design; use it only from a trusted
operator environment.

## Run The E2E Smoke Test

The default smoke run performs no RTDB write:

```powershell
npm.cmd run smoke:device-token
```

It performs:

1. `POST TOKEN_BROKER_URL` with the lab device credential.
2. Identity Toolkit `accounts:signInWithCustomToken`.
3. Verify Identity Toolkit returns `localId = device:esp32-voltix-001`.
4. Authenticated `GET /devices/esp32-voltix-001/config.json`.

Expected output shape:

```text
[smoke] Token broker: 200; custom token fp=<redacted fingerprint>
[smoke] Identity Toolkit: 200; ID token fp=<redacted fingerprint>
[smoke] RTDB config read: 200
[smoke] RTDB live patch skipped; pass --live-patch to opt in.
```

To also prove the production hardware claim can write `live`, explicitly opt
in:

```powershell
npm.cmd run smoke:device-token -- --live-patch
```

The write is restricted to this harmless marker:

```text
/devices/esp32-voltix-001/live/tokenBrokerSmoke
```

```json
{
  "checkedAt": 1780000000000,
  "source": "token-broker-e2e"
}
```

It does not write commands, relay state, session state, history, config, or
user paths.

## Expected Failure Checks

Run these deliberately one at a time, then restore the correct value:

| Check | Expected result |
| --- | --- |
| Missing required local env | Script fails before any request/Admin access |
| Wrong `DEVICE_SECRET` | Broker returns generic HTTP `401` |
| Wrong `CREDENTIAL_VERSION` | Broker returns generic HTTP `401` |
| `deviceAuth.revoked = true` | Broker returns generic HTTP `401` |
| Broker missing server env | Broker returns generic HTTP `503` |
| Non-local HTTP broker URL | Smoke script refuses before request |
| Owner/member mismatch | Provisioning refuses before write |

The scripts report only the failed stage and HTTP status. They do not print
response bodies that might contain tokens or sensitive service details.

## Cleanup And Evidence

After the run:

1. Remove `/devices/esp32-voltix-001/live/tokenBrokerSmoke` through trusted
   Admin tooling if the optional patch was used.
2. Clear `DEVICE_SECRET`, `DEVICE_AUTH_PEPPER`, and Admin variables from the
   shell.
3. Keep only redacted statuses/fingerprints as evidence.
4. Confirm no repository rules or runtime surfaces changed:

   ```powershell
   git diff --exit-code -- firmware web firebase
   ```

Do not place the lab secret into firmware as part of this sprint. Firmware
integration remains a separate reviewed change.
