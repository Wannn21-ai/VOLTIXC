import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mqttConfig = await readFile(
  new URL("../firmware/include/mqtt_config.h", import.meta.url),
  "utf8",
);
const mqttHeader = await readFile(
  new URL("../firmware/include/mqtt_manager.h", import.meta.url),
  "utf8",
);
const mqttSource = await readFile(
  new URL("../firmware/src/mqtt_manager.cpp", import.meta.url),
  "utf8",
);
const mqttStateSyncSource = await readFile(
  new URL("../firmware/src/mqtt_state_sync.cpp", import.meta.url),
  "utf8",
);
const mqttCloudSyncSource = await readFile(
  new URL("../firmware/src/mqtt_cloud_sync.cpp", import.meta.url),
  "utf8",
);
const platformio = await readFile(
  new URL("../firmware/platformio.ini", import.meta.url),
  "utf8",
);
const credentialsExample = await readFile(
  new URL("../firmware/include/credentials.h.example", import.meta.url),
  "utf8",
);
const mainSource = await readFile(
  new URL("../firmware/src/main.cpp", import.meta.url),
  "utf8",
);
const storageSource = await readFile(
  new URL("../firmware/src/storage.cpp", import.meta.url),
  "utf8",
);

test("MQTT identity and all device01 topics are centralized", () => {
  assert.match(mqttConfig, /HOST\s*=\s*[\s\S]*ed7655203a9e419493d52c0b8771c836\.s1\.eu\.hivemq\.cloud/);
  assert.match(mqttConfig, /PORT\s*=\s*8883/);
  assert.match(mqttConfig, /DEVICE_ID\s*=\s*"device01"/);
  assert.match(mqttConfig, /BASE_TOPIC\s*=\s*"voltix\/device01"/);

  for (const topic of [
    "status",
    "telemetry",
    "session",
    "event",
    "command",
    "config",
    "command/ack",
    "config/state",
    "history",
    "history/ack",
  ]) {
    assert.match(mqttConfig, new RegExp(`voltix/device01/${topic}`));
  }
});

test("credentials remain local and TLS certificate verification is required", () => {
  assert.match(credentialsExample, /#define VOLTIX_MQTT_USERNAME ""/);
  assert.match(credentialsExample, /#define VOLTIX_MQTT_PASSWORD ""/);
  assert.match(credentialsExample, /#define VOLTIX_MQTT_ROOT_CA ""/);
  assert.match(mqttSource, /config\.transport = MQTT_TRANSPORT_OVER_SSL/);
  assert.match(mqttSource, /config\.cert_pem = MqttConfig::ROOT_CA/);
  assert.match(mqttSource, /config\.skip_cert_common_name_check = false/);
  assert.doesNotMatch(mqttSource, /setInsecure|skip_cert_common_name_check = true/);
});

test("MQTT runs in its background task with bounded reconnect and queued publish", () => {
  assert.match(mqttSource, /esp_mqtt_client_start\(mqttClient\)/);
  assert.match(mqttSource, /esp_mqtt_client_enqueue\(/);
  assert.match(mqttSource, /config\.reconnect_timeout_ms = MqttConfig::RECONNECT_INTERVAL_MS/);
  assert.match(mqttConfig, /RECONNECT_INTERVAL_MS = 10000UL/);
  assert.doesNotMatch(mqttSource, /\bdelay\s*\(/);
});

test("LWT, retain flags, and QoS follow the topic contract", () => {
  assert.match(mqttConfig, /OFFLINE_WILL_PAYLOAD = "\{\\"online\\":false\}"/);
  assert.match(mqttSource, /config\.lwt_topic = MqttConfig::TOPIC_STATUS/);
  assert.match(mqttSource, /config\.lwt_qos = 1/);
  assert.match(mqttSource, /config\.lwt_retain = 1/);
  assert.match(
    mqttSource,
    /enqueueJson\(MqttConfig::TOPIC_STATUS, document, 1, true\)/,
  );
  assert.match(
    mqttSource,
    /enqueueJson\(MqttConfig::TOPIC_TELEMETRY, document, 0, false\)/,
  );
  assert.match(
    mqttSource,
    /enqueueJson\(MqttConfig::TOPIC_EVENT, document, 1, false\)/,
  );
});

test("command/config payloads are bounded and network callbacks only enqueue work", () => {
  assert.match(mqttHeader, /enum class MqttCommandType/);
  assert.match(mqttSource, /deserializeJson\(document, payload, length\)/);
  assert.match(mqttSource, /MAX_INBOUND_PAYLOAD_BYTES/);
  assert.match(mqttSource, /strcmp\(commandText, "start"\)/);
  assert.match(mqttSource, /strcmp\(commandText, "stop"\)/);
  assert.match(mqttSource, /strcmp\(commandText, "relay"\)/);
  assert.match(mqttSource, /strcmp\(commandText, "reset"\)/);
  assert.doesNotMatch(
    mqttSource,
    /sessionStart|sessionStop|relaySet|factoryReset|systemReset|storageAppendCompletedSession/,
  );
  assert.match(mqttCloudSyncSource, /mqttSetCommandHandler\(queueCommandFromMqtt\)/);
  assert.match(mqttCloudSyncSource, /mqttSetConfigHandler\(queueConfigFromMqtt\)/);
  assert.match(mqttCloudSyncSource, /if \(takeCommand\(command\)\) processCommand\(command\)/);
  assert.match(mqttCloudSyncSource, /sessionStart\(deviceName\)/);
  assert.match(mqttCloudSyncSource, /sessionStop\(EndReason::USER_STOP\)/);
});

test("main uses MQTT cloud sync and Firebase transport sources are excluded", () => {
  assert.match(mainSource, /mqttBegin\(\);\s+mqttCloudSyncBegin\(\);\s+mqttStateSyncBegin\(\);/);
  assert.match(
    mainSource,
    /networkUpdate\(\);\s+mqttLoop\(\);\s+sessionRecoveryUpdate\(\);/,
  );

  assert.match(mainSource, /mqttStateSyncUpdate\(\)/);
  assert.match(mainSource, /mqttCloudSyncUpdate\(\)/);
  assert.doesNotMatch(mainSource, /firebaseBegin|firebaseUpdate|firebaseSync/);
  assert.doesNotMatch(mainSource, /mqttPublish(?:Status|Telemetry|Session|Event)\(/);
  for (const source of [
    "firebase_sync.cpp",
    "firebase_paths.cpp",
    "device_auth.cpp",
    "firebase_integration_scaffold.cpp",
  ]) {
    assert.match(platformio, new RegExp(`-<${source.replace(".", "\\.")}>`));
  }
});

test("state sync mirrors existing state without controlling the system", () => {
  assert.match(mqttStateSyncSource, /TELEMETRY_INTERVAL_MS = 1000UL/);
  assert.match(mqttStateSyncSource, /STATUS_INTERVAL_MS = 5000UL/);
  assert.match(mqttStateSyncSource, /mqttPublishStatus\(message\)/);
  assert.match(mqttStateSyncSource, /mqttPublishTelemetry\(message\)/);
  assert.match(mqttStateSyncSource, /mqttPublishSession\(message\)/);
  assert.match(mqttStateSyncSource, /mqttPublishEvent\("session_started"/);
  assert.doesNotMatch(
    mqttStateSyncSource,
    /sessionStart\(|sessionStop\(|relaySet\(|storageAppend|sessionRecoveryUpdate\(/,
  );
});

test("LittleFS history uses the same device identity and waits for backend acknowledgement", () => {
  assert.match(storageSource, /entry\["deviceId"\] = MqttConfig::DEVICE_ID/);
  assert.match(storageSource, /mqttPublishHistoryJson\(payload\.c_str\(\), payload\.length\(\)\)/);
  assert.match(mqttCloudSyncSource, /storageMarkSessionQueued\(historySessionId\)/);
  assert.doesNotMatch(storageSource, /firebaseUploadHistory|firebaseSet/);
});
