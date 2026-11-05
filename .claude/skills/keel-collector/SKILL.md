---
name: keel-collector
description: Use when you add a configuration type to the backup (a Graph catalog entry), change what a type reads (select, item reads, parent reads), or add a PowerShell or REST workload read.
---

# Adding a backup collector or catalog entry

KEEL backs up a Graph type when the type has an entry in the **catalog**. There is no per-type collector code:
`engine/collect/entraAdapter.mjs` reads every entry the same way. Model: commit `c4463154` (an Intune type
declared behind a live gate, 16 files).

## 1. The catalog entry

- Add the entry to the family file in `tools/tenant-probe/catalog.d/` (`intune.mjs`, `policies.mjs`,
  `entra-governance.mjs` and so on). A new family file needs one import and one spread in
  `tools/tenant-probe/catalog.mjs`.
- The entry's fields are documented in the header of `tools/tenant-probe/catalog.mjs`: `type`, `path`,
  `version`, `select`, `query`, `parent`, `itemReads`, `childReads`, `linkedFrom`, `pageCap`, `singleton`,
  `criticality`, `blastRadius`, `liveGate`, `note`.
- Rules from past mistakes:
  - **Select every writable field** that a restore would need, not just what a list shows (lessons
    2026-10-12-collect-every-writable-field, 2026-10-22-list-read-drops-write-fields). Leave out counters that
    change on their own (they look like drift).
  - **`$select` routing** on `/deviceManagement` can send you to another API version or drop fields (lesson
    2026-10-23-devicemanagement-select-routing). Deleted-item reads need their own select (lesson
    2026-10-12-deleted-items-select).
  - **Read in a fixed language**: every Graph read sends Accept-Language (lessons
    2026-10-12-accept-language-everywhere, 2026-10-30-graph-accept-language). Use the shared reader in
    `tools/tenant-probe/graph.mjs`.
  - **An `$expand` can return no children** without an error (lesson 2026-10-22-expand-returned-no-children).
    Prefer `itemReads`.
  - **A type the tenant doesn't have** must not fail the whole backup (lessons
    2026-10-22-one-type-failed-whole-backup, 2026-10-22-not-used-types-shown-as-errors). See
    `unavailableOnTenant` in `engine/collect/entraAdapter.mjs`.
- **Not proven live yet?** Set `liveGate: '<why>'`. The type is then declared (names, groups, coverage) but not
  collected (`LIVE_GATED_TYPES` in `engine/collect/descriptors.mjs`). Remove `liveGate` only after a live read
  passes on the test tenant (an operator queue item).

## 2. Files that change with it

| File | What to add |
|---|---|
| `engine/collect/descriptors.mjs` | The type in the `LISTED` order, if it belongs in a set place |
| `engine/cir/naturalKey.mjs` | How the type is matched across tenants: `ID_KEY_TYPES`, `CONSTANT_KEY_TYPES` (singletons) or its own key in `naturalKeyFor` |
| `engine/cir/objectName.mjs` | `OWN_NAME_FIELDS`, if the object has no `displayName`/`name` (lessons 2026-10-22-kinds-with-no-name-field, 2026-10-22-name-fields-copied-per-file) |
| `engine/cir/canonicalize.mjs` | Only if a field holds references (`FIDELITY`) or must be normalised |
| `engine/cir/serverOwned.mjs` | Fields the service sets, so they never show as drift or get written |
| `engine/insights/taxonomy.d/<service>.mjs` | The type in a category (`taxonomy.test.mjs` fails on a type in no group) |
| `engine/coverage/qualification.mjs` | `TYPE_DECISIONS` (`manual('…')` until a writer exists) and `EXPANSION_INVENTORY` (`research`, `byHand` or `notWritable`) |
| `engine/coverage/completeness.mjs` | The type's `COMPLETENESS` entry |
| `engine/coverage/coverageDoc.mjs` | The type's `TYPE_GUIDE` text, then `node tools/coverage-doc.mjs` |
| `engine/collect/relationships.mjs` | Only for edges (assignments, members, owners): `RELATIONSHIP_FAMILIES` |

The pinned counts in `engine/collect/breadth.test.mjs`, `engine/collect/registry.test.mjs`,
`engine/collect/descriptors.test.mjs` and `portal/test/unnamed-kinds.test.ts` move with a new type. Update them
and say why in the PR. A new type must not block drift for every other type (lesson
2026-10-22-one-new-kind-blocked-drift).

If restore depends on a field of a collected record, check that `engine/store/schema.sql` (or a fragment in
`engine/store/schema.d/`) stores it, and test the round trip through `engine/store/db.mjs` (lesson
2026-10-14-fixture-shape-vs-stored-shape). Schema changes are additive only.

## 3. Workload and content reads (not Graph)

- PowerShell and REST workloads (Exchange, Teams, Purview, SharePoint): `engine/collect/workloads/registry.mjs`
  (`WORKLOAD_COLLECTORS`), run by `cli/keel-workload-collect.mjs`. Cmdlets run in the container described by
  `ops/powershell/` (`run-cmdlet.ps1`) through `engine/powershell/jobQueue.mjs`. A new workload ships with
  `enabledByDefault: false`.
- A cmdlet enum arrives as a **number** (lesson 2026-10-30-pnp-enums-arrive-as-numbers). Map it before you
  compare it by name, and test with the number.
- Content (mail, files, Teams messages): `engine/content/collectors.mjs` (`CONTENT_COLLECTORS`), run by
  `cli/keel-content-collect.mjs`.
- Test fakes: `engine/test/fakeCmdletContainer.mjs`, `fakeDsc.mjs`, `fakeExchangeRoles.mjs`,
  `fakePnpStructure.mjs`, `fakeSharePointRest.mjs`.

## 4. Tests and checks

```bash
cd engine && node --test collect/breadth.test.mjs collect/registry.test.mjs collect/descriptors.test.mjs \
  collect/liveGate.test.mjs cir/naturalKey.test.mjs insights/taxonomy.test.mjs \
  coverage/coverageDoc.test.mjs coverage/completeness.test.mjs
cd portal && node --import tsx --test test/unnamed-kinds.test.ts
```

- Fixture payloads use the shape Graph really returns: real id formats (lesson 2026-10-17-fixture-id-shapes),
  `@odata.type` where Graph sends it, and enums as Graph sends them.
- No test calls Graph. Payloads are fixtures; tenant ids are pseudonymised (`tools/qualification/pseudonymize.mjs`).
- Then run the full engine suite and follow the **keel-pr-checklist** skill.
