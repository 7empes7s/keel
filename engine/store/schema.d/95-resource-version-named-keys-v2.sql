-- The keys that have at least one saved version with a name, now that user flows
-- (b2xIdentityUserFlow) are named by their id like attribute sets. The condition is
-- mayHaveNameSql() in engine/cir/objectName.mjs, kept as the same text
-- (engine/insights/names.test.mjs checks the name probe uses this index).
--
-- It replaces resource_version_named_key_idx (fragment 94), whose condition no longer
-- matches: CREATE INDEX IF NOT EXISTS would keep the old condition, and the deploy
-- refuses DROP, so the new condition gets a new name. Adding another kind named by its
-- id changes the condition again and needs another index like this one.
-- Plain (not concurrent) build, like fragment 94.
CREATE INDEX IF NOT EXISTS resource_version_named_key_v2_idx
  ON resource_version (natural_key)
  WHERE (resource_type IN ('attributeSet', 'b2xIdentityUserFlow') OR COALESCE(payload->>'appleId', payload->>'appleIdentifier', payload->>'deviceName', payload->>'directoryPropertyName', payload->>'displayName', payload->>'exchangeAlias', payload->>'fileName', payload->>'issuerName', payload->>'mail', payload->>'managedDeviceName', payload->>'name', payload->>'organizationName', payload->>'primarySmtpAddress', payload->>'profileName', payload->>'serialNumber', payload->>'serverName', payload->>'sourceDisplayName', payload->>'subject', payload->>'subjectName', payload->>'targetDisplayName', payload->>'title', payload->>'tokenName', payload->>'userPrincipalName') IS NOT NULL);
