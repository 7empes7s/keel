# Match live objects by id before name (2026-10-12)

Q43 step 49: a drift renamed a Conditional Access policy. The restore planned a
`create` (Graph 400, duplicate) instead of an `update`, because the natural key
of a CA policy is its display name and the renamed live object no longer matched
the snapshot key. The id fallback only knew the live tenant's ids, which map to
the live (renamed) key, never back to the snapshot's.

| Mistake | Rule now |
| --- | --- |
| Matched snapshot and live by natural key only for display-name-keyed types (CA policies, named locations, auth strengths, groups). | On a same-tenant restore, a live object whose id a snapshot resource carries is that resource: it takes the snapshot key and plans as `update` (name put back). Cross-tenant restores keep the natural key. |
| Built the id to key map from the live tenant alone (`targetResources`, `existingTargetIds`). | The snapshot's ids are indexed first, in one shared helper (`keyForLiveObject`), and `existingTargetIds` learns the plan's id-matched objects. No per-type code. |
| No fixture for "renamed live object". | `engine/reconcile/renameDrift.test.mjs` pins one `update`, no `create`, and the cross-tenant case. |
