-- Hide people's names (redesign Track A3, IN-ANON). One row for the whole install:
-- when enabled, every person Keel names is shown as a stable code name ("Person K7Q2")
-- worked out from their id or email and this row's salt (engine/insights/anonymity.mjs).
-- The salt is made once and kept when the setting is turned off and on again, so a
-- person keeps the same code name. Only an admin changes the setting, and each change
-- is written to the audit record (evidence kind 'people-anonymity').
CREATE TABLE IF NOT EXISTS people_anonymity (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled    boolean NOT NULL DEFAULT false,
  salt       text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text NOT NULL
);
