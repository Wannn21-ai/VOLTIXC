# ESP32 Production Device Authentication Plan

## Status And Scope

This is the architecture plan for Issue #49. It does not activate device
authentication, change firmware or web behavior, deploy a backend, change
`firebase/database.rules.json`, or contain real credentials.

The target keeps the existing safety and data-ownership contracts:

- `deviceId` is a stable device identity and is never a user UID.
- One ESP32 may be shared by multiple Firebase Auth users.
- The ESP32 never hardcodes a user UID or writes `/users/{uid}/history`.
- Every completed session is saved to LittleFS before cloud sync.
- Failed authentication or Firebase access leaves local operation safe and
  completed sessions pending in LittleFS.

The recommended production model is a trusted token broker issuing Firebase
custom tokens to known devices. The ESP32 exchanges a custom token for a
short-lived Firebase ID token, then presents the ID token on its device-scoped
RTDB REST requests.

## Trust Boundaries

| Component | Trusted for | Must not contain/do |
| --- | --- | --- |
| ESP32 | Prove possession of its rotatable device credential; use short-lived tokens; operate safely offline | Service-account key, Admin SDK credential, user UID authorization, public-rule assumptions |
| Token broker | Verify device credential/state; issue narrowly claimed custom tokens; rotate/revoke credentials | Return service-account material; trust caller-supplied claims |
| Firebase Auth | Exchange custom token and refresh token for ID tokens | Treat the Web API key as authorization |
| RTDB rules | Enforce signed-in web access and same-device hardware claims | Grant anonymous device access |
| Logged-in web app | Read the shared device queue and project records to the current user's history | Give its user token or UID to the ESP32 |

## Recommended Token Flow

Use a unique Firebase Auth UID namespace for hardware, such as
`device:esp32-voltix-001`. Do not use a human user's UID for a device token.

1. The ESP32 connects to the trusted token broker over certificate-validated
   HTTPS and sends its stable `deviceId`, credential version, and a proof of its
   device credential.
2. The broker verifies the credential, device enabled state, rate limits,
   replay protection, and provisioning record.
3. The broker uses the Firebase Admin SDK to create a short-lived custom token
   for the hardware UID with broker-controlled claims.
4. The ESP32 sends the custom token to Identity Toolkit:

   ```text
   POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=<WEB_API_KEY>
   ```

   ```json
   {
     "token": "<CUSTOM_TOKEN>",
     "returnSecureToken": true
   }
   ```

5. Identity Toolkit returns an `idToken`, `refreshToken`, `expiresIn`, and
   `localId`. The ESP32 verifies `localId` matches the expected hardware UID.
   Firebase custom tokens are sign-in artifacts with a limited validity window;
   the returned `expiresIn` value, normally about one hour for an ID token, is
   the firmware's authority for refresh scheduling.
6. The ESP32 uses the ID token on RTDB REST requests:

   ```text
   PATCH /devices/esp32-voltix-001/live.json?auth=<ID_TOKEN>
   GET /devices/esp32-voltix-001/command.json?auth=<ID_TOKEN>
   PUT /devices/esp32-voltix-001/history/<sessionId>.json?auth=<ID_TOKEN>
   ```

7. Before expiry, the ESP32 exchanges the refresh token at:

   ```text
   POST https://securetoken.googleapis.com/v1/token?key=<WEB_API_KEY>
   Content-Type: application/x-www-form-urlencoded

   grant_type=refresh_token&refresh_token=<REFRESH_TOKEN>
   ```

8. On an RTDB `401`, firmware refreshes once and retries the original request
   once. Repeated failure returns to a bounded backoff; it must not loop,
   interrupt a session, toggle the relay, or discard pending LittleFS data.
9. On credential revocation, claim/version mismatch, or a broker denial, the
   device stays locally usable under existing safety behavior but loses
   production cloud access until reprovisioned.

The Web API key is required by the Firebase Auth REST endpoints, but it is not
an authorization secret. Authorization comes from the signed ID token and RTDB
rules.

## Device Identity And Credential Records

Recommended authoritative relationship and device-auth metadata:

```text
/devices/{deviceId}/deviceAuth/enabled
/devices/{deviceId}/deviceAuth/credentialVersion
/devices/{deviceId}/deviceAuth/keyHash
/devices/{deviceId}/deviceAuth/lastTokenIssuedAt
/devices/{deviceId}/deviceAuth/lastSeenAt
/devices/{deviceId}/deviceAuth/revokedAt
```

`deviceId` is assigned during provisioning and persisted locally. A device
credential must be unique, randomly generated, rotatable, and stored separately
from user relationships. Prefer a backend secret store or private backend
database for `keyHash`; if metadata is kept in RTDB, deny all client reads and
writes to `deviceAuth`. Admin SDK services bypass rules and must enforce their
own authorization.

Never store a raw device secret in RTDB. For a high-entropy random credential,
the broker can compare a server-peppered HMAC/SHA-256-derived value in constant
time. A low-entropy code must use a password hash and must never be the
long-lived device credential.

Two acceptable credential-proof designs are:

- Baseline: send the unique high-entropy credential only over
  certificate-validated HTTPS and compare a server-peppered derived value.
- Stronger challenge/HMAC: store the per-device verification key in protected
  backend secret storage, because that key is equivalent to a secret, and
  require a fresh broker-issued or single-use nonce. A public-key device
  identity is another later option if hardware/provisioning constraints allow
  it.

Treat flash-stored credentials as extractable. Rotation, revocation, request
rate limiting, and short-lived tokens are required even when flash encryption
is available. This plan does not assume new secure-element hardware.

## Custom Token Claims

Recommended minimum claims:

```json
{
  "deviceId": "esp32-voltix-001",
  "deviceRole": "hardware",
  "credentialVersion": 3
}
```

The broker, never the ESP32, chooses every claim. RTDB authorization should
require both:

```text
auth.token.deviceRole === 'hardware'
auth.token.deviceId === $deviceId
```

The hardware claim contains no human account UID. One ESP32 can serve multiple
accounts; the logged-in web user determines only the destination user-history
projection.

Use `credentialVersion` to reject a device at the broker before issuing another
custom token after rotation. Because already-issued ID tokens remain usable
until expiry, emergency revocation may also require disabling/deleting the
hardware Firebase Auth user or checking a server-controlled revocation marker
through a proxy. Keep token lifetime and incident response expectations
explicit.

## Production RTDB Rule Intent

The final rules must default-deny anonymous access and deny cross-device
hardware access. A review-only example is provided at
`firebase/database.rules.device-auth.draft.json`; it is not a deployable
replacement for current production rules. It focuses on authorization intent
and intentionally omits many existing payload validators and trusted-service
transactions. Deploying it as-is would be unsafe.

Required intent:

| Path | Human user | Hardware token for same `$deviceId` |
| --- | --- | --- |
| `/devices/{deviceId}/config` | Authenticated users read/write | Read/write |
| `/devices/{deviceId}/live` | Authenticated users read | Write |
| `/devices/{deviceId}/commands/current` | Authenticated users write | Read/clear |
| `/devices/{deviceId}/commands/lastAck` | Authenticated users read | Write |
| `/devices/{deviceId}/history/{id}` | Authenticated users read/delete | Write |
| `/devices/{deviceId}/completedSessions/{id}` | Authenticated users read/delete | Write |
| `/devices/{deviceId}/deviceAuth` | No ordinary client access | No access |
| `/users/{uid}/history` | Same logged-in user | No access |

Important rule-review points:

- Do not grant a hardware token `.read` at `/devices/{deviceId}` because that
  would expose private auth metadata.
- Every hardware permission must check both `deviceRole` and matching
  `deviceId`; checking only `deviceId` is weaker and risks claim confusion.
- Keep human user command writes separate from hardware command reads/acks.
- Prefer a separate acknowledgement path. Allowing hardware to overwrite the
  user command object complicates validation and auditability.
- Keep transitional `completedSessions` access only until the logged-in web
  projection flow is verified against the final device queue/history path.
- Validate payload shape, allowed fields, sizes, and immutable identifiers
  before deploying final rules.
- Test rules in the Firebase Emulator Suite with owner, operator, viewer,
  anonymous, disabled device, wrong-device token, and same-device token cases.

## Firmware Changes Required In A Later Sprint

No firmware changes are made by this plan. A later focused implementation
should:

1. Add an auth module separate from relay/session/overload code.
2. Persist `deviceId`, broker URL identifier/config, credential version, and
   device credential using the best available protected local storage.
3. Never print the device credential, custom token, ID token, or refresh token.
4. Replace the current `WiFiClientSecure::setInsecure()` usage with certificate
   validation before sending any credential or token.
5. Request a custom token from the broker with replay-resistant proof.
6. Exchange the custom token through `signInWithCustomToken`.
7. Cache the ID token expiry and refresh token; prefer RAM for tokens and
   persist only when recovery requirements justify the exposure.
8. Add `?auth=<ID_TOKEN>` to current RTDB REST URL construction without logging
   the resulting URL.
9. Refresh before expiry; on `401`, refresh and retry the request once.
10. Use bounded exponential backoff with jitter for broker/Auth failures.
11. Keep existing RTDB request timeouts and nonblocking scheduling under review
    so authentication cannot stall monitoring.
12. Preserve current failure behavior: config uses valid cache/defaults,
    commands are unavailable, live publish pauses, and history remains pending.
13. Preserve `session stop -> LittleFS save -> device-scoped Firebase queue ->
    logged-in web projection -> /users/{currentUser.uid}/history`.

The current `FIREBASE_API_KEY` remains usable for Firebase Auth REST endpoint
selection. It does not become a secret or a device credential. The broker URL
may be public; authorization still requires a valid device proof.

## Token Broker Options

| Option | Advantages | Risks / costs | Recommendation |
| --- | --- | --- | --- |
| Firebase Cloud Functions / Cloud Run with Admin SDK | Native Firebase IAM, straightforward custom-token issuance, centralized logs and rate limiting | Requires backend deployment, secret management, billing/quotas, cold-start/region review | Recommended default when the Firebase project is the operational center |
| Small Node/Vercel serverless broker | Fits an existing Vercel workflow and can use Admin SDK securely in server-only environment variables | Must configure service-account access/IAM carefully; serverless limits, region latency, logs, abuse protection, and secret rotation need review | Acceptable when Vercel is already operated and hardened |
| Manual temporary custom token | Fast lab proof of token exchange and RTDB rule matching | Custom tokens are short-lived for sign-in, manual flow does not provide rotation/provisioning, easy to mishandle, not scalable | Disposable lab testing only; never production |

For either production broker:

- Use server-side Admin SDK credentials through managed IAM/secret storage.
- Authenticate device requests independently of the Firebase Web API key.
- Rate-limit by device and network signals, reject replays, and use constant-time
  credential comparison.
- Issue claims only after reading the authoritative device record.
- Log token issuance metadata, not tokens or raw secrets.
- Expose credential rotation/revocation and incident-response procedures.

## Migration And Verification Phases

### Phase 1: Documentation And Draft Review

- Review this plan, broker pseudocode, and draft rules.
- Confirm final command acknowledgement and history queue path names.
- Threat-model credential extraction, replay, broker abuse, and ownership
  transfer.
- Do not deploy the draft rules.

### Phase 2: Token Broker Skeleton

- Implement broker endpoints in a development environment.
- Use placeholder/test credentials outside Git.
- Add rate limiting, replay defense, credential version checks, and redacted
  audit logs.
- Unit-test disabled, unknown, wrong-secret, replayed, and rotated devices.

### Phase 3: Firmware Token Exchange

- Add auth module, certificate validation, token cache/refresh, and authenticated
  URL construction.
- Preserve all existing local behavior and safety logic.
- Verify `401` refreshes and retries once, then returns to backoff.

### Phase 4: Rules And Emulator Tests

- Convert reviewed draft intent into a complete candidate ruleset.
- Test user roles and hardware claims in the Emulator Suite.
- Confirm anonymous and cross-device access are denied.
- Review payload validation and transitional paths before production rollout.

### Phase 5: One-Device Staged Test

- Provision `esp32-voltix-001` in a disposable/staging project.
- Confirm relay stays OFF at boot and no command is seeded.
- Verify authenticated config read, live write, neutral command read, ack path,
  final history write, and transitional queue write if still required.
- Verify the ESP32 cannot access another device ID or any user history path.

### Phase 6: Pending History Sync

- Run one approved session and confirm LittleFS save occurs first.
- Restore connectivity/auth and verify pending records sync idempotently.
- Verify the logged-in web app copies the device-scoped queue record into
  `/users/{currentUser.uid}/history` without device-side UID knowledge.

### Phase 7: Production Rollout

- Deploy reviewed broker and final tested rules.
- Provision/rotate production device credentials.
- Monitor auth failures, issuance rates, and pending sync.
- Remove all reliance on DEV smoke-test rules and verify default-deny remains.
- Document rollback: disabling cloud access must leave local monitoring and
  LittleFS history safe.

## Security Warnings

- Never put Firebase service-account JSON, private keys, Admin SDK credentials,
  or backend secrets in ESP32 firmware, the web app, Serial logs, or Git.
- Never commit raw device credentials, custom tokens, ID tokens, refresh tokens,
  real UIDs, or populated environment files.
- Firebase Web API keys are not secrets and do not authorize RTDB access.
- Never use public `.read: true` or `.write: true` device rules in production.
- Never send credentials or tokens through TLS with certificate verification
  disabled.
- Treat device credentials as extractable and make them unique, revocable, and
  rotatable.
- Redact query strings because `?auth=<ID_TOKEN>` can leak through URL logging.
- Custom claims are authorization inputs. The broker must derive them from
  trusted records, not request fields.
- Admin SDK bypasses RTDB rules. Broker code needs its own strict authorization,
  validation, logging, and tests.

## Acceptance Mapping

- Custom token, ID token, refresh, and RTDB REST use: documented above.
- Device identity, claims, and production rule intent: documented above.
- Firmware changes and safe auth-failure behavior: documented without runtime
  changes.
- Broker options and device provisioning flow: compared and documented.
- Migration/test phases include `esp32-voltix-001` and pending LittleFS history.
- Security warnings explicitly forbid service-account material in firmware.

See also:

- [`device-token-broker-pseudocode.md`](device-token-broker-pseudocode.md)
- [`device-live-schema.md`](device-live-schema.md)
