-- Wave 2 MAILR: the content restore journal (engine/content/restore/journal.mjs).
-- One run per restore plan; one entry per container or item the run creates or decides
-- to leave alone. A run interrupted part way resumes from its entries, so nothing is
-- written twice. Mail restore writes it; file restore (FILER) uses the same tables.
-- Additive and safe to re-apply.

-- id is the plan's digest, so the same request always resumes the same run.
CREATE TABLE IF NOT EXISTS content_restore_run (
  id            text PRIMARY KEY,
  tenant_ref    text NOT NULL,
  workload      text NOT NULL,
  plan          jsonb NOT NULL,
  label         text NOT NULL,
  requested_by  text,
  approved_by   text,
  status        text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  report        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- source_key names what the entry is about: a content ref (keel-content:<uuid>) for an
-- item, or a container key for a folder, calendar or list the run created or reused.
-- pending is written before the write is sent, so a resume knows to look for it first.
CREATE TABLE IF NOT EXISTS content_restore_entry (
  run_id      text NOT NULL REFERENCES content_restore_run (id) ON DELETE CASCADE,
  source_key  text NOT NULL,
  kind        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('pending', 'restored', 'skipped', 'failed')),
  target_id   text,
  reason      text,
  attempts    integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, source_key)
);
