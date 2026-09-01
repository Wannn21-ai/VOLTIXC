"use strict";

const { randomInt } = require("node:crypto");
const deviceToken = require("./device-token");

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_CANDIDATES = 16;

function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(statusCode).json(body);
}

function createCodeCandidates(randomNumber = randomInt) {
  const candidates = [];
  let attempts = 0;
  while (candidates.length < MAX_CODE_CANDIDATES && attempts < MAX_CODE_CANDIDATES * 4) {
    attempts++;
    const code = String(randomNumber(0, 1000000)).padStart(6, "0");
    if (!candidates.includes(code)) candidates.push(code);
  }
  return candidates;
}

function createHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const getAdminServices = dependencies.getAdminServices || deviceToken.getFirebaseAdminServices;
  const now = dependencies.now || Date.now;
  const randomNumber = dependencies.randomInt || randomInt;

  return async function handler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return sendJson(response, 405, { error: "method_not_allowed" });
    }

    const validation = deviceToken.validateRequestBody(request.body);
    if (!validation.ok) {
      return sendJson(response, 400, { error: "invalid_request" });
    }
    if (deviceToken.missingServerEnvVars(env).length > 0) {
      return sendJson(response, 503, { error: "pairing_service_unavailable" });
    }

    let services;
    try {
      services = await getAdminServices(env);
    } catch {
      return sendJson(response, 503, { error: "pairing_service_unavailable" });
    }

    const requestBody = validation.value;
    const requestedAt = now();
    const candidates = createCodeCandidates(randomNumber);
    let outcome = { error: "pairing_service_unavailable" };

    try {
      const rootRef = services.database.ref("/");
      const initialSnapshot = await rootRef.get();
      const initialRoot = initialSnapshot.val();
      const result = await rootRef.transaction((rootValue) => {
        outcome = { error: "pairing_service_unavailable" };
        const transactionRoot = rootValue === null ? initialRoot : rootValue;
        const root = transactionRoot && typeof transactionRoot === "object"
          ? structuredClone(transactionRoot)
          : {};
        const device = root.devices?.[requestBody.deviceId];
        const verification = deviceToken.verifyDeviceCredentialRecord(
          requestBody.deviceId,
          requestBody.deviceSecret,
          requestBody.credentialVersion,
          device,
          {
            pepper: env.DEVICE_AUTH_PEPPER,
            requireOwner: false,
          }
        );
        if (!verification.verified) {
          outcome = { error: "invalid_device_credential" };
          return;
        }
        if (device.paired === true ||
            (typeof device.ownerUid === "string" && device.ownerUid.trim())) {
          outcome = { error: "device_already_owned" };
          return;
        }

        const pairingCodes = root.pairingCodes || {};
        for (const [code, record] of Object.entries(pairingCodes)) {
          if (/^\d{6}$/.test(code) &&
              record?.deviceId === requestBody.deviceId &&
              record.used === false &&
              Number.isFinite(Number(record.expiresAt)) &&
              Number(record.expiresAt) > requestedAt) {
            outcome = { code, expiresAt: Number(record.expiresAt), reused: true };
            return;
          }
        }

        const code = candidates.find((candidate) => !pairingCodes[candidate]);
        if (!code) {
          outcome = { error: "pairing_code_collision" };
          return;
        }

        if (!root.pairingCodes) root.pairingCodes = {};
        const expiresAt = requestedAt + PAIRING_CODE_TTL_MS;
        root.pairingCodes[code] = {
          deviceId: requestBody.deviceId,
          createdAt: requestedAt,
          expiresAt,
          used: false,
        };
        outcome = { code, expiresAt, reused: false };
        return root;
      }, undefined, false);

      if (!result.committed && !outcome.code) {
        const status = outcome.error === "invalid_device_credential" ? 401 :
          outcome.error === "device_already_owned" ? 409 : 503;
        return sendJson(response, status, { error: outcome.error });
      }
      return sendJson(response, 200, {
        code: outcome.code,
        expiresAt: outcome.expiresAt,
      });
    } catch {
      return sendJson(response, 503, { error: "pairing_service_unavailable" });
    }
  };
}

module.exports = createHandler();
module.exports.PAIRING_CODE_TTL_MS = PAIRING_CODE_TTL_MS;
module.exports.createCodeCandidates = createCodeCandidates;
module.exports.createHandler = createHandler;
