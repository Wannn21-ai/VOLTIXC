"use strict";

const { randomUUID } = require("node:crypto");
const { verifyWebUser } = require("../backend/auth.js");
const { requestBody, sendJson } = require("../backend/http.js");
const { publishJson } = require("../backend/mqtt-publisher.js");

const DEVICE_ID = "device01";
const ALLOWED_TYPES = new Set(["START", "STOP"]);

function optionalText(value, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.slice(0, maxLength);
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function createHandler(dependencies = {}) {
  const verifyUser = dependencies.verifyUser || verifyWebUser;
  const publish = dependencies.publish || publishJson;
  const now = dependencies.now || Date.now;
  const makeId = dependencies.makeId || randomUUID;

  return async function handler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return sendJson(response, 405, { error: "method_not_allowed" });
    }
    const body = requestBody(request);
    const type = optionalText(body?.type, 16).toUpperCase();
    if (!body || !ALLOWED_TYPES.has(type)) {
      return sendJson(response, 400, { error: "invalid_command" });
    }

    let user;
    try {
      user = await verifyUser(request, dependencies);
    } catch {
      return sendJson(response, 503, { error: "authentication_unavailable" });
    }
    if (!user?.uid) return sendJson(response, 401, { error: "authentication_required" });

    const issuedAt = now();
    const command = {
      deviceId: DEVICE_ID,
      id: `cmd_${makeId()}`,
      command: type.toLowerCase(),
      uid: user.uid,
      sessionId: optionalText(body.sessionId, 48),
      deviceName: optionalText(body.deviceName, 31),
      issuedAt,
      expiresAt: issuedAt + 15000,
    };
    for (const key of [
      "tariff",
      "overloadThreshold",
      "loadPowerThreshold",
      "loadCurrentThreshold",
    ]) {
      const value = finitePositive(body[key]);
      if (value !== undefined) command[key] = value;
    }

    try {
      await publish(`voltix/${DEVICE_ID}/command`, command, { qos: 1, retain: false }, dependencies);
      return sendJson(response, 202, { accepted: true, id: command.id, expiresAt: command.expiresAt });
    } catch {
      return sendJson(response, 503, { error: "mqtt_unavailable" });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
