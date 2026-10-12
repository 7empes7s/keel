# Deleted-items listings must name their fields (2026-10-12)

Live run Q43, step 10: restoring a soft-deleted user was refused with "retention deadline
unprovable (no deletedDateTime)", and the replan then planned `user create`, which is not a
registered capability. Fixed in `engine/reconcile/liveState.mjs`, `reconciliationPlan.mjs` and
`engine/restore/recoveryMechanism.mjs`; fixture `engine/reconcile/deletedItemsSelect.test.mjs`.

| Mistake | Rule now |
| --- | --- |
| `/directory/deletedItems/microsoft.graph.user` was listed with no `$select`. Graph's default user projection omits `deletedDateTime` (groups return it by default), so the fixture passed and live failed. | Every Graph listing that feeds a decision names its `$select`, and the field the decision needs is in it. `DELETED_ITEM_ROUTES` carries `select`; use `deletedItemListPath(type)`. |
| Deleted items were matched by natural key (UPN) only, so a name Entra changed on deletion looked like "not found" and the plan fell through to `create`. | Match a deleted item by the snapshot `sourceId` first, then by natural key. Fake readers in tests must behave like Graph: return a field only when `$select` names it, and match paths with `startsWith` or `path.split('?')[0]`, never the bare route. |
| A refused restore and an unregistered `create` both read as "manual" with no explanation of what was looked up. | A refused soft-delete restore keeps `verb: restore-soft-deleted` and says the listing lacked `deletedDateTime`; an unregistered `create` after a successful deleted-items read says the object is neither live nor deleted and nothing is recreated. |
