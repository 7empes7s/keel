# Operation qualification ledger (roadmap task-63)

The ledger answers, for every catalogue type and every write operation, what
KEEL can actually do and what evidence backs the claim. It is built by
`buildOperationLedger()` in `engine/coverage/qualification.mjs` and printed by:

```sh
node tools/qualification/operations.mjs            # table
node tools/qualification/operations.mjs --json     # full ledger
node tools/qualification/operations.mjs --harness  # plus the fixture harness
node tools/qualification/operations.mjs --check    # exit 1 if a type has no decision
```

The coverage report carries each type's `qualification`. The portal's
Coverage page shows it as **Recovery decision** inside each row's details.

## Per-type decision

Each of the 52 catalogue types has a hand-written entry in `TYPE_DECISIONS`:

| Decision | Meaning | Types |
| --- | --- | --- |
| `automated` | Writes are registered in `capabilities.mjs` | group, roleAssignment, namedLocation, conditionalAccessPolicy |
| `manual` | Recovery is a refusal plus human steps, by design. Each entry carries its reason. | organization, domain, subscribedSku, both template catalogues, user, contact, identityProvider, directoryRole, managedDevice |
| `unknown` | Not yet investigated | everything else |

The table is checked against the registry both ways: a type marked
`automated` without a registered write capability fails the ledger, and so
does a registered type marked anything else. A missing type fails too; it is
never defaulted. Relabelling a type therefore cannot forge a capability.

`user` and `application` are marked as **soft-restore candidates**: Graph can
restore them from deleted items. That is a candidate for investigation, not a
capability. Their `restore-soft-deleted` rows stay unsupported.

## Per-operation row

Each row records the following:

- **decision** (`supported`, `unsupported`, `manual` or `unknown`) and the
  task-52 capability **claim**;
- **credential mode** and **id outcome**;
- **idempotency**: the mechanism that makes a retry safe;
- **field classification**, from the field-projection review;
- **remapping**: whether the operation ever rewrites references, and whether
  remapping to a different id is proven;
- **fixture** and **live** evidence.

The group `member` and `owner` edge operations from task-61 are listed
separately. They write no payload, so they never need remapping.

## Remapping is per operation, not `descriptor.remappable`

`descriptor.remappable` is not a write gate. `applyWave` compares each
reference field before and after `rewriteReferences`:

- If every id is unchanged, nothing was remapped and no proof is needed. A
  same-tenant update stays valid even for a `remappable: false` type.
- If any id changed, as it does for a new object or a cross-tenant reference,
  the run needs a remapping proof recorded for exactly that
  `(resourceType, operation)`. Otherwise it fails with `unqualified-remapping`
  before any write, including in dry run and preview.

Proven today, each proof naming the test that fails without it:

| Operation | Proof |
| --- | --- |
| group create | `engine/restore/applyPatches.test.mjs` |
| roleAssignment create | `engine/restore/applyEngine.test.mjs` |
| conditionalAccessPolicy create | `cli/keel-restore.test.mjs` |
| conditionalAccessPolicy update | `engine/roadmap/fidelity-ledger.test.mjs` |

**Not proven**, so a remapped write is refused:

- roleAssignment update;
- group update (no writable group field holds a reference);
- group restore.

`recordRemappingProof` refuses three things:

- an operation that writes no references (delete);
- an unregistered capability;
- a proof for one operation standing in for another.

## Fixture harness

`runFixtureHarness()` drives the production `applyWave` once for each of the 13
registered object operations, against an in-memory fake Graph that honours
create, PATCH, DELETE, soft restore and read-back. Every result is labelled
`synthetic`. A run never changes a claim: the registry is identical before and
after, and a declared-only registration stays `declared`.

## Limitations

- Nothing is live-qualified. Live qualification still goes only through
  `qualifyLiveEvidence`, with tenant-, operation- and contract-matched,
  non-synthetic, fresh evidence.
- The idempotency text describes the mechanism. It is not separately measured
  against Graph.
- No data or schema changes, so there is no migration. A report produced
  before this change has no `qualification`, and the portal shows "Unknown".
