import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { startMqttLive } from "../web/js/mqtt-live.js";

const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const config = await readFile(new URL("../web/js/mqtt-config.js", import.meta.url), "utf8");
const client = await readFile(new URL("../web/js/mqtt-live.js", import.meta.url), "utf8");
const dashboard = await readFile(new URL("../web/js/dashboard.js", import.meta.url), "utf8");
const build = await readFile(new URL("../scripts/build-web.mjs", import.meta.url), "utf8");
const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const endpoint = await readFile(new URL("../api/mqtt-web-config.js", import.meta.url), "utf8");

test("dashboard uses authenticated secure HiveMQ WebSocket configuration", () => {
  assert.match(endpoint, /ed7655203a9e419493d52c0b8771c836\.s1\.eu\.hivemq\.cloud/);
  assert.match(endpoint, /MQTT_PORT = 8884/);
  assert.match(endpoint, /MQTT_PATH = "\/mqtt"/);
  assert.match(endpoint, /MQTT_DEVICE_ID = "device01"/);
  assert.match(config, /CONFIG_ENDPOINT = "\/api\/mqtt-web-config"/);
  assert.match(config, /user\.getIdToken\(\)/);
  assert.match(config, /Authorization: `Bearer \$\{idToken\}`/);
  assert.match(config, /`wss:\/\/\$\{config\.host\}:\$\{config\.port\}/);
  assert.doesNotMatch(config, /ws:\/\//);
});

test("web MQTT credentials stay server-side until authenticated config request", () => {
  assert.doesNotMatch(html, /MQTT_WEB_USERNAME|MQTT_WEB_PASSWORD|mqtt-password/);
  assert.match(envExample, /MQTT_WEB_USERNAME=/);
  assert.match(envExample, /Never reuse the ESP32 credential/);
  assert.match(build, /node_modules["],\s*["']mqtt["],\s*["']dist["],\s*["']mqtt\.min\.js/);
  assert.match(endpoint, /verifyIdToken\(idToken, true\)/);
  assert.match(endpoint, /Cache-Control", "no-store, private"/);
  assert.doesNotMatch(endpoint, /console\.(?:log|warn|error)/);
});

test("MQTT.js reconnects and subscribes with topic-specific QoS", () => {
  assert.match(client, /reconnectPeriod: 5000/);
  assert.match(client, /connectTimeout: 10000/);
  assert.match(client, /queueQoSZero: false/);
  assert.match(client, /\[topics\.status\]: \{ qos: 1 \}/);
  assert.match(client, /\[topics\.telemetry\]: \{ qos: 0 \}/);
  assert.match(client, /\[topics\.session\]: \{ qos: 1 \}/);
  assert.match(client, /\[topics\.event\]: \{ qos: 1 \}/);
  assert.match(client, /MAX_PAYLOAD_BYTES = 8192/);
  assert.match(client, /payload deviceId mismatch/);
});

test("dashboard prefers fresh MQTT and retains Firebase live fallback", () => {
  assert.match(dashboard, /startMqttLive\(user, \{/);
  assert.match(dashboard, /function mqttRealtimePreferred/);
  assert.match(dashboard, /if \(mqttRealtimePreferred\(\)\) return;/);
  assert.match(dashboard, /const mqttPreferred = mqttRealtimePreferred\(nowMs\)/);
  assert.match(dashboard, /mqttStatusOnline === true/);
  assert.match(dashboard, /onValue\(ref\(db, `\$\{liveBase\}\/system`/);
  assert.match(dashboard, /onValue\(ref\(db, `\$\{liveBase\}\/device`/);
});

test("START and STOP remain on the reviewed Firebase command path", () => {
  assert.match(dashboard, /async function sendRelayCommand/);
  assert.match(dashboard, /devices\/\$\{selectedDevice\.id\}\/commands\/current/);
  assert.doesNotMatch(dashboard, /publishCommand|TOPIC_COMMAND/);
});

test("web client authenticates, subscribes, and dispatches a device status message", async t => {
  const originalFetch = globalThis.fetch;
  const originalMqtt = globalThis.mqtt;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.mqtt = originalMqtt;
  });

  const clientEvents = new EventEmitter();
  let connectOptions = null;
  let subscribedTopics = null;
  let stopped = false;
  clientEvents.subscribe = (topics, callback) => {
    subscribedTopics = topics;
    callback(null);
  };
  clientEvents.end = force => {
    stopped = force;
  };

  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/mqtt-web-config");
    assert.equal(options.headers.Authorization, "Bearer firebase-id-token");
    return {
      ok: true,
      async json() {
        return {
          host: "ed7655203a9e419493d52c0b8771c836.s1.eu.hivemq.cloud",
          port: 8884,
          path: "/mqtt",
          deviceId: "device01",
          username: "limited-web-user",
          password: "not-a-real-password",
        };
      },
    };
  };
  globalThis.mqtt = {
    connect(url, options) {
      assert.equal(
        url,
        "wss://ed7655203a9e419493d52c0b8771c836.s1.eu.hivemq.cloud:8884/mqtt",
      );
      connectOptions = options;
      return clientEvents;
    },
  };

  const connections = [];
  const statuses = [];
  const live = await startMqttLive(
    { getIdToken: async () => "firebase-id-token" },
    {
      onConnection: state => connections.push(state),
      onStatus: status => statuses.push(status),
    },
  );

  assert.equal(live.configured, true);
  assert.equal(connectOptions.protocolVersion, 4);
  assert.equal(connectOptions.reconnectPeriod, 5000);

  clientEvents.emit("connect");
  assert.equal(subscribedTopics["voltix/device01/status"].qos, 1);
  assert.equal(subscribedTopics["voltix/device01/telemetry"].qos, 0);
  assert.equal(connections.at(-1).connected, true);

  clientEvents.emit(
    "message",
    "voltix/device01/status",
    Buffer.from('{"deviceId":"device01","online":true}'),
  );
  assert.deepEqual(statuses, [{ deviceId: "device01", online: true }]);

  live.stop();
  assert.equal(stopped, true);
});
