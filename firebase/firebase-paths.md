# VOLTIX Firebase RTDB Paths

This document describes the planned VOLTIX Realtime Database contract. It is a
design artifact only; no real Firebase project or credentials are configured by
these files.

## Roles

| Role | Device data | Commands | Config | Members |
| --- | --- | --- | --- | --- |
| `owner` | Read | Write | Read/write | Manage |
| `operator` | Read | Write non-administrative commands | Read only | No access |
| `viewer` | Read | No access | Read only | No access |

Membership is authoritative at `/devices/{deviceId}/members/{uid}`. The
corresponding `/users/{uid}/devices/{deviceId}` entry is a user-facing index and
must be created or removed by a trusted pairing/invite transaction in the final
implementation.

## User Paths

| Path | Purpose | Reader | Writer |
| --- | --- | --- | --- |
| `/users/{uid}/profile` | Account display metadata | Same user | Same user |
| `/users/{uid}/settings` | Personal display and monitoring preferences | Same user | Same user |
| `/users/{uid}/devices/{deviceId}` | Device index, role, and nickname | Same user | Final pairing/invite service; owner-only draft rule |
| `/users/{uid}/history/{historyId}` | Per-user history projection used by the current web history flow | Same user | Same authenticated user after device-membership check |

The user history projection preserves the current local-first contract:

1. ESP32 completes a session and saves it to LittleFS.
2. Device uploads the completed session to a device-scoped queue/history path.
3. The authenticated web/backend flow copies it into the current user's history.

The final backend should perform this projection transactionally and verify
membership. The schema does not make the ESP32 responsible for a user UID.

## Device Paths

| Path | Purpose | Reader | Writer |
| --- | --- | --- | --- |
| `/devices/{deviceId}` | Device metadata root | Owner/member | Trusted provisioning only for immutable identity fields |
| `/devices/{deviceId}/members/{uid}` | Authoritative access role | Owner/member through device read | Owner or trusted invite service |
| `/devices/{deviceId}/config` | Shared monitoring configuration | Owner/member | Owner or authenticated device |
| `/devices/{deviceId}/live` | Current system and measurement state | Owner/member | Authenticated device only |
| `/devices/{deviceId}/command` | Requested relay/session actions | Owner/operator | Owner/operator |
| `/devices/{deviceId}/history/{historyId}` | Device-scoped completed session record | Owner/member | Authenticated device or owner |

`ownerUid`, `paired`, and `createdAt` are provisioning-owned fields. Client
rules intentionally deny direct writes because changing them requires a
multi-location trusted transaction.

## Current-to-Final Path Transition

The repository currently uses development paths that are not renamed by this
documentation-only sprint:

| Current development path | Final planned path |
| --- | --- |
| `/devices/{deviceId}/completedSessions/{historyId}` | `/devices/{deviceId}/history/{historyId}` |
| `/devices/{deviceId}/commands/current` | `/devices/{deviceId}/command` |
| `/devices/{deviceId}/commands/lastAck` | Command acknowledgement schema to be finalized with the backend |

Do not deploy the draft rules against the current application until a later
integration sprint explicitly migrates these contracts and verifies the
LittleFS-first session flow.

## Pairing and Invite Paths

| Path | Purpose | Reader | Writer |
| --- | --- | --- | --- |
| `/pairingCodes/{code}` | Short-lived first-owner claim | Firebase Admin pairing endpoint only | Firebase Admin pairing endpoint only |
| `/inviteCodes/{code}` | Short-lived member invite | Trusted invite service | Owner can create; trusted service redeems |

Codes must:

- have an expiry later than their creation time;
- be rejected after expiry or after `used` becomes `true`;
- never grant access by merely being readable;
- be redeemed by a trusted backend that atomically updates device membership
  and the user's device index.

Production rules deny code lookup to every client. The implemented Firebase
Admin endpoints validate, create, claim, and release pairing records while
enforcing these checks in trusted code.

## Custom Auth Claims Used by Draft Rules

| Claim | Meaning |
| --- | --- |
| `auth.token.deviceId` | Authenticated device identity; must equal the path device ID |
| `auth.token.inviteService` | Trusted service allowed to redeem invite codes |

The hardware token is never granted pairing-service authority. Pairing uses
Firebase Admin server authority instead of a custom client claim.

The final firmware payload fields and current-to-final live migration boundary
are documented in [../docs/device-live-schema.md](../docs/device-live-schema.md).
