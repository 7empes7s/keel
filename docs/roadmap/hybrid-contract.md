# Deferred hybrid topology contract and cloud refusal rules (task 111)

## Status — 2026-10-03

Implemented and fixture-tested only. **The hybrid agent runtime is deferred.** KEEL has no
agent executable, no polling service, no on-premises connection and no persisted command
ledger. This task defines the message contract a future adapter would use, and the rules the
cloud side applies. Nothing in it can reach an on-premises system.

The contract is described for readers in `docs/contracts/hybrid-topology.md`. This file records
what was built and what it does not prove.

## What was built

### `engine/contracts/topology.mjs`

- `HYBRID_RUNTIME` is `{ status: 'deferred', available: false, entrypoints: [] }`.
  `dispatchHybridCommand()` always throws `HybridRuntimeDeferredError`.
- `validateTopologyMessage(message, { tenantRef, ledger, now })` validates schema v1 for the
  three message kinds: `poll` (adapter to cloud), `command` (cloud to adapter, carried in a poll
  response) and `result` (adapter to cloud).
  - **Tenant pin.** The message and every capability evidence record must name the pinned
    tenant. A missing pin validates nothing.
  - **Adapter identity.** `adapterId`, an `adapterKind` from `ADAPTER_KINDS` (only
    `active-directory`) and a `credentialRef`. Secret-named keys and credential-shaped strings
    anywhere in a message are refused.
  - **Capability evidence.** Claims use the task-52 `CLAIM_LEVELS`. While the runtime is
    deferred, adapter evidence reads `declared` at most; anything stronger is refused.
  - **Operation intents.** Each intent names its object, operation, source authority and
    execution site. Only the entries in `HYBRID_INTENT_MATRIX` are supported: an on-premises
    update of an on-premises-authoritative `user` or `group`. A cloud execution site is
    refused through the same `refuseIfSynced` guard restore uses. An intent whose observed
    object is synced but which declares another authority is refused.
  - **Command identity.** A messageId or commandId is single-use per ledger. A command has a
    lifetime of at most 15 minutes. One bad intent refuses the whole command, and a refused
    command is never recorded.
  - **Result provenance.** A result must name a command the ledger issued, to the same tenant
    and adapter, and one of its intents. It carries an `intentDigest` that binds tenant,
    adapter, command, intent, object, operation and execution site. It must be non-synthetic,
    name the adapter build, and be observed inside the command window. Each intent accepts one
    result. A result replayed under another command fails the digest.
  - A valid command reads `dispatchable: false` with `refusal: 'hybrid-runtime-deferred'`.
- `hybridRuntimeInventory({ root, fs, path })` scans the real tree for runtime entrypoints:
  `cli/*.mjs` (tests excluded), `ops/*.service|*.timer` units and their `ExecStart` targets,
  and `package.json` `bin` entries. An entrypoint counts as hybrid runtime when its name says
  agent, poll, hybrid, on-prem or topology, or when its source loads `contracts/topology.mjs`.
  `runtimeDeclarationProblems` reports any disagreement between that inventory and
  `HYBRID_RUNTIME`.

### `engine/safety/syncedObjectGuard.mjs`

- `sourceAuthorityOf(resource)` returns `cloud`, `on-premises`, `hybrid` or `unknown`.
  `onPremisesSyncEnabled: true` is always `on-premises`, whatever hint the resource carries.
  A resource-level `sourceAuthority` hint can add a refusal but never remove one. A malformed
  hint reads `unknown`. A Graph payload field is never read as an authority hint.
- `refuseIfSynced` now also refuses `hybrid`, `on-premises` and `unknown` authority, and
  returns the `sourceAuthority` it decided. The original synced reason string is unchanged.
  Restore selection (`selectionGuardRefusals`), `applyWave` and the deletion guard already call
  it, so the refusal reaches every cloud write path without a parallel gate.

## Integration and migration

- There is no server route, CLI or portal page for this task. A surface that accepts or shows
  topology messages would be part of the deferred runtime. The restore paths are the
  integration: they refuse hybrid-authoritative objects through the shared guard.
- No data changes. The ledger is in memory. There is no table, so there is no migration.
  Legacy reads: a message without `schemaVersion: 1` is refused, not upgraded.
- Task-90 authorization is untouched. Topology messages are not a read path and carry no
  principal. A future runtime must authorize adapters and commands server-side.

## Validation (2026-10-03, isolated local PostgreSQL 16)

- Task validate command (with `KEEL_DB_TEST_URL` and `KEEL_TENANT_CONFIG_PATH` exported instead
  of sourcing `/etc/keel/db.env`):
  `node --test engine/roadmap/hybrid-contract.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs`:
  40 pass, 0 fail.
- The new suite is added to the CI engine step in `.github/workflows/portal.yml`.
- Required mutation checks, each run against the new suite and reverted:
  - Accept a foreign tenant (envelope tenant check disabled): fails the foreign-tenant test.
  - Allow a cloud write to a synced object (both refusals in `refuseIfSynced` disabled): fails
    the unsupported-intent test and the cloud-write-path test (`applyWave` writes the synced
    group), and the synced-object guard script.
  - Declare the runtime available (`HYBRID_RUNTIME.available = true`): fails four tests; the
    command becomes dispatchable, the declaration disagrees with the empty inventory, and adapter
    evidence above `declared` is accepted.

## Limits

- Fixture-tested only. No adapter, agent or on-premises directory exists or was contacted.
  Nothing here is live-qualified, and nothing can be until a runtime exists.
- The command ledger is per process and in memory. Single-use identity holds only within one
  ledger. A runtime must persist it, per tenant, before any command is issued.
- The intent matrix names user and group updates only. It is a contract boundary, not a claim
  that those operations work on-premises.
- The inventory scan recognises entrypoints by the conventions this repository uses today
  (`cli/`, `ops/` units, package `bin`). A new kind of entrypoint must be added to the scan.
