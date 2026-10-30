-- Issue #681: the Engage writer, a small app of its own for Viva Engage community
-- restores, gets its own connection row. The role check is widened by dropping and
-- re-adding it under the same name, so this stays safe to re-apply.
ALTER TABLE access_connection DROP CONSTRAINT IF EXISTS access_connection_role_check;
ALTER TABLE access_connection ADD CONSTRAINT access_connection_role_check
  CHECK (role IN ('control', 'settings-reader', 'admin-role-reader', 'content-reader',
    'power-platform-reader', 'settings-restorer', 'content-restorer', 'engage-writer', 'delegated',
    'svc-reader', 'svc-writer', 'svc-dataverse'));
