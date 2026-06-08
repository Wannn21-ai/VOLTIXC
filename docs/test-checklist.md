# VOLTIX Integration Test Run Sheet

Use this short run sheet while executing the full
[end-to-end Firebase device test plan](e2e-firebase-device-test.md).

## Before Test

- [ ] Select Mode A, B, or C and use a disposable/reviewed Firebase project.
- [ ] Confirm relay is OFF and no actionable command is seeded.
- [ ] Confirm `.env.local`, `dist/`, credentials, UIDs, and tokens are ignored.
- [ ] Record web/firmware commit SHAs and placeholder replacements privately.
- [ ] Build web and firmware without source changes.

## Web And Firebase

- [ ] Serve generated `dist/`.
- [ ] Register/login succeeds.
- [ ] `/users/<uid>/profile` exists.
- [ ] `/users/<uid>/settings` exists.
- [ ] No-device state works before a relationship is seeded.
- [ ] Seed `/users/<uid>/devices/<deviceId>`.
- [ ] Seed owner/member relationship and complete device config.
- [ ] Dashboard reads final `/live/system` and `/live/device`.
- [ ] Settings personal save works.
- [ ] Device config save works only when supported and authorized.
- [ ] Final history renders before transitional/user fallback.
- [ ] Duplicate `id`/`sessionId` renders once.
- [ ] No-history and permission-denied states are readable.
- [ ] No fatal browser console errors.

## Firmware And Hardware

- [ ] Current firmware builds and flashes.
- [ ] Relay remains OFF through boot/connectivity testing.
- [ ] Serial shows expected device ID and config path behavior.
- [ ] Firmware applies valid final config or retains safe cached/default config.
- [ ] Live telemetry targets final system/device children.
- [ ] Neutral/stale singular command fallback causes no action.
- [ ] OLED local monitoring works when Firebase writes are denied.
- [ ] Overload behavior is unchanged.
- [ ] Session stop saves LittleFS before cloud sync.
- [ ] Failed cloud sync remains pending in LittleFS.
- [ ] Successful sync creates final device history.
- [ ] ESP32 never writes user history or hardcodes a UID.

## After Test

- [ ] Remove neutral commands and disposable seed data if no longer needed.
- [ ] Restore production-oriented rules after any Mode B test.
- [ ] Confirm no credential or real UID is staged.
- [ ] Record failures using the follow-up template in the full plan.
