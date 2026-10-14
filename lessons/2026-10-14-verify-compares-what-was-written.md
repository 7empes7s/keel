# Post-write verification compares what was written, never the server's whole read-back

**Date:** 2026-10-14
**Where it bit:** live test tenant, steps 1, 3 and 48 demoted. A group create, a group soft-delete
restore and a Conditional Access create all landed, and were reported "created object did not
verify" or "residual drift after update".

## What happened

This is the second time server-owned fields broke a live write (the first was
`2026-10-12-create-bodies-server-owned.md`, on create bodies). The fix for bodies did not reach
the checks after the write. `engine/restore/applyEngine.mjs` hashed the whole re-read, which has no
`$select`, against the body or snapshot:

- properties the snapshot never held (a group's `description: null`, a policy's
  `conditions.platforms`, `grantControls.termsOfUse`) read as differences;
- property annotations such as `grantControls.authenticationStrength@odata.context` name the new
  object, and `fieldClass()` only treats a bare `@odata.*` key as server-owned;
- only types in `CREATE_EXCLUDED_FIELDS` had their read-back narrowed (top level only).

## Rule

- Every write path's verification goes through `verificationView(live, written)` in
  `engine/reconcile/writableProjection.mjs`: the read-back cut down to the paths that were written,
  then `canonicalHash`, which strips server-owned paths through `fieldClass()`. Do not add a second
  server-owned list.
- A written path that reads back different, or not at all, still fails. Test both directions.
- A fixture fake for a write path returns what Graph returns: server-assigned values, properties the
  snapshot lacks and property annotations. An echo fake hides this class of bug.

## Fix

PR `claude/verify-ignores-server-fields`: `verificationView` used by the create and soft-delete
restore checks in `applyWave`; test `engine/restore/verifyServerManaged.test.mjs`.
