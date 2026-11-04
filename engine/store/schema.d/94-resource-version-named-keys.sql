-- The keys that have at least one saved version with a name: the condition is
-- mayHaveNameSql() in engine/cir/objectName.mjs, kept as the same text (engine/insights/names.test.mjs checks the name probe uses this index).
-- Plain (not concurrent) build, like fragments 91 and 93: writes to resource_version wait
-- a few seconds the first time this is applied.
--
-- Users: engine/insights/names.mjs and portal/lib/saved-names.ts. When an object's newest
-- version has no name, they walk its older versions for one. For kinds that never carry a
-- name (app consent, role assignments, owners) that read every saved version of the object,
-- hundreds each: most of the Alerts page's two name reads (operator queue Q313). One probe
-- of this index now says when there is no name to find.
CREATE INDEX IF NOT EXISTS resource_version_named_key_idx
  ON resource_version (natural_key)
  WHERE (resource_type IN ('attributeSet') OR COALESCE(payload->>'appleId', payload->>'appleIdentifier', payload->>'deviceName', payload->>'directoryPropertyName', payload->>'displayName', payload->>'exchangeAlias', payload->>'fileName', payload->>'issuerName', payload->>'mail', payload->>'managedDeviceName', payload->>'name', payload->>'organizationName', payload->>'primarySmtpAddress', payload->>'profileName', payload->>'serialNumber', payload->>'serverName', payload->>'sourceDisplayName', payload->>'subject', payload->>'subjectName', payload->>'targetDisplayName', payload->>'title', payload->>'tokenName', payload->>'userPrincipalName') IS NOT NULL);
