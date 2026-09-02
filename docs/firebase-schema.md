# Firebase schema

The canonical machine-readable paths are in
`firebase/firebase-paths.json`; production authorization is in
`firebase/database.rules.json`.

## Model

- `/devices/{deviceId}` is shared hardware state.
- `/users/{uid}` is private data for the signed-in Firebase Auth user.
- One ESP32 may be used by multiple signed-in accounts.
- The ESP32 authenticates as `device:{deviceId}` and never receives or
  hardcodes a human user UID.

The protected hardware credential record is:

```text
/devices/{deviceId}/deviceAuth/enabled
/devices/{deviceId}/deviceAuth/revoked
/devices/{deviceId}/deviceAuth/credentialVersion
/devices/{deviceId}/deviceAuth/hashAlg
/devices/{deviceId}/deviceAuth/secretHash
```

Only trusted Admin provisioning may access those fields. Browser and firmware
access is denied by production rules.

## Runtime paths

```text
/devices/{deviceId}/config
/devices/{deviceId}/live
/devices/{deviceId}/commands/current
/devices/{deviceId}/commands/lastAck
/devices/{deviceId}/history/{historyId}
/devices/{deviceId}/completedSessions/{historyId}
/devices/{deviceId}/historyCleanup/current
/devices/{deviceId}/historyCleanup/lastAck
```

Signed-in web users access the shared runtime paths. Hardware access always
requires `deviceRole === "hardware"` and a matching `deviceId` claim.

## User history

The final history workflow remains:

```text
Session stop
-> ESP32 saves LittleFS
-> ESP32 uploads to the device queue
-> logged-in web reads the queue
-> web copies to /users/{currentUser.uid}/history
```

If Firebase fails, the LittleFS record remains pending. A user's profile,
settings, and history remain readable/writable only by that same authenticated
user.
