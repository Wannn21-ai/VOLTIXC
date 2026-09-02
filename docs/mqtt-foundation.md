# VOLTIX MQTT foundation

The MQTT module is an isolated realtime communication sidecar. Existing
Firebase authentication, START/STOP command validation, configuration, and
history code remains active. MQTT commands do not call relay, session, reset,
or state-machine functions yet.

## Local configuration

Add these values to the ignored `firmware/include/credentials.h` file:

```cpp
#define VOLTIX_MQTT_USERNAME ""
#define VOLTIX_MQTT_PASSWORD ""
#define VOLTIX_MQTT_ROOT_CA R"MQTT_CA(
-----BEGIN CERTIFICATE-----
YOUR_REVIEWED_HIVEMQ_ROOT_CA
-----END CERTIFICATE-----
)MQTT_CA"
```

Use the CA certificate documented for the active HiveMQ Cloud cluster. The
firmware does not call `setInsecure()` and deliberately leaves MQTT disabled if
the username, password, or CA is empty.

## Runtime behavior

- `mqttBegin()` configures TLS, the retained offline Last Will, and callbacks.
- `mqttLoop()` starts the ESP-IDF MQTT background task after Wi-Fi is connected.
- ESP-MQTT retries in its own task every 10 seconds; the local firmware loop is
  not used for socket waits.
- On connect, the device subscribes to `command` and `config` at QoS 1 and
  publishes retained `{"online":true}` status.
- Telemetry publishes at QoS 0 without retain.
- Status publishes at QoS 1 with retain; session and event publish at QoS 1
  without retain.
- Incoming JSON is limited to 512 bytes. Supported command names are parsed,
  but no command affects the VOLTIX system until a later integration explicitly
  registers and implements a handler.

MQTT is transport only. This foundation does not store cloud history and does
not change the LittleFS-first session completion flow.

## Firmware realtime publisher

`mqtt_state_sync.cpp` observes the existing runtime state without changing it:

- telemetry and session snapshots are published every second;
- retained status is refreshed every five seconds and on state changes;
- session start/end, overload, load removal, user stop, and power-loss events
  are published at QoS 1 when MQTT is connected;
- electrical current and power are zeroed outside an active relay/session,
  matching the existing live-data safety contract;
- an MQTT failure never starts, stops, or modifies a local session.

## Web dashboard

The dashboard connects to HiveMQ using secure WebSocket port `8884` and path
`/mqtt`. MQTT is preferred only while a recent status message exists. If the
MQTT client or configuration is unavailable, the existing Firebase live
listeners remain the fallback.

Install dependencies and build:

```powershell
npm.cmd install
npm.cmd run build:web
```

Create a dedicated HiveMQ browser user with read-only ACL limited to the
`voltix/device01/status`, `telemetry`, `session`, and `event` topics. Configure
these values only in the server/deployment environment:

```text
MQTT_WEB_USERNAME=YOUR_LIMITED_WEB_USERNAME
MQTT_WEB_PASSWORD=YOUR_LIMITED_WEB_PASSWORD
```

Do not reuse the ESP32 credential. `/api/mqtt-web-config` verifies the logged-in
user's Firebase ID token before returning connection configuration with
`Cache-Control: no-store`. MQTT credentials are necessarily visible in memory
to an authenticated browser that opens the connection, so read-only topic ACL
restrictions remain mandatory. Credentials are not embedded in HTML or tracked
JavaScript. The build vendors the pinned MQTT.js browser bundle into
`dist/vendor/`.

When serving `dist/` with a plain static server, `/api/mqtt-web-config` is not
available and the dashboard intentionally uses Firebase live fallback. Test the
MQTT web path through the deployed serverless environment (or its local
development runtime) where the `/api` route and server environment variables
are available.

Run focused checks:

```powershell
npm.cmd run test:mqtt
```
