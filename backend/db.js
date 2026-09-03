"use strict";

const { Pool } = require("pg");

let pool;

function databaseUrl(env = process.env) {
  const value = env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

function getPool(env = process.env) {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl(env),
      ssl: env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: true },
      max: Number(env.DATABASE_POOL_MAX || 5),
    });
  }
  return pool;
}

module.exports = { databaseUrl, getPool };
