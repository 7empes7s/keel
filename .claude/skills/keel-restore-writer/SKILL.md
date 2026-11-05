---
name: keel-restore-writer
description: Use when you add a restore writer for a configuration type, add a verb to one, or fix one, from the write itself through approval gating, the qualification ledger and the fixture test.
---

# Restore writer, end to end

A writer is not done when the PATCH works. It is done when every item below is true, the ledger says the same
thing as the code, and a test fails when the safety check is reverted. Models: PR #998 (`roleAssignmentSchedule`,
a built-in branch) and PR #999 (authentication contexts and staged rollout, registry writers).
`docs/ARCHITECTURE.md` explains the layers.

## 0. Before you start

- Check that the issue isn't already fixed: `git log origin/master --oneline --grep="#<issue>"`.
- Read the type's catalog entry (`tools/tenant-probe/catalog.d/*.mjs`), its `TYPE_DECISIONS` and
  `EXPANSION_INVENTORY` entries in `engine/coverage/qualification.mjs`, and its row in `docs/coverage.md`.
- Get the **real Graph shape** of the object: from the issue's evidence, from a stored fixture in
  `docs/release/qualifications/`, or from the Graph v1.0 reference. If it is from the reference alone, say so in
  the PR's assumptions.

## 1. Pick the write path

| Path | Use when | Where |
|---|---|---|
| Registry writer, record-driven | A plain object with a collection, fields and verbs | A record built with `defineRecord` in `engine/restore/identityObjectOperations.mjs` or `intuneOperations.mjs`. It is registered automatically by `engine/restore/writers/ido.mjs`. |
| Registry writer, own module | A type with its own rules (an upsert under a fixed id, add-only references) | A new `engine/restore/<topic>Operations.mjs`, plus an entry in `engine/restore/writers/entra.mjs` or `ido.mjs` (`{ resourceType, verbs, handler, apply }`; see the header of `writers/registry.mjs`) |
| Built-in branch in `applyWave` | Only when the type already has one (Intune policies, tenant policies, admin roles, users) | `engine/restore/applyEngine.mjs` |

- `registerWriter` refuses a repeated pair.
- `writers/registry.test.mjs` fails when a registered writer replaces a built-in one, or when it has no
  capability that names the same `handler`.
- Add the capability:
  - for a registry writer, in `engine/coverage/capabilities.d/entra.mjs` or `ido.mjs`:
    `{ resourceType, operation, path, handler, idOutcome, proofRef }`. `proofRef` is your test file.
  - for a built-in branch, in `engine/coverage/capabilities.mjs`: `registerAll(type, path, verbs)` and
    `recordFixtureProof(type, verb, testFile)`.
- Register only the verbs you prove. An unregistered verb is refused, which is the safe default.
- Prefer a new module over growing `applyEngine.mjs`. The code-health ratchet lets a file over 800 lines grow
  only 5% past its baseline (`docs/code-health.md`).

## 2. Fields: what is written and what becomes a manual step

- Write only declared fields: the record's `writable` and `createOnly` lists, or the writer's own field list.
- **Trust, federation, certificate and sign-in fields are never written** (CLAUDE.md, lesson 2026-10-21). That
  covers `inboundTrust`, `signingCertificate`, `issuerUri`, named-location `isTrusted`, a task extension's Logic
  App and sign-in, and certificate bindings.
  - The rule lives in `engine/restore/workloads/writeDeclarations.mjs`: `TRUST_FIELDS` (per type),
    `CROSS_TENANT_TRUST_FIELDS`, `TRUST_FIELD_PATTERN` and `isTrustField()`.
  - If your type has a trust field that the pattern does not catch, add it to `TRUST_FIELDS`.
  - `defineRecord` throws on a trust field in a declared list. A list nested under a record (method
    configurations, child objects, settings blocks) must be built by a function that throws on a trust field,
    like `checkedMethodFields` in `engine/restore/tenantPolicyOperations.mjs`, never as a plain literal (lesson
    2026-11-04-method-fields-skip-trust-check).
  - When a trust field differs between the backup and live, return the manual step from `trustFieldStep()`
    (`engine/restore/recordWriter.mjs`), showing backup and live values. Write the other fields.
  - A PUT that replaces the whole object clears what it leaves out: use `wholeReplaceTrustRefusal()`.
- Server-owned fields stay out of the body (lesson 2026-10-12-create-bodies-server-owned).
- A list read can drop fields that a write needs. Check the item read (lesson 2026-10-22-list-read-drops-write-fields).
- A field that holds a reference the write must remap (an administrative-unit scope, a group or role id) must
  be declared as a reference in `engine/cir/canonicalize.mjs` (for example `SCOPE_REFERENCE_FIELDS`). Otherwise
  the backup cannot name it.
- Add or extend the type's field projection: a `registerFieldProjection(...)` call in `engine/contracts/fieldProjection.mjs`.

## 3. Safety gates

- **Approvals.** A field that changes access, sharing or sign-in is a content effect.
  - Add a `CONTENT_EFFECT_RULES` entry in `engine/safety/contentEffects.mjs` with `reviewed: true`. An unreviewed
    type with a dangerous-looking field is refused as `unclassified-content-effect`.
  - For record kinds whose access fields are held, add to `APPROVAL_HELD_FIELDS`.
  - Call `approvalHeldRefusal` (or wrap your refusal with `withApprovalGate`, both in
    `engine/restore/approvalHeld.mjs`) **before any read or write**. A dry run must read and write nothing.
  - A skipped write carries no effect, so nobody approves a write that never happens (#998's second commit).
- **Tenant-wide objects** (one setting for the whole tenant): set `tenantWide: true` on the record. Writes then
  need `--allow-tenant-wide-test-writes` (test `engine/restore/tenantWideRecords.test.mjs`).
  `TENANT_WIDE_RECORD_TYPES` in `tools/qualification/live-gate-plan.mjs` picks the record up by itself.
- **Lockout.** A type the catalog rates `tenant-lockout` needs the break-glass gate. The registry writer
  receives `ctx.lockoutGate`. Group edges go through `engine/safety/edgeLockoutGate.mjs` (`privilegedGroupIds`).
  A tenant-lockout delete is refused in `applyWave`.
- **Deletes** stay unregistered unless the issue asks for them. To let a delete through only as the undo of an
  object this restore created, use `undoOnlyDelete` (`approvalHeld.mjs`) as the record's `refusal`.
- **Match before create.** Read live first. An object that already matches is a skip, and a failed lookup is
  never treated as "absent" (lessons 2026-10-12-match-by-id-before-name, 2026-10-22-rerun-after-create).

## 4. Permission and ledger

- Add the Graph permission to `KEEL_PERMISSIONS` in `engine/bootstrap/permissionCatalog.mjs`.
  `permissionCatalog.test.mjs` checks both directions.
- `engine/coverage/qualification.mjs`:
  - `TYPE_DECISIONS`: `automated('<odata type>', 'issue #NNN subset: …')`. Say what is written, what is
    skipped and what needs approval.
  - `EXPANSION_INVENTORY`: `subset(...)`, with the route and permission.
  - `recordRemappingProof(type, op, testFile)` if references are rewritten to recreated objects.
- `engine/coverage/completeness.mjs` (`COMPLETENESS`) and the type's `TYPE_GUIDE` text in
  `engine/coverage/coverageDoc.mjs`.
- `tools/qualification/operations.mjs`: a `FIXTURE_PAYLOADS` entry, plus `fakeGraph()` routes for every call the
  writer makes. Use the real Graph shape here too.
- `tools/qualification/live-gate-plan.mjs`: a `FIXTURE_GUIDANCE` entry with a `KEEL-RT-` fixture.
- Regenerate and recount with the **keel-generated-files** skill: `node tools/coverage-doc.mjs`, and the
  supported count in `engine/roadmap/fidelity-ledger.test.mjs`.
- Update, never skip, the tests that pinned the old status. Typical ones: `fidelity-expansion`,
  `capability-registry`, `completeness`, `entra-directory-writers`, `fidelity-ledger`.

## 5. Tests

Put them in `engine/roadmap/<topic>.test.mjs` or `engine/restore/<topic>.test.mjs`. Drive the production
`applyWave()` (`engine/restore/applyEngine.mjs`) against `fakeGraph()` from `tools/qualification/operations.mjs`
or `idoFakeGraph()` from `engine/test/idoFakeGraph.mjs`. Never call a live tenant.

Cover at least:
- create and update from a snapshot payload in the **stored** shape. If restore depends on a field, store the
  record through `engine/store/db.mjs` and read it back (lesson 2026-10-14-fixture-shape-vs-stored-shape).
- that no trust field is ever in a write body, and that a difference in one becomes the manual step
- held without approval; partly approved still held; the approved run writes; the dry run writes nothing
- already-matching live means nothing is sent; a failed lookup sends nothing
- unregistered verbs stay unsupported
- dates set explicitly or relative to now, never the wall clock by accident

**Revert check:** disable the safety check (the trust filter, the approval gate, the skip), run the test, see it
fail, and restore the check. The commands are in **keel-live-bug-fix** step 4. Say in the PR which check you
reverted and which tests failed.

Run:
```bash
cd engine && node --test restore/writers/registry.test.mjs restore/recordWriterTrust.test.mjs \
  restore/genericWriterTrust.test.mjs bootstrap/permissionCatalog.test.mjs <your test files>
cd engine && node --test --test-concurrency=4 $(../tools/engine-test-files.sh)   # full suite before the PR
```

## 6. PR

- Update the type's design doc in `docs/roadmap/` if it has one. Add the route and permission to
  `docs/roadmap/restorer-least-privilege.md`.
- In `ops/STATE.md` "Open live gates", add one line for the new live capture.
- Write numbered **live capture steps** for the operator in the PR: a `KEEL-RT-` fixture, snapshot, change,
  dry run, approve, restore, verify, clean up. Never a built-in privileged role or a break-glass principal.
- Then follow the **keel-pr-checklist** skill.
