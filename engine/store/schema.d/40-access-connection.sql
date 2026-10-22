-- Connections: one row per Keel app or service account in a tenant, and an event for
-- every change to one (handoff/delegated-access DESIGN 3.4). Filled by
-- engine/bootstrap/connections.mjs from what the Setup page already reads. Holds
-- references only: credential_ref names the credential file on the host, never a secret.
-- Additive and safe to re-apply.
CREATE TABLE IF NOT EXISTS access_connection (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref             text NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('app', 'service-account')),
  role                   text NOT NULL CHECK (role IN ('control', 'settings-reader', 'admin-role-reader', 'content-reader',
                           'power-platform-reader', 'settings-restorer', 'content-restorer', 'delegated',
                           'svc-reader', 'svc-writer', 'svc-dataverse')),
  -- App id, or the user object id for a service account.
  object_ref             text,
  -- not-checked: Keel could not look at the tenant yet, so nothing is claimed.
  state                  text NOT NULL CHECK (state IN ('not-checked', 'not-created', 'waiting-for-consent', 'working',
                           'missing-permission', 'switched-off', 'needs-reconnect', 'removed')),
  wanted                 jsonb,
  observed               jsonb,
  credential_ref         text,
  credential_expires_at  timestamptz,
  last_used_at           timestamptz,
  last_sign_in_at        timestamptz,
  created_by             text NOT NULL,
  updated_by             text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_ref, role)
);

CREATE TABLE IF NOT EXISTS access_event (
  id                    bigserial PRIMARY KEY,
  tenant_ref            text NOT NULL,
  connection_id         uuid NOT NULL REFERENCES access_connection(id),
  action                text NOT NULL,
  actor                 text NOT NULL,
  at                    timestamptz NOT NULL DEFAULT now(),
  before                jsonb,
  after                 jsonb,
  entra_correlation_id  text
);
CREATE INDEX IF NOT EXISTS access_event_connection_idx ON access_event (connection_id, at DESC);
CREATE INDEX IF NOT EXISTS access_event_tenant_idx ON access_event (tenant_ref, at DESC);
