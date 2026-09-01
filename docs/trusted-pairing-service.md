# Trusted Device Pairing Service

Production pairing uses three Firebase Admin-backed server endpoints. Neither
the browser nor ESP32 reads or writes `/pairingCodes` directly, and the hardware
token keeps only its device-scoped `deviceId`, `deviceRole: "hardware"`, and
credential-version claims. It is never granted `pairingService` authority.

## Endpoints

### `POST /api/device-pairing-code`

The ESP32 sends the same `deviceId`, `deviceSecret`, and `credentialVersion`
credential envelope used by `/api/device-token`. The server verifies the
provisioned hash with the server-only pepper. Unlike normal RTDB token issuance,
this bootstrap verification does not require an existing owner.

For an unowned device, the endpoint reuses its active unused code or atomically
reserves a collision-free six-digit code for ten minutes. The response contains
only `code` and `expiresAt`. An owned device receives
`device_already_owned`; an invalid credential receives the generic
`invalid_device_credential` response.

### `POST /api/claim-device`

The browser sends `{ "code": "123456" }` with the signed-in user's Firebase ID
token as `Authorization: Bearer <token>`. The server verifies the token and
loads the current Firebase Auth display name without inventing a fallback.

One root RTDB transaction validates expiry/usage/ownership and writes all of
the following together:

```text
/devices/{deviceId}/ownerUid
/devices/{deviceId}/paired
/devices/{deviceId}/ownerProfile
/devices/{deviceId}/members/{uid}
/users/{uid}/devices/{deviceId}
/pairingCodes/{code}/used
/pairingCodes/{code}/usedBy
```

Because validation and mutation happen in one transaction, concurrent claims
cannot create two owners.

### `POST /api/release-device`

System Reset sends the provisioned device credential to this endpoint before
deleting local state. One root transaction removes the owner profile, all
device members and their user-device indexes, and old pairing codes, then sets
`paired` to `false`.

Reset is fail-safe: if Wi-Fi or the trusted backend is unavailable, firmware
does not clear local ownership or any other factory-reset data. The user can
retry after reconnecting. This prevents the ESP32 from appearing unowned while
Firebase still belongs to the previous account.

## Firebase Data

Active code:

```json
{
  "pairingCodes": {
    "123456": {
      "deviceId": "esp32-voltix-001",
      "createdAt": 1780000000000,
      "expiresAt": 1780000600000,
      "used": false
    }
  }
}
```

Successful binding adds:

```json
{
  "ownerUid": "firebase-user-uid",
  "paired": true,
  "ownerProfile": {
    "uid": "firebase-user-uid",
    "displayName": "Alya",
    "pairingCode": "123456"
  }
}
```

Production RTDB rules deny all client access to `/pairingCodes`. Firebase Admin
access bypasses client rules only inside the trusted server environment.
Service-account credentials and `DEVICE_AUTH_PEPPER` remain server-only; the
firmware stores only its provisioned device secret and certificate roots.
