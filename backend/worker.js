"use strict";

const { readFile } = require("node:fs/promises");
const path = require("node:path");
const mqtt = require("mqtt");
const { getPool } = require("./db.js");
const { HOST, PORT, requiredCredentials } = require("./mqtt-publisher.js");

const MAX_PAYLOAD_BYTES = 16384;
const DEVICE_ID = "device01";
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

function parseTopic(topic) {
  const match = /^voltix\/([^/]+)\/(status|telemetry|session|event|history|command\/ack|config\/state|history\/cleanup\/ack)$/.exec(topic);
  if (!match || !DEVICE_ID_PATTERN.test(match[1])) return null;
  return { deviceId: match[1], channel: match[2] };
}

function parsePayload(buffer) {
  if (!buffer || buffer.length === 0 || buffer.length > MAX_PAYLOAD_BYTES) return null;
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function storeMessage(pool, mqttClient, topic, buffer) {
  const route = parseTopic(topic);
  const payload = parsePayload(buffer);
  if (!route || !payload) return false;
  if (payload.deviceId && payload.deviceId !== route.deviceId) return false;

  if (["status", "telemetry", "session"].includes(route.channel)) {
    const column = route.channel;
    await pool.query(
      `INSERT INTO device_live (device_id, ${column}, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (device_id) DO UPDATE
       SET ${column} = EXCLUDED.${column}, updated_at = now()`,
      [route.deviceId, JSON.stringify(payload)],
    );
    return true;
  }

  if (route.channel === "event") {
    await pool.query(
      "INSERT INTO device_events (device_id, event) VALUES ($1, $2::jsonb)",
      [route.deviceId, JSON.stringify(payload)],
    );
    return true;
  }

  if (route.channel === "command/ack") {
    const commandId = String(payload.id || "");
    if (!commandId) return false;
    await pool.query(
      `INSERT INTO command_ack (device_id, command_id, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (device_id, command_id) DO UPDATE
       SET payload = EXCLUDED.payload, received_at = now()`,
      [route.deviceId, commandId, JSON.stringify(payload)],
    );
    return true;
  }

  if (route.channel === "config/state") {
    await pool.query(
      `INSERT INTO device_config (device_id, config)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (device_id) DO UPDATE
       SET config = EXCLUDED.config, updated_at = now()`,
      [route.deviceId, JSON.stringify(payload)],
    );
    return true;
  }

  if (route.channel === "history/cleanup/ack") {
    const requestId = String(payload.requestId || "");
    if (!requestId) return false;
    await pool.query(
      `UPDATE history_cleanup_requests
       SET status = $1, completed_at = now()
       WHERE device_id = $2 AND request_id = $3`,
      [String(payload.status || "DONE"), route.deviceId, requestId],
    );
    mqttClient.publish(
      `voltix/${route.deviceId}/history/cleanup`,
      "",
      { qos: 1, retain: true },
    );
    return true;
  }

  const sessionId = String(payload.sessionId || payload.id || "");
  if (!sessionId) return false;
  const uid = String(payload.uid || "").trim() || null;
  const storedPayload = {
    ...payload,
    pendingSync: false,
    syncStatus: "SYNCED",
    syncedAt: new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO session_history (device_id, session_id, user_uid, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (device_id, session_id) DO UPDATE
     SET user_uid = COALESCE(session_history.user_uid, EXCLUDED.user_uid),
         payload = EXCLUDED.payload`,
    [route.deviceId, sessionId, uid, JSON.stringify(storedPayload)],
  );
  mqttClient.publish(
    `voltix/${route.deviceId}/history/ack`,
    JSON.stringify({ deviceId: route.deviceId, sessionId, stored: true }),
    { qos: 1, retain: false },
  );
  return true;
}

async function applySchema(pool) {
  const schema = await readFile(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
}

async function publishPendingCleanup(pool, mqttClient, deviceId = DEVICE_ID) {
  if (!mqttClient.connected) return false;
  const result = await pool.query(
    `SELECT payload FROM history_cleanup_requests
     WHERE device_id = $1 AND status = 'PENDING'
     ORDER BY created_at ASC LIMIT 1`,
    [deviceId],
  );
  if (!result.rows[0]?.payload) return false;
  mqttClient.publish(
    `voltix/${deviceId}/history/cleanup`,
    JSON.stringify(result.rows[0].payload),
    { qos: 1, retain: true },
  );
  return true;
}

async function startWorker(env = process.env) {
  const pool = getPool(env);
  await applySchema(pool);
  const credentials = requiredCredentials(env);
  const client = mqtt.connect(`mqtts://${HOST}:${PORT}`, {
    ...credentials,
    clientId: env.MQTT_WORKER_CLIENT_ID || "voltix-backend-worker",
    protocolVersion: 4,
    clean: false,
    keepalive: 30,
    reconnectPeriod: 5000,
  });

  client.on("connect", () => {
    const baseTopic = `voltix/${DEVICE_ID}`;
    client.subscribe({
      [`${baseTopic}/status`]: { qos: 1 },
      [`${baseTopic}/telemetry`]: { qos: 0 },
      [`${baseTopic}/session`]: { qos: 1 },
      [`${baseTopic}/event`]: { qos: 1 },
      [`${baseTopic}/history`]: { qos: 1 },
      [`${baseTopic}/command/ack`]: { qos: 1 },
      [`${baseTopic}/config/state`]: { qos: 1 },
      [`${baseTopic}/history/cleanup/ack`]: { qos: 1 },
    });
    publishPendingCleanup(pool, client).catch(error => {
      console.error("[mqtt-worker] Cleanup publish failed:", error.message);
    });
    console.info("[mqtt-worker] Connected and subscribed");
  });
  client.on("message", (topic, payload) => {
    storeMessage(pool, client, topic, payload).catch(error => {
      console.error("[mqtt-worker] Store failed:", error.message);
    });
  });
  client.on("error", error => console.error("[mqtt-worker] MQTT error:", error.message));
  const cleanupTimer = setInterval(() => {
    publishPendingCleanup(pool, client).catch(error => {
      console.error("[mqtt-worker] Cleanup retry failed:", error.message);
    });
  }, 5000);
  cleanupTimer.unref?.();
  return client;
}

if (require.main === module) {
  startWorker().catch(error => {
    console.error("[mqtt-worker] Startup failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  applySchema,
  parsePayload,
  parseTopic,
  publishPendingCleanup,
  startWorker,
  storeMessage,
};
