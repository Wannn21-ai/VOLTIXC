"use strict";

const { verifyWebUser } = require("../backend/auth.js");
const { getPool } = require("../backend/db.js");
const { requestBody, sendJson } = require("../backend/http.js");
const { publishJson } = require("../backend/mqtt-publisher.js");

const DEVICE_ID = "device01";
const ALLOWED_KEYS = new Set([
  "currency", "tariff", "overloadThreshold", "overloadWarningPercent",
  "loadPowerThreshold", "loadCurrentThreshold", "loadRemovedDelaySec",
  "offlineTimeoutSec", "checkpointIntervalSec", "notifDevice",
  "notifDisconnect", "notifSession", "notifOverload", "refreshInterval",
  "theme", "language",
]);

function sanitizeSettings(input) {
  const output = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return output;
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (["string", "number", "boolean"].includes(typeof value)) output[key] = value;
  }
  return output;
}

function deviceConfig(settings, revision) {
  const output = { deviceId: DEVICE_ID, revision };
  for (const key of [
    "currency", "tariff", "overloadThreshold", "overloadWarningPercent",
    "loadPowerThreshold", "loadCurrentThreshold", "loadRemovedDelaySec",
    "offlineTimeoutSec", "checkpointIntervalSec",
  ]) {
    if (settings[key] !== undefined) output[key] = settings[key];
  }
  return output;
}

function createHandler(dependencies = {}) {
  const verifyUser = dependencies.verifyUser || verifyWebUser;
  const getDatabasePool = dependencies.getPool || getPool;
  const publish = dependencies.publish || publishJson;
  const now = dependencies.now || Date.now;

  return async function handler(request, response) {
    if (!["GET", "PUT"].includes(request.method)) {
      response.setHeader("Allow", "GET, PUT");
      return sendJson(response, 405, { error: "method_not_allowed" });
    }
    let user;
    try {
      user = await verifyUser(request, dependencies);
    } catch {
      return sendJson(response, 503, { error: "authentication_unavailable" });
    }
    if (!user?.uid) return sendJson(response, 401, { error: "authentication_required" });
    const pool = dependencies.pool || getDatabasePool(dependencies.env || process.env);

    if (request.method === "GET") {
      const result = await pool.query(
        "SELECT settings FROM user_settings WHERE user_uid = $1",
        [user.uid],
      );
      return sendJson(response, 200, { settings: result.rows[0]?.settings || {} });
    }

    const patch = sanitizeSettings(requestBody(request));
    if (Object.keys(patch).length === 0) {
      return sendJson(response, 400, { error: "invalid_settings" });
    }
    const result = await pool.query(
      `INSERT INTO user_settings (user_uid, settings)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (user_uid) DO UPDATE
       SET settings = user_settings.settings || EXCLUDED.settings, updated_at = now()
       RETURNING settings`,
      [user.uid, JSON.stringify(patch)],
    );
    const settings = result.rows[0].settings;
    const revision = now();
    try {
      await publish(
        `voltix/${DEVICE_ID}/config`,
        deviceConfig(settings, revision),
        { qos: 1, retain: true },
        dependencies,
      );
    } catch {
      return sendJson(response, 202, { settings, revision, mqttPending: true });
    }
    return sendJson(response, 200, { settings, revision });
  };
}

module.exports = createHandler();
module.exports.ALLOWED_KEYS = ALLOWED_KEYS;
module.exports.createHandler = createHandler;
module.exports.deviceConfig = deviceConfig;
module.exports.sanitizeSettings = sanitizeSettings;
