"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");

const BROKER_APP_NAME = "voltix-device-token-broker";
const REQUIRED_SERVER_ENV_VARS = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_DATABASE_URL",
  "DEVICE_AUTH_PEPPER",
];

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
const ALLOWED_BODY_FIELDS = new Set([
  "deviceId",
  "deviceSecret",
  "credentialVersion",
]);

function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(statusCode).json(body);
}

function parseRequestBody(body) {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  return body;
}

function validateRequestBody(rawBody) {
  const body = parseRequestBody(rawBody);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false };
  }

  if (Object.keys(body).some((field) => !ALLOWED_BODY_FIELDS.has(field))) {
    return { ok: false };
  }

  if (typeof body.deviceId !== "string" ||
      !DEVICE_ID_PATTERN.test(body.deviceId)) {
    return { ok: false };
  }

  if (typeof body.deviceSecret !== "string" ||
      body.deviceSecret.length < 16 ||
      body.deviceSecret.length > 4096) {
    return { ok: false };
  }

  if (!Number.isSafeInteger(body.credentialVersion) ||
      body.credentialVersion < 1) {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      deviceId: body.deviceId,
      deviceSecret: body.deviceSecret,
      credentialVersion: body.credentialVersion,
    },
  };
}

function missingServerEnvVars(env = process.env) {
  return REQUIRED_SERVER_ENV_VARS.filter((name) => !env[name]?.trim());
}

function computeDeviceSecretHash(
  deviceId,
  credentialVersion,
  deviceSecret,
  pepper
) {
  return createHash("sha256")
    .update(`${pepper}:${deviceId}:${credentialVersion}:${deviceSecret}`, "utf8")
    .digest("hex");
}

function constantTimeHashEqual(expectedHash, computedHash) {
  if (typeof expectedHash !== "string" ||
      !/^[0-9a-f]{64}$/i.test(expectedHash)) {
    return false;
  }

  const expected = Buffer.from(expectedHash, "hex");
  const computed = Buffer.from(computedHash, "hex");
  return expected.length === computed.length && timingSafeEqual(expected, computed);
}

function normalizePrivateKey(privateKey) {
  return privateKey.replace(/\\n/g, "\n");
}

function getFirebaseAdminServices(env = process.env) {
  const { cert, getApps, initializeApp } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  const { getDatabase } = require("firebase-admin/database");

  let app = getApps().find((candidate) => candidate.name === BROKER_APP_NAME);
  if (!app) {
    app = initializeApp({
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID.trim(),
        clientEmail: env.FIREBASE_CLIENT_EMAIL.trim(),
        privateKey: normalizePrivateKey(env.FIREBASE_PRIVATE_KEY),
      }),
      databaseURL: env.FIREBASE_DATABASE_URL.trim(),
    }, BROKER_APP_NAME);
  }

  return {
    auth: getAuth(app),
    database: getDatabase(app),
  };
}

async function verifyDeviceCredential(
  deviceId,
  deviceSecret,
  credentialVersion,
  options
) {
  const snapshot = await options.database.ref(`/devices/${deviceId}`).get();
  if (!snapshot.exists()) return { verified: false };

  const device = snapshot.val();
  const deviceAuth = device?.deviceAuth;
  if (typeof device?.ownerUid !== "string" || !device.ownerUid.trim() ||
      !deviceAuth || deviceAuth.enabled !== true ||
      deviceAuth.revoked === true ||
      deviceAuth.credentialVersion !== credentialVersion ||
      deviceAuth.hashAlg !== "sha256-pepper-v1") {
    return { verified: false };
  }

  const computedHash = computeDeviceSecretHash(
    deviceId,
    credentialVersion,
    deviceSecret,
    options.pepper
  );
  if (!constantTimeHashEqual(deviceAuth.secretHash, computedHash)) {
    return { verified: false };
  }

  return {
    verified: true,
    deviceRecord: {
      deviceId,
      ownerUid: device.ownerUid,
      credentialVersion,
    },
  };
}

function buildCustomClaims(deviceRecord) {
  return {
    deviceId: deviceRecord.deviceId,
    deviceRole: "hardware",
    ownerUid: deviceRecord.ownerUid,
    credentialVersion: deviceRecord.credentialVersion,
  };
}

function createHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const getAdminServices = dependencies.getAdminServices || getFirebaseAdminServices;
  const now = dependencies.now || Date.now;

  return async function handler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return sendJson(response, 405, { error: "method_not_allowed" });
    }

    const validation = validateRequestBody(request.body);
    if (!validation.ok) {
      return sendJson(response, 400, { error: "invalid_request" });
    }

    if (missingServerEnvVars(env).length > 0) {
      return sendJson(response, 503, { error: "broker_unavailable" });
    }

    let services;
    try {
      services = await getAdminServices(env);
    } catch {
      return sendJson(response, 503, { error: "broker_unavailable" });
    }

    try {
      const requestBody = validation.value;
      const verification = await verifyDeviceCredential(
        requestBody.deviceId,
        requestBody.deviceSecret,
        requestBody.credentialVersion,
        {
          database: services.database,
          pepper: env.DEVICE_AUTH_PEPPER,
        }
      );

      if (!verification.verified) {
        return sendJson(response, 401, { error: "invalid_device_credential" });
      }

      const deviceRecord = verification.deviceRecord;
      const customToken = await services.auth.createCustomToken(
        `device:${deviceRecord.deviceId}`,
        buildCustomClaims(deviceRecord)
      );
      const issuedAt = now();
      await services.database
        .ref(`/devices/${deviceRecord.deviceId}/deviceAuth`)
        .update({
          lastTokenIssuedAt: issuedAt,
          lastSeenAt: issuedAt,
        });

      return sendJson(response, 200, {
        customToken,
        expiresInSec: 3600,
      });
    } catch {
      return sendJson(response, 500, { error: "internal_error" });
    }
  };
}

module.exports = createHandler();
module.exports.REQUIRED_SERVER_ENV_VARS = REQUIRED_SERVER_ENV_VARS;
module.exports.buildCustomClaims = buildCustomClaims;
module.exports.computeDeviceSecretHash = computeDeviceSecretHash;
module.exports.constantTimeHashEqual = constantTimeHashEqual;
module.exports.createHandler = createHandler;
module.exports.getFirebaseAdminServices = getFirebaseAdminServices;
module.exports.missingServerEnvVars = missingServerEnvVars;
module.exports.normalizePrivateKey = normalizePrivateKey;
module.exports.validateRequestBody = validateRequestBody;
module.exports.verifyDeviceCredential = verifyDeviceCredential;
