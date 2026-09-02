"use strict";

const { getFirebaseAdminServices } = require("./device-token.js");

const MQTT_HOST = "ed7655203a9e419493d52c0b8771c836.s1.eu.hivemq.cloud";
const MQTT_PORT = 8884;
const MQTT_PATH = "/mqtt";
const MQTT_DEVICE_ID = "device01";
const REQUIRED_SERVER_ENV_VARS = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_DATABASE_URL",
  "MQTT_WEB_USERNAME",
  "MQTT_WEB_PASSWORD",
];

function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  return response.status(statusCode).json(body);
}

function missingServerEnvVars(env = process.env) {
  return REQUIRED_SERVER_ENV_VARS.filter(name => !env[name]?.trim());
}

function bearerToken(header) {
  if (typeof header !== "string") return "";
  const match = header.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  return match ? match[1] : "";
}

function createHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const getAdminServices = dependencies.getAdminServices || getFirebaseAdminServices;

  return async function handler(request, response) {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      return sendJson(response, 405, { error: "method_not_allowed" });
    }

    if (missingServerEnvVars(env).length > 0) {
      return sendJson(response, 503, { error: "mqtt_config_unavailable" });
    }

    const idToken = bearerToken(request.headers?.authorization);
    if (!idToken) {
      return sendJson(response, 401, { error: "authentication_required" });
    }

    let services;
    try {
      services = await getAdminServices(env);
    } catch {
      return sendJson(response, 503, { error: "mqtt_config_unavailable" });
    }

    try {
      const decoded = await services.auth.verifyIdToken(idToken, true);
      if (!decoded?.uid) {
        return sendJson(response, 401, { error: "authentication_required" });
      }

      return sendJson(response, 200, {
        host: MQTT_HOST,
        port: MQTT_PORT,
        path: MQTT_PATH,
        deviceId: MQTT_DEVICE_ID,
        username: env.MQTT_WEB_USERNAME.trim(),
        password: env.MQTT_WEB_PASSWORD,
      });
    } catch {
      return sendJson(response, 401, { error: "authentication_required" });
    }
  };
}

module.exports = createHandler();
module.exports.REQUIRED_SERVER_ENV_VARS = REQUIRED_SERVER_ENV_VARS;
module.exports.bearerToken = bearerToken;
module.exports.createHandler = createHandler;
module.exports.missingServerEnvVars = missingServerEnvVars;
