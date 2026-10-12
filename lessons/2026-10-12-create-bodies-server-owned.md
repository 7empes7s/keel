# Create bodies must be projected through the server-owned classifier, never the raw snapshot payload

**Date:** 2026-10-12
**Where it bit:** live test tenant; restores that create a group, a namedLocation or a conditionalAccessPolicy failed with HTTP 400.

## What happened

`engine/restore/applyEngine.mjs`'s generic create branch posted `resource.payload` as collected:
`id`, `createdDateTime`, `modifiedDateTime`, `deletedDateTime`, `@odata.context`, a group's
`securityIdentifier`, `assignedLicenses`, `onPremisesSyncEnabled`, and so on. Graph refuses a
body that sets a read-only property. Only the policy-governed types and the three types in
`CREATE_EXCLUDED_FIELDS` had a projected body; every other type fell through to the raw payload.

The classification already existed: `fieldClass(path, resourceType)` in `engine/cir/serverOwned.mjs`
decides serverOwned/immutable/writable and was applied to PATCH bodies and to the hash, but not to
POST bodies.

## Rule

- A write body is always derived from the classifier, never from the snapshot as stored.
  POST: drop `serverOwned` paths recursively (`createBodyProjection`), keep immutable and writable.
  PATCH: `writableProjection` (drops serverOwned and immutable).
- Keep `@odata.type`: it is the derived-type discriminator Graph needs on a create, not a
  server-assigned annotation.
- Verification compares what was written: hash the projected body, not the snapshot.
- A field the classifier strips must still be restored on its own path when it is real
  configuration (`assignedLicenses` goes through `assignLicense` after the create).
- A fixture test for a new write path uses a Graph-like fake that returns 400 for server-managed
  properties, so a pass-through body cannot pass locally and fail live.

## Fix

PR `claude/fix-create-server-owned`: `createBodyProjection` in
`engine/reconcile/writableProjection.mjs`, applied in the generic create branch of `applyWave`;
licences of a created group restored through `restoreLicences`; test
`engine/restore/createServerOwned.test.mjs`.
