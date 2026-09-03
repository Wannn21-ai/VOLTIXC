"use strict";

const { randomUUID } = require("node:crypto");
const { verifyWebUser } = require("../backend/auth.js");
const { getPool } = require("../backend/db.js");
const { requestBody, sendJson } = require("../backend/http.js");

const DEVICE_ID = "device01";

function createHandler(dependencies = {}) {
  const verifyUser = dependencies.verifyUser || verifyWebUser;
  const getDatabasePool = dependencies.getPool || getPool;
  const now = dependencies.now || Date.now;
  const makeId = dependencies.makeId || randomUUID;

  return async function handler(request, response) {
    if (!["GET", "POST", "DELETE"].includes(request.method)) {
      response.setHeader("Allow", "GET, POST, DELETE");
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
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          `UPDATE session_history SET user_uid = $1
           WHERE device_id = $2 AND user_uid IS NULL`,
          [user.uid, DEVICE_ID],
        );
        const result = await connection.query(
          `SELECT session_id, payload, received_at
           FROM session_history
           WHERE device_id = $1 AND user_uid = $2
           ORDER BY received_at DESC`,
          [DEVICE_ID, user.uid],
        );
        await connection.query("COMMIT");
        const sessions = result.rows.map(row => ({
          ...row.payload,
          id: row.payload?.id || row.session_id,
          sessionId: row.payload?.sessionId || row.session_id,
          receivedAt: row.received_at,
        }));
        return sendJson(response, 200, { sessions });
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    }

    const body = requestBody(request);
    if (request.method === "POST") {
      const sessionId = typeof body?.sessionId === "string"
        ? body.sessionId.trim()
        : typeof body?.id === "string" ? body.id.trim() : "";
      if (!sessionId || sessionId.length > 64) {
        return sendJson(response, 400, { error: "session_id_required" });
      }
      const payload = { ...body, uid: user.uid, sessionId };
      const result = await pool.query(
        `INSERT INTO session_history (device_id, session_id, user_uid, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (device_id, session_id) DO UPDATE
         SET user_uid = EXCLUDED.user_uid, payload = EXCLUDED.payload
         WHERE session_history.user_uid IS NULL
            OR session_history.user_uid = EXCLUDED.user_uid
         RETURNING session_id`,
        [DEVICE_ID, sessionId, user.uid, JSON.stringify(payload)],
      );
      if (result.rowCount === 0) {
        return sendJson(response, 409, { error: "session_owned_by_another_user" });
      }
      return sendJson(response, 201, { stored: true, sessionId });
    }
    const deleteAll = body?.all === true;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    if (!deleteAll && !sessionId) {
      return sendJson(response, 400, { error: "session_id_required" });
    }
    const requestId = `cleanup_${makeId()}`;
    const createdAt = now();
    const cleanupPayload = deleteAll
      ? {
          deviceId: DEVICE_ID,
          type: "DELETE_ALL_HISTORY",
          requestId,
          beforeTs: createdAt,
          requestedBy: user.uid,
          createdAt,
        }
      : {
          deviceId: DEVICE_ID,
          type: "DELETE_HISTORY_SESSION",
          requestId,
          sessionIds: [sessionId],
          requestedBy: user.uid,
          createdAt,
        };
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      const result = deleteAll
        ? await connection.query(
            "DELETE FROM session_history WHERE device_id = $1 AND user_uid = $2",
            [DEVICE_ID, user.uid],
          )
        : await connection.query(
            `DELETE FROM session_history
             WHERE device_id = $1 AND user_uid = $2 AND session_id = $3`,
            [DEVICE_ID, user.uid, sessionId],
          );
      await connection.query(
        `INSERT INTO history_cleanup_requests
         (device_id, request_id, user_uid, payload)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [DEVICE_ID, requestId, user.uid, JSON.stringify(cleanupPayload)],
      );
      await connection.query("COMMIT");
      return sendJson(response, 202, {
        deleted: result.rowCount,
        cleanupQueued: true,
        requestId,
      });
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
