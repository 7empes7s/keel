# Every write body keeps `@odata.type`, not only create bodies

**Date:** 2026-10-14
**Where it bit:** live step 40 (namedLocation update) on the test tenant: PATCH 400
"1042: Unexpected type: namedLocationType". The same PATCH by hand with `@odata.type` returned 204.

## What happened

PR #173 kept `@odata.type` on create bodies (`createBodyProjection`) but left `writableProjection`,
the PATCH body, dropping every `@odata.*` key as server-owned. A namedLocation is polymorphic
(ipNamedLocation / countryNamedLocation) and its `ipRanges` entries are too (iPv4CidrRange /
iPv6CidrRange); Graph needs the discriminator on a PATCH as well as on a POST.

## Rule

- A fix to one write body (POST) is checked against every other write body (PATCH, follow-up PATCH
  after a restore) in the same PR.
- `@odata.type` is a type discriminator, not a server-assigned annotation: every projection that
  builds a write body keeps it, at every depth, when the snapshot recorded it. Other `@odata.*`
  annotations are still dropped.
- The Graph-like fake in a write-path fixture test refuses a PATCH without `@odata.type` for a
  polymorphic type.

## Fix

PR `claude/update-keeps-odata-type`: `writableProjection` in
`engine/reconcile/writableProjection.mjs` keeps `@odata.type`; test
`engine/restore/updateKeepsOdataType.test.mjs`.
