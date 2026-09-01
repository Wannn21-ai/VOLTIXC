"use strict";

const deviceToken = require("./device-token");

const ADMIN_ENV_VARS = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_DATABASE_URL",
];
const CODE_PATTERN = /^\d{6}$/;

function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(statusCode).json(body);
}

function parseBody(body) {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function bearerToken(headers = {}) {
  const authorization = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1] : "";
}

function createHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const getAdminServices = dependencies.getAdminServices || deviceToken.getFirebaseAdminServices;
  const now = dependencies.now || Date.now;

  return async function handler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return sendJson(response, 405, { error: "method_not_allowed" });
    }

    const body = parseBody(request.body);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((field) => field !== "code") ||
        typeof body.code !== "string" || !CODE_PATTERN.test(body.code)) {
      return sendJson(response, 400, { error: "invalid_request" });
    }
    const idToken = bearerToken(request.headers);
    if (!idToken) {
      return sendJson(response, 401, { error: "authentication_expired" });
    }
    if (ADMIN_ENV_VARS.some((name) => !env[name]?.trim())) {
      return sendJson(response, 503, { error: "pairing_service_unavailable" });
    }

    let services;
    try {
      services = await getAdminServices(env);
    } catch {
      return sendJson(response, 503, { error: "pairing_service_unavailable" });
    }

    let decodedToken;
    let userRecord;
    try {
      decodedToken = await services.auth.verifyIdToken(idToken, true);
      userRecord = await services.auth.getUser(decodedToken.uid);
      if (typeof decodedToken.uid !== "string" || !decodedToken.uid || userRecord.disabled === true) {
        throw new Error("invalid user");
      }
    } catch {
      return sendJson(response, 401, { error: "authentication_expired" });
    }

    const uid = decodedToken.uid;
    const displayName = typeof userRecord.displayName === "string"
      ? userRecord.displayName.trim().slice(0, 80)
      : "";
    const claimedAt = now();
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
        const pairing = root.pairingCodes?.[body.code];
        if (!pairing) {
          outcome = { error: "invalid_code" };
          return;
        }
        if (pairing.used === true) {
          outcome = { error: "code_already_used" };
          return;
        }
        if (!Number.isFinite(Number(pairing.expiresAt)) ||
            Number(pairing.expiresAt) <= claimedAt) {
          outcome = { error: "expired_code" };
          return;
        }

        const deviceId = pairing.deviceId;
        const device = root.devices?.[deviceId];
        if (!device) {
          outcome = { error: "invalid_code" };
          return;
        }
        const currentOwner = typeof device.ownerUid === "string"
          ? device.ownerUid.trim()
          : "";
        if (currentOwner || device.paired === true) {
          outcome = { error: "device_already_owned" };
          return;
        }

        const nickname = typeof device.name === "string" && device.name.trim()
          ? device.name.trim().slice(0, 80)
          : "VOLTIX Device";
        device.ownerUid = uid;
        device.paired = true;
        device.ownerProfile = { uid, displayName, pairingCode: body.code };
        if (!device.members) device.members = {};
        device.members[uid] = { role: "owner", addedAt: claimedAt };

        if (!root.users) root.users = {};
        if (!root.users[uid]) root.users[uid] = {};
        if (!root.users[uid].devices) root.users[uid].devices = {};
        root.users[uid].devices[deviceId] = {
          role: "owner",
          nickname,
          addedAt: claimedAt,
        };

        pairing.used = true;
        pairing.usedBy = uid;
        outcome = { deviceId, nickname };
        return root;
      }, undefined, false);

      if (!result.committed) {
        const status = outcome.error === "invalid_code" ? 404 :
          outcome.error === "expired_code" ? 410 :
          outcome.error === "code_already_used" || outcome.error === "device_already_owned" ? 409 : 503;
        return sendJson(response, status, { error: outcome.error });
      }

      return sendJson(response, 200, {
        id: outcome.deviceId,
        nickname: outcome.nickname,
        role: "owner",
      });
    } catch {
      return sendJson(response, 503, { error: "pairing_service_unavailable" });
    }
  };
}

module.exports = createHandler();
module.exports.ADMIN_ENV_VARS = ADMIN_ENV_VARS;
module.exports.bearerToken = bearerToken;
module.exports.createHandler = createHandler;
