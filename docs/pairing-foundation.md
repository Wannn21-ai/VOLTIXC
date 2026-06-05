# VOLTIX Pairing Claim Foundation

This sprint adds the Device-page web claim flow. It does not implement OLED code
generation, device authentication, Cloud Functions, or a production pairing
backend.

## Web Claim Behavior

When the authenticated user has no current device, `device.html` displays a
6-digit pairing-code form. The web flow:

1. validates the code format;
2. reads `/pairingCodes/{code}`;
3. rejects missing, expired, used, or malformed codes;
4. reads the referenced device and rejects already-paired devices;
5. attempts one atomic multi-location update;
6. caches the claimed device as the current device only after the update
   succeeds.

The atomic claim attempts to create or update:

```text
/users/{uid}/devices/{deviceId}
/devices/{deviceId}/ownerUid
/devices/{deviceId}/paired
/devices/{deviceId}/name
/devices/{deviceId}/members/{uid}
/pairingCodes/{code}/used
/pairingCodes/{code}/usedBy
```

Under the production-oriented `firebase/database.rules.json`, ordinary web
users cannot directly read pairing codes or claim provisioning-owned fields.
The Device page reports that a trusted pairing service is required and never
shows fake success.

## Stage A: Development / TA-Friendly Testing

Use a dedicated disposable Firebase development project only. Seed a test
device and code from Firebase Console:

```json
{
  "devices": {
    "voltix-dev-001": {
      "ownerUid": "",
      "paired": false,
      "name": "VOLTIX Test Device",
      "firmwareVersion": "v1.0.0",
      "createdAt": 1780000000000,
      "lastSeen": 1780000000000,
      "config": {
        "currency": "IDR",
        "tariff": 1444.7,
        "overloadThreshold": 2000,
        "overloadWarningPercent": 99,
        "loadPowerThreshold": 1,
        "loadCurrentThreshold": 0.02,
        "loadRemovedDelaySec": 2,
        "offlineTimeoutSec": 300,
        "checkpointIntervalSec": 30
      },
      "members": {}
    }
  },
  "pairingCodes": {
    "928144": {
      "deviceId": "voltix-dev-001",
      "createdAt": 1780000000000,
      "expiresAt": 1890000000000,
      "used": false
    }
  }
}
```

For a direct-client Stage A test, the repository includes
`firebase/database.rules.stage-a-pairing.example.json`. It is a standalone,
temporary ruleset for a disposable project and allows an authenticated user to:

- read unused pairing codes;
- read an unpaired device referenced by a code;
- write the first owner relationship and their own user-device index;
- mark that pairing code used.

This ruleset intentionally omits normal production protections and application
access. It only supports the isolated pairing test. This temporary access cannot
securely prove that the writer knows the pairing
code at every destination path. It therefore must not be added to the committed
production rules, merged into `database.rules.json`, or deployed to a project
containing real data. Remove it immediately after the isolated test.

Recommended Stage A procedure:

1. Create a disposable Firebase project.
2. Enable Email/Password Auth.
3. Seed the example device/code.
4. Temporarily publish `database.rules.stage-a-pairing.example.json`.
5. Generate `dist/` with the development project environment values.
6. Register/sign in, open Device, and claim `928144`.
7. Verify all relationship paths and `usedBy` were written together.
8. Restore default-deny production rules.

If temporary rules are not installed, the expected result is a clear
trusted-pairing-service error.

## Stage B: Product-Grade Target

The final flow must move claim validation and writes into a trusted backend or
Cloud Function:

1. ESP32 obtains secure device credentials.
2. In unpaired state, ESP32 creates or requests a short-lived 6-digit code.
3. OLED displays:

   ```text
   VOLTIX Setup
   Pair Code: 928144
   Open app > Device > Pair
   ```

4. Web submits the code to a trusted callable/HTTPS endpoint.
5. Backend validates authentication, expiry, one-time use, and device state.
6. Backend performs the atomic relationship update with Admin SDK.
7. Code expires or regenerates periodically and cannot be reused.

Never embed an Admin SDK credential, service account, or permanent pairing
secret in the web app or firmware.

The target firmware state machine, OLED priority, code lifecycle, and identity
persistence plan are documented in
[firmware-pairing-flow.md](firmware-pairing-flow.md).
