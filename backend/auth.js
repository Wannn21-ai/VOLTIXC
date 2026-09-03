"use strict";

const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

function getAuthService(env = process.env) {
  for (const name of ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"]) {
    if (!env[name]?.trim()) throw new Error("Firebase Auth server configuration is incomplete");
  }
  const app = getApps()[0] || initializeApp({
    credential: cert({
      projectId: env.FIREBASE_PROJECT_ID.trim(),
      clientEmail: env.FIREBASE_CLIENT_EMAIL.trim(),
      privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
  return getAuth(app);
}

function bearerToken(header) {
  if (typeof header !== "string") return "";
  const match = header.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  return match ? match[1] : "";
}

async function verifyWebUser(request, dependencies = {}) {
  const token = bearerToken(request.headers?.authorization);
  if (!token) return null;
  const authService = dependencies.auth || getAuthService(dependencies.env || process.env);
  try {
    const decoded = await authService.verifyIdToken(token, true);
    return decoded?.uid ? decoded : null;
  } catch (error) {
    // Invalid, expired, and revoked ID tokens are authentication failures, not
    // backend outages. Configuration/network failures still bubble up as 503.
    if (typeof error?.code === "string" && error.code.startsWith("auth/")) return null;
    throw error;
  }
}

module.exports = { bearerToken, getAuthService, verifyWebUser };
