# A derived type's PATCH body needs @odata.type too

Live Q45 (2026-10-13): a named location update was demoted. Graph answered the
PATCH with 400 "1042: Unexpected type: namedLocationType" because the update body
dropped `@odata.type`. The same PATCH with `@odata.type` returned 204. PR #173 had
kept `@odata.type` on create bodies only.

| Mistake | Rule now |
| --- | --- |
| The `@odata.type` fix was applied to the create body and not to the update body of the same type. | When a write body fix lands for one verb, check every other verb that writes the same type (create, update, follow-up PATCH after a restore) in the same PR, with a fixture test of each body. |
| The update projection treated every `@odata.*` key as server-owned. | A type whose collection holds derived types lists itself in `UPDATE_KEEPS_ODATA_TYPE` (engine/reconcile/writableProjection.mjs), or builds its own PATCH body that sends the type, as Intune, authentication method configurations and PIM rules do. |
