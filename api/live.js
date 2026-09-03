"use strict";

const { verifyWebUser } = require("../backend/auth.js");
const { getPool } = require("../backend/db.js");
const { sendJson } = require("../backend/http.js");

const DEVICE_ID = "device01";

function createHandler(dependencies = {}) {
  const verifyUser = dependencies.verifyUser || verifyWebUser;
  const getDatabasePool = dependencies.getPool || getPool;
  return async function handler(request, response) {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
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
    const result = await pool.query(
      `SELECT status, telemetry, session, updated_at
       FROM device_live WHERE device_id = $1`,
      [DEVICE_ID],
    );
    return sendJson(response, 200, result.rows[0] || {
      status: { online: false }, telemetry: {}, session: {}, updated_at: null,
    });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
