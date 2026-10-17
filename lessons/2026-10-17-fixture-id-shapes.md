# Fixtures used GUIDs where Graph returns other id shapes

On 2026-10-17 app consent grants showed their raw id on Changes, Compare, Alerts, Approvals, Activity,
Job, Ask and Incidents. Every "never show an id" check matched GUIDs only, and the test fixtures gave the
grant a GUID-shaped id, so the tests passed while live pages leaked. A real oauth2PermissionGrant id is a
43-character base64url token, and a provisioning job id is `<template>.<32 hex>.<32 hex>`.

| Mistake | Rule now |
| --- | --- |
| Fixture ids shaped like GUIDs for types whose Graph ids are not GUIDs | Fixtures use the id shape Graph really returns for the type (grant tokens, job ids, hex runs) |
| One GUID regex copied into each page's id check | One check, `holdsObjectId` in `portal/lib/object-ids.ts`; pages import it instead of writing their own |
