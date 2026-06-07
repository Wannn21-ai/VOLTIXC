"use strict";

const REQUIRED_SERVER_ENV_VARS = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
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

async function verifyDeviceCredential(
  deviceId,
  deviceSecret,
  credentialVersion
) {
  void deviceId;
  void deviceSecret;
  void credentialVersion;

  // Replace this fail-closed placeholder only after a reviewed credential
  // store verifies enabled state, version, secret hash, and revocation state.
  return { verified: false, reason: "not_implemented" };
}

function buildCustomClaims(deviceRecord) {
  return {
    deviceId: deviceRecord.deviceId,
    deviceRole: "hardware",
    ownerUid: deviceRecord.ownerUid,
    credentialVersion: deviceRecord.credentialVersion,
  };
}

async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "method_not_allowed" });
  }

  const validation = validateRequestBody(request.body);
  if (!validation.ok) {
    return sendJson(response, 400, { error: "invalid_request" });
  }

  if (missingServerEnvVars().length > 0) {
    return sendJson(response, 503, { error: "broker_unavailable" });
  }

  try {
    const requestBody = validation.value;
    const verification = await verifyDeviceCredential(
      requestBody.deviceId,
      requestBody.deviceSecret,
      requestBody.credentialVersion
    );

    if (verification.reason === "not_implemented") {
      return sendJson(response, 501, {
        error: "credential_verification_not_implemented",
      });
    }

    if (!verification.verified) {
      return sendJson(response, 401, { error: "invalid_device_credential" });
    }

    // Token signing intentionally remains unreachable until credential
    // verification and its backing store have been implemented and reviewed.
    return sendJson(response, 501, { error: "token_signing_not_implemented" });
  } catch {
    return sendJson(response, 500, { error: "internal_error" });
  }
}

module.exports = handler;
module.exports.REQUIRED_SERVER_ENV_VARS = REQUIRED_SERVER_ENV_VARS;
module.exports.buildCustomClaims = buildCustomClaims;
module.exports.missingServerEnvVars = missingServerEnvVars;
module.exports.validateRequestBody = validateRequestBody;
module.exports.verifyDeviceCredential = verifyDeviceCredential;
