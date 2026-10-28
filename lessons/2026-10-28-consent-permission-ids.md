# Consent policy permission ids stored as unknown references (2026-10-28)

The operator (issue #641, queue Q111) found that every restore of an app permission
pre-approval policy was refused before planning: "cannot resolve reference at
conditions[0].permissions.permissionIds[0] (symbol null)". Permission ids are published by
the API, not the tenant, and an app's `requiredResourceAccess` already wrote them as stored.
The same rule was never given to the other places that list permission ids. A
resource-specific permission (such as `ChatMessage.Read.Chat`) is not in the API's app roles,
so the index never named it either, and it fell through to "unknown".

| Mistake | Rule now |
| --- | --- |
| The "permission ids are global" rule named one field path (`requiredResourceAccess`). | Every field that lists permission ids is in `GLOBAL_CONSTANT_FIELDS`: also a pre-approval policy's `conditions.permissions.permissionIds` and a permission grant policy's `includes/excludes.permissions`. When a type that lists permissions is added, add its path there. |
| Only the classifier was tested, not what the restore does with its answer. | A test runs canonicalization and the restore resolver together (`engine/cir/consentPermissionIds.test.mjs`), so a reference that would refuse at restore fails at collection. |
