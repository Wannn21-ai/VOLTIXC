# VOLTIX Safe Local Hardware Validation Checklist

Use this checklist only after the web/Firebase/ESP32 communication smoke tests
have passed and production Firebase rules have been restored. This is a manual
validation procedure, not permission to change firmware, rules, credentials,
relay/session semantics, or the device Auth model.

Mains AC can cause electric shock, fire, or equipment damage. AC wiring and
energized testing must be performed only by a competent person using a
current-limited, protected test setup. Stop immediately if wiring, enclosure,
relay state, sensor readings, temperature, smell, sound, or firmware behavior
is unexpected.

## Test Record

Record results outside the repository or in a redacted issue comment. Never
record passwords, tokens, API keys, real UIDs, or other secrets.

| Item | Test value |
| --- | --- |
| Tester and date | |
| Firmware commit SHA | |
| Hardware revision / device ID | |
| Test location and mains voltage | |
| Small test load and rated power | |
| Overload threshold before test | |
| Production rules restore verified at | |
| Result | PASS / FAIL / STOPPED |

For every phase, record the expected result, actual result, redacted Serial
evidence, and any follow-up issue. Do not patch behavior during the test.

## Stop Conditions

Stop the test, switch the relay OFF, switch the MCB/breaker OFF, unplug USB, and
do not continue until the setup is reviewed if any of these occur:

- The relay is ON unexpectedly, including during boot.
- Exposed AC conductors, loose terminals, damaged insulation, or mixed AC/DC
  wiring are found.
- The enclosure, cable, relay, PZEM, or load becomes hot, smells unusual,
  sparks, or makes an unexpected sound.
- Serial output stops, the ESP32 repeatedly resets, or local OFF control does
  not respond.
- PZEM readings are implausible or unstable after AC is enabled.
- LittleFS reports a save failure after a completed session.

## Phase 0 - Preflight Safety

Do not energize AC during this phase.

- [ ] Confirm the MCB/breaker is OFF and verify the circuit is de-energized
      before inspecting or adjusting wiring.
- [ ] Confirm the ESP32 can be powered by USB only for firmware and Serial
      testing.
- [ ] Confirm no high-power load is connected. Use only a known, small,
      suitable test load when a later phase explicitly requires one.
- [ ] Confirm relay contacts, PZEM wiring, terminals, conductor sizes, fusing,
      strain relief, and insulation match the reviewed wiring plan.
- [ ] Confirm AC and low-voltage DC wiring are physically separated and no
      exposed conductor can be touched.
- [ ] Confirm protective equipment appropriate to the test location is active,
      such as an RCD/GFCI and correctly rated breaker or fuse.
- [ ] Confirm an operator can immediately switch the MCB/breaker OFF without
      reaching across energized conductors.
- [ ] With AC still OFF, boot from USB and confirm the relay initializes OFF.
- [ ] Run `status` and confirm `relay=OFF`.

**Gate:** Continue only when the wiring inspection passes and the relay is OFF.

## Phase 1 - USB-Only Serial Test

Keep the MCB/breaker OFF and leave the AC load circuit de-energized throughout
this phase. Invalid PZEM readings are expected without AC and must be non-fatal.

1. Open Serial Monitor at `115200`.
2. Run each command separately and record the result:

   ```text
   status
   config
   setthreshold
   setthreshold 0
   setthreshold -1
   setthreshold nan
   setthreshold 5001
   time
   recoverystatus
   on
   off
   toggle
   toggle
   status
   ```

3. Verify the following:

- [ ] `status`, `time`, and `recoverystatus` return without a crash or reboot.
- [ ] `config` prints the current runtime config, including overload threshold,
      tariff, load thresholds, checkpoint interval, source, and pending state.
- [ ] Missing, non-numeric, zero, negative, and above-maximum `setthreshold`
      values are rejected without changing the runtime threshold.
- [ ] `on` enters the existing load-validation flow, turns the relay ON only
      for validation, then rejects no-load and returns the relay OFF.
- [ ] The USB-only `on` attempt does not create completed history from invalid
      or no-load PZEM data.
- [ ] `off` always leaves the relay OFF.
- [ ] The two `toggle` commands exercise relay ON then OFF without leaving it
      ON. `toggle` is a relay dry-test command and does not prove session
      validation.
- [ ] OLED, LEDs, and buzzer remain responsive and do not crash or reset the
      firmware.
- [ ] Invalid PZEM readings remain non-fatal.
- [ ] A final `status` shows `relay=OFF` and no active monitoring session.

**Gate:** Continue only when local OFF control works and the final relay state
is OFF.

## Phase 2 - Relay Dry Test

Keep mains AC disconnected from the relay contacts and do not connect a
high-power load. This phase checks relay actuation only.

- [ ] Start with `status` showing `relay=OFF`.
- [ ] Run `toggle`; confirm the relay actuates ON as expected.
- [ ] Run `toggle` again; confirm the relay actuates OFF.
- [ ] Run `on`, observe the existing no-load validation behavior, then confirm
      it returns the relay OFF without completed history.
- [ ] Run `off`; confirm the relay remains OFF.
- [ ] Reboot or power-cycle the ESP32 using USB only.
- [ ] Confirm the relay initializes OFF during every boot.
- [ ] With WiFi unavailable or Firebase returning the expected production
      `401 AUTH_REQUIRED`, confirm local relay safety and OFF control still
      work.

**Gate:** Do not enable AC unless the relay consistently boots and finishes
this phase OFF.

## Phase 3 - PZEM AC Sensing Test With Small Load

Only a competent person may perform this phase. Do not touch, move, or adjust
wiring while AC is energized.

1. Switch the MCB/breaker OFF and verify the circuit is de-energized.
2. Connect one known, small test load within the ratings of every component.
3. Close and secure the protected enclosure. Keep USB/Serial access physically
   separated from AC wiring.
4. Confirm the relay is OFF, then enable AC.
5. Run `status` before starting a session and observe the readings.

- [ ] Voltage is plausible for the local mains supply.
- [ ] Frequency is plausible for the local supply, approximately `50 Hz` in
      Indonesia.
- [ ] With the small load powered through the approved path, current is above
      the configured load threshold and power is above the configured load
      threshold.
- [ ] Current and power are plausible for the known load rating.
- [ ] Readings become valid without ESP32 resets or loss of local OFF control.
- [ ] Temporarily invalid readings remain non-fatal and do not create a false
      completed session.

If readings are implausible, switch the relay OFF, switch the MCB/breaker OFF,
and investigate only after verifying the circuit is de-energized.

## Phase 4 - Session Behavior Test

Use the same small load and approved local or web control path. Do not alter
session semantics for this test.

- [ ] Start one controlled session.
- [ ] Confirm START first enters load validation (`WAITING_LOAD`) with the
      relay ON.
- [ ] Confirm monitoring begins only after stable, valid sensor readings exceed
      the existing load-detection thresholds.
- [ ] Confirm voltage, current, power, elapsed time, energy, and cost remain
      plausible while monitoring.
- [ ] Stop the session using the existing safe control path; separately test
      load removal only if the setup allows it without touching energized
      wiring.
- [ ] Confirm the relay turns OFF and the session finalizes once.
- [ ] Confirm Serial/storage evidence shows the completed session was saved to
      LittleFS before any Firebase cloud-sync result.
- [ ] Confirm a failed or denied Firebase sync leaves the local record pending
      in LittleFS.
- [ ] Confirm any device queue/cloud record remains device-scoped; the ESP32
      does not write `/users/{uid}/history` or contain a hardcoded user UID.
- [ ] When cloud import is available, confirm the logged-in web app owns the
      copy into `/users/{currentUser.uid}/history`.

**Gate:** Stop testing if LittleFS save fails or the relay does not turn OFF.

## Phase 5 - Low-Threshold Overload Test

Do not test overload behavior by connecting a dangerous or high-power load.
This phase validates the existing behavior only; it does not change overload
semantics.

1. Confirm the relay is OFF and no session or recovery is active.
2. Run `config` and record the original `overloadThreshold` value.
3. Set a deliberately low but valid threshold below the known small load. For
   example, use `setthreshold 15` for a stable approximately `21 W` test load.
4. Run `config` again and confirm `overloadThreshold=15.00W` and
   `configSource=SERIAL`. Confirm `pendingSync=true` while cloud sync is
   denied or unavailable; it may become `false` after a successful sync. The
   command persists the threshold locally; Firebase access is not required.
5. Confirm the selected threshold remains below every component rating and does
   not require increasing load power.
6. Run `on` and wait for the existing load-verification flow to accept the
   small load and begin monitoring.

   ```text
   config
   setthreshold 15
   config
   on
   wait for load verification with ~21W small load
   confirm overload triggers
   history
   pending
   setthreshold 2000
   config
   ```

- [ ] The configured warning behavior appears before the trip point, where
      supported by the current configuration.
- [ ] Crossing the deliberately low threshold triggers the existing overload
      behavior.
- [ ] The relay turns OFF and the alarm/indicator behavior occurs without
      requiring unsafe power.
- [ ] The completed session is saved to LittleFS first and records the overload
      end reason.
- [ ] Run `history` and confirm the final snapshot records the low overload
      threshold and overload end reason.
- [ ] Run `pending` and confirm denied or unavailable Firebase sync leaves the
      completed session pending locally.
- [ ] Local OFF control remains available.

After recording the result, restore the original threshold while the relay is
OFF and no session is active. For the default threshold, run
`setthreshold 2000`, then run `config` and verify the restored value. If the
recorded original value was not `2000 W`, restore that recorded value instead.
If a safe low-threshold test cannot be arranged, mark this phase **NOT RUN**
and create a follow-up test plan; do not increase the physical load.

## Phase 6 - Cleanup And Restore

- [ ] Run `off` and confirm `status` shows `relay=OFF`.
- [ ] Switch the MCB/breaker OFF and verify the circuit is de-energized before
      disconnecting the test load or opening the enclosure.
- [ ] Restore any changed overload threshold and verify the original value.
- [ ] Confirm production Firebase rules remain active.
- [ ] Confirm no DEV-only Firebase smoke-test rules remain published.
- [ ] Confirm expected production denials, such as `401 AUTH_REQUIRED`, do not
      stop local operation or remove pending LittleFS data.
- [ ] Confirm no firmware, web behavior, Firebase rules, credentials/env
      values, relay/session semantics, or device Auth model changed during the
      test.
- [ ] Confirm no credentials, secrets, unredacted logs, real UIDs, generated
      files, or temporary test data are staged for commit.
- [ ] Record PASS, FAIL, STOPPED, or NOT RUN for every phase and create focused
      follow-up issues for failures.

## Final Sign-Off

- [ ] All completed phases passed their gates.
- [ ] Relay is OFF.
- [ ] MCB/breaker is OFF.
- [ ] Original configuration is restored.
- [ ] Production Firebase rules are restored and verified.
- [ ] Test results and known issues are recorded without secrets.
