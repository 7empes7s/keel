# Post-write verification must ignore what Graph sets on its own

**Date:** 2026-10-14
**Where it bit:** live operator run Q45 (2026-10-13, test tenant). A group create, a Conditional
Access policy create and a group restore from deleted items all landed, but were recorded as
uncertain and demoted.

## What happened

PR #173 fixed the create bodies, but each verification path still compared a different view:
the create path hashed the raw read-back, the restore path hashed it without removing nulls, and
only the update path removed top-level nulls. A read without `$select` returns every uncaptured
property as null, and a Conditional Access policy carries `authenticationStrength@odata.context`,
a property annotation that embeds the policy's own id. The `@odata.` rule in `fieldClass()`
only matches keys that start with `@odata.`, so this annotation was compared. The demotion reasons
named `securityIdentifier`, `renewedDateTime` and `expirationDateTime`. Those were already classed
server-owned. The real differences were the nulls and the annotation.

## Rule now

| Mistake | Rule now |
| --- | --- |
| Each write path normalised its read-back its own way. | Every post-write check compares `verificationView()` of both sides (`engine/reconcile/writableProjection.mjs`). It drops server-owned fields, OData annotations at any depth and nulls. |
| A create compared the whole read-back with the body. | A create verifies the fields it wrote. Graph's defaults for fields the body did not carry are not drift. |
| Fixture fakes echoed the body back, so verification passed locally and failed live. | A verification test reads back the full Graph default projection: server-set values, annotations and nulls. It also has a negative case where a written value comes back different. |
| A demotion reason that names fields was taken as the cause. | Reproduce the demotion from the capture. The named fields may already be excluded. |

## Fix

PR #212 (`claude/verify-ignores-server-fields`): `verificationView()` in
`engine/reconcile/writableProjection.mjs`, used by the create, update and restore-from-deleted-items
checks in `applyWave`. Tests: `engine/restore/verifyServerFields.test.mjs` and
`engine/restore/verifyServerManaged.test.mjs`.
