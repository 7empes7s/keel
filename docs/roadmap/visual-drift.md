# Decision-focused semantic drift and cross-linked reports (task 98)

## Status (2026-10-03)

Built on the current HEAD, on top of task 87 (baseline compliance and linked findings),
task 90 (entity scope), task 91 (change attribution) and task 59 (impact analysis and
roll-back planning). **Fixture-tested only.** No Microsoft endpoint, tenant or
credential was used. The Creos and Enovos entities, groups, findings, requests and
roll-back plans are synthetic fixtures. The page is read-only: nothing here writes to
the tenant or to KEEL's governance state.

## What a change now shows

### Semantic comparison (`engine/govern/semanticDrift.mjs#semanticChange`)

- **Same rules as drift detection.** The comparison walks the stored baseline and
  current copies with the classification behind the canonical hash
  (`classifyForOperation('comparison', …)`, task 51). Fields Microsoft sets itself
  (ids, creation and modification times, `@odata` annotations, server-computed fields
  such as a group's `mail`) are **counted and never listed**. Key order and annotations
  inside a list do not count as a change.
- **Grouped by impact.** Each setting is one of:
  - *Cannot be changed back in place*: an immutable field (for example `mailEnabled`
    on a group). Listed first, because a roll back cannot simply write it back.
  - *Changes behaviour*: a writable field.
  - *Earlier value not known*: see below.
- **Unknown before is never a deletion.** A modified change whose baseline copy was not
  kept (a legacy row with only hashes, or no payload) reads "KEEL did not keep the
  baseline's copy of this, so the earlier values are not known. Nothing is shown as
  removed." Each current setting is listed as "Now set", with "Not known" as its
  earlier value. It is never shown as added, removed or "not set".
- **Types without field rules** fall back to the rules every type shares (ids and
  timestamps), and the page says so.
- **Capped.** At most 50 settings per change are serialized. The rest are counted
  ("Showing 50 of 63 settings").
- **What the client receives.** `getDriftData` keeps the stored payloads for the
  `/api/drift` reader (unchanged contract). The Changes page passes its client table
  `displayItems(items)`, where both copies have the fields Microsoft sets itself
  removed (`comparedSettings`). So neither the HTML nor the client props carry them,
  including the "Technical details" copies.

### Linked records (`engine/govern/semanticDrift.mjs#driftEvidence`)

For each change the reader may already see (the task-90 scope filter runs first), in a
bounded read of at most 200 changes and 5 records of each kind:

| Record | Matches when | Otherwise |
|---|---|---|
| Found by (the collection that saw the change) | its stored version has the change's recorded hash (absent, for a removal) | `mismatch`; `unchecked` when the change has no recorded hash; `missing` when the collection is gone |
| Baseline copy | the baseline's version has the change's recorded "before" hash | `mismatch`, `unchecked` or `missing`; `not-in-baseline` for an added resource |
| Compliance | task 87's `complianceFindings` lists the change as linked (same collection as the evaluation's evidence) | listed as not linked when it rests on a different collection |
| Approval | a `remediate` request names the change; its job (by the approval idempotency key) is shown as queued, running or finished, never as a result | — |
| Roll-back plan and result | a dry run made after the change was found covers the resource and restores from the baseline's own backup; its result comes from the restore journal (`rollback_entry.outcome` for that plan and resource) | `mismatch` when it restores from another backup. No journal entry is "No result is recorded yet" |

Every mismatch is said in words on its row ("· does not match"), counted in a note
above the list, and counted per page. Nothing is joined across mismatched evidence.

The ownership sentence comes from task 89/90's current ownership evidence
(`ownershipOfResources`). The attribution confidence is task 91's verdict headline.

### Decision summary (`portal/components/decision-workbook.tsx`)

Above the list: open changes by impact (Could lock out admins, Affects access,
Cosmetic). It shows the changes and the settings that change behaviour, with a total
row. Every change is in exactly one row, so the rows add up to the total and to the
list's count (`summarizeSemanticDrift`). Notes count changes resting on mismatched
records, changes with no baseline copy, and changes that touch only fields Microsoft
manages.

## Hidden entities

The changes list itself is filtered in SQL by task 90. This task adds records that
could otherwise reveal other entities, and each one is reduced server-side before it is
serialized for an entity-scoped reader:

- **A shared resource's owners** list only the reader's own entities. The others become
  `othersWithheld: true` ("Shared by CREOS and other entities").
- **A request or plan that also covers other changes or resources** gives a central
  reader the count. An entity-scoped reader gets only `othersWithheld: true` ("It also
  covers other changes"): no ids, keys or count.
- **Compliance findings** are filtered to the reader's visible change ids.
- **Attribution actors** keep task 91's rule.

The boundary test checks the serialized `getDriftData` result, the page's client props,
the rendered components and the rendered page for the hidden entity's code, name,
change id, resource key and object id.

## Integration

- `portal/lib/portal-data.ts#getDriftData` adds `semantic` and `evidence` to each item,
  and `summary` to the result, for central and scoped readers alike. A failed evidence
  read yields `evidence: null` ("KEEL could not read the records behind this change"),
  never a guess. `displayItems` is the page's display projection.
- `portal/app/drift/page.tsx` passes `displayItems(data.items)` and `data.summary`.
- `portal/components/drift-table.tsx` renders the summary above the list. An opened
  change renders `SemanticDiff` (falling back to the old `DriftDiff` for items without
  `semantic`, such as older API consumers), then the linked records, then task 91's
  attribution.
- Styles are component-scoped (`portal/components/decision-styles.tsx`, a hoisted
  `<style>`). The shared stylesheet is unchanged.
- No schema change, migration or new table. Legacy rows read through the same paths:
  no payload means "not known", and no hash means `unchecked`.

## Validation (2026-10-03, isolated local PostgreSQL 16)

- `node --test engine/roadmap/visual-drift.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs`:
  9 pass, 0 fail (4 in the new file).
- Portal: `npm run typecheck` is clean. `npm test` was run as its individual files
  (`drift`, `drift-diff`, `change-attribution`, `scoped-authorization`,
  `experience-contract`, `read-page-auth`, `remediation-control`): all pass.
- Related engine suites (`baseline-compliance-ui`, `change-attribution`,
  `scoped-authorization`, `portal-experience`, `portal-parity`, `semantic-projection`):
  42 pass, 0 fail.
- UI harness: two new interaction tests.
  - Keyboard: open and close a change with Enter and Space. The settings are grouped
    by impact, mismatched records are flagged, the record keeps the ids, an unknown
    earlier value reads "Not known", and axe passes on the opened change.
  - Phone width (390 px): no sideways scrolling, linked records stack, and axe passes.
  - The `drift` screenshot baselines (dark and light) were updated for the new decision
    summary and the seventh fixture change.
- `roadmap/visual-drift.test.mjs` is added to the CI engine list in
  `.github/workflows/portal.yml`.

Required mutation checks, each applied, run and reverted:

| Mutation | Fails |
|---|---|
| Show raw full-object diff (stop skipping fields Microsoft sets itself) | "behavioural changes are listed …" and the portal test |
| Include hidden entity in serialized props (keep every owner of a shared resource) | the portal test: "serialized data carries ENOVOS" |
| Render unknown before as absent (list unknown-before settings as added) | "an unknown before state is never a deletion …" and the portal test; rendering "Not set in the baseline" in the component also fails the portal test |

## Limits

- **Fixture evidence only.** No live tenant data was read. Whether real collections
  carry fields that are server-managed but not yet classified is the same open question
  task 51 records. Such a field would show as "Changes behaviour" until it is classified
  in `engine/cir/serverOwned.mjs`.
- **Plans are matched by resource key and time.** A dry run covers a change when its
  closure holds the change's resource and it was made after the change was found.
  Dry-run artifacts do not record which change ids they were built for. The match rule
  is "the plan restores from the baseline's own backup", not "built for this exact
  change".
- **Results come from the restore journal only.** Entries written before task 70 have
  no `restore_ref` and do not appear. A queued or running job is never shown as a
  result.
- **Unknown-before is per change, not per field.** A baseline copy that exists but was
  read with a narrower field set than the current one shows the missing fields as
  added. KEEL does not record per-field read coverage.
- **Bounded reads.** At most 200 changes get links, and at most 500 matching requests
  and 500 plans are read per page. Beyond that, the newest are linked.
- **Approval requests have no tenant column.** They are matched only through this
  tenant's change ids and dry-run ids, never by name.
