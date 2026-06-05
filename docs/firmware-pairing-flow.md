# VOLTIX Firmware Pairing Flow Plan

This document defines the target firmware pairing states and OLED behavior. It
is a planning artifact only. Issue #21 does not add pairing runtime code, change
the existing display priority, or authorize an untrusted ESP32/web client to
claim a device.

## Target State Machine

The target integration state is separate from the current `SystemMode` and
`SessionState` enums. A later firmware sprint may map these target states onto
the existing runtime without changing session safety behavior.

| State | Responsibility | Main transition out |
| --- | --- | --- |
| `BOOT` | Load persistent identity/config, mount LittleFS, and recover any checkpoint before normal operation. | WiFi credentials missing -> `WIFI_SETUP`; otherwise start network connection. |
| `WIFI_SETUP` | Run the existing captive portal and collect network settings. | Network ready -> evaluate paired state; offline selection -> existing offline flow. |
| `UNPAIRED` | Keep relay/session commands disabled and request a short-lived pairing code when online. | Valid code available -> `PAIRING_DISPLAY`; claim observed -> `PAIRED_IDLE`. |
| `PAIRING_DISPLAY` | Show the active code and expiry status without exposing a permanent secret. | Code expires -> request/regenerate code; claim observed -> `PAIRED_IDLE`. |
| `PAIRED_IDLE` | Publish idle live state, consume config, and wait for a permitted command or local action. | Session start -> online/offline monitoring; connectivity change -> transition handling. |
| `MONITORING_ONLINE` | Preserve the current online session and live-publish behavior. | Network loss -> `MONITORING_OFFLINE`; stop/trip -> local-first finalization. |
| `MONITORING_OFFLINE` | Preserve the active session using cached config and checkpoints without requiring Firebase. | Network restored -> `TRANSITION_SYNC`; stop/trip -> local-first finalization. |
| `TRANSITION_SYNC` | Reconcile cached config and upload pending device-scoped session records after connectivity returns. | Sync attempt completes -> paired idle or active monitoring state. |
| `OVERLOAD_TRIPPED` | Keep the existing overload safety screen and relay protection at highest priority. | Alarm reset under existing safety rules -> paired idle. |
| `ERROR_STATE` | Show a recoverable identity/network/storage error without silently enabling commands. | Error resolved or controlled restart -> `BOOT`. |

Pairing is not allowed to interrupt recovery, overload protection, an active
session, session finalization, or the current offline workflow. Those existing
safety/runtime states remain authoritative.

## Target OLED Flow

Pairing screens are shown only when the device is unpaired, online enough to
obtain/validate a code, and no higher-priority safety or session screen is
active.

Active code:

```text
VOLTIX Setup
Pair Code: 928144
Open app > Device
```

Expired code:

```text
Code expired
Generating new
code...
```

Successful claim:

```text
Pairing Success
Device:
VOLTIX Rumah
```

OLED rules:

- A pairing code is exactly six decimal digits.
- A code is one-time use and expires after 10 minutes.
- If a code expires while still unpaired, firmware requests a replacement and
  clearly shows the regeneration state.
- The success screen is temporary; the device then enters `PAIRED_IDLE`.
- The OLED may show the short-lived pairing code and device display name, but
  never a service-account key, admin credential, device private key, custom
  token, user UID, or other permanent secret.
- Existing recovery, overload, button feedback, monitoring, waiting-load,
  finished-summary, and captive-portal screens keep priority over pairing.

## Device Identity And Persistence

| Value | Source of truth | Persistence | Notes |
| --- | --- | --- | --- |
| `deviceId` | Provisioning/manufacturing identity | `Preferences` | Stable and unique; never derived from or replaced by a user UID. |
| `firmwareVersion` | Build-time firmware metadata | Firmware image | Published as metadata/live status; not user-editable. |
| `paired` | Trusted backend/device relationship | Cached in `Preferences` | Cache improves boot UX, but backend state is authoritative when online. |
| `ownerUid` | Trusted pairing relationship | Optional cache in `Preferences` | Used only as metadata if the authenticated device is permitted to read it; never hardcoded. |
| `lastPairingCode` | Trusted pairing service response | RAM preferred; optional short-lived `Preferences` cache | Clear after claim/expiry; never treat as a permanent credential. |
| `pairingCodeExpiresAt` | Trusted pairing service response | Same lifecycle as pairing code | Unix epoch milliseconds so expiry survives restart when time is valid. |

Use `Preferences` for small identity/config metadata. Continue using LittleFS
for completed sessions, pending sync records, and recovery checkpoints.

## Stage A And Stage B

### Stage A / TA-Friendly

Stage A may use a disposable development project with a manually seeded code or
a temporary trusted helper. It may simplify authentication only in that
isolated environment. Firmware must not ship admin credentials, and temporary
rules must not be merged into production rules.

The current firmware runtime, hardcoded development device path, and existing
OLED screens remain unchanged during this planning sprint.

### Stage B / Product-Grade

1. Firmware authenticates as a device using a secure device identity, custom
   token flow, or trusted backend proxy.
2. An unpaired device requests a one-time six-digit code from the trusted
   pairing service.
3. The service records code, device, creation time, and expiry.
4. Web submits the code to the trusted service as the currently authenticated
   user.
5. The service atomically validates and creates owner/member/user-device
   relationships, then marks the code used.
6. Firmware observes the trusted paired state, clears the code, shows success,
   and enters `PAIRED_IDLE`.

No relay/session command may execute while unpaired. The pairing service, not
the OLED code alone, grants access.

## Later Integration Checklist

- Add pairing state data without replacing existing `SystemMode` or
  `SessionState` behavior.
- Authenticate the device before allowing final live/config/command paths.
- Add OLED pairing screens below all existing safety/session priorities.
- Verify expiry/regeneration across restart and temporary network loss.
- Verify successful claim cannot be replayed.
- Verify pairing never changes the LittleFS-first session flow.

See [device-live-schema.md](device-live-schema.md) for the final device paths
and payload contracts.
