# VOLTIX Firebase paths

VOLTIX uses one shared hardware device, currently `esp32-voltix-001`. Firebase
Auth still identifies each web user, but there is no device claim, ownership,
membership, or code-based association layer.

## User-scoped data

| Path | Purpose | Access |
|---|---|---|
| `/users/{uid}/profile` | Authenticated user's profile | Same user only |
| `/users/{uid}/settings` | Authenticated user's dashboard preferences | Same user only |
| `/users/{uid}/history/{historyId}` | History projection for the user currently logged in | Same user only |

## Shared device data

| Path | Purpose | Writer |
|---|---|---|
| `/devices/{deviceId}/deviceAuth` | Hashed device credential metadata | Trusted Admin provisioning only |
| `/devices/{deviceId}/config` | Shared runtime configuration | Authenticated web user or matching hardware identity |
| `/devices/{deviceId}/live` | Live system and measurement data | Matching hardware identity |
| `/devices/{deviceId}/commands/current` | Current web command | Authenticated web user; matching hardware may clear it |
| `/devices/{deviceId}/commands/lastAck` | Command acknowledgement | Matching hardware identity |
| `/devices/{deviceId}/history/{historyId}` | Final device history queue | Matching hardware identity; web may remove imported entries |
| `/devices/{deviceId}/completedSessions/{historyId}` | Compatibility completed-session queue | Matching hardware identity; web may remove imported entries |
| `/devices/{deviceId}/historyCleanup` | Web cleanup request and hardware acknowledgement | Authenticated web user and matching hardware identity by child operation |

The ESP32 never hardcodes a Firebase user UID. After a session stops it saves to
LittleFS first, uploads to the device queue, and the logged-in web client copies
the record to `/users/{currentUser.uid}/history`.

Production authorization is defined only in `database.rules.json`. Hardware
authorization uses the token claims `deviceRole: "hardware"` and matching
`deviceId`; browser access requires a signed-in non-hardware Firebase user.
