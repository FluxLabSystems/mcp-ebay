-- Phase 4: server-side checkpoint of what a scheduled research run has
-- already done. audit_events is insert-only by design (§21) and records
-- calls, not run progress, so a run that ended at the per-turn tool-call
-- ceiling had nothing to resume from and re-searched from zero.
--
-- Identifiers and counts only. No scraped page content, no listing text.
-- Rows carry their own expiry and are swept alongside pairing tokens.

CREATE TABLE run_checkpoints (
  run_id text PRIMARY KEY,
  dashboard text NOT NULL,
  owner_subject text,
  status text NOT NULL CHECK (status IN ('running','completed','abandoned')),
  searched jsonb NOT NULL DEFAULT '[]'::jsonb,
  verified_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  checkpoint_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

-- The resume lookup: newest unexpired 'running' run for one dashboard.
CREATE INDEX idx_run_checkpoints_resumable ON run_checkpoints (dashboard, status, updated_at DESC);
-- Retention sweep, mirroring idx_artifacts_expires_at.
CREATE INDEX idx_run_checkpoints_expires_at ON run_checkpoints (expires_at);
