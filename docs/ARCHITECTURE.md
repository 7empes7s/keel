# KEEL architecture

A map for builders: where each layer lives, how data flows, what may import what, and what keeps a restore
safe. Rules are in `CLAUDE.md`, live facts in `ops/STATE.md`, and step-by-step recipes in `.claude/skills/`.
Keep this file short. Update it in the same PR when a layer boundary, a top-level directory or a generated file
changes.

## The pieces

| Part | Path | Runs as |
|---|---|---|
| Engine | `engine/` (Node ESM, `.mjs`, no build step) | imported by the CLIs and the portal |
| CLI | `cli/keel-*.mjs` | one process per command; the worker and scheduler run them as jobs |
| Portal | `portal/` (Next.js 16, TypeScript) | `keel-portal` on Mulinux, behind Cloudflare Access |
| Database | Postgres 16; schema `engine/store/schema.sql` + `engine/store/schema.d/*.sql` | `keel-postgres` (docker) |
| PowerShell workers | `ops/powershell/` (`run-cmdlet.ps1`, `run-dsc.ps1`, Dockerfiles) | containers started by `engine/powershell/jobQueue.mjs` |
| Graph client and catalog | `tools/tenant-probe/` (`graph.mjs`, `auth.mjs`, `catalog.mjs`, `catalog.d/`) | imported by the engine |
| Qualification tools | `tools/qualification/`, `tools/release/`, `tools/coverage-doc.mjs` | run by hand or by the operator |
| Status page | `status/` | `keel-status-generate.timer` |
| Host units | `ops/*.service`, `ops/*.timer` | systemd on Mulinux |

## Data flow

```
 collect ─────────► store ─────────► drift / insights ──────────► restore plan ──► approvals ──► restore write
 (Graph, PowerShell)   (snapshot,       (baseline diff, compare,      (dry-run          (content        (writers, journal,
                        resource_version) feed, alerts)                artifact)         effects,         read-back verify)
                                                                                         sign-off)
                         ▲                                                                    │
                         └──────────── portal and CLI read and enqueue jobs ◄─────────────────┘
```

### 1. Collectors: `engine/collect/`, `engine/content/`, `engine/collect/workloads/`

- **Graph configuration.** `cli/keel-collect.mjs` (`runCollect`) calls `collectSnapshot` in
  `engine/collect/snapshot.mjs`.
  - Reads are done by `collectWithOutcomes` in `engine/collect/entraAdapter.mjs`.
  - The reads are data-driven: every type is an entry in `CATALOG` (`tools/tenant-probe/catalog.mjs`, with one
    file per family in `catalog.d/`). `engine/collect/descriptors.mjs` turns entries into `DESCRIPTORS`. An
    entry with `liveGate` is declared but not collected (`LIVE_GATED_TYPES`).
  - Edges (assignments, members, owners) are collected by `collectRelationships` in
    `engine/collect/relationships.mjs` (`RELATIONSHIP_FAMILIES`).
- **Canonical form.** `engine/cir/` builds it: `canonicalizeAll` in `canonicalize.mjs`, natural keys in
  `naturalKey.mjs` (`naturalKeyFor`), field classes in `serverOwned.mjs` and display names in `objectName.mjs`.
  The hash is `canonicalHash.mjs`.
- **Workloads** (Exchange, Teams, Purview, SharePoint): `WORKLOAD_COLLECTORS` in
  `engine/collect/workloads/registry.mjs`, run by `cli/keel-workload-collect.mjs`. Cmdlets run through
  `engine/powershell/jobQueue.mjs` (`runCmdlet`). A workload ships disabled (`enabledByDefault: false`, enforced
  by `engine/collect/registry.mjs`).
- **Content** (mail, files, Teams messages): `CONTENT_COLLECTORS` in `engine/content/collectors.mjs`, run by
  `cli/keel-content-collect.mjs`.

### 2. Store: `engine/store/`

- `engine/store/db.mjs` writes snapshots: `createSnapshot`, `insertResourceVersion`, `insertReferences`,
  `completeSnapshot`. Read helpers include `getLatestSnapshot` and `getResourceVersions`.
- Baselines and drift rows are written by `engine/store/governance.mjs`.
- `engine/store/loadSchema.mjs` builds the schema in one place: `schema.sql`, then each `schema.d/NN-topic.sql`
  in name order. Run `node engine/store/loadSchema.mjs | psql "$KEEL_DB_URL"` to apply it.
- Schema changes are **additive only**. The deploy refuses `DROP`, `TRUNCATE` and `DELETE FROM`. Add a new
  fragment rather than editing a shared block.

### 3. Drift and insights: `engine/govern/`, `engine/reconcile/`, `engine/insights/`

- `cli/keel-drift.mjs detect` collects live, then compares it with the active baseline using `diffSnapshots`
  (`engine/govern/diffSnapshots.mjs`), and records drift.
- Compare (`cli/keel-compare.mjs`) uses `engine/govern/compare.mjs`: `compareSnapshots`, `compareTenants` and
  `compareWithLive`.
- Baselines are in `engine/govern/baseline.mjs`, semantic drift in `semanticDrift.mjs`, workload drift in
  `workloadDrift.mjs`, and the evidence chain in `evidence.mjs`.
- Live state and the reconciliation plan: `engine/reconcile/liveState.mjs` (`buildLiveIndex`) and
  `reconciliationPlan.mjs` (`buildReconciliationPlan`). PATCH bodies come from `writableProjection.mjs`.
- Insights:
  - the change feed: `engine/insights/feed.mjs` (`loadChangeFeed`)
  - the weekly summary: `summary.mjs`
  - flags: `flags.mjs`
  - service grouping: `taxonomy.mjs` and `taxonomy.d/`

### 4. Restore planning and writers: `engine/restore/`

`cli/keel-restore.mjs` (`runRestore`) always plans first.
1. Build the reconciliation plan.
2. `classifyContentEffects`.
3. Plan the waves: `planWaves`, `planDeletionWaves` in `engine/restore/wavePlanner.mjs`.
4. Persist a **dry-run artifact** (`createDryRunArtifact` in `engine/restore/dryRunArtifact.mjs`).

An enforce run happens only by promoting that artifact (`--artifact <id> --enforce`). A direct enforce is
refused.

`applyWave` in `engine/restore/applyEngine.mjs` writes one wave:
- **Registry writers** first: `writerFor(type, verb)` from `engine/restore/writers/registry.mjs`. The fragments
  are `writers/entra.mjs` and `writers/ido.mjs`.
  - Record-driven types use `defineRecord` in `engine/restore/recordWriter.mjs`. Their records are in
    `identityObjectOperations.mjs` and `intuneOperations.mjs`.
  - Own-module writers include `signInSettingsOperations.mjs`, `accessPackageOperations.mjs` and
    `userFlowOperations.mjs`.
- **Built-in branches** next: Intune policies, tenant policies, admin roles (`adminRoleOperations.mjs`), users
  and the generic Entra writer.
- Every write is journalled first (`rollbackJournal.mjs`) and read back. The writes are undone by compensation
  (`compensation.mjs`, `--compensate`).

Each (type, operation) a writer handles has a **capability**: `engine/coverage/capabilities.mjs` plus
`capabilities.d/{entra,ido,wkld}.mjs`. The capability names the same `handler` as the writer. Workload writes
are declared in `engine/restore/workloads/writeDeclarations.mjs` (`WKLD_WRITE_OPERATIONS`) and planned and
promoted through `workloads/dispatch.mjs`.

### 5. Approvals: `engine/safety/`, `engine/govern/`

- **Content effects.** `engine/safety/contentEffects.mjs` (`CONTENT_EFFECT_RULES`, `classifyContentEffects`,
  `assertContentEffectApproval`) names what a write would change for people: access, sharing, sign-in.
- **Restore approval rules.** `engine/govern/restoreApprovalSettings.mjs` (`effectsNeedApproval`,
  `restoreNeedsApproval`) decides which effects need a second person.
- **Holding a write.** `approvalHeldRefusal` in `engine/restore/approvalHeld.mjs` holds a write until its
  effect is approved.
- **Portal actions** that need approval create an `approval_request`. A different principal approves it, and
  that mints the job (`portal/lib/action.ts`, `guarded`).

### 6. Portal and CLI: `portal/`, `cli/`

- **Auth.** `portal/proxy.ts` puts every request behind the Cloudflare Access assertion: none gives **401**, a
  cross-site state change gives **403** (`portal/lib/same-origin.ts`). It then resolves the principal and its
  capabilities into headers.
- **Reads** declare a surface in `portal/lib/read.ts` (`DATA_SURFACES`, `guardedRead`). **Writes** go through
  `portal/lib/action.ts` (`guarded`, `guardedAction`).
- **Jobs.** The portal never runs collection or restore itself. It queues a `job` row (`enqueue` in `engine/jobs/queue.mjs`), and
  `cli/keel-worker.mjs` claims it, checks the requester's grants again, and runs the matching CLI as a child
  process. Recurring jobs are queued by `cli/keel-scheduler.mjs`. Capabilities per job kind are in
  `engine/authz/jobCapabilities.mjs`. Roles and capabilities are in `engine/authz/permissions.mjs`, and checks
  in `engine/authz/can.mjs`.
- **UI checks** use fixtures in `portal/ui-harness/` (`app.tsx`; `npm run test:ui`). Colours are the tokens in
  `portal/app/globals.css`.

### Other engine areas

| Directory | What it holds |
|---|---|
| `engine/coverage/` | The qualification ledger, capabilities, completeness, and the coverage doc renderer |
| `engine/benchmarks/` | Benchmark controls (ScubaGear, NIST, Secure Score) and fixes |
| `engine/bootstrap/` | Tenant onboarding and `permissionCatalog.mjs` (`KEEL_PERMISSIONS`) |
| `engine/graph/` | The dependency graph and impact (`dependencyGraph.mjs`, `resolver.mjs`) |
| `engine/identity/` | Audit-log ingestion and change attribution |
| `engine/notify/` | Alerts, notification channels (Teams, Slack) and the weekly summary |
| `engine/policy/` | Automatic roll-back policies and change intents |
| `engine/itsm/` | The ITSM approval mirror |
| `engine/telemetry/` | The SIEM outbox |
| `engine/export/` | Signed bundles and config export |
| `engine/storage/` | Offsite storage adapters (local, S3-compatible, Azure Blob) |
| `engine/schedules/` | Schedule cadences |
| `engine/jobs/` | The job queue (`queue.mjs`, `enqueue`) and job progress |
| `engine/query/` | "Ask" question plans |
| `engine/contracts/` | Field projection (`fieldProjection.mjs`) and release contracts |
| `engine/config/` | Reading `/etc/keel/*.json` |

## What may import what

Nothing lints this. One rule is tested: `portal/test/client-boundary.test.ts`, which stops a server module
importing a plain value from a `"use client"` module. The rest is how the code is laid out today. Keep to it:
- `engine/` never imports `portal/`. Outside tests, it imports `cli/` only in one place
  (`engine/policy/activation.mjs`). From `tools/` it imports only `tools/tenant-probe/` (the Graph client and
  catalog) and two qualification helpers.
- `engine/cir/` and `engine/collect/` sit at the bottom. They never import `restore/`, `govern/` or `safety/`.
  `engine/store/` never imports `restore/` or `govern/`.
- `engine/restore/` imports `engine/safety/` for its gates. Safety imports restore only for small shared
  helpers (`pimRuleWeakenings`, `comparable`, `relationshipOperationKey`); keep it that way.
- `cli/` composes engine modules and owns argument parsing and process exit codes. Shared logic belongs in
  `engine/`, not in a CLI. Tests may import CLIs (for example `lockoutGateFor` from `cli/keel-restore.mjs`).
- `portal/lib/` imports the engine directly (`../../engine/...`). Pages and routes import `portal/lib/`, not
  the engine.

## Data model at a glance

Tables are in `engine/store/schema.sql`, unless marked "(fragment)", which means they come from a file in
`schema.d/`.

| Area | Tables |
|---|---|
| Backups | `snapshot`, `resource_version`, `resource_reference`, `resource_symbol`, `resource_lineage*`, `relationship_edge_set`, `relationship_edge`, `branding_asset*`, `type_coverage_latest` (fragment) |
| Content | `content_item`, `content_chunk`, `content_ref`, `content_run`, `content_sync_state`, `content_restore_run`, `content_restore_entry` (all fragments) |
| Workloads | `workload_collection`, `workload_observation`, `workload_ledger_evidence`, `workload_ledger_grants`, `workload_drift` (fragment) |
| Drift and baselines | `baseline`, `baseline_resource`, `drift`, `disposition`, `baseline_score_point` (fragment) |
| Restore | `plan`, `restore_dry_run`, `rollback_entry`, `content_effect_approval`, `recovery_completion_item`, `recovery_completion_event`, `retention_pin` |
| Approvals | `approval_request`, `approval_policy`, `approval_signoff`, `restore_approval_setting`, `restore_approval_rule`, `approval_mode` (the last five are fragments) |
| Evidence | `evidence`, `evidence_head` (a hash chain) |
| Auth | `principal`, `role_grant`, `breakglass_account`, `breakglass_lifecycle_event`, `access_connection` (fragment) |
| Jobs | `job`, `schedule` |
| Alerts and notify | `alert*`, `channel`, `subscription`, `delivery`, `change_flag_*` (fragment) |
| Integrations | `siem_*`, `itsm_*`, `incident*`, `benchmark_*`, `api_drift_*`, `audit_ingest_*` (fragment) |

## Restore safety model

1. **Dry run first, always.** Every write comes from a persisted dry-run artifact with a plan digest. The dry
   run reads live and writes nothing.
2. **Trust, federation, certificate and sign-in fields are never written.** Examples: `inboundTrust`,
   `signingCertificate`, `issuerUri`, named-location trust, a task extension's Logic App and sign-in.
   - They are defined in `engine/restore/workloads/writeDeclarations.mjs` (`TRUST_FIELDS`,
     `TRUST_FIELD_PATTERN`, `isTrustField`).
   - Bodies are stripped by `withoutTrustFields` and the generic projection (`trustFieldsOf` in
     `engine/reconcile/writableProjection.mjs`).
   - A difference in one becomes a person's step (`trustFieldStep` in `engine/restore/recordWriter.mjs`).
   - `defineRecord` throws on a trust field in a declared list.
   - Tests: `engine/restore/recordWriterTrust.test.mjs`, `genericWriterTrust.test.mjs` and
     `wholeReplaceTrust.test.mjs`.
3. **Approvals.** Content effects (admin access, sharing, sign-in) are held until approved by someone other than
   the requester (only in solo approval mode, `engine/govern/approvalMode.mjs`, may the requester approve, and the
   approval says so). Tenant-wide records (`tenantWide: true`) are refused on the test tenant unless the dry run used
   `--allow-tenant-wide-test-writes` (`tenantWideRecordProblem` in `recordWriter.mjs`). Deletes pass the
   non-overridable refusals in `engine/safety/deletionGuard.mjs` (`refuseUnsafeDeletion`), and a delete of a
   `tenant-lockout` type is refused in `applyWave`.
4. **Lockout gates.** Types rated `tenant-lockout` need an allowing break-glass gate (`engine/safety/lockoutGate.mjs`,
   `edgeLockoutGate.mjs`, `breakGlassReadiness.mjs`). Conditional Access lands report-only; turning a policy on
   is a separate, approved step.
5. **Live-qualified gates.** Being fixture-tested is not being proven live.
   - `TYPE_DECISIONS` in `engine/coverage/qualification.mjs` records what is automated. `liveFailures` records
     what failed live.
   - Live evidence is in `docs/release/qualifications/` (`tools/qualification/entraLive.mjs capture|promote|demote`).
   - A workload write runs only when `workloadWriteQualification` finds fresh live evidence (at most
     `WORKLOAD_WRITE_EVIDENCE_MAX_AGE_MS`, 30 days).
6. **Verify on read-back.** Every field sent must read back as sent. Verification never ignores whole fields to
   hide real drift.
7. **Builders never write to a real tenant.** Live captures are operator queue items on `KEEL-RT-` fixtures.

## Generated and ledger files

| File | Source | Regenerate | Guard |
|---|---|---|---|
| `docs/coverage.md` | `TYPE_DECISIONS`, capabilities, `TYPE_GUIDE` in `engine/coverage/coverageDoc.mjs` | `node tools/coverage-doc.mjs` | `engine/coverage/coverageDoc.test.mjs`, `--check` |
| `docs/roadmap/benchmark-content/scubagear-coverage.md` | the ScubaGear rules | `node tools/scubagear-rules.mjs report --write` | `engine/benchmarks/scubagear/import.test.mjs` |
| Release sign-off docs (`docs/roadmap/release-signoff.md`, `operator-gates.md`) | a candidate build | `node tools/release/readiness.mjs …` | operator only |
| Operation counts in `engine/roadmap/fidelity-ledger.test.mjs` | `buildOperationLedger()` | recompute | itself |

On a merge conflict, never pick a side. Regenerate the generated file, recompute the count, and keep both sides
of the hand-written ledgers (`qualification.mjs`, `completeness.mjs`, `tools/qualification/operations.mjs`,
`live-gate-plan.mjs`). Exact steps: `.claude/skills/keel-generated-files/SKILL.md`.

## Tests

| Suite | Where | Command |
|---|---|---|
| Engine, CLI, tools, status | every tracked `*.test.mjs` under `engine/`, `cli/`, `tools/`, `status/` (glob, `tools/engine-test-files.sh`) | `cd engine && node --test --test-concurrency=4 $(../tools/engine-test-files.sh)` |
| Per-feature acceptance | `engine/roadmap/*.test.mjs` (restore writers, the ledger, live gates) | part of the engine suite |
| Portal unit and route | `portal/test/*.test.ts` | `cd portal && npm test` |
| Portal UI | `portal/ui-harness/{ui,layout,shell,idle}.spec.ts`, baselines in `__screenshots__/` | `cd portal && npm run test:ui` |
| Types and build | `portal/` | `npm run typecheck`, `npm run build` |

- **Database.** Each test file gets its own Postgres schema from `createIsolatedTestDatabase` in
  `engine/test/dbTestHelper.mjs`. It needs `KEEL_DB_TEST_URL`. `tools/dev-setup.sh` sets it up.
- **Fakes.** No test calls Graph or PowerShell:
  - `fakeGraph()` in `tools/qualification/operations.mjs`
  - `idoFakeGraph()` in `engine/test/idoFakeGraph.mjs`
  - `engine/test/fake*.mjs` for cmdlets, DSC, PnP and SharePoint REST
- **CI.** `.github/workflows/portal.yml` (Portal) has the `ui` job (typecheck, build, `test:ui`) and the `tests`
  job (`npm test`, then the engine suite). It runs on PRs that touch `portal/`, `engine/`, `cli/`, `tools/`,
  `ops/powershell/` or the workflow itself, and on every push to master. `merge-gate.yml` merges
  `automerge`-labelled PRs (`tools/merge-gate.sh`), and `automerge-label.yml` removes the label on each push.
- `EXCLUDED` in `tools/engine-test-files.sh` lists the few host-only suites. Never add to it to get green.
