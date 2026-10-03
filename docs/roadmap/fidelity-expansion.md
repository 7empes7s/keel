# Measured Entra operation expansion batches (roadmap task-107)

## Status — 2026-10-03

Implemented and fixture-tested. **Nothing here is live-qualified.** Every claim
below is `fixture-tested`: the production `applyWave()` writer and read-back
verification ran against an in-memory fake Graph. That proves KEEL's code
behaviour, not Microsoft's, and not a real recovery.

## What changed

### The batch inventory

`engine/coverage/qualification.mjs` now holds `EXPANSION_INVENTORY`: every one of
the 52 catalogue types sits in exactly one batch with an explicit status, the
Graph route a write would use, the least permission it would need, and a reason.

| Batch | Task | Types |
| --- | --- | --- |
| `identity-application` — Identity and applications | task-107 | 16 |
| `policy` — Policies | task-108 | 16 |
| `administrative-configuration` — Administrative configuration | task-109 | 6 |
| `device-management` — Intune, outside the Entra batches | none | 14 |

Statuses: `qualified-subset` (at least one registered operation), `manual`
(recovery is a human step by design), `unsupported` (no write route exists) and
`research-needed` (a route may exist; its API, permission or safety contract is
not checked). Intune is not an Entra family; it is listed so no catalogue type
is silently left out, and no Entra batch owns it.

`buildExpansionInventory()` refuses, rather than trusts, an inventory that:

- leaves a catalogue type out, or names one that is not in the catalogue;
- marks a type `qualified-subset` without a registered write capability, or
  anything else while one is registered;
- disagrees with `TYPE_DECISIONS` (manual vs. unknown vs. automated);
- gives a `research-needed` entry no route to investigate, or any entry no
  permission reason;
- carries any field outside `batch/status/api/permission/reason` — for example a
  `fullyRestorable` flag. The **restore scope** (`none`, `partial`, `full`) is
  derived from registered operations only (`restoreScopeFor()`); it cannot be
  declared. Today only `group` is `full` (registered before this task).

### The first qualified subset

Registered in `engine/coverage/capabilities.mjs`, each with fixture proof in
`engine/roadmap/fidelity-expansion.test.mjs`:

| Type | Operation | Route | Id outcome |
| --- | --- | --- | --- |
| application | create | `POST /applications` | new object id and new appId |
| application | update | `PATCH /applications/{id}` | preserved |
| application | restore-soft-deleted | `POST /directory/deletedItems/{id}/restore` | preserved |
| servicePrincipal | create | `POST /servicePrincipals` | new object id |

Every sibling verb stays `unsupported` and is refused by `verbCapability()`
before any guard, journal write or writer call: application **delete**, and
service principal **update, delete and soft-delete restore**. Deleting an app
registration strands every consumer of its credentials; KEEL has no qualified
guard for that.

### Credentials are never written

- `passwordCredentials`, `keyCredentials`, `appId` and `publisherDomain` are
  **immutable** for `application` (`engine/cir/serverOwned.mjs`). They are never
  in a PATCH body; a difference in them after an update is reported
  `not-remediable`, never claimed fixed. They stay in the configuration hash, so
  stored snapshot hashes are unchanged (no re-hash, no legacy migration) and a
  rotated or removed secret still shows as drift.
- A create body leaves them out too (`CREATE_EXCLUDED_FIELDS`), and the create is
  verified against exactly the fields it wrote.
- Credential completion semantics (task-65) are unchanged: a recreated
  application still opens credential, certificate, consent, integration and
  sign-in validation items; a soft restore opens only sign-in validation; an
  update opens none. The batch report lists these steps beside each operation.

### New ids remap explicit references

A service principal points at its application by **appId**, which the
snapshot's GUID walk cannot see. `EXPLICIT_REFERENCES` declares it, and
`withExplicitReferences()` adds `{ field: 'appId', symbol: 'application:<appId>',
identifier: 'appId' }` to the resource (also in `cli/keel-restore.mjs`, so the
wave planner orders the application first).

- A recreated application reports its new appId on the applied entry, only when
  the read-back agrees with the create response. `recordAppliedIds()` in
  `cli/keel-restore.mjs` stores it as `<naturalKey>#appId`.
- `rewriteReferences()` writes that new appId into the service principal's create
  body. If the application already exists in the target under the same natural
  key, the appId is unchanged and left as is. Otherwise the resource is refused:
  an object id is never written into an appId field.
- Remapping for `servicePrincipal create` is recorded as proven
  (`recordRemappingProof`). No other new operation has a remapping proof, so a
  rewrite to a different id on an application create, update or restore is
  refused by the existing task-63 gate.

### CLI, report and portal

- `node tools/qualification/operations.mjs --batch <id> [--json]` runs one batch:
  each qualified operation through the production `applyWave()` path against the
  fake, the writes it made, the completion steps it leaves, the refused sibling
  verbs and every remaining type with its API and permission reason. The report
  is marked synthetic and the runner throws if a run changed any claim.
  `--check` now also validates the inventory.
- The coverage report's `qualification` record carries `expansion` (batch,
  status, derived restore scope, reason). The Protect type record shows it as
  **Expansion batch** in its technical details. Older reports without it read
  "not recorded", never a stronger claim.

## Validation (2026-10-03, build container)

- Task Validate command (with `KEEL_DB_TEST_URL` and `KEEL_TENANT_CONFIG_PATH` set
  in place of `/etc/keel/db.env`): 43 tests, 43 passed.
- CI engine step from `.github/workflows/portal.yml` (now including this test
  file): 131 passed. Portal `npm test`, `typecheck`, `build` and `test:ui` (88
  checks) passed.
- Mutation checks, each reverted afterwards:
  - all verbs registered for `application` (or `servicePrincipal`) → 4 (2) tests fail;
  - the application credential completion step removed → 3 fail; credentials
    left in the create body → 1 fails;
  - `administrativeUnit` marked `qualified-subset` → 5 fail; restore scope
    declared `full` → 1 fails.

## Limits

- **Documentation not re-checked.** `learn.microsoft.com` is blocked from the
  build container, so the routes and permissions in `EXPANSION_INVENTORY` were
  not re-fetched on 2026-10-03. They are declarations to confirm against the
  current Graph v1.0 reference (application create/update, deletedItems restore,
  servicePrincipal create) before any live qualification, per Global
  Constraint 8.
- **Restorer grant unverified.** These writes need `Application.ReadWrite.All` on
  the KEEL Restorer. Whether it is granted was not checked; no live run was made.
- **The fake is generous.** Real Graph returns many default properties on read
  (`api`, `web`, `info`, ...). A live create may need those normalised before
  verification passes. Live qualification will show it.
- **Owners and app role assignments** stay relationship edges and are refused
  through the parent (task-61). A recreated application has no owners until they
  are added by hand.
- **No live evidence** exists for any operation here; `qualifyLiveEvidence()` is
  the only route to `live-qualified`, and nothing in this task calls it.
