CREATE TABLE IF NOT EXISTS device_live (
  device_id text PRIMARY KEY,
  status jsonb,
  telemetry jsonb,
  session jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_events (
  id bigserial PRIMARY KEY,
  device_id text NOT NULL,
  event jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_history (
  device_id text NOT NULL,
  session_id text NOT NULL,
  user_uid text,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, session_id)
);

CREATE INDEX IF NOT EXISTS session_history_user_received_idx
  ON session_history (user_uid, received_at DESC);

CREATE TABLE IF NOT EXISTS user_settings (
  user_uid text PRIMARY KEY,
  settings jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_config (
  device_id text PRIMARY KEY,
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS command_ack (
  device_id text NOT NULL,
  command_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, command_id)
);

CREATE TABLE IF NOT EXISTS history_cleanup_requests (
  device_id text NOT NULL,
  request_id text NOT NULL,
  user_uid text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (device_id, request_id)
);

CREATE INDEX IF NOT EXISTS history_cleanup_pending_idx
  ON history_cleanup_requests (device_id, status, created_at);
