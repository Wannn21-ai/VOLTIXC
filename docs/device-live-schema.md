# VOLTIX Final Device Path Contract

This document defines the target firmware-facing Firebase contract. It does not
migrate the current firmware paths, alter Firebase rules, or change web
behavior. A later integration sprint must introduce secure device auth and
verify each migration independently.

Non-breaking code scaffolding for this contract lives in
`firmware/include/firebase_paths.h` and
`firmware/include/firebase_integration_scaffold.h`. The active runtime does not
call these helpers yet.

## Ownership And Identity

- `{deviceId}` is a stable provisioning identity, never a user UID.
- ESP32 writes only device-scoped data. It never writes directly to
  `/users/{uid}/history`.
- An authenticated device is the sole writer of final live state.
- Authorized owner/member clients read live state; web clients do not write it.
- Timestamps in the final contract are Unix epoch milliseconds.
- Pairing/member metadata belongs under `/devices/{deviceId}` and is not part
  of the high-frequency live payload.

## Final Firmware Paths

| Path | Firmware behavior | Final writer |
| --- | --- | --- |
| `/devices/{deviceId}/live/system` | Publish connectivity and runtime status. | Authenticated device |
| `/devices/{deviceId}/live/device` | Publish current electrical measurements. | Authenticated device |
| `/devices/{deviceId}/config` | Read/cache shared monitoring configuration. | Owner or authenticated device, per final policy |
| `/devices/{deviceId}/command` | Read permitted command and safely acknowledge/clear it. | Owner/operator writes; device consumes |
| `/devices/{deviceId}/history/{historyId}` | Upload a completed record only after LittleFS save succeeds. | Authenticated device |

The device must be paired and securely authenticated before it reads commands
or writes these final production paths.

## Live Payload

### `/devices/{deviceId}/live/system`

```json
{
  "timestamp": 1780000000000,
  "internet": true,
  "mode": "ONLINE",
  "relay": "ON",
  "wifiStatus": "CONNECTED",
  "activeSsid": "HomeWiFi",
  "firmwareVersion": "v1.0.0"
}
```

| Field | Type | Contract |
| --- | --- | --- |
| `timestamp` | number | Unix epoch milliseconds when this payload was produced. |
| `internet` | boolean | Whether the device currently has usable internet connectivity. |
| `mode` | string | Target high-level mode such as `BOOT`, `SETUP`, `ONLINE`, `OFFLINE`, or `TRANSITION`. |
| `relay` | string | Explicit `ON` or `OFF`. |
| `wifiStatus` | string | Connectivity status such as `CONNECTED`, `CONNECTING`, or `DISCONNECTED`. |
| `activeSsid` | string | Current SSID for display/diagnostics; empty when unavailable. |
| `firmwareVersion` | string | Build version currently running on the device. |

### `/devices/{deviceId}/live/device`

```json
{
  "connected": true,
  "voltage": 220.4,
  "current": 0.38,
  "power": 85.2,
  "apparent": 88.0,
  "pf": 0.96,
  "frequency": 50.0,
  "energy": 0.125,
  "cost": 180.59,
  "duration": 3600,
  "overload": false
}
```

| Field | Type | Unit / meaning |
| --- | --- | --- |
| `connected` | boolean | Measurement source is available and valid. |
| `voltage` | number | Volts. |
| `current` | number | Amperes. |
| `power` | number | Active watts. |
| `apparent` | number | Apparent volt-amperes. |
| `pf` | number | Power factor. |
| `frequency` | number | Hertz. |
| `energy` | number | Session energy in kWh. |
| `cost` | number | Session cost using cached/shared config. |
| `duration` | number | Active session duration in seconds. |
| `overload` | boolean | Whether overload protection is active/tripped. |

Live writes should update only the relevant child (`system` or `device`) so one
publisher does not erase sibling data. Publishing frequency and stale-data
thresholds must be finalized with the web integration and RTDB usage budget.

## Current-To-Final Live Migration

Current firmware behavior is intentionally unchanged by Issue #21:

| Current development contract | Final contract |
| --- | --- |
| Hardcoded `/devices/esp32-voltix-001/live` | Templated `/devices/{deviceId}/live` derived from provisioned identity |
| One PATCH containing `system`, `device`, and `session` | Separate canonical `live/system` and `live/device` payloads |
| `system.timestamp = millis()` | Unix epoch milliseconds |
| `system.systemMode` | `system.mode` |
| `system.relay` boolean | `system.relay` string `ON` / `OFF` |
| `device.powerFactor` | `device.pf` |
| Session detail nested under `live/session` | Keep live summary minimal; completed details belong in device history |

Do not partially switch these fields in production. The later migration must
coordinate firmware, web readers, device authentication, rules, and fallback
behavior in one verified integration change.

## Config Sync Contract

Firmware consumes `/devices/{deviceId}/config`:

```text
currency
tariff
overloadThreshold
overloadWarningPercent
loadPowerThreshold
loadCurrentThreshold
loadRemovedDelaySec
offlineTimeoutSec
checkpointIntervalSec
```

Firmware keeps safe local defaults, caches the last known valid config, and
uses that cache while offline. Invalid or incomplete remote config must not
erase a valid cache. Web changes are applied when the paired device reconnects,
using the established revision/pending-sync strategy during implementation.

## Command Contract

Firmware consumes `/devices/{deviceId}/command` only when paired and online:

```json
{
  "relay": "UNCHANGED",
  "startSession": false,
  "stopSession": false,
  "resetAlarm": false,
  "updatedAt": 1780000000000
}
```

Commands must preserve existing safety/session validation. In particular, no
relay/session command executes while unpaired. A later integration sprint must
select and document an idempotent acknowledgement/clear strategy before
migrating the current `commands/current` and `commands/lastAck` paths.

## Completed Session Contract

On session stop/finalization:

1. Save the completed record to LittleFS first.
2. Only after local save succeeds, queue/upload it to
   `/devices/{deviceId}/history/{historyId}`.
3. If Firebase is unavailable, retain it as pending sync.
4. Recover interrupted active sessions from the existing checkpoint flow.
5. The authenticated web/backend flow projects device history into
   `/users/{currentUser.uid}/history`; ESP32 never hardcodes that UID.

Required completed fields:

```text
name
startTime
endTime
durationSec
energyKwh
cost
voltageAvg
currentAvg
powerAvg
powerMax
pfAvg
frequencyAvg
apparentAvg
modeStart
modeEnd
modePath
endReason
overload
syncStatus
```

## Stage A And Stage B Security

Stage A may use a disposable development project and temporary simplified
device writes for TA testing. Such access is not production secure and must not
weaken `firebase/database.rules.json`.

For Stage A only, the existing development paths may remain in use:

```text
/devices/esp32-voltix-001/live
/devices/esp32-voltix-001/config
/devices/esp32-voltix-001/commands/current
/devices/esp32-voltix-001/commands/lastAck
/devices/esp32-voltix-001/completedSessions/{historyId}
```

These paths are compatibility references, not approval for anonymous
production writes. Use a disposable project or trusted test service, and remove
temporary access immediately after testing.

Stage B requires secure device identity/custom tokens or a trusted backend
proxy. Pairing code creation/claim and privileged relationship writes belong to
trusted services. Never put Admin SDK credentials, service-account keys,
database secrets, permanent pairing secrets, or real Firebase config values in
firmware or repository documentation.

See [firmware-pairing-flow.md](firmware-pairing-flow.md) for the target state
machine, OLED flow, and identity persistence plan.
