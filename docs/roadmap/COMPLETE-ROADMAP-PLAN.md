# KEEL complete roadmap — executable implementation plan

Date: 2026-09-15 UTC. Status: reviewed and queued at operator request.
This is the authoritative implementation decomposition of the September 14 living vision,
Final App Map, WS2 draft and Codex reviews. It does not claim future features already exist.
The September 15 final review resolves contradictions; this plan takes precedence where older
prose disagrees. Preserve original scope: one managed tenant, configuration/container settings,
no file/message content, and no on-prem agent runtime.

## Global Constraints

1. Work only on the named task in /opt/keel. All file paths below are relative to that repository.
   Reuse existing code and explicit earlier task interfaces. Inspect current HEAD before editing;
   old comments, task completion and deployed files do not establish present source parity.
   Never overwrite /opt/keel-live, switch branches, force-push, restart services or commit yourself.
2. Implementation/testing authorization is granted by the operator's September 15 request.
   Builders use fixtures/fake Microsoft writers, bounded local HTTP fixtures and isolated test DB
   through engine/test/dbTestHelper.mjs. Never mutate live tenant objects, provision cloud resources,
   send actual notifications/ITSM changes, purchase services or run live drills from these tasks.
   Keep collector/restorer credentials separate, Conditional Access never enforced by builders.
3. Dependencies in queue dependsOn are enforced by the driver: all must be done before dispatch.
   External qualification gates carry hold=true and blocked status until named evidence exists.
   Do not clear holds, edit other queue entries, invent credentials, or treat elapsed time as evidence.
   An independently useful fixture-tested feature may ship disabled while external qualification waits.
4. Every new table uses tenant_ref (or a proven tenant-scoped parent FK) and every read/write path
   checks current authorization server-side, including exports/counts/query results and worker entry.
   Discover actual closed-inventory registries in portal/lib; extend them, never create parallel gates.
   A queued job is not an executed or verified result. Evidence records each state transition.
5. Preserve immutable artifact-only restore promotion, current-state revalidation, kill switch,
   run-as reauthorization, source-authority refusal, impact ceilings, quotas, retry/idempotency and
   post-write verification. Do not build a second remediation/restore engine. Disposition changes
   governance state and must not be modeled as an unnecessary Microsoft object write.
6. All capability claims distinguish declared, fixture-tested, live-qualified, unsupported and unknown.
   Qualification is tenant/operation/subtype/projection/build/credential/time-specific. A fake proves
   code behavior, not Microsoft support or real recovery. Empty successful reads differ from failures.
   Tiered observations have time windows; do not present them as an atomic tenant-wide snapshot.
7. Credentials/private keys/tokens never enter git, exports, logs or evidence. Store references only.
   Preserve semantic history during schema/hash/identity migrations. Migrations are forward-compatible,
   additive and retry-safe in isolated tests; include explicit handling of preexisting schema/data.
8. For unstable external APIs, check current official documentation during implementation; record URL,
   retrieval date, credential mode and limits in the relevant qualification ledger. Unsupported routes
   must remain manual/refused. Do not infer capability from a vendor marketing sentence or URL alone.
9. UI tasks conform to `docs/roadmap/portal-experience.md` (2026-10-03), which supersedes this
   constraint's earlier wording: every page and object card is built as verdict, explanation and
   technical record; objects are shown by name and identifiers only inside the labelled record
   layer; internal vocabulary stays out of the first two layers; the seven-entry navigation is the
   only map. Render actual reader data, never placeholder values. A UI task's validate command
   includes the contract's mechanical checks (`cd portal && npm run test:ui`) once task-129 ships.
10. Every task must add its named boundary-level test file, exercising the production implementation
    and real integration seam with injected fakes or isolated DB. Tests must not mirror a hand-authored
    roadmap manifest or merely assert a file/string exists. Research/contract tasks ship executable
    validators/harnesses plus positive and adversarial fixtures, not prose-only completion.
11. Run the exact Validate command from /opt/keel. The named new test file must exist (no skipped
    placeholder tests). Review runs the three explicit mutations and derives further real defects,
    restores each mutation precisely, and preserves unrelated work. Load-bearing verification remains
    enabled; never add exemptions to make a weak test suite pass.
12. When source already implements a requirement, preserve it and add missing meaningful boundary
    tests/evidence rather than reimplementing it. External readiness remains pending until authentic
    runner evidence is available. The final release task consumes all qualification gates, without
    silently activating anything in production.

## Review and ownership

See /root/docs/superpowers/specs/2026-09-15-keel-roadmap-final-review.md for findings and decisions.
Task execution is build → exact validation → independent mutation review → driver-owned commit.
Each task below owns its implementation, tests, migration and user-visible evidence contract.
The queue is an ordered preference list plus a dependency DAG, not a blanket sequential lock.
Schedules tasks 42-44 retain their September 14 implementation plan; 43/44 receive explicit
prerequisites and requeue notes. No completed entry is replaced or renumbered.

## Operator decisions — 2026-09-30

Recorded from the operator. These refine the external admission gates; no task is started by this entry.

- **Driver stays stopped.** The autonomous driver (about 350 agent sessions for 10 ships) is not restarted as
  it was. Remaining work goes in small batches in a warm session, chosen by the operator.
- **task-118 (ServiceNow).** A non-production instance and OAuth app are provided (credentials in
  `/etc/keel/servicenow.env`, outside git). The gate is still held on task-97 (the adapter does not exist yet)
  and on mapped test users and a workflow inside the instance, to be confirmed once task-97 ships.
- **task-114 (storage).** Users must be able to save backups anywhere, including on-prem and local. The local-disk
  adapter stays a supported target but keeps its honest ceiling (`retentionLock` and `immutability` unsupported),
  so it cannot pass the live retention-lock gate. Decision on how to qualify task-114 is OPEN: (1) one real
  lock-capable target, e.g. S3-compatible Object Lock; (2) a stronger local mode on a separate WORM or
  append-only mount with an explicit, tested ceiling change; (3) release honestly reports storage immutability
  as unqualified. The disk is about 90% full, so backups belong on a separate volume.
- **task-122 (Exchange).** The fixture is the existing generic KEEL rehearsal user `keel-rt-20260908-alice`
  (already licensed with Exchange). No license is taken from a real user and no shared mailbox is created
  (Graph cannot create one; the Restorer has no Exchange admin-as-app grant). It still depends on task-105,
  task-104 and task-121.
- **Permissions.** KEEL Restorer was granted Graph `MailboxSettings.ReadWrite` (tenant-wide scope; use it only
  on the fixture mailbox). `Mail.ReadWrite` is added only if the Exchange adapter needs mail rules or folders.
- **GlobalAdmin app.** The operator created a separate setup-only app with app-role and directory-role
  management rights. Certificate and key are in `/etc/keel/globaladmin.*` (key mode 600, outside git), with
  cert auth. It holds no directory role until a task needs one. The Restorer stays the day-to-day
  fixture writer. Every grant is logged in `/opt/ai-vault/daily/`.
- **Sandbox guardrails (never lock the operator out).** Do not change the operator's admin accounts, the
  break-glass and emergency-access accounts or the Global Reader account. Do not enforce Conditional Access or
  MFA policy and do not touch security defaults. Only create, edit or delete `KEEL-RT-*` fixtures and new
  objects the work itself made. Keep the GlobalAdmin certificate valid.
- **task-117 (Sentinel) — deferred, worked around.** No Azure subscription is available and none is expected soon.
  The Sentinel adapter (task-80) stays fixture-tested only and ships disabled. Generic webhook and CEF export
  (task-81) is the supported SIEM path for the nucleus. task-117 no longer blocks release: task-124 lists Sentinel
  as "fixture-tested, live-unqualified, deferred" and never as live-qualified. Revisit when a subscription exists.
- **task-114 (storage) — decided: local copy, honest ceiling.** Storage provider is not the point; the nucleus must
  be proven first, and further storage channels come later. Backups go to a local copy on a separate volume
  (the disk is about 90% full). The local adapter keeps `retentionLock` and `immutability` unsupported, so
  task-114 is rescoped to qualify what a local copy can prove: independent recovery read and manifest
  verification from that copy (task-68/69 machinery). Storage immutability is reported unqualified in the release
  ledger (option 3 above), not claimed. No lock-capable target is required for the nucleus release.
- **Consequence for gates.** The no-overclaiming rule is unchanged: unqualified items are reported as such, not
  hidden and not treated as passed. Only the hard "must be live-qualified" blocking of task-114's lock canary and
  task-117 is lifted for task-124; the queue holds and task-124's dependency list need a matching edit before
  either task is dispatched.
- **Open:** none for storage or Sentinel. task-118 still waits on task-97.

## Operator decisions — 2026-10-03

Recorded from the operator after the 2026-10-03 project review. These change how the portal is
built; they do not start or stop any engine task.

- **The portal is written for two readers at once.** Any executive must understand each page from
  the first screen; any engineer must find every identifier in a labelled technical record. The
  review found the opposite: Policies showed a run-as principal as a raw UUID and a "Policy ID"
  field with no meaning to an administrator; Approvals described a request as an action code and
  JSON; Jobs used the job UUID as the page subtitle; Coverage was an 11-column evidence taxonomy;
  the healthy dashboard said "No issues detected". `docs/roadmap/portal-experience.md` is the
  contract that fixes this and is authoritative for every portal task from today.
- **Identification rule.** Every object is shown by its human name or a generated sentence built
  from its own fields. A field that references another object renders that object's name, linked.
  Identifiers appear only inside "Technical details", each labelled with its kind, a copy
  affordance and where it is accepted. Stored enum codes never reach the screen unmapped.
- **Honesty moves, it does not shrink.** Every caveat, proof reference and provenance field the
  portal shows today is still shown, inside the record layer of the object it qualifies. A page
  level aside such as "Declaration is not verification." is replaced by a per-type sentence.
- **Navigation is seven entries with one map.** Overview, Protect, Changes, Restore, Approvals,
  Activity, Settings. The page eyebrow is its nav group. Pending UI tasks (73, 76, 83, 87, 92, 98,
  99, 100, 110) place their pages inside this map or justify an eighth entry in their task text.
- **Tasks 129, 130 and 131** carry the redesign. task-129 lands the contract's shell, navigation,
  overview sentence and the mechanical checks in the UI harness; task-130 applies the
  identification rules to policies, principals, approvals, jobs, evidence and baselines; task-131
  collapses coverage into Protect and rewrites the Changes and Restore copy. They depend only on
  shipped work and may be dispatched ahead of every other queued task. task-54's matrix layout is
  superseded by task-131; its data and tests are kept.
- **Recommended, not yet decided:** freeze the workstreams outside the nucleus (WS4 scenario work,
  WS5 benchmarks, WS6 reporting and query, WS7 paging adapters, WS8 ServiceNow, WS9 attribution,
  WS11 hybrid, WS12 Sentinel) and the SharePoint, Teams, Exchange, OneDrive and Purview adapters
  until one live collect → baseline → drift → restore journey has been recorded as live-qualified
  on the real tenant. The queue is not edited by this entry.

## Implementation status — 2026-10-04 (overnight run)

Two coordinated sessions worked through the queue on 2026-10-03/04, coordinated in issue
#20. Every PR was reviewed and merged only with both CI checks green. Each task records its
own implementation and limits in a dated status section of the doc it names. This is the index.

**Merged, code complete (fixture-tested; live qualification where the task names one is
still separate).** Each item gives the task, then its PR.
- 72 (#29), 73 (#36), 82 (#24), 83 (#30), 84 (#31), 87 (#27), 89 (#23)
- 90 (#34), 91 (#40), 92 (#46), 93 (#52), 94 (#49), 95 (#55), 96 (#57), 97 (#61)
- 98 (#48), 99 (#53), 100 (#56), 101 (#32), 102 (#33), 103 (#35)
- 107 (#28), 108 (#39), 109 (#45), 110 (#26), 111 (#37)
- 130 (#14), 131 (#15)
- Adapters that ship **disabled**, each until its workload's live qualification exists:
  SharePoint 102/103, Teams 104 (#50), Exchange 105 (#59), OneDrive/Purview 106 (#64).

**Merged as code halves; the gate stays `pending` until the operator captures live
evidence.** Each item gives the task, then its PR.
- 113 (#41), 114 (#47; local-copy scope per the 2026-09-30 decision), 115 (#42)
- 116 (#43), 117 (#60), 118 (#63), 120 (#44), 121 (#54), 122 (#62), 123 (#66)

No `docs/release/qualifications/*.json` claims live qualification for any of these. The
capture and verify commands, fixtures, open operator decisions and suggested order are in
[operator-gates.md](operator-gates.md).

**In progress / not started:** 112 (fixture-tested journeys and the release ledger) was
started once all 16 of its dependencies merged; its ledger keeps readiness pending while any
live gate is pending. 124 is not started: it needs 112–119 and live evidence.

**Integration.** #38 and #65 fixed issues found by running every engine, CLI and tools suite
on master:
- a grant timestamp-precision mismatch;
- a benchmark test path;
- approve-gated emergency changes missing from the read inventory;
- a host-dependent rehearsal test.

The remaining full-suite failures need the VPS: `/opt/keel`, `/opt/mimoun` and
`/var/lib/keel/reference-data`.

## Task index

| ID | Workstream | Deliverable | Prerequisites | Admission |
|---|---|---|---|---|
| task-45 | Foundation | Versioned observation and release evidence contracts | None | Dependency-gated |
| task-46 | Foundation | Reconcile M4 portal source with current engine contracts | task-45 | Dependency-gated |
| task-47 | WS2 | Persist structured per-type collection outcomes | task-45 | Dependency-gated |
| task-48 | WS2 | Tenant-scoped historical identity context for collection | task-47 | Dependency-gated |
| task-49 | WS2 | Scope Graph reads by tier without changing identity | task-48 | Dependency-gated |
| task-50 | WS2 | Stable resource lineage across rename and recovery | task-48 | Dependency-gated |
| task-51 | WS2 | Versioned field projection and classification contracts | task-47 | Dependency-gated |
| task-52 | WS2 | Evidence-backed operation capability registry | task-51 | Dependency-gated |
| task-53 | WS2 | License consent and role diagnosis without masking failures | task-47, task-52 | Dependency-gated |
| task-54 | WS2 | Capability matrix and linked observation views | task-46, task-49, task-53 | Dependency-gated |
| task-55 | WS2 | Enforce automation limits after dependency expansion | task-52 | Dependency-gated |
| task-56 | WS2 | Atomic redacted configuration file exports | task-51 | Dependency-gated |
| task-57 | WS2 | First-class group membership and owner observations | task-50, task-47 | Dependency-gated |
| task-58 | WS2 | App grant owner and Intune assignment observations | task-57 | Dependency-gated |
| task-59 | WS2 | Operation-specific forward and reverse dependency analysis | task-58, task-55 | Dependency-gated |
| task-60 | WS2 | Bounded dynamic group impact prediction | task-59, task-51 | Dependency-gated |
| task-61 | WS2 | Qualified relationship restore operations | task-59, task-52 | Dependency-gated |
| task-62 | WS2 | Detect Microsoft API and catalog drift | task-47 | Dependency-gated |
| task-63 | WS2 | Per-operation qualification ledger for all catalog types | task-52, task-61 | Dependency-gated |
| task-64 | WS2 | Select qualified native or reconstructed recovery | task-63, task-50 | Dependency-gated |
| task-65 | WS2 | Track credential and service recovery completion | task-64 | Dependency-gated |
| task-66 | WS2 | Guard irreversible effects of configuration changes | task-59, task-64 | Dependency-gated |
| task-67 | WS10 | Storage retention residency and recovery manifest | task-56, task-45 | Dependency-gated |
| task-68 | WS10 | Reconstruct Keel read-only from independent artifacts | task-67 | Dependency-gated |
| task-69 | WS10 | Qualify independent retention-locked storage | task-67 | Dependency-gated |
| task-70 | WS10 | Conflict-aware compensation for failed restores | task-66, task-65 | Dependency-gated |
| task-71 | WS10 | Incident-qualified recovery points and retention pins | task-64, task-51 | Dependency-gated |
| task-72 | WS10 | Offline and bounded same-tenant recovery drills | task-68, task-70 | Dependency-gated |
| task-73 | WS10 | Measured freshness recovery time and resilience portal | task-54, task-67, task-72 | Dependency-gated |
| task-74 | WS3 | Least-privilege onboarding prerequisite planner | task-53 | Dependency-gated |
| task-75 | WS3 | Resumable Microsoft identity provisioning journal | task-74 | Dependency-gated |
| task-76 | WS3 | Guided onboarding and named prerequisite resolution | task-75, task-46 | Dependency-gated |
| task-77 | WS12 | Unified correlated operational and evidence events | task-45 | Dependency-gated |
| task-78 | WS12 | Externally anchored evidence-chain verification | task-77, task-67 | Dependency-gated |
| task-79 | WS12 | Durable SIEM event outbox and replay checkpoints | task-77 | Dependency-gated |
| task-80 | WS12 | Azure Monitor and Sentinel export adapter | task-79 | Dependency-gated |
| task-81 | WS12 | Generic webhook and CEF export adapters | task-79 | Dependency-gated |
| task-82 | WS7 | Durable alert lifecycle and flapping behavior | task-77 | Dependency-gated |
| task-83 | WS7 | Acknowledgement deadlines escalation and alerts inbox | task-82, task-46 | Dependency-gated |
| task-84 | WS7 | Teams Slack PagerDuty and SMS channel adapters | task-83 | Dependency-gated |
| task-85 | WS5 | Versioned benchmark and custom-control evaluation | task-51, task-53 | Dependency-gated |
| task-86 | WS5 | CIS licensing gate Secure Score and framework mappings | task-85 | Dependency-gated |
| task-87 | WS5 | Baseline age compliance views and linked findings | task-86, task-54 | Dependency-gated |
| task-88 | WS9 | Bounded audit and sign-in ingestion with sizing evidence | task-77, task-47 | Dependency-gated |
| task-89 | WS9 | CMDB-first ownership and explicit shared scope | task-50, task-46 | Dependency-gated |
| task-90 | WS9 | Entity-scoped reads and approval eligibility | task-89, task-59 | Dependency-gated |
| task-91 | WS9 | Evidence-based change attribution and approver routing | task-88, task-90 | Dependency-gated |
| task-92 | WS4 | Immutable policy activation preview and reconciliation plan UI | task-55, task-91, task-87 | Dependency-gated |
| task-93 | WS4 | Time-bounded approved emergency deviations | task-92 | Dependency-gated |
| task-94 | WS4 | Break-glass lifecycle readiness and usage canary | task-91, task-83 | Dependency-gated |
| task-95 | WS4 | Bounded proposed-policy scenario evaluation | task-60, task-94 | Dependency-gated |
| task-96 | WS8 | Canonical approval mirror and adapter contract | task-93, task-90 | Dependency-gated |
| task-97 | WS8 | ServiceNow configurable workflow adapter | task-96 | Dependency-gated |
| task-98 | WS6 | Decision-focused semantic drift and cross-linked reports | task-87, task-91, task-59 | Dependency-gated |
| task-99 | WS6 | Bounded grounded tenant query and cited answers | task-98, task-90 | Dependency-gated |
| task-100 | WS6 | Verified outcome and executive value reporting | task-73, task-98 | Dependency-gated |
| task-101 | WS2 | Qualify workload configuration APIs and permissions | task-66, task-53 | Dependency-gated |
| task-102 | WS2 | SharePoint site configuration read adapter | task-101 | Dependency-gated |
| task-103 | WS2 | Qualified SharePoint configuration restore | task-102, task-61, task-66 | Dependency-gated |
| task-104 | WS2 | Teams configuration and structural membership adapter | task-103, task-120 | Dependency-gated |
| task-105 | WS2 | Exchange mailbox configuration adapter | task-104, task-121 | Dependency-gated |
| task-106 | WS2 | OneDrive container settings and Purview label configuration | task-105, task-122 | Dependency-gated |
| task-107 | WS2 | Measured Entra operation expansion batches | task-63, task-66 | Dependency-gated |
| task-108 | WS2 | Bounded policy configuration restore qualification | task-107 | Dependency-gated |
| task-109 | WS2 | Bounded administrative configuration restore qualification | task-108 | Dependency-gated |
| task-110 | WS1 | Measured schedule load warnings | task-49, task-77, task-43, task-44 | Dependency-gated |
| task-111 | WS11 | Deferred hybrid topology contract and cloud refusal rules | task-52, task-90 | Dependency-gated |
| task-112 | Release | Six end-to-end journeys and release qualification ledger | task-76, task-73, task-71, task-65, task-78, task-80, task-81, task-84, task-95, task-97, task-99, task-100, task-106, task-109, task-110, task-111 | Dependency-gated |
| task-113 | Foundation | Authenticated deployed release acceptance | task-46, task-54, task-44 | External evidence hold |
| task-114 | WS10 | Independent storage retention and recovery qualification | task-69, task-68 | External evidence hold |
| task-115 | WS2 | Native recovery credential qualification | task-64 | External evidence hold |
| task-116 | WS10 | Bounded same-tenant drill and Keel recovery acceptance | task-72, task-76 | External evidence hold |
| task-117 | WS12 | Sentinel workspace ingestion qualification | task-80 | External evidence hold |
| task-118 | WS8 | ServiceNow non-default workflow qualification | task-97 | External evidence hold |
| task-119 | WS5 | CIS distribution rights and licensed pack qualification | task-86 | External evidence hold |
| task-120 | WS2 | SharePoint configuration workload qualification | task-103 | External evidence hold |
| task-121 | WS2 | Teams configuration workload qualification | task-104, task-120 | External evidence hold |
| task-122 | WS2 | Exchange configuration workload qualification | task-105, task-121 | External evidence hold |
| task-123 | WS2 | OneDrive and Purview configuration qualification | task-106, task-122 | External evidence hold |
| task-124 | Release | Verify complete roadmap release without overclaiming readiness | task-112, task-113, task-114, task-115, task-116, task-117, task-118, task-119, task-120, task-121, task-122, task-123 | Dependency-gated |
| task-129 | Portal | Portal experience contract: shell, navigation, overview sentence, mechanical checks | task-46 | Dependency-gated |
| task-130 | Portal | Named objects and labelled technical records for policies, principals, approvals, jobs, evidence, baselines | task-129 | Dependency-gated |
| task-131 | Portal | Protect page with per-type drawer; Changes and Restore in plain words | task-129, task-54 | Dependency-gated |

### Task 45: Versioned observation and release evidence contracts

**Workstream:** Foundation. **Depends on:** None.

**Files:** `engine/coverage/snapshots.mjs`, `engine/coverage/report.mjs`, `engine/contracts/observation.mjs`, `tools/release/readiness.mjs`, `tools/release/qualification.mjs`; new boundary tests in `engine/roadmap/foundation.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Define versioned evidence with tenant_ref, observation ID, per-type start/end window, source build, completeness and evidence level (fixture-tested, live-qualified, unknown). Preserve legacy snapshot reads; a tiered snapshot is not an atomic tenant image. Add a read-only readiness CLI recording source and deployed revisions, health and authenticated feature-probe outcomes; missing session yields unknown, never pass. Never print session headers. Produce docs/release/readiness.json without changing deployment. Implement the common tools/release/qualification.mjs verify CLI now: gate, evidence path, --require-live; validate schema, trusted runner identity/signature or independently verifiable artifact digest, tenant/build/operation/credential mode and observation freshness. Missing proof must exit nonzero. Register gate-specific validators additively in later tasks; --require-live rejects synthetic fixtures.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/foundation.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Legacy and mixed-tier fixtures read correctly; different observation windows cannot be labeled simultaneous; health 200 with an unauthorized feature probe does not prove feature parity; executable negative fixtures reject cross-tenant joins and fabricated live qualification.

**Required mutation checks:**

- Ignore tenant_ref on observation join.
- Convert an unknown probe to pass.
- Drop observation-window mismatch.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/foundation.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 46: Reconcile M4 portal source with current engine contracts

**Workstream:** Foundation. **Depends on:** task-45.

**Files:** `portal/app`, `portal/lib`, `portal/components`, `engine/contracts/release.mjs`, `docs/release/source-parity.md`; new boundary tests in `engine/roadmap/portal-parity.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Compare master, m4-portal-design, and /opt/keel-live read-only; reuse the existing Jobs, Policies, Notifications, Principals, Evidence and collection-history changes from M4 tasks 35-41. Port only missing compatible changes into /opt/keel without switching branches, merging histories or changing deployed files. Preserve task-08 immutable promotion and task-07 read authorization. Record original commit provenance and resolve outdated bindings against current master. Add missing collection history and reconciliation preview bindings only where absent; later tasks extend them.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/portal-parity.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** All six existing surface families are rendered from real engine readers, not mock data; portal typecheck/tests pass; unauthenticated pages and APIs reject before reads; immutable artifact-only restore remains enforced. Source-parity report distinguishes source tests from deployment status.

**Required mutation checks:**

- Omit a ported surface from read inventory.
- Submit restore using raw selection instead of artifact.
- Treat zero-item successful collection as failure.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/portal-parity.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 47: Persist structured per-type collection outcomes

**Workstream:** WS2. **Depends on:** task-45.

**Files:** `tools/tenant-probe/graph.mjs`, `engine/collect/entraAdapter.mjs`, `engine/collect/snapshot.mjs`, `engine/coverage/report.mjs`; new boundary tests in `engine/roadmap/outcomes.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Preserve HTTP status, Graph code, redacted message, endpoint/API version, observation timestamps, pagination completion and partial counts through adapter, digest, storage and report. Distinguish failed, complete-empty, partial and not-requested. Normalize old message-only digests without inventing evidence. Do not change strict raw coverage success based on diagnosis.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/outcomes.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** A second-page error preserves first-page partial count but fails completeness; empty success stays complete; old digests remain readable; codes survive to report while authorization headers and token-shaped values do not.

**Required mutation checks:**

- Discard structured Graph error code.
- Mark second-page failure complete.
- Rewrite unavailable outcome to complete-empty.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/outcomes.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

### Task 48: Tenant-scoped historical identity context for collection

**Workstream:** WS2. **Depends on:** task-47.

**Files:** `engine/store/schema.sql`, `engine/store/resourceSymbols.mjs`, `engine/cir/canonicalize.mjs`, `engine/collect/snapshot.mjs`; new boundary tests in `engine/roadmap/symbol-context.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Persist tenant/type/source-ID aliases with source observation, time interval and tombstone state using successful type outcomes only. Current batch overrides persistent context. Canonicalize references and role-assignment keys using the same fallback context, recording stale provenance separately from semantic hashes. Seed from existing successful snapshots without rewriting historical keys. Missing bootstrap context stays unresolved and cannot authorize writes. A successful full per-type enumeration can tombstone absent IDs; failed/partial reads cannot.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/symbol-context.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** The reproduced tier1 roleAssignment to tier2 user keeps its original resolved key when context exists; unknown IDs stay unknown; aliases never cross tenants; rename/name reuse and partial-read deletion fixtures preserve identity; all tiers update context.

**Required mutation checks:**

- Skip persistent context in composed keys.
- Tombstone IDs after partial read.
- Drop tenant qualification.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/symbol-context.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

### Task 49: Scope Graph reads by tier without changing identity

**Workstream:** WS2. **Depends on:** task-48.

**Files:** `engine/collect/entraAdapter.mjs`, `engine/collect/registry.mjs`, `engine/collect/snapshot.mjs`, `engine/cir/canonicalize.mjs`; new boundary tests in `engine/roadmap/tier-scoping.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Pass tier from collectSnapshot to registered adapter selection before any HTTP read. Unscoped calls continue full collection. Filter digest consistently and use the historical identity context for keys and classified references. Record unresolved bootstrap/stale references rather than fetching every excluded endpoint silently. Keep non-tier-selected types not-requested, not empty.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/tier-scoping.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Reader call log contains only requested-tier endpoints; full scan retains current behavior; the real user/roleDefinition/roleAssignment cross-tier reproduction passes; a later weekly update is available to the next hourly run; no spurious delete/add drift from context metadata.

**Required mutation checks:**

- Filter after collection instead of before.
- Remove cross-tier fallback.
- Label unrequested type complete-empty.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/tier-scoping.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

### Task 50: Stable resource lineage across rename and recovery

**Workstream:** WS2. **Depends on:** task-48.

**Files:** `engine/store/schema.sql`, `engine/store/resourceLineage.mjs`, `engine/cir/canonicalize.mjs`, `engine/graph/resolver.mjs`, `engine/govern/diffSnapshots.mjs`; new boundary tests in `engine/roadmap/lineage.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Add tenant-scoped logical resource IDs, historical name aliases and explicit recovery/recreation links while retaining persisted natural keys for compatibility. Same source-ID rename preserves lineage; same name with a different source ID does not merge unless an evidenced recovery links them. Tombstones and alias validity windows are explicit. Teach diff and resolver to consume lineage without making stale aliases current authorization.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/lineage.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Rename yields one resource history; unrelated name reuse yields a new lineage; recovery link requires provenance; historical snapshot still resolves its then-current identity; ambiguous alias refuses target resolution.

**Required mutation checks:**

- Merge resources solely by reused name.
- Resolve expired alias as current.
- Drop recovery provenance requirement.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/lineage.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

### Task 51: Versioned field projection and classification contracts

**Workstream:** WS2. **Depends on:** task-47.

**Files:** `engine/cir/serverOwned.mjs`, `engine/cir/canonicalHash.mjs`, `engine/reconcile/writableProjection.mjs`, `engine/contracts/fieldProjection.mjs`; new boundary tests in `engine/roadmap/semantic-projection.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Define explicit per-type field behavior for collection, comparison, create, update, verification and sensitive export. Start with six original M1 types. Track reviewed-empty/unreviewed/has-rules independently of map emptiness. Pin projection version and retain raw historical truth; mixed hash versions are compared by explicit reprojection or unknown, never directly equated. Unknown fields are excluded from writes and flagged for review. Read-projection completeness remains unknown unless independently evidenced.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/semantic-projection.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Cosmetic change causes zero semantic drift but behavior change does; old hashes do not manufacture changes; sensitive payload fields never enter export projection; unreviewed empty maps stay unreviewed; new field cannot silently become writable.

**Required mutation checks:**

- Compare raw objects instead of projection.
- Infer reviewed status from empty map.
- Hash old and new projection versions as comparable.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/semantic-projection.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

### Task 52: Evidence-backed operation capability registry

**Workstream:** WS2. **Depends on:** task-51.

**Files:** `engine/coverage/capabilities.mjs`, `engine/coverage/report.mjs`, `engine/restore/applyEngine.mjs`, `engine/reconcile/verb.mjs`; new boundary tests in `engine/roadmap/capability-registry.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Create explicit type/subtype/operation records naming handler, projection, supported credential mode, ID outcome, limits, proof reference and evidence level. Preserve existing fidelity declaration separately. A fake-writer test establishes fixture-tested only; live-qualified requires matching tenant, operation, projection/build and freshness evidence. URL availability and descriptor.remappable alone never qualify CRUD. Fail closed on unsupported planned operations without blanket-refusing valid same-tenant update because remappable=false.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/capability-registry.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** All supported operations point to real handlers with executable tests; adding an unevidenced qualified verb fails; stale/wrong-tenant live proof cannot promote a claim; existing supported restores remain functional; unsupported operation refuses before writer call.

**Required mutation checks:**

- Qualify operation from pathFor alone.
- Promote fixture proof to live-qualified.
- Bypass unsupported-operation check.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/capability-registry.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 53: License consent and role diagnosis without masking failures

**Workstream:** WS2. **Depends on:** task-47, task-52.

**Files:** `engine/coverage/diagnosis.mjs`, `engine/coverage/report.mjs`, `engine/store/tenantRef.mjs`, `tools/tenant-probe/catalog.mjs`; new boundary tests in `engine/roadmap/capability-diagnosis.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Join time-qualified tenant SKU/service-plan observations and explicit granted-consent/role evidence to a versioned source-linked feature prerequisite registry. SKU ownership alone is insufficient for user entitlement or consent. Only confirmed missing prerequisite yields a named diagnosis; ambiguous 403 stays unknown with original code. New failed prerequisite reads supersede older successes for freshness. Do not mutate raw collection outcome.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/capability-diagnosis.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Distinct missing license, disabled plan, missing scope, missing role and unknown cases preserve raw failure; stale/future/wrong-tenant SKU data cannot justify diagnosis; legacy reports remain readable.

**Required mutation checks:**

- Classify every 403 as missing license.
- Use older SKU success over newer failure.
- Leak diagnosis into raw complete status.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/capability-diagnosis.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

### Task 54: Capability matrix and linked observation views

**Workstream:** WS2. **Depends on:** task-46, task-49, task-53.

**Files:** `portal/components/coverage-report.tsx`, `portal/lib/portal-data.ts`, `portal/lib/types.ts`, `portal/app/coverage/page.tsx`, `engine/coverage/report.mjs`; new boundary tests in `engine/roadmap/coverage-ui.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Render six original M1 types with endpoint/version, projection/pagination evidence, prerequisite diagnosis, operation-specific status, relationship completeness, irrecoverable fields, declaration and measured proof. Retain all existing types with honest unknown states. Link backup, drift and later benchmark views by observation IDs and windows; show mismatched observations explicitly. Support keyboard and narrow screens using existing portal styles.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/coverage-ui.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Report-to-page integration retains every state and evidence link; no single full-fidelity badge hides partial relationships; zero-item completed type is successful; unauthorized access fails before fetching.

**Required mutation checks:**

- Collapse fixture-tested to verified.
- Drop unknown pagination state.
- Fetch before authorization.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/coverage-ui.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 55: Enforce automation limits after dependency expansion

**Workstream:** WS2. **Depends on:** task-52.

**Files:** `engine/policy/execute.mjs`, `engine/policy/evaluate.mjs`, `cli/keel-remediate.mjs`, `cli/keel-restore.mjs`, `engine/restore/dryRunArtifact.mjs`; new boundary tests in `engine/roadmap/closure-ceiling.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Keep the existing policy to remediate to runRestore path. Resolve current policy/run-as constraints server-side at execution; after closure compute maximum impact over actual operations/resources and recheck again on artifact promotion. Include policy/version and expanded scope in immutable plan evidence. Preserve kill switch, duplicate/action limits, queued semantics and worker reauthorization. Return existing blocked-max-blast-radius refusal, never a successful execution.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/closure-ceiling.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Original drift under ceiling with expanded dependency above ceiling refuses before any write; within-ceiling still works; policy/grant changed between enqueue and execution refuses; task-08 promotion tests remain green.

**Required mutation checks:**

- Check original drift only.
- Trust caller-supplied ceiling.
- Skip promotion-time policy version check.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/closure-ceiling.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 56: Atomic redacted configuration file exports

**Workstream:** WS2. **Depends on:** task-51.

**Files:** `engine/export/configExport.mjs`, `engine/export/manifest.mjs`, `cli/keel-export.mjs`, `engine/collect/snapshot.mjs`; new boundary tests in `engine/roadmap/config-export.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Publish tenant/snapshot/type trees with deterministic JSON, manifest mapping hashed filenames to persisted keys, per-type completeness and observation provenance. Stage privately, reject symlink/path escape, atomically rename and advance latest only after manifest checks. Failed types remain explicit unknown/missing; absence means deletion only within successful complete type enumeration. Keep volatile times in manifest, redact via field projection, and never publish secret values. Local publication only; storage policy belongs to WS10.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/config-export.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Same values with different collection times produce identical resource bytes; slash-containing key cannot escape; interrupted export leaves old latest; partial type is not empty; deleting a resource under successful enumeration is represented correctly; manifests verify checksums.

**Required mutation checks:**

- Advance latest before rename.
- Skip sensitive-field exclusion.
- Construct filename directly from natural key.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/config-export.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

### Task 57: First-class group membership and owner observations

**Workstream:** WS2. **Depends on:** task-50, task-47.

**Files:** `engine/collect/relationships.mjs`, `engine/store/schema.sql`, `engine/coverage/report.mjs`, `engine/govern/diffSnapshots.mjs`; new boundary tests in `engine/roadmap/relationship-observations.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Collect group members and owners as separate paginated child observations with parent lineage, edge type, target identity, completeness, API source and timestamps. Do not infer complete edges from parent payload. Separate direct from transitive/dynamic results. Snapshot membership-only changes even if parent unchanged; missing target payload does not drop edge. Failed child read keeps last-known state labeled stale, never authorizes removal.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/relationship-observations.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Unchanged parent with removed member creates edge drift; empty complete edge set differs from failed read; multi-page and nested edge fixtures preserve all members; wrong-tenant edge is rejected.

**Required mutation checks:**

- Derive membership from parent only.
- Treat child failure as empty.
- Discard edge with unseen target.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/relationship-observations.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

### Task 58: App grant owner and Intune assignment observations

**Workstream:** WS2. **Depends on:** task-57.

**Files:** `engine/collect/relationships.mjs`, `tools/tenant-probe/catalog.mjs`, `engine/coverage/report.mjs`; new boundary tests in `engine/roadmap/privilege-relationships.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Extend explicit child registry to application/service-principal owners, app-role assignments and supported Intune policy assignments. Pin endpoint/version, paging and credential prerequisites per family using official docs checked at implementation. Preserve assignment filters and scope metadata. Unsupported subtype stays unknown rather than using a generic endpoint. No write capability is implied.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/privilege-relationships.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** App grant addition and Intune target/filter change create separate edge drift; missing permission produces failed child coverage; unsupported subtype cannot claim full relationships; full pagination is exercised.

**Required mutation checks:**

- Drop assignment filter from projection.
- Mark unsupported subtype complete.
- Ignore last child page.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/privilege-relationships.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

### Task 59: Operation-specific forward and reverse dependency analysis

**Workstream:** WS2. **Depends on:** task-58, task-55.

**Files:** `engine/graph/impact.mjs`, `engine/restore/selection.mjs`, `engine/restore/wavePlanner.mjs`, `cli/keel-restore.mjs`; new boundary tests in `engine/roadmap/impact-graph.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Build one typed graph over versioned resource and relationship observations. Restore prerequisite closure follows forward edges; deletion/impact analysis uses reverse edges and operation semantics. Bounded cycle-safe traversal reports incomplete/stale graph and hidden dependencies without dropping them. Disposition is a local governance operation with its own checks, not a synthetic Microsoft restore. Recheck impact at execution.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/impact-graph.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Deleting a parent sees reverse dependents; restore orders prerequisites; cycle terminates deterministically; incomplete edge coverage cannot yield an exact safe impact claim; existing unresolved-reference behavior is documented and stricter refusal is introduced explicitly for affected operations.

**Required mutation checks:**

- Use forward closure for delete.
- Drop invisible nodes from safety graph.
- Label stale graph exact.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/impact-graph.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 60: Bounded dynamic group impact prediction

**Workstream:** WS2. **Depends on:** task-59, task-51.

**Files:** `engine/graph/dynamicImpact.mjs`, `engine/safety/blastRadius.mjs`, `tools/qualification/dynamicGroups.mjs`; new boundary tests in `engine/roadmap/dynamic-impact.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Implement a small documented predicate subset over attribute changes and nested edges with work/time limits. Unsupported expressions, rule-processing delay or stale member data return possibly-affected bounds and reason, never exact membership. Add deterministic synthetic scale benchmark and a read-only real-sizing harness with external evidence input; record D3 as unqualified until measured. Integrate conservative results into impact disclosure and refusal policy.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/dynamic-impact.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Attribute edit discovers indirectly affected dynamic group; unsupported expression and exhausted work budget yield bounded unknown; cycles do not hang; scale report contains measured input size/runtime, not invented tenant figures.

**Required mutation checks:**

- Interpret unsupported expression as false.
- Ignore work budget.
- Omit dynamic reverse impact.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/dynamic-impact.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 61: Qualified relationship restore operations

**Workstream:** WS2. **Depends on:** task-59, task-52.

**Files:** `engine/restore/relationshipWriter.mjs`, `engine/restore/applyEngine.mjs`, `engine/reconcile/verb.mjs`, `engine/restore/dryRunArtifact.mjs`; new boundary tests in `engine/roadmap/relationship-restore.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Add explicit group member/owner add-remove operations through qualified $ref handlers, preserving lineage remapping and current relationship preconditions. Start only with group member/owner family; other children remain read-only until their operation proofs exist. Include edge operations in dry-run digest, current-state fingerprint, ordering, approval and post-write verification. Failed membership reads forbid destructive reconciliation.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/relationship-restore.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Membership restore never PATCHes members onto parent; lost response is reconciled without duplicate addition; concurrent legitimate edge change invalidates promotion; partial edge inventory refuses removal.

**Required mutation checks:**

- PATCH parent for relationship operation.
- Ignore membership in fingerprint.
- Remove edges after failed read.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/relationship-restore.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 62: Detect Microsoft API and catalog drift

**Workstream:** WS2. **Depends on:** task-47.

**Files:** `tools/qualification/apiDrift.mjs`, `engine/coverage/catalogDrift.mjs`, `engine/jobs/queue.mjs`, `cli/keel-worker.mjs`; new boundary tests in `engine/roadmap/api-drift.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Add bounded scheduled metadata comparison for configured official Graph metadata/OpenAPI sources. Pin downloaded source digest/date, ETag and version. Diff explicit catalog mappings and changed fields; emit review candidates only. Network failure is unknown; never auto-register types, permissions or write verbs. Use existing job/authorization inventories and configurable cadence.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/api-drift.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Added endpoint creates candidate with source proof; changed field does not become writable; 304 is handled; timeout and oversized source are bounded and visible; duplicate fetch does not duplicate findings.

**Required mutation checks:**

- Auto-enable discovered endpoint.
- Equate fetch failure with no changes.
- Ignore source size limit.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/api-drift.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

### Task 63: Per-operation qualification ledger for all catalog types

**Workstream:** WS2. **Depends on:** task-52, task-61.

**Files:** `engine/coverage/qualification.mjs`, `tools/qualification/operations.mjs`, `engine/restore/applyEngine.mjs`; new boundary tests in `engine/roadmap/fidelity-ledger.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Inventory every current descriptor into an explicit operation ledger with source links, field classification, supported credential, ID outcome, idempotency, remapping, fixture result and optional live result. Replace the incorrect requirement to make descriptor.remappable a blanket runtime gate: qualify remapping only where an operation actually requires it. Build a harness for existing group/named-location/role-assignment/CA paths and soft-restore candidates; unsupported operations remain refusal/manual. Never change a declaration based solely on a passing fake.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/fidelity-ledger.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** All catalog entries have an explicit known/unknown decision; same-tenant update can remain valid with remappable=false; new-object reference remapping requires proof; current supported paths retain tests and live evidence cannot be forged by changing a label.

**Required mutation checks:**

- Promote every remappable descriptor to writable.
- Omit an unqualified catalog type.
- Accept proof for different operation.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/fidelity-ledger.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 64: Select qualified native or reconstructed recovery

**Workstream:** WS2. **Depends on:** task-63, task-50.

**Files:** `engine/reconcile/verb.mjs`, `engine/reconcile/liveState.mjs`, `engine/restore/recoveryMechanism.mjs`, `portal/components/recovery-mechanism.tsx`; new boundary tests in `engine/roadmap/native-recovery.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Select among soft-delete, native backup recovery, existing-object update, recreation, manual handoff and refusal using qualified availability and permissions. Persist mechanism, retained/new ID, deadline, credential mode and proof in plan. Distinguish not-found from lookup-failed; never silently recreate on a failed native lookup. CA/native backup API details are checked against current Microsoft docs and stay manual if credential qualification is absent.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/native-recovery.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Qualified soft restore preserves ID; expired recovery point refuses that mechanism; 403/timeout does not fall back to recreation; unsupported native route is manual; mechanism change invalidates approval.

**Required mutation checks:**

- Fallback to create on lookup error.
- Ignore retention deadline.
- Omit mechanism from plan digest.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/native-recovery.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 65: Track credential and service recovery completion

**Workstream:** WS2. **Depends on:** task-64.

**Files:** `engine/restore/completion.mjs`, `engine/store/schema.sql`, `portal/components/recovery-completion.tsx`; new boundary tests in `engine/roadmap/identity-completion.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Emit owned completion items for unrecoverable secrets, certificates, consent and downstream integration steps. Store metadata and verification evidence only, never secret values. Separate configuration-restored from service-validation-pending and verified-complete. Completion transitions require current authorized actor and linked evidence; reopening remains possible.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/identity-completion.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Recreated application stays pending until required completion evidence exists; duplicate completion is idempotent; revoked actor cannot close item; credential sentinel never appears in snapshot/export/evidence/log fixtures.

**Required mutation checks:**

- Mark recreate fully complete immediately.
- Allow unauthenticated completion.
- Persist supplied secret value.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/identity-completion.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 66: Guard irreversible effects of configuration changes

**Workstream:** WS2. **Depends on:** task-59, task-64.

**Files:** `engine/safety/contentEffects.mjs`, `engine/restore/dryRunArtifact.mjs`, `cli/keel-restore.mjs`; new boundary tests in `engine/roadmap/content-effects.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Annotate retention-reducing, hold-releasing, externally-sharing and irreversible transitions by explicit before/after field rules. Unknown dangerous transition refuses until classified. Require separate current high-impact approval bound to effect-bearing plan and preserve platform Preservation Lock refusals. An inverse setting never claims to recover lost/disclosed content. Existing Conditional Access restrictions remain.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/content-effects.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Shortened retention requires approval; preservation lock cannot be bypassed; changed effect invalidates old approval; benign unchanged setting proceeds; disclosure states content is not backed up.

**Required mutation checks:**

- Classify hold release as cosmetic.
- Reuse approval after effect change.
- Retry around preservation lock.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/content-effects.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 67: Storage retention residency and recovery manifest

**Workstream:** WS10. **Depends on:** task-56, task-45.

**Files:** `engine/storage/adapter.mjs`, `engine/storage/local.mjs`, `engine/storage/recoveryManifest.mjs`, `ops/keel-dump-manifest.mjs`; new boundary tests in `engine/roadmap/storage-contract.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Define adapter operations publish/read/list/verify/retention-status with explicit supported capabilities; implement local disk reference. Manifest links schema/build, SQL dump checksum, included observation IDs, configuration export manifest, evidence checkpoint, tenant pin and separately-held key recovery instructions. Local filesystem permissions do not count as immutable storage. Record residency/provider/credential boundary metadata without embedding credentials.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/storage-contract.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Manifest verifies against actual artifact bytes and included observation IDs; missing key instructions yield incomplete recovery; local adapter reports retention-lock unsupported; foreign tenant or build/schema incompatibility is refused.

**Required mutation checks:**

- Accept mismatched dump checksum.
- Label local permissions immutable.
- Omit tenant pin.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/storage-contract.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 68: Reconstruct Keel read-only from independent artifacts

**Workstream:** WS10. **Depends on:** task-67.

**Files:** `tools/recovery/reconstruct.mjs`, `engine/authz/recoveryMode.mjs`, `ops/recovery-runbook.md`; new boundary tests in `engine/roadmap/keel-recovery.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Build an offline recovery verifier and disposable-database reconstruction workflow. Require explicit independently authenticated recovery identity; start read-only with outbound writes disabled, verify manifest/history before access, and list missing credential prerequisites. Do not alter active services or production DB. Exercise reconstruction using generated test artifacts, including schedules, approvals, grants and evidence.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/keel-recovery.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Empty disposable instance recovers fixture history with writers disabled; modified manifest/head refuses; missing credentials produce named prerequisites; no anonymous recovery bypass; incompatible schema stops before import.

**Required mutation checks:**

- Enable writes during reconstruction.
- Accept tampered manifest.
- Allow anonymous emergency identity.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/keel-recovery.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 69: Qualify independent retention-locked storage

**Workstream:** WS10. **Depends on:** task-67.

**Files:** `engine/storage/s3Compatible.mjs`, `tools/qualification/storageLock.mjs`, `engine/storage/qualification.mjs`; new boundary tests in `engine/roadmap/immutable-storage.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Implement a capability-negotiated S3-compatible reference adapter and deletion-test harness; do not assume every S3-compatible service supports Object Lock. Bind qualification to provider/bucket/mode/retention/credential boundary and canary artifact evidence. No provider purchase or real deletion is run by builder. Missing external qualification remains not-qualified and prevents immutable claims. Include encryption and residency checks with independent recovery material references.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/immutable-storage.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Fake locked provider rejects deletion and reports retention; unsupported backend stays not-qualified; credential unable to alter retention cannot be confused with account-admin credential; retries verify object checksum.

**Required mutation checks:**

- Infer Object Lock from S3 compatibility.
- Mark upload success as immutable proof.
- Skip retention-mode check.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/immutable-storage.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 70: Conflict-aware compensation for failed restores

**Workstream:** WS10. **Depends on:** task-66, task-65.

**Files:** `engine/restore/rollbackJournal.mjs`, `engine/restore/compensation.mjs`, `engine/govern/rollbackPlan.mjs`, `cli/keel-restore.mjs`; new boundary tests in `engine/roadmap/compensation.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Extend inverse-instruction journal with observed pre/post state, per-write uncertain outcome and operation identities; keep governance baseline rollback planner distinct. Build inverse plan by re-reading current state and refusing conflicts with later legitimate changes. Use same impact, capability, artifact approval and verification path as forward restore. Never promise atomic rollback or restoration of erased content.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/compensation.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Lost success response reconciles actual state; partial-wave compensation only undoes matching writes; concurrent admin update is not overwritten; compensation itself needs immutable approval; irrecoverable effects remain explicit.

**Required mutation checks:**

- Apply inverse without current-state comparison.
- Treat lost response as guaranteed failure.
- Bypass normal approval for undo.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/compensation.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 71: Incident-qualified recovery points and retention pins

**Workstream:** WS10. **Depends on:** task-64, task-51.

**Files:** `engine/govern/incidents.mjs`, `engine/store/retention.mjs`, `engine/restore/dryRunArtifact.mjs`, `portal/components/incident-recovery.tsx`; new boundary tests in `engine/roadmap/incident-recovery.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Add investigator-owned compromise intervals, snapshot assessments, malicious-field exclusions and retention pins. Selecting an unsuitable or unassessed incident recovery point requires explicit authorized override with reason or refusal. Bind assessment/version/exclusions to plan and post-restore checks. Retention pins supersede routine prune until authorized release; pin existence is not evidence of clean state.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/incident-recovery.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Most recent compromised snapshot is refused; assessment change invalidates promotion; pinned data survives prune; excluded malicious grant is checked after recovery; cross-tenant assessment cannot qualify a point.

**Required mutation checks:**

- Prefer newest snapshot regardless of assessment.
- Prune incident-pinned data.
- Omit exclusions from fingerprint.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/incident-recovery.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 72: Offline and bounded same-tenant recovery drills

**Workstream:** WS10. **Depends on:** task-68, task-70.

**Files:** `tools/rehearsal/roundTrip.mjs`, `tools/rehearsal/qualification.mjs`, `engine/coverage/recoveryReadiness.mjs`; new boundary tests in `engine/roadmap/drill-harness.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Reuse existing uniquely named disposable-object round trip and test-DB guard. Add offline plan validation and opt-in bounded same-tenant drill manifest with allowlisted objects, tenant pin, elapsed time and cleanup evidence. Builder runs fakes only; default cannot call live writes. Offline validation cannot count as a real recovery drill. No cloned tenant or tenant-wide policy rehearsal.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/drill-harness.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Offline mode makes zero writes; non-disposable target or production DB refuses; failed cleanup is visible; elapsed time comes from observed run; foreign tenant cannot be selected.

**Required mutation checks:**

- Allow non-disposable target.
- Count offline pass as live recovery.
- Suppress failed cleanup.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/drill-harness.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 73: Measured freshness recovery time and resilience portal

**Workstream:** WS10. **Depends on:** task-54, task-67, task-72.

**Files:** `engine/coverage/recoveryMetrics.mjs`, `portal/app/resilience/page.tsx`, `portal/lib/portal-data.ts`; new boundary tests in `engine/roadmap/recovery-metrics.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Compute freshness by successful per-type/relationship observation sets and actual verified offsite manifests; show oldest required dependency age and gaps. Compute observed recovery duration from verified job/drill history separately from configured objectives and collection cadence. No data means unmeasured. Render resilience, incident points, immutable-storage qualification and Keel recovery readiness with evidence links.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/recovery-metrics.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Failed or partial latest collection does not improve RPO; a newer dump lacking a required observation does not advance recoverable point; failed drill never improves RTO; no samples renders unmeasured; scoped authorization holds.

**Required mutation checks:**

- Use configured schedule as achieved RPO.
- Count failed restore as successful timing.
- Hide unmeasured state.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/recovery-metrics.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 74: Least-privilege onboarding prerequisite planner

**Workstream:** WS3. **Depends on:** task-53.

**Files:** `engine/bootstrap/prerequisites.mjs`, `engine/bootstrap/plan.mjs`, `tools/tenant-probe/auth.mjs`; new boundary tests in `engine/roadmap/bootstrap-plan.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Derive requested workload grants from explicit capability requirements, distinguishing Graph permissions, workload RBAC, PIM activation and KEEL app permissions. Inspect preexisting app/SP state through injected read adapters. Produce resumable plan with named manual prerequisites and consent scope; do not promise that one consent can provision every workload or bypass privileged role requirements.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/bootstrap-plan.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Existing correct registration is reused; missing PIM/role/consent remains explicit; purchased SKU cannot substitute for permission; plan requesting unrelated broad grants is rejected; secrets absent from plan.

**Required mutation checks:**

- Treat admin consent as all workload authority.
- Recreate existing app unconditionally.
- Log token in prerequisite report.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/bootstrap-plan.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 75: Resumable Microsoft identity provisioning journal

**Workstream:** WS3. **Depends on:** task-74.

**Files:** `engine/bootstrap/execute.mjs`, `engine/bootstrap/journal.mjs`, `cli/keel-bootstrap.mjs`; new boundary tests in `engine/roadmap/bootstrap-executor.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Execute only an immutable approved provisioning plan using injected qualified identity adapters, separate collector/restorer credential references and least-privilege operations. Journal desired/observed outcomes before retry; partial setup resumes without duplicate SPs or privileges. Revocation/changed prerequisites stop execution. No live provisioning in builder tests; CLI defaults to plan mode.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/bootstrap-executor.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Crash after creation before acknowledgement resumes from observed object; revoked grant refuses next step; collector and restorer identities cannot collapse; pending manual step cannot be reported complete.

**Required mutation checks:**

- Retry creation without journal lookup.
- Proceed after grant revocation.
- Share collector credential for writes.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/bootstrap-executor.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 76: Guided onboarding and named prerequisite resolution

**Workstream:** WS3. **Depends on:** task-75, task-46.

**Files:** `portal/app/setup/page.tsx`, `portal/components/setup-progress.tsx`, `portal/lib/action.ts`; new boundary tests in `engine/roadmap/bootstrap-ui.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Show registration/consent instructions, existing-state reuse, per-workload pending prerequisites and journal progress. Enable first collect only when required read grants are confirmed, never require unrelated write privileges for read-only onboarding. Bind provisioning action to authorized configuration principal and immutable plan. Link initial coverage result including unsupported workloads.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/bootstrap-ui.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Missing prerequisite stops affected action but permits eligible read-only setup; retry resumes journal; read-only principal cannot provision; session expiry retains progress without bypassing auth.

**Required mutation checks:**

- Start collect with missing read grants.
- Authorize setup from read capability alone.
- Convert pending manual step to done.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/bootstrap-ui.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 77: Unified correlated operational and evidence events

**Workstream:** WS12. **Depends on:** task-45.

**Files:** `engine/govern/evidence.mjs`, `engine/telemetry/events.mjs`, `engine/jobs/queue.mjs`, `cli/keel-worker.mjs`; new boundary tests in `engine/roadmap/event-envelope.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Define canonical tenant/event ID/source/time/schema/correlation envelope for existing evidence, job and drift records. Preserve source sequence and observed/event timestamps; redact secrets and cap payload size. Use stable identities on retry and expose structured logs without creating a second competing audit authority. Configurable capture cost metrics reuse job/Graph observations.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/event-envelope.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Same event replay has same ID; different events cannot collide; nested sensitive fields are redacted; job-to-evidence correlation survives retry; source ordering gaps stay visible.

**Required mutation checks:**

- Generate random new ID on replay.
- Leak nested authorization header.
- Collapse distinct source sequences.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/event-envelope.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 78: Externally anchored evidence-chain verification

**Workstream:** WS12. **Depends on:** task-77, task-67.

**Files:** `engine/govern/evidence.mjs`, `engine/govern/anchor.mjs`, `engine/storage/adapter.mjs`; new boundary tests in `engine/roadmap/evidence-anchors.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Publish signed tenant/sequence/head/build checkpoints outside primary DB via independent storage reference and versioned key identity. Verify external trust/key availability explicitly. Distinguish verified, broken-at-sequence, truncated and unanchored. Rotation has an authenticated continuity record; fixture signatures never qualify production trust.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/evidence-anchors.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Tampering records and internal head together is caught by external checkpoint; truncation below checkpoint fails; wrong-tenant/unknown key fails; missing external anchor shows unanchored not verified.

**Required mutation checks:**

- Trust internal head without external comparison.
- Ignore sequence truncation.
- Accept unknown signing key.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/evidence-anchors.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 79: Durable SIEM event outbox and replay checkpoints

**Workstream:** WS12. **Depends on:** task-77.

**Files:** `engine/telemetry/outbox.mjs`, `engine/store/schema.sql`, `cli/keel-worker.mjs`; new boundary tests in `engine/roadmap/export-outbox.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Create per-destination durable outbox keyed by source event and sink with retry/backoff, poison-event quarantine, delivery lag and replay checkpoints. Advance only after acknowledged acceptance; uncertain acknowledgements retain the same event ID. At-least-once transport is explicit; provide receiver deduplication contract instead of claiming exactly-once physical ingestion.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/export-outbox.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Crash after remote acceptance before checkpoint replays same ID; one poison event does not erase following events; revoked destination pauses delivery; restart preserves cursor and lag.

**Required mutation checks:**

- Advance checkpoint before acceptance.
- Assign new event ID on retry.
- Drop poison event silently.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/export-outbox.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 80: Azure Monitor and Sentinel export adapter

**Workstream:** WS12. **Depends on:** task-79.

**Files:** `engine/telemetry/adapters/sentinel.mjs`, `ops/sentinel-schema.json`, `ops/sentinel-dedup.kql`, `tools/qualification/sentinel.mjs`; new boundary tests in `engine/roadmap/sentinel-adapter.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Implement current Logs Ingestion API adapter with configured DCR endpoint/immutable ID/stream, correct token audience and schema mapping. Do not provision Azure resources implicitly. Include KEEL event ID and tenant-specific source identity and a KQL logical dedup view; request ID is diagnostic, not an idempotency guarantee. Return pending prerequisites if workspace/DCR credentials unavailable.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/sentinel-adapter.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Fixture endpoint validates URL/body/audience; throttles and lost acknowledgement replay stable ID; KQL fixture groups duplicates into one logical event; missing DCR yields named pending setup; no tokens in logs.

**Required mutation checks:**

- Assume x-ms-client-request-id guarantees dedup.
- Acknowledge throttled batch.
- Use Graph token audience for ingestion.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/sentinel-adapter.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 81: Generic webhook and CEF export adapters

**Workstream:** WS12. **Depends on:** task-79.

**Files:** `engine/telemetry/adapters/webhook.mjs`, `engine/telemetry/adapters/cef.mjs`, `portal/app/integrations/page.tsx`; new boundary tests in `engine/roadmap/generic-siem.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Add authenticated configured-destination webhook and bounded escaped CEF payload adapters with stable IDs and observable retry. Webhook is reference generic transport; syslog deployments declare whether acknowledgement/delivery guarantees exist. Surface setup, lag, errors, quarantined events and replay under configuration authorization. Prevent destinations supplied by untrusted event payloads.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/generic-siem.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** CEF special characters cannot inject records; event cannot choose a destination; read-only viewer cannot configure/replay; unknown-delivery transport is not reported acknowledged; repeated event keeps ID.

**Required mutation checks:**

- Interpolate unescaped CEF newline.
- Route using payload URL.
- Report unacknowledged syslog delivery successful.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/generic-siem.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 82: Durable alert lifecycle and flapping behavior

**Workstream:** WS7. **Depends on:** task-77.

**Files:** `engine/notify/alerts.mjs`, `engine/store/schema.sql`, `engine/notify/notifications.mjs`; new boundary tests in `engine/roadmap/alert-state.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Add open/acknowledged/resolved/reopened transitions over existing delivery primitives. Correlate by tenant/resource/control/condition identity; acknowledgement records actor/time without resolving condition. Define hysteresis for flapping and immutable transition evidence. Suppressed condition is not silently deleted.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/alert-state.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Repeated drift updates same open alert; resolve then recurrence reopens with history; acknowledging does not resolve; duplicate event is idempotent; out-of-order stale event cannot close new occurrence.

**Required mutation checks:**

- Acknowledge also resolves condition.
- Create new alert on every retry.
- Apply stale resolution to newer occurrence.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/alert-state.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

**Addendum (added by the watcher, 2026-09-19, after 3 build/review rounds each found a different real
gap — this closes the transition/concurrency matrix the original spec under-specified):**

1. **Concurrent alert creation must not crash.** `alert_condition_identity_idx` is a UNIQUE index on
   `(tenant_ref, resource_key, control, condition)`, but the alert-creation path has no conflict
   handling around it — two concurrent `applyConditionEvent` calls for the same identity that both
   observe "no existing alert" will both attempt the INSERT, and the second raises a raw unique-
   violation instead of converging on one alert row. Fix with `SELECT ... FOR UPDATE` on the identity
   before the existence check (serializing concurrent calls), matching the lock pattern already used
   for the update path. Add a test that runs two concurrent `applyConditionEvent` calls for the same
   identity and asserts exactly one alert row results, with no unhandled error from either call.
2. **Reopen must clear the full prior-occurrence state, with an explicit test per field.** The
   existing reopen UPDATE already clears `acknowledged_by`, `acknowledged_at`, AND `resolved_event_id`
   — but only `acknowledged_by`/`acknowledged_at` have a dedicated test. Add a test asserting a
   reopened occurrence's `resolved_event_id` is also `null` (a mutation removing that one clearing
   clause must fail the suite).
3. **`listAlerts` and `listAlertTransitions` must share the same tenant/capability gate.** Add a test
   for each asserting a principal cannot list or read transitions for another tenant's alerts, and
   that the capability check is the same one already enforced elsewhere in this module (do not invent
   a new capability name).
4. **The resolve-hysteresis boundary is exact, not inclusive — lock it in with a test.** With
   `hysteresis.resolveMs = 0`, a resolution observed at the exact same instant as the alert's last
   firing must NOT be treated as a flap (strict `<`, never `<=`, when comparing
   `observation.occurredAt` against `lastFiringAt + resolveMs`). Add a test at exactly this boundary
   (same-instant resolution, `resolveMs: 0`) asserting it is NOT flagged as a flap — this is the
   specific case a `<`→`<=` mutation would otherwise pass unnoticed.

Do not weaken or remove any of the three original "Required mutation checks" while adding these —
all four items above are additional coverage, not a replacement for the original acceptance criteria.

### Task 83: Acknowledgement deadlines escalation and alerts inbox

**Workstream:** WS7. **Depends on:** task-82, task-46.

**Files:** `engine/notify/escalation.mjs`, `portal/app/alerts/page.tsx`, `portal/lib/action.ts`, `cli/keel-worker.mjs`; new boundary tests in `engine/roadmap/alert-escalation.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Use persisted deadlines and existing jobs for re-notification and configured escalation targets. Atomic claim prevents duplicate escalation; re-evaluate current ack/condition before sending. Route via existing channels with assignment fallback explicit. Show owner, deadline, state/history and current cause; authorize ack/resolve independently of mere viewing.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/alert-escalation.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Missed acknowledgement escalates once; ack racing deadline suppresses send; restart preserves overdue deadline; missing recipient is actionable error; read-only principal cannot resolve.

**Required mutation checks:**

- Use process memory for deadline.
- Skip ack recheck before send.
- Allow read-only resolve.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/alert-escalation.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 84: Teams Slack PagerDuty and SMS channel adapters

**Workstream:** WS7. **Depends on:** task-83.

**Files:** `engine/notify/adapters.mjs`, `engine/notify/channels/teams.mjs`, `engine/notify/channels/slack.mjs`, `engine/notify/channels/pagerduty.mjs`, `engine/notify/channels/sms.mjs`; new boundary tests in `engine/roadmap/notification-adapters.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Implement separate adapter contracts and fixture-tested clients for configured Teams/Slack webhook endpoints, PagerDuty Events API and a configured SMS provider. Verify official API contracts at implementation; use no real sends. Secrets are credential references. Cap/redact payloads, use native dedup keys where supported, normalize retry-after and report provider-specific delivery semantics; SMS provider choice stays explicit configuration.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/notification-adapters.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Each adapter has request/response fixtures including throttle, rejection and missing setup; PagerDuty dedup is stable across retry; unsupported endpoint/provider remains unconfigured; no secret appears in evidence.

**Required mutation checks:**

- Ignore retry-after.
- Change incident dedup key on retry.
- Record webhook secret URL in evidence.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/notification-adapters.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 85: Versioned benchmark and custom-control evaluation

**Workstream:** WS5. **Depends on:** task-51, task-53.

**Files:** `engine/benchmarks/registry.mjs`, `engine/benchmarks/evaluate.mjs`, `engine/store/schema.sql`; new boundary tests in `engine/roadmap/benchmark-engine.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Define framework/edition/profile/evaluator version, allowlisted predicates, required observations and licensed-source provenance. Results are pass/fail/unknown/not-applicable/exception with evidence IDs and observation windows. Ship original custom-control fixtures first; never embed CIS text without rights evidence. One control can map to multiple framework references without claiming legal compliance.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/benchmark-engine.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Missing/stale prerequisite yields unknown; edition change is not tenant drift; exception retains failure/evidence; predicate uses semantic fields; future-dated evidence cannot justify current pass.

**Required mutation checks:**

- Treat missing observation as pass.
- Conflate edition changes with tenant drift.
- Erase underlying finding under exception.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/benchmark-engine.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 86: CIS licensing gate Secure Score and framework mappings

**Workstream:** WS5. **Depends on:** task-85.

**Files:** `engine/benchmarks/packs.mjs`, `engine/benchmarks/secureScore.mjs`, `tools/qualification/benchmarkLicense.mjs`; new boundary tests in `engine/roadmap/benchmark-packs.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Implement licensed-pack import validation and rights manifest with edition/profile, redistribution scope and source digest. No CIS content bundled absent adequate permission; add synthetic pack fixtures. Import Microsoft Secure Score through read adapter with timestamp/denominator/provenance rather than conflating external score with KEEL evaluation. Map authored controls to ISO/NIS2 and other references as evidence links, not blanket certification.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/benchmark-packs.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Pack without rights manifest is rejected; version mismatch invalidates cached result; Score missing data is unknown; one control mapped to several frameworks is evaluated once; no external points invented.

**Required mutation checks:**

- Accept unlicensed embedded pack.
- Count one mapped control several times.
- Render missing Secure Score as zero-risk pass.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/benchmark-packs.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 87: Baseline age compliance views and linked findings

**Workstream:** WS5. **Depends on:** task-86, task-54.

**Files:** `portal/app/benchmarks/page.tsx`, `portal/app/baselines/page.tsx`, `engine/govern/baseline.mjs`; new boundary tests in `engine/roadmap/baseline-compliance-ui.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Show capture age, observation scope, changes since capture and versioned re-snapshot action preserving old baseline. Link control findings to semantic drift, backup observation and pending restore plan when they use matching evidence; otherwise display mismatch. Report configured storage residency and qualification without certifying regulatory compliance. Authorized exceptions need owner/reason/expiry.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/baseline-compliance-ui.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Baseline re-snapshot preserves old evidence; age not inferred from last page load; expired exception exposes finding; cosmetic-only change is zero drift; read-only viewer cannot replace baseline.

**Required mutation checks:**

- Overwrite previous baseline on recapture.
- Hide expired exception.
- Manufacture cross-link across mismatched observations.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/baseline-compliance-ui.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 88: Bounded audit and sign-in ingestion with sizing evidence

**Workstream:** WS9. **Depends on:** task-77, task-47.

**Files:** `engine/identity/auditIngest.mjs`, `engine/identity/auditSizing.mjs`, `cli/keel-worker.mjs`; new boundary tests in `engine/roadmap/audit-ingestion.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Add optional read-only audit/sign-in adapter with durable per-source cursor, stable source-event IDs, bounded pagination/time, retention and data minimization. Support references to existing organizational archive instead of mandatory full duplicate ingestion. Record observed volume, cost inputs and lost retention windows; synthetic sizing is labeled synthetic. No unlimited ingestion or automatic tenant permissions.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/audit-ingestion.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Restart and overlapping pages deduplicate source IDs; retention gap is visible; revoked read scope is distinct from empty log; configured work budget terminates large page stream; no secret/token payload persists.

**Required mutation checks:**

- Advance cursor before persistence.
- Silently hide retention gap.
- Remove request budget.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/audit-ingestion.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 89: CMDB-first ownership and explicit shared scope

**Workstream:** WS9. **Depends on:** task-50, task-46.

**Files:** `engine/identity/ownership.mjs`, `engine/identity/adapters/cmdb.mjs`, `engine/store/schema.sql`; new boundary tests in `engine/roadmap/ownership.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Resolve owner/entity through configured CMDB mapping with documented entity-code fallback and explicit SHARED/unknown states. Bind ownership evidence to tenant/resource lineage and freshness. Lookup failure cannot widen to global permissions. Build configurable fixture adapter; do not assume access to employer CMDB. Retain history so a moved resource does not rewrite prior approval evidence.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/ownership.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Creos/Enovos synthetic resources route correctly; ambiguous owner enters SHARED; failed CMDB lookup stays unresolved; reused names do not inherit ownership; expired ownership cannot authorize a write.

**Required mutation checks:**

- Global-allow on CMDB failure.
- Merge ownership by display name.
- Ignore evidence expiry.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/ownership.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 90: Entity-scoped reads and approval eligibility

**Workstream:** WS9. **Depends on:** task-89, task-59.

**Files:** `engine/authz/can.mjs`, `engine/authz/permissions.mjs`, `portal/lib/read.ts`, `portal/lib/portal-data.ts`; new boundary tests in `engine/roadmap/scoped-authorization.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Enforce row-level ownership scope in server readers for every page/API/export/search/count and scoped approval checks. Configuration/principal grants remain distinct from Microsoft workload credentials. Preserve hidden resources in server safety graph; return redacted cross-entity dependency explanation or central approver handoff. No client filtering as authorization and no hidden counts that disclose foreign entities.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/scoped-authorization.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Scoped viewer cannot fetch another entity by ID/search/export/count; allowed dependency causes redacted handoff rather than disappearing; central approver remains explicitly authorized; changes in ownership/grants invalidate pending action.

**Required mutation checks:**

- Filter only client-side.
- Omit hidden dependency from safety graph.
- Use stale ownership for approval.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/scoped-authorization.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 91: Evidence-based change attribution and approver routing

**Workstream:** WS9. **Depends on:** task-88, task-90.

**Files:** `engine/identity/attribution.mjs`, `engine/govern/approvals.mjs`, `portal/components/change-attribution.tsx`; new boundary tests in `engine/roadmap/change-attribution.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Correlate observed field changes with resource/time-qualified Microsoft audit events and optional sign-in context. Classify exact/plausible/unknown; temporal proximity alone cannot be exact. Route approval using current eligible ownership, with explicit central handoff for cross-entity scope. Preserve privacy/minimization and missing-log states.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/change-attribution.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Direct resource/operation evidence supports exact; two nearby actors yield plausible/unknown; missing retention is unknown; changed ownership reroutes or refuses without widening; tenant isolation survives shared actor IDs.

**Required mutation checks:**

- Label nearest sign-in exact.
- Ignore resource identity.
- Route cross-entity approval to first matching entity.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/change-attribution.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 92: Immutable policy activation preview and reconciliation plan UI

**Workstream:** WS4. **Depends on:** task-55, task-91, task-87.

**Files:** `engine/policy/activation.mjs`, `portal/app/policies/page.tsx`, `portal/components/policy-preview.tsx`, `engine/restore/dryRunArtifact.mjs`; new boundary tests in `engine/roadmap/policy-disclosure.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Preview matched resources, closure-expanded impact, current run-as grants, limits, unsupported operations and matching benchmark findings before activating auto-remediation. Freeze activation intent with policy/projection/ownership versions while execution still recomputes current state. Reuse existing reconciliation planner and approved dry-run contract; no separate execution engine.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/policy-disclosure.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Changed policy/grant/ownership invalidates activation; preview displays dependencies over ceiling; queued job is not labeled repaired; unknown impact blocks unsafe activation; execution-time checks remain active.

**Required mutation checks:**

- Trust preview as permanent execution authorization.
- Omit expanded dependencies.
- Report queued remediation as executed.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/policy-disclosure.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 93: Time-bounded approved emergency deviations

**Workstream:** WS4. **Depends on:** task-92.

**Files:** `engine/policy/changeIntent.mjs`, `engine/policy/execute.mjs`, `engine/store/schema.sql`, `portal/components/change-intent.tsx`; new boundary tests in `engine/roadmap/change-intents.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Record immutable approved resource/field before-after intent with owner, approver, window and optional external change ID. Keep drift visible; suppress only automatic reversion of the exact approved transition while window is active. Concurrent unrelated field changes still alert/remediate normally. On expiry, evaluate current state afresh; no blind revert. Tie future ITSM mirroring to same decision.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/change-intents.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Authorized emergency field change stays visible and unreverted in window; other field change still triggers; expiry resumes evaluation; changed transition cannot reuse approval; clock boundaries and revoke are deterministic.

**Required mutation checks:**

- Suppress whole resource instead of scoped field.
- Ignore intent expiry.
- Apply expired inverse without reread.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/change-intents.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 94: Break-glass lifecycle readiness and usage canary

**Workstream:** WS4. **Depends on:** task-91, task-83.

**Files:** `engine/safety/breakGlassReadiness.mjs`, `engine/safety/breakGlassInvariant.mjs`, `portal/app/readiness/page.tsx`; new boundary tests in `engine/roadmap/breakglass-readiness.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Report separate cloud-only identity, phishing-resistant credential evidence, policy exclusions, privileged access path and last validation dimensions. Evaluate supported CA/risk/PIM/app surfaces individually with unknown for unavailable evidence. Add configured rotation/validation reminders and usage alerts from audit evidence; do not rotate credentials or weaken active policies automatically.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/breakglass-readiness.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** CA exclusion alone cannot make readiness pass; unknown credential evidence stays unknown; usage creates correlated alert; stale validation becomes due; unsupported policy surface is visible.

**Required mutation checks:**

- Collapse readiness to CA exclusion boolean.
- Assume absent method means secure.
- Suppress emergency-account usage event.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/breakglass-readiness.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 95: Bounded proposed-policy scenario evaluation

**Workstream:** WS4. **Depends on:** task-60, task-94.

**Files:** `engine/safety/simulationGate.mjs`, `engine/safety/policyScenario.mjs`, `engine/safety/signInPathGate.mjs`, `tools/qualification/conditionalAccess.mjs`; new boundary tests in `engine/roadmap/policy-simulation.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Implement explicitly supported local predicate subset for proposed combined policy set with scoped scenario generation, matrix coverage and budget. Keep existing production gates. Microsoft What If is a separate live-policy read evaluation, not proof of proposed combined state. Unsupported conditions and untested scenarios remain unknown; never assert universal lockout safety. No live CA changes in tasks.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/policy-simulation.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Combined fixture policies expose lockout missing from isolated diff; unsupported session condition yields unknown; budget truncation is visible; passing sample is labeled sampled; existing sign-in path gate cannot be bypassed.

**Required mutation checks:**

- Evaluate each policy independently only.
- Turn unsupported predicate into allow.
- Treat live What If as proposed-state proof.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/policy-simulation.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 96: Canonical approval mirror and adapter contract

**Workstream:** WS8. **Depends on:** task-93, task-90.

**Files:** `engine/itsm/bridge.mjs`, `engine/itsm/outbox.mjs`, `engine/govern/approvals.mjs`; new boundary tests in `engine/roadmap/itsm-contract.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Define one canonical KEEL decision with external record mapping, plan digest, approver identity, version and immutable event ID. Durable outbox/inbox handles duplicate, reordered and lost callbacks. External status alone does not grant authority; current eligible approver and unchanged plan are required. Conflict between simultaneous decisions is deterministic and evidenced.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/itsm-contract.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Portal and external approvals yield one decision/action; delayed callback cannot approve newer plan; duplicate callback idempotent; external user without current grant refuses; conflicting decisions remain visible.

**Required mutation checks:**

- Authorize from external approved string alone.
- Duplicate action on callback retry.
- Approve changed plan version.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/itsm-contract.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

### Task 97: ServiceNow configurable workflow adapter

**Workstream:** WS8. **Depends on:** task-96.

**Files:** `engine/itsm/adapters/servicenow.mjs`, `tools/qualification/servicenow.mjs`, `portal/app/integrations/page.tsx`; new boundary tests in `engine/roadmap/servicenow.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Implement adapter with explicit configurable table/record/state/identity mappings; verify current official contracts when building. Include fixture for non-default workflow, authenticated callbacks or authenticated polling with replay defense, and reconciliation after lost delivery. Keep instance credentials referenced only. D6 remains pending until test-instance evidence exists; do not assume employer instance access.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/servicenow.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Non-default workflow maps to same canonical approval; lost callback is reconciled once; forged/replayed event cannot widen authority; missing mapping disables adapter visibly; failed external update does not roll back canonical decision silently.

**Required mutation checks:**

- Hardcode default change-request states.
- Accept unsigned unauthenticated callback.
- Lose pending mirror after network error.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/servicenow.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 98: Decision-focused semantic drift and cross-linked reports

**Workstream:** WS6. **Depends on:** task-87, task-91, task-59.

**Files:** `portal/app/drift/page.tsx`, `portal/components/semantic-diff.tsx`, `portal/components/decision-workbook.tsx`; new boundary tests in `engine/roadmap/visual-drift.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Render accessible field-level before/after differences grouped by impact with ownership and attribution confidence. Link exact observation, backup, compliance finding, approval, restore plan and outcome; display evidence mismatches explicitly. Use capped tables, meaningful empty states and keyboard navigation. Read-only safe display; do not expose hidden entity fields in HTML or client payloads.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/visual-drift.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Actual behavioral changes are highlighted while cosmetic fields are absent; unknown before state is not shown as deletion; hidden entity omitted server-side; keyboard and narrow-screen fixtures remain usable; counts reconcile.

**Required mutation checks:**

- Show raw full-object diff.
- Include hidden entity in serialized props.
- Render unknown before as absent.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/visual-drift.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 99: Bounded grounded tenant query and cited answers

**Workstream:** WS6. **Depends on:** task-98, task-90.

**Files:** `engine/query/intent.mjs`, `engine/query/execute.mjs`, `portal/app/ask/page.tsx`; new boundary tests in `engine/roadmap/grounded-query.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Translate a fixed initial set of intents (changes by entity/time/type, coverage, failed jobs) to validated read-only query plans with parameterized filters, row/time budgets and current scope. Natural-language model adapter is optional; it cannot execute SQL/tools or invent values. Treat retrieved text as data, answer only from returned records with citations and windows; unsupported question or missing history returns unknown.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/grounded-query.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Sales-this-week fixture returns only authorized matching records with source links; prompt injection in resource description cannot change scope/query; unbounded query refuses; no history is stated explicitly; writes are impossible.

**Required mutation checks:**

- Execute model-supplied SQL.
- Omit server ownership filter.
- Answer missing history as no changes.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/grounded-query.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 100: Verified outcome and executive value reporting

**Workstream:** WS6. **Depends on:** task-73, task-98.

**Files:** `engine/reports/value.mjs`, `portal/app/reports/page.tsx`; new boundary tests in `engine/roadmap/value-reports.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Count distinct verified remediation outcomes, resolved control findings and measured recovery metrics from canonical event IDs. Separate attempted/queued/failed/verified and avoid duplicate retries. Hours saved requires an explicitly configured estimate with assumptions displayed; otherwise omit it. Provide time/entity scope and export provenance with capped readable tables, without regulatory-compliance claims.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/value-reports.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Retry events counted once; failed/queued jobs never inflate verified outcomes; reopened violation not permanently closed; no time-saving assumption produces no invented hours; totals and percentages remain consistent.

**Required mutation checks:**

- Count enqueue as verified repair.
- Count retry as new outcome.
- Invent fixed hours per event.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/value-reports.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 101: Qualify workload configuration APIs and permissions

**Workstream:** WS2. **Depends on:** task-66, task-53.

**Files:** `tools/qualification/workloads.mjs`, `engine/collect/workloadContract.mjs`, `ops/powershell/probe-workloads.ps1`; new boundary tests in `engine/roadmap/workload-contract.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Create configuration-only workload descriptor and qualification harness recording operation/endpoint or cmdlet, version, app/delegated support, RBAC, paging, throttle and consistency evidence. Separate SharePoint site settings, Teams settings/membership, Exchange mailbox settings, OneDrive site-level settings and Purview label definitions/publication; no file/message content, per-item labels or per-file permissions. Current official docs and optional explicitly supplied read-only captures feed the ledger. Unsupported/unproven operations stay disabled.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/workload-contract.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Descriptor requesting content endpoint fails scope validator; fixture proof is not live qualification; missing workload RBAC gives named pending prerequisite; version drift invalidates operation evidence.

**Required mutation checks:**

- Allow content endpoint under container name.
- Mark synthetic probe live-qualified.
- Reuse proof after API version change.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/workload-contract.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

### Task 102: SharePoint site configuration read adapter

**Workstream:** WS2. **Depends on:** task-101.

**Files:** `engine/collect/workloads/sharepoint.mjs`, `engine/collect/registry.mjs`, `engine/coverage/report.mjs`; new boundary tests in `engine/roadmap/sharepoint-read.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Implement first workload read adapter for explicitly supported site sharing/configuration fields and site-level permission metadata, using qualified Graph or workload-specific interface only. Bound discovery and paging, preserve source authority/coverage per field and separate site from file permissions. Live activation requires matching qualification evidence; fixture-tested implementation can ship disabled.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/sharepoint-read.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Site settings with multiple pages persist consistent observations; permission failure is partial coverage; fixture asserts zero file/message endpoints; unsupported field stays unknown; tenant scope cannot change from site URL.

**Required mutation checks:**

- Crawl files to infer coverage.
- Label partial field read complete.
- Trust arbitrary site URL tenant.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/sharepoint-read.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs
```

### Task 103: Qualified SharePoint configuration restore

**Workstream:** WS2. **Depends on:** task-102, task-61, task-66.

**Files:** `engine/restore/workloads/sharepoint.mjs`, `engine/coverage/qualification.mjs`, `engine/restore/wavePlanner.mjs`; new boundary tests in `engine/roadmap/sharepoint-write.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Implement only operation-specific supported site-setting writes with server-owned/sensitive projection, immutable plan and content-effect approval. Wire through existing worker/restore path. Unsupported settings remain manual; missing live workload qualification keeps activation disabled. Never create content recovery claims or bypass Preservation Lock.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/sharepoint-write.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Fixture setting restore re-reads and verifies; high-impact sharing/retention changes need exact approval; unqualified operation does zero writes; later concurrent site update invalidates promotion.

**Required mutation checks:**

- Enable adapter solely on fixture pass.
- Bypass content-effect approval.
- Overwrite concurrent site configuration.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/sharepoint-write.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 104: Teams configuration and structural membership adapter

**Workstream:** WS2. **Depends on:** task-103, task-120.

**Files:** `engine/collect/workloads/teams.mjs`, `engine/restore/workloads/teams.mjs`, `engine/coverage/qualification.mjs`; new boundary tests in `engine/roadmap/teams-config.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Apply workload contract to Teams settings and membership structure with separate group/Teams observations, operations and proof. Implement fixture-tested read plus supported write handlers through existing safety path; messages/files remain excluded. Gate activation on SharePoint qualification and Teams-specific evidence; a SharePoint fixture pass alone is insufficient.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/teams-config.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Team setting and member changes have separate outcomes; no message endpoints called; missing Teams qualification disables writes; relationship retry and verification preserve tenant identity.

**Required mutation checks:**

- Count Teams messages as configuration.
- Inherit SharePoint proof as Teams qualification.
- Conflate group and Teams membership completeness.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/teams-config.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 105: Exchange mailbox configuration adapter

**Workstream:** WS2. **Depends on:** task-104, task-121.

**Files:** `engine/collect/workloads/exchange.mjs`, `engine/restore/workloads/exchange.mjs`, `engine/powershell/jobQueue.mjs`; new boundary tests in `engine/roadmap/exchange-config.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Use explicit approved Exchange configuration cmdlets or qualified APIs with app-only/workload role evidence and bounded PowerShell argument transport. Implement mailbox settings and supported organization configuration as distinct operation records; exclude messages/content. No command string interpolation. Respect holds/retention/source authority; fixture code ships disabled until preceding workload and Exchange qualification are recorded.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/exchange-config.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Quoted hostile mailbox identifier remains one argument; unknown RBAC blocks writes; no content enumeration; output errors persist structured; hold-releasing operation refuses without qualified approval.

**Required mutation checks:**

- Interpolate mailbox identity into script source.
- Treat cmdlet exit error as empty success.
- Bypass hold effect guard.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/exchange-config.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 106: OneDrive container settings and Purview label configuration

**Workstream:** WS2. **Depends on:** task-105, task-122.

**Files:** `engine/collect/workloads/onedrive.mjs`, `engine/collect/workloads/purview.mjs`, `engine/restore/workloads/purview.mjs`; new boundary tests in `engine/roadmap/onedrive-purview.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Register OneDrive site-level sharing/configuration and Purview label definitions/publishing as explicit qualified configuration families. Reuse SharePoint mechanisms only where API/RBAC proof matches; record inheritance versus actual readable state. Item-applied labels, per-file permissions and content are excluded. Unknown or locked write remains manual/refused and runtime activation requires family-specific proof.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/onedrive-purview.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Label definition change is tracked without reading labeled content; inherited setting distinguished from explicit value; preservation lock refuses; no per-item crawl; proof for another family cannot enable writes.

**Required mutation checks:**

- Enumerate files for label inventory.
- Ignore inherited versus explicit state.
- Reuse unrelated workload qualification.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/onedrive-purview.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 107: Measured Entra operation expansion batches

**Workstream:** WS2. **Depends on:** task-63, task-66.

**Files:** `engine/coverage/qualification.mjs`, `engine/restore/applyEngine.mjs`, `engine/reconcile/writableProjection.mjs`, `tools/qualification/operations.mjs`; new boundary tests in `engine/roadmap/fidelity-expansion.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Inventory remaining Entra families into identity/application, policy, and administrative/configuration batches. In this task implement a batch runner and evidence report, and qualify only a first bounded application/service-principal operation subset supported by official APIs and existing safety contracts. Every remaining type gets an explicit unsupported/manual/research-needed entry with API/permission reason rather than a promise of universal restore. Subsequent task families below implement separate bounded groups. Preserve credential completion semantics.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/fidelity-expansion.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Subset operation proofs exercise actual writer and verification path; unsupported sibling verb remains disabled; new object ID remaps explicit supported references; all catalog types accounted for without widening fidelity labels blindly.

**Required mutation checks:**

- Enable all verbs for qualified type.
- Omit irrecoverable credential steps.
- Mark research-needed family fully restorable.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/fidelity-expansion.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 108: Bounded policy configuration restore qualification

**Workstream:** WS2. **Depends on:** task-107.

**Files:** `engine/restore/policyOperations.mjs`, `engine/coverage/qualification.mjs`, `engine/reconcile/writableProjection.mjs`; new boundary tests in `engine/roadmap/policy-fidelity.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Qualify supported authentication-strength and named policy configuration operations against official API/credential/field contracts, starting with at most three operation records. Preserve immutable system policies, unknown/sensitive fields and current CA restrictions. Add only proven fixture handlers and explicit live qualification gate; unsupported policy subtypes remain manual. Record the remaining policy family ledger.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/policy-fidelity.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Built-in immutable policy refuses; supported configurable subset survives full restore verification; changing subtype/projection invalidates proof; unknown policy fields are not PATCHed.

**Required mutation checks:**

- PATCH immutable built-in policy.
- Reuse proof across subtype.
- Forward unknown fields into writer.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/policy-fidelity.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 109: Bounded administrative configuration restore qualification

**Workstream:** WS2. **Depends on:** task-108.

**Files:** `engine/restore/administrativeOperations.mjs`, `engine/coverage/qualification.mjs`, `engine/reconcile/writableProjection.mjs`; new boundary tests in `engine/roadmap/administrative-fidelity.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Qualify supported administrative-unit and group-setting operation subsets with parent/dependency/source-authority checks. Start with at most three explicit operation records, keep global templates and synced objects nonwritable, and retain manual entries for unsupported remainder. Evidence reports include what configuration and relationships cannot be recovered, not a total coverage percentage.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/administrative-fidelity.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Global template and synced object refuse; qualified administrative operation verifies post-state and dependencies; unsupported relationship remains explicit; partial collection cannot authorize delete.

**Required mutation checks:**

- Write global reference template.
- Skip source-authority guard.
- Delete from partial observation.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/administrative-fidelity.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 110: Measured schedule load warnings

**Workstream:** WS1. **Depends on:** task-49, task-77, task-43, task-44.

**Files:** `engine/schedules/forecast.mjs`, `portal/app/schedules/page.tsx`, `engine/telemetry/events.mjs`; new boundary tests in `engine/roadmap/schedule-forecast.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Aggregate actual request/throttle/duration observations by kind/tier/workload and propose bounded cadence warnings with confidence/sample window. Forecast is advisory estimate, never a guarantee against Graph throttling. Insufficient samples remain unknown; interval floor and runtime governor still enforce independently. Include business-hour timezone presentation without changing UTC scheduling semantics.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/schedule-forecast.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Tier-scoped request counts determine forecast; no samples yields unknown; throttle-heavy history warns; advisory override cannot bypass minimum cadence floor or current authorization.

**Required mutation checks:**

- Use resource count as request count.
- Invent estimate without samples.
- Disable runtime floor after accepting warning.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/schedule-forecast.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 111: Deferred hybrid topology contract and cloud refusal rules

**Workstream:** WS11. **Depends on:** task-52, task-90.

**Files:** `engine/contracts/topology.mjs`, `engine/safety/syncedObjectGuard.mjs`, `docs/contracts/hybrid-topology.md`; new boundary tests in `engine/roadmap/hybrid-contract.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Define versioned outbound-poll message schema for future adapter identity, tenant pin, capability evidence, source authority, operation intents and result provenance. Implement schema validation and cloud-side refusal tests only; no agent executable, polling service or on-prem connection. Hybrid-authoritative objects remain refused for unsupported cloud writes. State explicitly that agent runtime is deferred.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/hybrid-contract.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Cross-tenant or unsupported topology intent rejects; replayed command identity cannot qualify new action; synced-object cloud refusal remains; artifact inventory contains no on-prem runtime entrypoint.

**Required mutation checks:**

- Accept foreign tenant in topology message.
- Allow cloud write to synced object.
- Declare unimplemented hybrid runtime available.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/hybrid-contract.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

### Task 112: Six end-to-end journeys and release qualification ledger

**Workstream:** Release. **Depends on:** task-76, task-73, task-71, task-65, task-78, task-80, task-81, task-84, task-95, task-97, task-99, task-100, task-106, task-109, task-110, task-111.

**Files:** `tools/release/journeys.mjs`, `tools/release/qualification.mjs`, `docs/release/acceptance.md`; new boundary tests in `engine/roadmap/acceptance-harness.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Exercise J1 onboarding with missing prerequisites; J2 collection/drift/compliance/investigation; J3 approved emergency deviation; J4 malicious-change recovery; J5 partial restore plus human completion; J6 Keel reconstruction. Use local fakes and isolated DB, include public route/worker boundaries, crash/retry/revocation and evidence links. Produce release ledger with separate fixture results and externally supplied live acceptance records. Every D1-D10 and G1-G8 objective maps to owner/test/evidence or explicit qualification gap.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/acceptance-harness.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Each journey validates terminal user-visible outcome and cannot pass on queued-only events; unknown external prerequisites keep readiness pending; evidence ancestry is consistent; one failed critical gate prevents ready label without blocking independent development.

**Required mutation checks:**

- Mark release ready with unknown qualification.
- Treat queued action as verified outcome.
- Ignore missing cross-workstream evidence link.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/acceptance-harness.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 113: Authenticated deployed release acceptance

**Workstream:** Foundation. **Depends on:** task-46, task-54, task-44.

**External admission gate:** A deployed candidate build matching the source manifest and an authenticated operator probe session. This task is held in the queue until that evidence exists.

**Files:** `tools/release/qualification.mjs`, `docs/release/qualifications/deployed-acceptance.json`; new boundary tests in `engine/roadmap/deployed-acceptance.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Run read-only authenticated page/API probes against the deployed candidate: coverage matrix, collection history, schedules, and restore review API contracts. Record exact build and authorization behavior; do not execute restore or redeploy services. Missing identity/build evidence remains pending. Add a verifier for the imported runner evidence and its source/build/tenant/operation identity. Do not generate successful production evidence from fixtures.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/deployed-acceptance.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Valid independently captured record verifies; altered signature/digest, wrong tenant/build/operation, stale evidence and missing prerequisite fail. Fixture mutation tests run locally; final validation also requires the actual evidence file.

**Required mutation checks:**

- Accept missing external evidence.
- Accept mismatched tenant or operation.
- Elevate fixture evidence to live-qualified.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/deployed-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && node tools/release/qualification.mjs verify --require-live --gate deployed-acceptance --evidence docs/release/qualifications/deployed-acceptance.json
```

### Task 114: Independent storage retention and recovery qualification

**Workstream:** WS10. **Depends on:** task-69, task-68.

**External admission gate:** A selected configured backend, independent recovery identity and a disposable retention-lock canary artifact. This task is held in the queue until that evidence exists.

**Files:** `tools/release/qualification.mjs`, `docs/release/qualifications/storage-live-acceptance.json`; new boundary tests in `engine/roadmap/storage-live-acceptance.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Import evidence from the bounded storage qualification runner showing canary deletion refusal under compromised-writer credentials, independent recovery read and manifest verification. Never delete ordinary backups. Check retention period/mode and actual identity separation; unsupported provider remains refused. Add a verifier for the imported runner evidence and its source/build/tenant/operation identity. Do not generate successful production evidence from fixtures.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/storage-live-acceptance.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Valid independently captured record verifies; altered signature/digest, wrong tenant/build/operation, stale evidence and missing prerequisite fail. Fixture mutation tests run locally; final validation also requires the actual evidence file.

**Required mutation checks:**

- Accept missing external evidence.
- Accept mismatched tenant or operation.
- Elevate fixture evidence to live-qualified.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/storage-live-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && node tools/release/qualification.mjs verify --require-live --gate storage-live-acceptance --evidence docs/release/qualifications/storage-live-acceptance.json
```

### Task 115: Native recovery credential qualification

**Workstream:** WS2. **Depends on:** task-64.

**External admission gate:** A named disposable native-recovery object, credential mode and bounded test evidence; CA remains manual until its app-only route is qualified. This task is held in the queue until that evidence exists.

**Files:** `tools/release/qualification.mjs`, `docs/release/qualifications/native-live-acceptance.json`; new boundary tests in `engine/roadmap/native-live-acceptance.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Validate actual native soft-delete/backup route evidence per supported operation against current Microsoft contract, preserving object ID result and retention deadline. An unavailable route records manual handoff, not successful automated support. Builder consumes evidence, not live writes. Add a verifier for the imported runner evidence and its source/build/tenant/operation identity. Do not generate successful production evidence from fixtures.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/native-live-acceptance.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Valid independently captured record verifies; altered signature/digest, wrong tenant/build/operation, stale evidence and missing prerequisite fail. Fixture mutation tests run locally; final validation also requires the actual evidence file.

**Required mutation checks:**

- Accept missing external evidence.
- Accept mismatched tenant or operation.
- Elevate fixture evidence to live-qualified.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/native-live-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs && node tools/release/qualification.mjs verify --require-live --gate native-live-acceptance --evidence docs/release/qualifications/native-live-acceptance.json
```

### Task 116: Bounded same-tenant drill and Keel recovery acceptance

**Workstream:** WS10. **Depends on:** task-72, task-76.

**External admission gate:** A named disposable same-tenant test object and independently captured execution/cleanup evidence. This task is held in the queue until that evidence exists.

**Files:** `tools/release/qualification.mjs`, `docs/release/qualifications/drill-live-acceptance.json`; new boundary tests in `engine/roadmap/drill-live-acceptance.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Verify bounded round-trip elapsed time, post-state and cleanup, plus read-only Keel reconstruction from independent artifacts. Scope must exclude active users and tenant-wide policies. Offline-only result cannot satisfy the live drill criterion. Add a verifier for the imported runner evidence and its source/build/tenant/operation identity. Do not generate successful production evidence from fixtures.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/drill-live-acceptance.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Valid independently captured record verifies; altered signature/digest, wrong tenant/build/operation, stale evidence and missing prerequisite fail. Fixture mutation tests run locally; final validation also requires the actual evidence file.

**Required mutation checks:**

- Accept missing external evidence.
- Accept mismatched tenant or operation.
- Elevate fixture evidence to live-qualified.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/drill-live-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && node tools/release/qualification.mjs verify --require-live --gate drill-live-acceptance --evidence docs/release/qualifications/drill-live-acceptance.json
```

### Task 117: Sentinel workspace ingestion qualification

**Workstream:** WS12. **Depends on:** task-80.

**External admission gate:** Configured test Log Analytics workspace, DCR/stream, identity and receiver query evidence. This task is held in the queue until that evidence exists.

**Files:** `tools/release/qualification.mjs`, `docs/release/qualifications/sentinel-live-acceptance.json`; new boundary tests in `engine/roadmap/sentinel-live-acceptance.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Validate event delivery and restart/replay against test workspace; prove logical dedup by stable event ID and query, do not claim unique physical rows or unproven exactly-once ingestion. Preserve actual delay/errors and absence of missing events. Add a verifier for the imported runner evidence and its source/build/tenant/operation identity. Do not generate successful production evidence from fixtures.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/sentinel-live-acceptance.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Valid independently captured record verifies; altered signature/digest, wrong tenant/build/operation, stale evidence and missing prerequisite fail. Fixture mutation tests run locally; final validation also requires the actual evidence file.

**Required mutation checks:**

- Accept missing external evidence.
- Accept mismatched tenant or operation.
- Elevate fixture evidence to live-qualified.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/sentinel-live-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && node tools/release/qualification.mjs verify --require-live --gate sentinel-live-acceptance --evidence docs/release/qualifications/sentinel-live-acceptance.json
```

### Task 118: ServiceNow non-default workflow qualification

**Workstream:** WS8. **Depends on:** task-97.

**External admission gate:** Configured nonproduction ServiceNow instance and mapped test users/workflow with current authorization evidence. This task is held in the queue until that evidence exists.

**Files:** `tools/release/qualification.mjs`, `docs/release/qualifications/servicenow-live-acceptance.json`; new boundary tests in `engine/roadmap/servicenow-live-acceptance.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Validate one non-default approval workflow in both directions including lost callback, duplicate callback, conflict and revoked approver. Evidence must show one canonical KEEL action. No real organizational request/message is sent by builder. Add a verifier for the imported runner evidence and its source/build/tenant/operation identity. Do not generate successful production evidence from fixtures.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/servicenow-live-acceptance.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Valid independently captured record verifies; altered signature/digest, wrong tenant/build/operation, stale evidence and missing prerequisite fail. Fixture mutation tests run locally; final validation also requires the actual evidence file.

**Required mutation checks:**

- Accept missing external evidence.
- Accept mismatched tenant or operation.
- Elevate fixture evidence to live-qualified.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/servicenow-live-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && node tools/release/qualification.mjs verify --require-live --gate servicenow-live-acceptance --evidence docs/release/qualifications/servicenow-live-acceptance.json
```

### Task 119: NIST SP 800-53 benchmark pack qualification

**Workstream:** WS5. **Depends on:** task-86.

**Addendum (added by the watcher, 2026-09-24, per operator direction — "let's start with NIST then, it's free"):** this task originally targeted CIS Benchmark content, which requires a paid CIS SecureSuite membership to bundle/automate commercially. Retargeted to NIST SP 800-53 Rev 5.2.0: a U.S. Government work product, public domain under 17 U.S.C. § 105, requiring no purchase, membership, or redistribution-rights artifact at all. The genuine, officially-retrieved catalog is pinned at `docs/roadmap/benchmark-content/nist-sp800-53-rev5-pin.json` (version, source URL, retrieval timestamp, sha256 of the full OSCAL catalog, which is kept outside git at the `localPath` it names — 10.4MB, mechanically re-derivable, verify via the pinned sha256 rather than re-fetching blind). Because NIST content needs no rights manifest, this task's external admission gate is satisfied by that pin alone — no separate license artifact is coming or needed. `engine/benchmarks/packs.mjs` (task-86) still validates a rights manifest generically for any FUTURE proprietary pack (e.g. if CIS is added later); for this task, the pack's rights manifest should simply assert `licensing.status: "public-domain"` sourced from the pin file, which the generic validator must accept as satisfying "permitted distribution scope" without requiring a purchased-rights record.

**Second addendum (2026-09-24):** operator asked for further open-source benchmark research beyond NIST. Found and pinned CISA's ScubaGear as a second, even better-fitting free source — see the new Task 126 below rather than widening this task's already-queued scope.

**Files:** `tools/release/qualification.mjs`, `docs/release/qualifications/nist-benchmark-acceptance.json`, `docs/roadmap/benchmark-content/nist-sp800-53-rev5-pin.json` (already present); new boundary tests in `engine/roadmap/nist-benchmark-acceptance.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD, including the existing pin file at `docs/roadmap/benchmark-content/nist-sp800-53-rev5-pin.json` and the full catalog at the `localPath` it names; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Validate the rights manifest (public-domain status read from the pin, not a purchased license) and permitted distribution scope against the pinned source artifact (verify its sha256 against the pin before trusting it), then import a representative profile of NIST SP 800-53 Rev 5 controls (e.g. the AC, IA, AU and CM families, the ones most relevant to an M365/Entra configuration-governance product) and run expected control fixtures. Map KEEL's own authored checks to specific NIST control IDs as evidence links, not a blanket compliance certification. Add a verifier for the imported runner evidence and its source/build/tenant/operation identity. Do not generate successful production evidence from fixtures.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/nist-benchmark-acceptance.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Valid independently captured record verifies; altered signature/digest, wrong tenant/build/operation, stale evidence and missing prerequisite fail; the pin's sha256 is checked against the actual catalog bytes before any control is imported. Fixture mutation tests run locally; final validation also requires the actual evidence file.

**Required mutation checks:**

- Accept missing external evidence.
- Accept mismatched tenant or operation.
- Elevate fixture evidence to live-qualified.
- Import catalog content without checking its sha256 against the pin (a corrupted or substituted catalog would otherwise pass silently).

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/nist-benchmark-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && node tools/release/qualification.mjs verify --require-live --gate nist-benchmark-acceptance --evidence docs/release/qualifications/nist-benchmark-acceptance.json
```

### Task 120: SharePoint configuration workload qualification

**Workstream:** WS2. **Depends on:** task-103.

**External admission gate:** A disposable SharePoint site and workload-specific read/write qualification evidence. This task is held in the queue until that evidence exists.

**Files:** `tools/release/qualification.mjs`, `docs/release/qualifications/sharepoint-live-acceptance.json`; new boundary tests in `engine/roadmap/sharepoint-live-acceptance.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Verify site-settings API/cmdlet, app credential/RBAC, throttle behavior, supported fields, source authority and guarded restore post-state with zero content calls. This is the first workload prerequisite; update only its qualified operation records. Add a verifier for the imported runner evidence and its source/build/tenant/operation identity. Do not generate successful production evidence from fixtures.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/sharepoint-live-acceptance.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Valid independently captured record verifies; altered signature/digest, wrong tenant/build/operation, stale evidence and missing prerequisite fail. Fixture mutation tests run locally; final validation also requires the actual evidence file.

**Required mutation checks:**

- Accept missing external evidence.
- Accept mismatched tenant or operation.
- Elevate fixture evidence to live-qualified.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/sharepoint-live-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs && node tools/release/qualification.mjs verify --require-live --gate sharepoint-live-acceptance --evidence docs/release/qualifications/sharepoint-live-acceptance.json
```

### Task 121: Teams configuration workload qualification

**Workstream:** WS2. **Depends on:** task-104, task-120.

**External admission gate:** A disposable Team and membership fixture plus Teams-specific qualification evidence. This task is held in the queue until that evidence exists.

**Files:** `tools/release/qualification.mjs`, `docs/release/qualifications/teams-live-acceptance.json`; new boundary tests in `engine/roadmap/teams-live-acceptance.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Validate separate settings and structural membership operations, app permissions, paging/retry and post-state; prove no message/file content access. Cannot reuse SharePoint live proof as Teams proof. Add a verifier for the imported runner evidence and its source/build/tenant/operation identity. Do not generate successful production evidence from fixtures.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/teams-live-acceptance.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Valid independently captured record verifies; altered signature/digest, wrong tenant/build/operation, stale evidence and missing prerequisite fail. Fixture mutation tests run locally; final validation also requires the actual evidence file.

**Required mutation checks:**

- Accept missing external evidence.
- Accept mismatched tenant or operation.
- Elevate fixture evidence to live-qualified.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/teams-live-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs && node tools/release/qualification.mjs verify --require-live --gate teams-live-acceptance --evidence docs/release/qualifications/teams-live-acceptance.json
```

### Task 122: Exchange configuration workload qualification

**Workstream:** WS2. **Depends on:** task-105, task-121.

**External admission gate:** A disposable mailbox configuration fixture and qualified Exchange app/RBAC context. This task is held in the queue until that evidence exists.

**Files:** `tools/release/qualification.mjs`, `docs/release/qualifications/exchange-live-acceptance.json`; new boundary tests in `engine/roadmap/exchange-live-acceptance.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Validate supported mailbox configuration operations and argument-safe workload execution with zero message content access. Keep unsupported held/locked fields refused and preserve platform errors. Add a verifier for the imported runner evidence and its source/build/tenant/operation identity. Do not generate successful production evidence from fixtures.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/exchange-live-acceptance.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Valid independently captured record verifies; altered signature/digest, wrong tenant/build/operation, stale evidence and missing prerequisite fail. Fixture mutation tests run locally; final validation also requires the actual evidence file.

**Required mutation checks:**

- Accept missing external evidence.
- Accept mismatched tenant or operation.
- Elevate fixture evidence to live-qualified.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/exchange-live-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs && node tools/release/qualification.mjs verify --require-live --gate exchange-live-acceptance --evidence docs/release/qualifications/exchange-live-acceptance.json
```

### Task 123: OneDrive and Purview configuration qualification

**Workstream:** WS2. **Depends on:** task-106, task-122.

**External admission gate:** Disposable site/configuration-label fixtures and family-specific privilege/effect evidence. This task is held in the queue until that evidence exists.

**Files:** `tools/release/qualification.mjs`, `docs/release/qualifications/onedrive-purview-live-acceptance.json`; new boundary tests in `engine/roadmap/onedrive-purview-live-acceptance.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Verify only site settings and label-definition/publication operations; no item labels, file permissions or content crawl. Preservation Lock and irreversible-effect refusals must be observed, not overridden. Add a verifier for the imported runner evidence and its source/build/tenant/operation identity. Do not generate successful production evidence from fixtures.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/onedrive-purview-live-acceptance.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Valid independently captured record verifies; altered signature/digest, wrong tenant/build/operation, stale evidence and missing prerequisite fail. Fixture mutation tests run locally; final validation also requires the actual evidence file.

**Required mutation checks:**

- Accept missing external evidence.
- Accept mismatched tenant or operation.
- Elevate fixture evidence to live-qualified.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/onedrive-purview-live-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs engine/coverage/*.test.mjs engine/cir/*.test.mjs && node tools/release/qualification.mjs verify --require-live --gate onedrive-purview-live-acceptance --evidence docs/release/qualifications/onedrive-purview-live-acceptance.json
```

### Task 124: Verify complete roadmap release without overclaiming readiness

**Workstream:** Release. **Depends on:** task-112, task-113, task-114, task-115, task-116, task-117, task-118, task-119, task-120, task-121, task-122, task-123.

**Files:** `tools/release/readiness.mjs`, `docs/release/final-acceptance.json`; new boundary tests in `engine/roadmap/release-signoff.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Generate source/deployed readiness comparison and final J1-J6 acceptance matrix from verified evidence and task deliverables. Report implemented, live-qualified, unsupported/manual and deferred separately for every objective. Every enabled write requires current relevant operation proof; global template and on-prem runtime remain excluded. Do not deploy or enable integrations automatically.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/release-signoff.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Final report refuses ready if required external proof absent or conflicting; manual unsupported routes are visible and not mislabeled automated; deferred hybrid runtime does not count as shipped; evidence links resolve.

**Required mutation checks:**

- Ignore missing external qualification.
- Count manual handoff as automated recovery.
- Label deferred runtime shipped.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/release-signoff.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && (cd portal && npm run typecheck && npm test)
```

### Task 125: Fix contract-m2's break-glass fixture for task-52's fail-closed capability gate

**Workstream:** WS2. **Depends on:** task-52.

**The defect, as measured:** `engine/contract-m2.test.mjs` fails deterministically on clean-export verification of task-52's shipped commit — reproduced twice, independent of any other change: `node --test engine/contract-m2.test.mjs` → `AssertionError: 0 !== 1` at the line asserting `breakGlassResult.skipped.length === 1`. Root cause: task-52 added `verbCapability()`, a fail-closed gate in `applyWave()` that refuses any `(resourceType, verb)` pair absent from `engine/coverage/capabilities.mjs`'s registry *before* `refuseUnsafeDeletion()` (the break-glass guard) ever runs. The test's break-glass fixture uses `resourceType: 'user'`, which was never registered for any verb — not before task-52 (the old hardcoded `pathFor()` map also excluded `user`) and not after. So the resource now lands in `failed` (reason: "unsupported operation: ...") instead of `skipped` (reason matching `/break-glass/i`), and the pre-existing assertions on `skipped` fail. This is a test-only gap: no currently-registered resourceType (`group`, `roleAssignment`, `namedLocation`, `conditionalAccessPolicy`) is affected, so the break-glass guard itself still runs correctly for every resource type this product actually supports deleting — but this cross-cutting M2 contract test no longer proves it, and task-52's own validate command never covered this file (it lives directly under `engine/`, outside that command's glob list), so the regression shipped unnoticed.

**Files:** `engine/contract-m2.test.mjs` only (test-only fix; no production code changes).

**Steps**

1. Inspect the current break-glass scenario (Step 3 of the file, around the `breakGlassResource`/`breakGlassResult` block) and `engine/coverage/capabilities.mjs`'s registrations at current HEAD.
2. Change the break-glass fixture's `resourceType` from `'user'` to `'group'` (registered for `delete`) and update its `naturalKey`/`targetId`/`payload` to a consistent group-shaped fixture (e.g. `group:emergency-access`-style, matching this file's existing group fixtures). This restores the scenario to actually reaching `refuseUnsafeDeletion()`, exactly as it did before task-52.
3. Add one new case proving task-52's gate itself: build a delete-verb resource with a resourceType that has no registration in `capabilities.mjs` (e.g. `authenticationStrengthPolicy`), call `applyWave`, and assert it lands in `failed` with a reason matching `/unsupported operation/i` and that `applied.length` is still `0` — do not remove or weaken the restored group-based break-glass assertions from Step 2.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** The break-glass scenario again exercises a resourceType actually registered for `delete`, so `refuseUnsafeDeletion()` genuinely runs and `skipped.length === 1` with a break-glass reason holds; a separate case proves an unregistered resourceType+verb is refused into `failed` before any guard or writer call; the full file passes.

**Required mutation checks:**

- Restore `resourceType: 'user'` instead of a registered type (silently stops exercising the break-glass code path again).
- Drop the new unsupported-operation case (task-52's fail-closed gate goes untested by this file again).
- Assert the new unsupported-operation case against `skipped` instead of `failed`.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/contract-m2.test.mjs engine/roadmap/capability-registry.test.mjs cli/keel-restore.test.mjs
```

### Task 126: CISA ScubaGear benchmark pack qualification

**Workstream:** WS5. **Depends on:** task-86.

**Why this task exists (added by the watcher, 2026-09-24, per operator direction to research further open-source benchmarks for comparison/remediation):** task-119 pins NIST SP 800-53 — abstract controls, useful for framework-mapping evidence but not directly executable against real tenant settings. Researched alternatives specifically for the "comparison and remediation" use case (an actual pass/fail check against a real configuration value, the way CIS Benchmarks work but free): CISA's ScubaGear is the clear best fit — CC0-1.0 public domain, actively maintained (2,679 stars, pushed the same day this was researched), and its Rego policies are literally executable per-setting checks for exactly KEEL's workloads (Entra ID, Defender, Exchange Online, SharePoint, Teams, Power BI, Power Platform). Its own CSV maps every ScubaGear policy onto a specific NIST SP 800-53 Rev 5 control ID, so KEEL can cite one coherent chain: a ScubaGear check → its mapped NIST control → the catalog entry task-119 already pinned. Pinned at `docs/roadmap/benchmark-content/scubagear-pin.json` (source commit SHA, archive sha256, per-file manifest at the `localManifest` path it names — the full content is kept outside git at `/var/lib/keel/reference-data/scubagear/`, verify against the manifest rather than re-fetching blind). Considered and explicitly rejected in the same research pass, for the reasons given in the pin file's `note` field: EIDSCA (no license file at all — do not bundle) and Maester (MIT, legitimate, but a test-runner that consumes EIDSCA rather than an independent source).

**Files:** `tools/release/qualification.mjs`, `docs/release/qualifications/scubagear-benchmark-acceptance.json`, `docs/roadmap/benchmark-content/scubagear-pin.json` (already present); new boundary tests in `engine/roadmap/scubagear-benchmark-acceptance.test.mjs`.

**Steps**

1. Inspect the named production paths and prerequisite outputs at current HEAD, including the existing pin file at `docs/roadmap/benchmark-content/scubagear-pin.json`, the Rego policies and baseline docs at the `localPath` it names, and its `MANIFEST.sha256`; retain compatible existing behavior. Add adversarial boundary fixtures for the acceptance cases below before the change.
2. Validate the rights manifest (public-domain status read from the pin, exactly as task-119 does for NIST — no purchased license applies here either) and verify each imported file's hash against `MANIFEST.sha256` before trusting it. Import a representative profile of ScubaGear Rego policies for at least the `aad` (Entra) and `exo` (Exchange Online) baselines, and surface each imported check's mapped NIST SP 800-53 control ID from `mappings/scuba-to-nist-sp-800-53-r5-fedramp-high.csv` as an evidence link — do not claim compliance certification. Add a verifier for the imported runner evidence and its source/build/tenant/operation identity. Do not generate successful production evidence from fixtures.
3. Complete the server/CLI/UI integration named by this task; include migration and legacy-read handling where data changes, and record the implementation/proof limitations in `docs/roadmap/scubagear-benchmark-acceptance.md`. Preserve the Global Constraints and do not widen this task to another workstream.
4. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Valid independently captured record verifies; altered signature/digest, wrong tenant/build/operation, stale evidence and missing prerequisite fail; a policy file whose bytes don't match `MANIFEST.sha256` is refused before import, not silently trusted. Fixture mutation tests run locally; final validation also requires the actual evidence file.

**Required mutation checks:**

- Accept missing external evidence.
- Accept mismatched tenant or operation.
- Elevate fixture evidence to live-qualified.
- Import a policy file without checking it against `MANIFEST.sha256` (a corrupted or substituted policy would otherwise pass silently).

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/scubagear-benchmark-acceptance.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs && node tools/release/qualification.mjs verify --require-live --gate scubagear-benchmark-acceptance --evidence docs/release/qualifications/scubagear-benchmark-acceptance.json
```

### Task 127: Fix the portal typecheck regression from task-55's automationContext

**The defect, as measured (watcher, 2026-09-28, clean `git archive` export of 7bc6354):**
`cd portal && npm run typecheck` exits 2. At c143803 (the parent) it exits 0. Commit 7bc6354
(task-55) added `automationContext` to the destructured parameters of `computePlanDigest` and
`createDryRunArtifact` in `engine/restore/dryRunArtifact.mjs` with no default, so TypeScript
infers it as REQUIRED and the existing portal callers fail:

```
test/approvals.test.ts(140,55): error TS2345: ... Property 'automationContext' is missing ... but required
test/restore.test.ts(293,38): error TS2345: ... Property 'automationContext' is missing ... but required
test/restore.test.ts(338,55): error TS2345: ... Property 'automationContext' is missing ... but required
```

At runtime the field is already optional (`...(automationContext ? { automationContext } : {})` and
`automationContext ?? null`), so only its declared shape is wrong.

**Steps:**
1. In `engine/restore/dryRunArtifact.mjs`, change `automationContext,` to `automationContext = null,`
   in the destructured parameter list of BOTH `computePlanDigest` and `createDryRunArtifact`.
   Change nothing else in that file. Do not add `automationContext` to the portal tests instead —
   callers without automation context are legitimate (manual restores).
2. REQUIRED TEST (added by the watcher after two reviews failed on its absence): in
   `engine/restore/dryRunArtifact.test.mjs`, in the existing persistence test where
   `const created = await createDryRunArtifact(client, fields);` and
   `const fetched = await getDryRunArtifact(client, { id: fields.id, tenantRef });` are called
   (`fields` has NO automationContext — a manual restore), add
   `assert.equal(created.automationContext, null);` and `assert.equal(fetched.automationContext, null);`.
   This kills the mutation `automationContext = {}` in createDryRunArtifact, which persists `{}` for
   manual restores and crashes promotion in cli/keel-restore.mjs (~line 203). Verify it: apply that
   mutation, confirm `node --test engine/restore/dryRunArtifact.test.mjs` FAILS, revert.
3. REQUIRED LEGACY-DIGEST PIN (added by the watcher after the third review): the `= null` default
   makes computePlanDigest's `automationContext ? … : {}` guard load-bearing — mutating it to
   `automationContext !== undefined` folds `automationContext: null` into EVERY manual-restore digest
   and makes every pre-task-55 dry-run artifact unpromotable, and no test notices. Add to
   `engine/restore/dryRunArtifact.test.mjs` a pure (no DB) test that pins a manual-restore digest to
   the value the PRE-task-55 code produced (computed by the watcher from c143803's
   engine/restore/dryRunArtifact.mjs, and identical at 28e3607):

   ```js
   test('manual-restore plan digest is unchanged from pre-task-55 artifacts', () => {
     const fields = { snapshotId: 'snap-pin-1', selection: ['group:Admins'], closureKeys: ['group:Admins'],
       targetTenantId: 'tenant-pin', collectorConfigPath: '/etc/keel/collector.json', targetConfigPath: '/etc/keel/target.json',
       reconciliationResources: null, waves: [['group:Admins']], patches: [] };
     const legacy = '5166cb535775f6877b0ed03be4ed6ab6e6f1cf8e9c1824f60123c56b04390de7';
     assert.equal(computePlanDigest(fields), legacy);
     assert.equal(computePlanDigest({ ...fields, automationContext: undefined }), legacy);
     assert.equal(computePlanDigest({ ...fields, automationContext: null }), legacy);
   });
   ```
   Use the file's existing test/assert imports (import computePlanDigest if it is not already).
   Measured: with the D5 mutation plus the `= null` default the digest becomes
   `f30a9917269597213b2085cdded9cd66eea6d03c2b9542b31a54bc8d62a68ca5`, so this test kills it.
   Do NOT change the literal to make the test pass — if it fails unmutated, the implementation is wrong.
4. Run `cd portal && npm run typecheck && npm test`, then the engine suite.

**Tests:** the portal typecheck itself is the regression gate; `engine/roadmap/closure-ceiling.test.mjs`
must stay green (it covers the automationContext-present path).

**Mutations:** (a) remove the `= null` default from `createDryRunArtifact` only → `npm run typecheck`
in portal must fail again; (b) change it to `= {}` → `engine/restore/dryRunArtifact.test.mjs` must fail; (c) change computePlanDigest's
guard to `automationContext !== undefined` → the legacy-digest pin must fail.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/closure-ceiling.test.mjs engine/restore/*.test.mjs && cd portal && npm run typecheck && npm test
```

### Task 128: Restore group `description` to the reviewed field projection (task-51 regression)

**The defect, as measured (watcher, 2026-09-28):** `node --test tools/rehearsal/roundTrip.test.mjs`
fails on every commit since 303d4d2 (task-51) and passes at its parent 58321d2 (bisected on clean
`git archive` exports, first-parent 809ae60..ed3e168):

```
Error: rollback did not apply exactly once: {"applied":[],"skipped":[],"failed":[{"naturalKey":"group:keel-rehearsal-2026-09-11T00-00-00-000Z","error":"residual drift after update","residual":["description"]}],"notRemediable":[]}
```

Cause: `engine/contracts/fieldProjection.mjs` registers `group` with a `knownFields` list that omits
`description`, so `classifyForOperation('update', 'description', 'group')` returns `'unknown'`
(measured) and `writableProjection` strips it from every group PATCH, although
`fieldClass('description','group')` is `'writable'` and Graph's group PATCH accepts it. The restore
can therefore never converge a group whose description drifted.

**Steps:**
1. Add `'description'` to the `group` registration's `knownFields` in
   `engine/contracts/fieldProjection.mjs` (next to `displayName`). Change nothing else there.
2. Add an assertion to `engine/roadmap/semantic-projection.test.mjs`:
   `classifyForOperation('update', 'description', 'group') === 'writable'`, and that
   `writableProjection({ displayName: 'x', description: 'd' }, 'group')` keeps `description`.
3. Run the validate command.

**Mutation:** remove `'description'` from the group knownFields → both the new assertion and
`tools/rehearsal/roundTrip.test.mjs` must fail.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test tools/rehearsal/roundTrip.test.mjs engine/roadmap/semantic-projection.test.mjs engine/cir/*.test.mjs engine/reconcile/*.test.mjs engine/restore/*.test.mjs
```

### Task 129: Portal experience contract: shell, navigation, overview sentence, mechanical checks

**Workstream:** Portal. **Depends on:** task-46. **Contract:** `docs/roadmap/portal-experience.md`.

**Files:** `portal/app/layout.tsx`, `portal/components/nav-links.tsx`, `portal/components/page-header.tsx`, `portal/components/data-unavailable.tsx`, `portal/components/dashboard/*`, `portal/lib/presentation.ts`, `portal/lib/types.ts` (`Ref`), `portal/lib/portal-data.ts`, `portal/app/globals.css`, `portal/ui-harness/app.tsx`, `portal/ui-harness/ui.spec.ts`; new boundary tests in `portal/test/experience-contract.test.ts` and `engine/roadmap/portal-experience.test.mjs`.

**Steps**

1. Inspect the named production paths at current HEAD; keep every reader, authorization gate and action route unchanged. Add the `data-layer` attribute convention (`verdict`, `explanation`, `record`) and a `TechnicalDetails` disclosure component; add the `Ref` type and a `displayEnum()` map in `portal/lib/presentation.ts` covering every enum value the portal renders today (job kinds and statuses, policy actions, blast radii, change types, approval statuses, delivery statuses, event kinds).
2. Replace the 13-entry, 5-group navigation with the contract's seven entries and make `PageHeader` derive its eyebrow from the nav entry so no page can carry a second taxonomy. Keep the command palette, active indicator and phone toggle. Existing routes keep working through redirects to their new home (for example `/coverage` → `/protect#types`, `/jobs` → `/activity`).
3. Rebuild the Overview verdict: the memorable number computed from the coverage reader and drill evidence, honest in each of the three states the contract names; healthy headline "Protected"; the hedge moved into the record layer. Keep the alert copy, posture tones, ring, sparkline and impact bar. Remove the duplicate timestamps and the "Catalog honesty" caption. Rewrite `DataUnavailable` per the copy rules.
4. Add the contract's eight mechanical checks to `portal/ui-harness/ui.spec.ts` with fixtures in `app.tsx` for every route. Checks 1 to 3 and 6 pass on Overview and the shell at the end of this task; the remaining routes are allowed to fail only through an explicit per-route allowlist in the spec that task-130 and task-131 empty, and the allowlist's size is asserted so it can only shrink.
5. Record the implementation and limits in `docs/roadmap/portal-experience.md` under a dated "Status" section. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Seven nav entries, eyebrow equals nav group on every page; Overview's verdict is one sentence under 25 words with the correct number in each of the three states and reads "Protected" when healthy; no UUID, natural key or banned term outside the record layer on Overview; mechanical checks run on every harness route with a shrinking allowlist; axe and screenshot suites pass; unauthorized access still fails before reads.

**Required mutation checks:**

- Render the overview number from a constant instead of the coverage reader → `engine/roadmap/portal-experience.test.mjs` fails.
- Give Drift the eyebrow "Governance" → the eyebrow test fails.
- Add a route to the allowlist → the allowlist-size assertion fails.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/portal-experience.test.mjs engine/authz/*.test.mjs engine/coverage/*.test.mjs && (cd portal && npm run typecheck && npm test && npm run test:ui)
```

### Task 130: Named objects and labelled technical records for policies, principals, approvals, jobs, evidence, baselines

**Workstream:** Portal. **Depends on:** task-129. **Contract:** `docs/roadmap/portal-experience.md`, "Identification rules" and the policy worked example.

**Files:** `portal/components/policy-state.tsx`, `portal/app/policies/**`, `portal/lib/policies.ts`, `portal/components/principal-details.tsx`, `portal/lib/principals.ts`, `portal/components/approval-inbox.tsx`, `portal/lib/approval-inbox.ts`, `portal/components/job-table.tsx`, `portal/components/job-detail.tsx`, `portal/lib/portal-jobs.ts`, `portal/components/evidence-timeline.tsx`, `portal/lib/evidence.ts`, `portal/app/baselines/page.tsx`, `portal/components/notification-console.tsx`, `portal/components/integration-console.tsx`, `engine/policy/evaluate.mjs` (`listPolicies` returns the run-as principal's email and display name), `engine/govern/approvals.mjs` (request summary resolution), `engine/jobs/queue.mjs` (job summary fields); new boundary tests in `engine/roadmap/named-objects.test.mjs`.

**Steps**

1. Inspect the named production paths at current HEAD. For each object, define its generated name sentence and its record fields in a table in `docs/roadmap/portal-experience.md` before changing code, using the policy worked example as the pattern. Readers return `Ref` values for every cross-object identifier (run-as principal, baseline, dry run, snapshot, request, principal of a grant) resolved server-side in one query per page.
2. Policies: the policy card becomes the worked example (verdict sentence with name, state, what it does, acting as whom, last action; explanation in sentences; record with labelled ids, enum codes and CLI equivalent). The page banner reads "Automation is on" or names the halt time and file. Pause, resume and edit actions reach the existing guarded routes. Principals: each person by name and email with roles in words and since when; grant, revoke and disable through the existing routes; ids in the record.
3. Approvals: each request as a sentence with requester, reason, what changes, impact and a link to the dry run or baseline it concerns, expiry in words; Approve and Reject unchanged; request id, action code and params in the record. Jobs and Evidence merge into the Activity timeline: each job and evidence record as a sentence with actor and age, filters in words, every id, hash, worker and raw JSON in the record. The Error block renders only when there is an error. Baselines keep their label and lose the duplicate "Set at" and "Age" pair. Notification and integration forms get labelled fields; raw config JSON moves to the record.
4. Empty the harness allowlist for every route this task touches; checks 1 to 7 pass on them. Keep every identifier and provenance field the pages showed before, now inside the record layer (check 7). Preserve authorization, approval TTL semantics and artifact-only promotion untouched.
5. Record the implementation and limits in `docs/roadmap/portal-experience.md`. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** No bare identifier or enum code on Policies, Principals, Approvals, Activity, Baselines, Notifications or Integrations outside the record layer; every cross-object reference renders as a linked name; a request whose dry run cannot be read renders "no longer readable" rather than an id; every identifier shown on 2026-10-03 is still shown inside the record; the harness allowlist is empty for these routes; axe and screenshots pass.

**Required mutation checks:**

- Return `run_as_principal_id` without the resolved `Ref` → `engine/roadmap/named-objects.test.mjs` fails and the reference check fails.
- Render `policy.action` raw → the enum check fails.
- Drop the policy id from the record layer → the record-completeness check fails.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/named-objects.test.mjs engine/policy/*.test.mjs engine/govern/*.test.mjs engine/jobs/*.test.mjs engine/authz/*.test.mjs && (cd portal && npm run typecheck && npm test && npm run test:ui)
```

### Task 131: Protect page with per-type drawer; Changes and Restore in plain words

**Workstream:** Portal. **Depends on:** task-129, task-54. **Contract:** `docs/roadmap/portal-experience.md`, "Page requirements" rows Protect, Changes, Restore. Supersedes task-54's matrix layout; task-54's reader fields and `engine/roadmap/coverage-ui.test.mjs` are kept.

**Files:** `portal/app/protect/**` (replacing `portal/app/coverage` and `portal/app/backups`), `portal/components/coverage-report.tsx`, `portal/components/backup-controls.tsx`, `portal/components/schedule-table.tsx`, `portal/components/schedule-editor.tsx`, `portal/app/drift/**`, `portal/components/drift-table.tsx`, `portal/components/drift-diff.tsx`, `portal/components/restore-selection.tsx`, `portal/app/restore/page.tsx`, `portal/lib/portal-data.ts`; new boundary tests in `engine/roadmap/protect-page.test.mjs`.

**Steps**

1. Inspect the named production paths at current HEAD. Protect: verdict sentence from the coverage and schedule readers; tier cards with next run and last result in words; failed and stale types listed by name with the existing backup action; one per-type drawer that states in one sentence whether the type is protected, partially protected, cannot be restored, or has no proven restore, and places the entire task-54 matrix (adapter, endpoint, pagination evidence, diagnosis, projection, proof reference, credential mode, observation) inside its record layer. Schedules lose raw cron and job-kind codes outside the record.
2. Changes: verdict from the drift reader with the impact count; the table shows each resource by type in words and display name; the diff describes each field in words with payload JSON in the record; "disposition" becomes decision; the remediation preview drops planned verbs, waves, deferred references and guard refusal codes from the explanation layer and states refusals as "KEEL refused to change X because …". Baselines become a tab of Changes.
3. Restore: step titles become the verdict; the promotion paragraph, CLI narration, closure counts and credential file paths leave the screen (paths are server configuration, never editable fields); the mechanism, content-effect and undo labels are kept; artifact and dry-run ids go to the record. Success and pending states use the copy rules ("Sent to approvers. Nothing changes until one of them approves.").
4. Empty the harness allowlist for Protect, Changes and Restore; checks 1 to 7 pass. Mirror the fixture data between the old coverage fixtures and the new drawer so no state task-54 tested disappears.
5. Record the implementation and limits in `docs/roadmap/portal-experience.md` and add a superseded note to `docs/roadmap/coverage-ui.md`. Run the exact validation command below and report its output and `git status --porcelain`. Do not commit.

**Acceptance:** Protect's first screen is a sentence, tier cards and a named list of problems; every task-54 evidence field is present inside a type's record layer; no natural key, verb, wave, closure or artifact id outside the record on Changes or Restore; credential paths are not rendered as inputs; the restore wizard's interaction test still walks select → dry run → review → confirm → track; the harness allowlist is empty; axe and screenshots pass.

**Required mutation checks:**

- Remove the proof reference from the type drawer's record → record-completeness and `engine/roadmap/coverage-ui.test.mjs` both fail.
- Render a natural key in the Changes table outside the record → the identifier check fails.
- Reintroduce the credential path inputs → `engine/roadmap/protect-page.test.mjs` fails.

**Validate:**

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/protect-page.test.mjs engine/roadmap/coverage-ui.test.mjs engine/coverage/*.test.mjs engine/govern/*.test.mjs engine/restore/*.test.mjs engine/authz/*.test.mjs && (cd portal && npm run typecheck && npm test && npm run test:ui)
```
