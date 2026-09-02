# VOLTIX MQTT foundation

The MQTT module is currently an isolated communication sidecar. Existing
Firebase live/config/command/history code is still active, and MQTT commands do
not call relay, session, reset, or state-machine functions yet.

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
