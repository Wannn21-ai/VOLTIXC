import { loadMqttWebConfig } from "./mqtt-config.js";

const MAX_PAYLOAD_BYTES = 8192;

function makeClientId() {
  const randomPart = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `voltix-web-${randomPart}`.slice(0, 64);
}

function parsePayload(payload, expectedDeviceId) {
  if (!payload || payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error("MQTT payload is empty or too large");
  }
  const parsed = JSON.parse(payload.toString());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MQTT payload must be a JSON object");
  }
  if (parsed.deviceId && parsed.deviceId !== expectedDeviceId) {
    throw new Error("MQTT payload deviceId mismatch");
  }
  return parsed;
}

export async function startMqttLive(user, handlers = {}) {
  const notifyConnection = (connected, reason = "") => {
    handlers.onConnection?.({ connected, reason });
  };

  if (!globalThis.mqtt?.connect) {
    console.warn("[mqtt-web] MQTT.js browser bundle unavailable; using Firebase fallback");
    notifyConnection(false, "library_missing");
    return { configured: false, stop() {} };
  }

  let config;
  try {
    config = await loadMqttWebConfig(user);
  } catch (error) {
    console.warn("[mqtt-web] Configuration unavailable; using Firebase fallback:", error.message);
    notifyConnection(false, "configuration_unavailable");
    return { configured: false, stop() {} };
  }
  if (!config) {
    console.info("[mqtt-web] Disabled in local visual mode; using Firebase fallback");
    notifyConnection(false, "configuration_missing");
    return { configured: false, stop() {} };
  }

  const topics = Object.freeze({
    status: `${config.baseTopic}/status`,
    telemetry: `${config.baseTopic}/telemetry`,
    session: `${config.baseTopic}/session`,
    event: `${config.baseTopic}/event`,
  });
  const topicHandlers = new Map([
    [topics.status, handlers.onStatus],
    [topics.telemetry, handlers.onTelemetry],
    [topics.session, handlers.onSession],
    [topics.event, handlers.onEvent],
  ]);

  const client = globalThis.mqtt.connect(config.url, {
    clientId: makeClientId(),
    username: config.username,
    password: config.password,
    protocolVersion: 4,
    clean: true,
    keepalive: 30,
    connectTimeout: 10000,
    reconnectPeriod: 5000,
    resubscribe: true,
    queueQoSZero: false,
  });

  client.on("connect", () => {
    client.subscribe({
      [topics.status]: { qos: 1 },
      [topics.telemetry]: { qos: 0 },
      [topics.session]: { qos: 1 },
      [topics.event]: { qos: 1 },
    }, error => {
      if (error) {
        console.warn("[mqtt-web] Subscription failed:", error.message);
        notifyConnection(false, "subscribe_failed");
        return;
      }
      console.info("[mqtt-web] Connected and subscribed");
      notifyConnection(true);
    });
  });

  client.on("message", (topic, payload) => {
    const handler = topicHandlers.get(topic);
    if (!handler) return;
    try {
      handler(parsePayload(payload, config.deviceId), Date.now());
    } catch (error) {
      console.warn(`[mqtt-web] Rejected payload topic=${topic}:`, error.message);
    }
  });

  client.on("reconnect", () => notifyConnection(false, "reconnecting"));
  client.on("offline", () => notifyConnection(false, "offline"));
  client.on("close", () => notifyConnection(false, "closed"));
  client.on("error", error => {
    console.warn("[mqtt-web] Connection error:", error.message);
    notifyConnection(false, "error");
  });

  return {
    configured: true,
    stop() {
      client.end(true);
    },
  };
}
