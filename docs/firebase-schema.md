# VOLTIX Firebase Schema and Security Plan

## Status

The files under `firebase/` are a design draft for the final VOLTIX Firebase
Realtime Database. They do not connect the repository to a real Firebase
project, contain credentials, or implement pairing/invite services.

The production-oriented draft is:

- default-deny at the database root;
- user-scoped for profile, settings, and user history;
- membership-scoped for device reads;
- owner-only for device administration;
- owner/operator for commands;
- authenticated-device-only for live telemetry and device history writes.

## Data Ownership

VOLTIX keeps device and user ownership separate:

- `/devices/{deviceId}` is the authoritative device state and membership tree.
- `/users/{uid}/devices/{deviceId}` is a user-facing index.
- `/devices/{deviceId}/history/{historyId}` is the device-scoped completed
  session source.
- `/users/{uid}/history/{historyId}` is the authenticated user's web projection.

The ESP32 must never hardcode a user UID. A finished session is saved to
LittleFS first, then synchronized to a device-scoped Firebase path. A trusted
web/backend flow can project that record into the currently authenticated
user's history after checking device membership.

The current firmware/web contract still uses
`/devices/{deviceId}/completedSessions/{historyId}` and plural command paths.
This sprint does not rename or integrate those paths. The final schema uses
`/devices/{deviceId}/history/{historyId}` and `/devices/{deviceId}/command`;
that migration belongs in a later integration sprint.

## Stage A: Development / TA-Friendly

The current ESP32 may write to RTDB without Firebase Auth. During isolated
development, temporary rules may allow only a known development device to write
limited paths such as:

- `/devices/{developmentDeviceId}/live`
- `/devices/{developmentDeviceId}/history`
- the firmware-owned acknowledgement portion of commands

This fallback is not represented in `firebase/database.rules.json` because it
would weaken the production draft. If temporary rules are used:

1. use a dedicated non-production Firebase project;
2. scope writes to one disposable device ID and the minimum required children;
3. never grant global `.read` or `.write`;
4. avoid storing personal or production data;
5. set a removal date and replace the rules before deployment.

A static secret embedded in firmware is not a production security boundary.
Anyone who extracts it can impersonate the device.

## Stage B: Product-Grade Target

Each device should authenticate before writing. Supported directions include:

- a custom Firebase token containing a verified `deviceId` claim;
- a secure backend or Cloud Function proxy that validates device requests;
- another device-auth mechanism that issues short-lived credentials.

The rules use `auth.token.deviceId === $deviceId` for device-scoped runtime
access. Pairing uses Firebase Admin server authority because it requires a
validated atomic multi-location write; the hardware token is not granted a
pairing-service claim.

## Pairing Transaction Target

After validating an unused, unexpired pairing code, a trusted service should
atomically:

1. set `/devices/{deviceId}/ownerUid`;
2. set `/devices/{deviceId}/paired` to `true`;
3. create `/devices/{deviceId}/members/{uid}` with role `owner`;
4. create `/users/{uid}/devices/{deviceId}` with role `owner`;
5. mark the pairing code used and record `usedBy`.

Ordinary clients cannot perform this transaction under the draft production
rules. A trusted Admin SDK service can perform the transaction while enforcing
expiry, one-time use, and device eligibility in backend code.

The production endpoints are documented in
[`trusted-pairing-service.md`](trusted-pairing-service.md). The isolated Stage A
manual procedure remains in [`pairing-foundation.md`](pairing-foundation.md).
Production rules block every direct client pairing-code read or write.

## Invite Transaction Target

Only the device owner may create an invite for role `operator` or `viewer`.
After validating an unused, unexpired code, a trusted service should atomically:

1. create `/devices/{deviceId}/members/{uid}`;
2. create `/users/{uid}/devices/{deviceId}`;
3. mark the invite used and record `usedBy`.

## Rules Review Notes

`firebase/database.rules.json` is intentionally a draft:

- Firebase rules cannot securely perform every cross-path pairing transaction;
- code expiry and one-time redemption must be enforced by a trusted service;
- immutable provisioning fields are not client-writable;
- command validation allows a compact planned command object, but the final
  command/ack schema should be reviewed when the backend sprint begins;
- schema and rules should be exercised with the Firebase Emulator Suite before
  connecting a final project.

## Pre-Integration Checklist

- Create separate development and production Firebase projects.
- Define device authentication and credential rotation.
- Implement trusted pairing and invite redemption.
- Add Emulator Suite tests for owner, operator, viewer, unauthenticated user,
  wrong-device token, expired code, and reused code.
- Review indexes and query patterns.
- Confirm that web history projection preserves the LittleFS-first flow.
- Verify no credentials or service-account files are committed.
