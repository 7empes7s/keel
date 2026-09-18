# Source parity: M4 portal design reconciled with master (task-46)

Date: 2026-09-18 UTC. Status: source-tested. This report records **source**
parity only. It does not assert, change, or verify deployment status; see
"Deployment status" below for the deliberate separation.

## Scope and method

Compared three trees read-only: `master` (d5f090b0e658ca6bcf56ec0d97cf946677b5ba76),
the `m4-portal-design` branch (f6deca902e0d79357a4c3eb7da2e533262d03140), and the
deployed tree at `/opt/keel-live` (7f59f2de442655aa864f31b93ed4c0d2f19ca909, used
only as a proven resolution reference). No branch was switched, no history was
merged, and no deployed file was changed. Only missing compatible changes were
ported into /opt/keel.

## Original commit provenance

The ported M4 surface families originate from these `m4-portal-design` commits:

| Family | Original commit | Subject |
| --- | --- | --- |
| jobs | 5805149cf54cac1b393f61d0fef4c9cf14e84cb2 | feat(portal): expose guarded job history and details |
| policies | a0ce862f3bc206b022111847ba8eb8fb92e7c9a7 | feat(portal): add guarded policy management and live state |
| notifications | e0bee5460cb8b916bccf9b001771dd6159d25b4b | feat(portal): add guarded notification configuration and history |
| principals | bc2fefba9ad419a24546fd5108f238eb4bda3964 | feat(portal): add guarded principal and role administration |
| evidence | aec9b2ac8358620a52a095893ff8ea7db3381213 | feat(portal): add guarded evidence timeline and chain verification |
| reconciliation preview | f6deca902e0d79357a4c3eb7da2e533262d03140 | feat(portal): preview remediation plans before operator approval |

The collection-history binding is the job history surface family: every
collection run is recorded as a job and rendered through the jobs surfaces, so
it shares the jobs provenance above. The branch's own merge resolution is
bed2656e83536d93d3e62093b34680bfba93d255; the deployed tree's later resolutions
(4198c84, b48613f, 7f59f2d) were consulted read-only for the nav/layout
conflicts against master's task-34 approval inbox.

## Per-family parity records

Each record follows `engine/contracts/release.mjs`: status `source-tested`
means the source tree renders the family from the named real engine reader and
the boundary suites pass. It says nothing about deployment.

| Family | Engine reader | Status | Provenance |
| --- | --- | --- | --- |
| jobs | engine/jobs/queue.mjs | source-tested | 5805149c |
| policies | engine/policy/evaluate.mjs | source-tested | a0ce862f |
| notifications | engine/notify/notifications.mjs | source-tested | e0bee546 |
| principals | engine/authz/principals.mjs, engine/authz/administration.mjs | source-tested | bc2fefba |
| evidence | engine/govern/evidence.mjs | source-tested | aec9b2ac |
| collection-history | engine/jobs/queue.mjs | source-tested | 5805149c |
| dashboard | engine/coverage/report.mjs | source-tested | pre-existing on master |
| coverage | engine/coverage/report.mjs | source-tested | pre-existing on master |
| drift | engine/govern (drift readers) | source-tested | pre-existing on master |
| baselines | engine/govern/baseline.mjs | source-tested | pre-existing on master |
| backups | engine/jobs/queue.mjs | source-tested | pre-existing on master |
| restore | engine/restore/dryRunArtifact.mjs | source-tested | pre-existing on master (task-08) |

## Outdated bindings resolved against current master

- `cli/keel-remediate.mjs` / `cli/keel-restore.mjs`: the branch's `previewOnly`
  binding predates task-08's immutable dry-run artifact flow. The preview now
  returns after wave planning and before the artifact revalidation, never
  acquiring Restorer credentials or a writer; the enforce path remains
  artifact-only. `runRemediate`'s task-08 parameters
  (`targetConfigPath`, `collectorConfigPath`, `requestedBy`, `readFile`) are
  optional so the preview binding can call the same job path without them.
- `portal/test/remediation-preview.test.ts`: under task-08 a dry run with guard
  refusals persists a `refused` artifact, so the direct-API promotion in the
  branch's test is now expected to fail closed at the artifact gate
  (`restore promotion refused`) with zero writes; the real-guard equivalence
  assertion is preserved.
- `portal/lib/read.ts`, `portal/lib/action.ts`, `portal/app/layout.tsx`,
  `portal/components/nav-links.tsx`, `portal/test/*`: merged additively with
  master's task-07 read authorization, task-08 dry-run artifact surface and
  task-34 approval inbox; the deployed tree's proven resolutions were reused
  where they matched.

## Deployment status

Deployment status is **not** established by this report or by any source test.
`/opt/keel-live` still runs its own pre-reconciliation merge
(7f59f2de442655aa864f31b93ed4c0d2f19ca909); whether any deployed build matches
this source tree is recorded separately by the read-only readiness recorder
(`docs/release/readiness.json`) and remains a deployment question, not a source
one. Per `engine/contracts/release.mjs`, a `deployed` parity status requires an
explicit evidence reference; no such evidence is asserted here.
