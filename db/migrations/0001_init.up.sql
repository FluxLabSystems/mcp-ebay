-- SDD v0.5 §21: core tables (normative columns) + required indexes.
-- No browser cookies, passwords, payment credentials, or raw profile data.

CREATE TABLE devices (
  device_id text PRIMARY KEY,
  name text NOT NULL,
  public_key_ed25519 bytea NOT NULL,
  key_fingerprint text UNIQUE NOT NULL,
  status text NOT NULL CHECK (status IN ('active','revoked')),
  agent_version text,
  paired_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE device_pairing_tokens (
  token_hash bytea PRIMARY KEY,
  requested_name text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE browser_sessions (
  browser_session_handle text PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(device_id),
  profile_name text NOT NULL,
  status text NOT NULL,
  opened_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  closed_at timestamptz
);

CREATE TABLE audit_events (
  event_id text PRIMARY KEY,
  observed_at timestamptz NOT NULL DEFAULT now(),
  user_subject text,
  device_id text REFERENCES devices(device_id),
  browser_session_handle text,
  tab_id text,
  tool_name text,
  request_id text,
  action_class text NOT NULL,
  outcome text NOT NULL,
  error_code text,
  trace_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE artifacts (
  artifact_id text PRIMARY KEY,
  request_id text NOT NULL,
  owner_subject text,
  mime_type text NOT NULL,
  byte_length bigint NOT NULL,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- §21 required indexes
CREATE INDEX idx_devices_status_last_seen ON devices (status, last_seen_at);
CREATE INDEX idx_browser_sessions_device_status ON browser_sessions (device_id, status);
CREATE INDEX idx_audit_events_observed_at ON audit_events (observed_at);
CREATE INDEX idx_audit_events_request_id ON audit_events (request_id);
CREATE INDEX idx_artifacts_expires_at ON artifacts (expires_at);
