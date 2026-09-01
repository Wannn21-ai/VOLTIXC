"use strict";

const deviceToken = require("./device-token");

function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(statusCode).json(body);
}

function createHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const getAdminServices = dependencies.getAdminServices || deviceToken.getFirebaseAdminServices;

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

        const memberUids = new Set(Object.keys(device.members || {}));
        if (typeof device.ownerUid === "string" && device.ownerUid.trim()) {
          memberUids.add(device.ownerUid.trim());
        }
        for (const uid of memberUids) {
          if (root.users?.[uid]?.devices) {
            delete root.users[uid].devices[requestBody.deviceId];
          }
        }

        delete device.ownerUid;
        device.paired = false;
        delete device.ownerProfile;
        delete device.members;
        for (const [code, pairing] of Object.entries(root.pairingCodes || {})) {
          if (pairing?.deviceId === requestBody.deviceId) {
            delete root.pairingCodes[code];
          }
        }
        outcome = { released: true };
        return root;
      }, undefined, false);

      if (!result.committed) {
        const status = outcome.error === "invalid_device_credential" ? 401 : 503;
        return sendJson(response, status, { error: outcome.error });
      }
      return sendJson(response, 200, { released: true });
    } catch {
      return sendJson(response, 503, { error: "pairing_service_unavailable" });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
