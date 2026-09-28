# Enforce automation limits after dependency expansion (task-55)

Date: 2026-09-22 UTC. Status: implemented, fixture-tested only against an isolated
test database with fake Graph readers/writers. No live tenant was touched; no live
qualification is claimed. Conditional Access is never enforced anywhere; collector
and restorer credentials remain separate (the promotion path re-checks
`assertSeparateRestorer` exactly as before).

## What was built

- `engine/policy/evaluate.mjs` — the guardrail math for post-expansion limits,
  co-located with the existing `exceedsMaxBlastRadius` enqueue-time guardrail:
  - `maxOperationImpact(resources, patches)` computes the maximum blast radius over
    the ACTUAL operations a plan performs after dependency closure — every resource
    with a write verb (`create`/`update`/`delete`/`restore-soft-deleted`) plus every
    resource carrying a deferred reference patch. `noop` resources perform no write
    and contribute nothing; an unrecognized blast-radius label always wins the
    maximum so it cannot slip under a ceiling.
  - `exceedsBlastRadiusCeiling(blastRadius, ceiling)` is the comparison, fail-closed
    on any unknown label.
  - `policyConstraintVersion(policy)` is the policy's constraint version: a content
    fingerprint over every field governing whether and how automation may act
    (action, enabled, max_blast_radius, rate limit, run-as identity, repair marker,
    paused state). Any change to any of these fields is a version change.
- `engine/policy/execute.mjs` — execution-time, server-side policy resolution:
  - `resolveQueuedAutomationPolicies(client, { driftIds })` rediscovers which
    automation policies are still `queued` on a set of drift ids via the durable
    `auto_remediation_execution` link table — the same table the worker's terminal
    outcome already uses. The job payload continues to carry only drift ids; a human
    remediation has no rows and keeps its unchanged operator-driven path.
  - `getAutomationPolicies(client, { policyIds })` re-reads policy rows fresh by id;
    a policy that vanished between enqueue and execution fails closed.
  - `assertExecutableAutomationPolicy(client, policy)` mirrors `executeAutoRemediation`'s
    own refusals (disabled / paused / run-as-repair-required) at execution time.
- `cli/keel-remediate.mjs` — `runRemediate` resolves the queued automation policy
  identities from the link table while its scope client is open and passes only the
  identities on the dry-run leg. The enforce leg stays artifact-only: policy
  identities come from the immutable artifact, never from the caller.
- `cli/keel-restore.mjs` — after the dependency closure and verb resolution and
  before any write (and before the preview return), when automation policy
  identities are in scope: the policy rows are re-read live, each is checked still
  executable, the ceiling is the strictest live `max_blast_radius` (never a
  caller-supplied value), and the maximum impact over the expanded closure's actual
  operations is compared against it. Exceeding it records the EXISTING
  `blocked-max-blast-radius` refusal as `automation-execution` evidence (with the
  policy ids, impact, ceiling and expanded scope) and throws, so the worker's
  terminal outcome can never be `executed`. On the dry-run leg the policy
  identity/version, ceiling, max impact, expanded scope and operations are bound
  into the immutable plan evidence (`restore_dry_run.automation_context`, folded
  into the plan digest). On promotion the same checks run again against live rows,
  plus a policy version check: any constraint change between dry run and promotion
  refuses with `restore promotion refused: automation policy ... constraints
  changed since the dry run`.
- `engine/restore/dryRunArtifact.mjs` + `engine/store/schema.sql` — additive,
  retry-safe `automation_context jsonb` column (NULL for every pre-existing
  artifact). The plan digest folds the context in only when present, so artifacts
  persisted before this change keep byte-identical digest inputs and remain
  promotable exactly as before; operator-driven restores (no automation context)
  are behaviorally unchanged.
- `engine/roadmap/closure-ceiling.test.mjs` — boundary tests driving the full
  production path (`executeAutoRemediation` enqueue → `runRemediate` → `runRestore`
  dry-run → artifact promotion) against an isolated test database with only the
  Graph/token boundary faked.

## Preserved invariants

The policy → remediate → runRestore path is unchanged in shape: enqueue still
mints one idempotent `remediate` job carrying only drift ids; the kill switch,
the max-actions-per-window pause, duplicate/policy-drift idempotency, queued (not
executed) semantics and the worker's run-as reauthorization immediately before
dispatch are all untouched. The original drift-only `max_blast_radius` check at
evaluate/execute time remains as the first gate; task-55 adds the second,
post-expansion gate, it does not replace the first. Task-08 immutable
artifact-only promotion and its digest/fingerprint revalidation are preserved —
the new promotion-time policy version check is an additional refusal, and the
task-08 promotion tests remain green.

## Acceptance evidence (fixture-tested)

- Original drift cosmetic under a cosmetic ceiling, closure expands to a
  tenant-lockout dependency update: enqueues fine, refuses with
  `blocked-max-blast-radius` before any write, persists no artifact, and the
  terminal outcome is `failed` — never `executed`.
- Within-ceiling (tenant-lockout ceiling) automation writes the whole expanded
  closure and records policy identity/version, ceiling, max impact, expanded scope
  and operations in the immutable artifact.
- Policy run-as changed between dry run and promotion refuses the promotion even
  though the ceiling outcome is unchanged; restoring the recorded constraints lets
  the same artifact promote.
- Policy disabled, or ceiling lowered, between enqueue and execution refuses —
  the lowered-ceiling case is one the original drift alone (cosmetic <
  access-affecting) would still pass, proving the check runs over the expanded
  closure against the live row, not the caller's or enqueue-time values.
- A policy paused after enqueue refuses before any write, even while enabled.
- Supplying `automationPolicyIds` alongside `artifactId` refuses before any write;
  promotion takes policy identities only from immutable artifact evidence.
- Missing impact metadata on an actual operation refuses before artifact creation.
  The maximum calculation retains an unknown label across later known labels, and
  the restore gate distinguishes no operations from operations with null impact
  by checking the operation count. The boundary regression failed before this gate
  correction and passed afterward.
- Requeue verification (2026-09-27): all eight isolated mutation runs were killed:
  original-selection-only impact, caller-trusted loosest ceiling, skipped policy
  version comparison, equality-boundary flip, caller policy injection, bypassed
  paused policy, null maximum overwritten by a known label, and null impact bypass
  at the restore gate. Each mutation was restored before the next run.

## Requeue correction (2026-09-27)

The execution gate now checks the current policy run-as principal through the
existing `findPrincipalById` / `can(..., 'remediate')` authorization seam at both
planning and promotion. This supplements the worker's queued-requester check:
a changed policy identity cannot inherit the previous requester's authorization,
and an unchanged policy fingerprint cannot hide a revoked grant.

The added promotion regression failed before the correction with `Missing
expected rejection: grant revocation after planning refuses promotion despite an
unchanged policy version`. Boundary fixtures also cover a changed policy run-as
whose grant expired after enqueue, with zero fake writes on both refusals.

## Limitations

- Fixture-tested only: the fake writer proves code behavior, not Microsoft Graph
  support for any operation. Live qualification remains pending external evidence.
- The policy "version" is a content fingerprint, not a monotonic counter; two
  consecutive changes that return every constraint field to its recorded value are
  (correctly) indistinguishable from no change.
- When several distinct policies have `queued` executions for the same drift ids,
  the strictest live ceiling applies (fail closed).

## Additional requeue correction (2026-09-27)

Queued automation now refuses if its current policy action is no longer
`auto_remediate`. The execution gate also rechecks the existing global automation
kill switch at planning and artifact promotion. Previously the action could change
to `require_approval` after enqueue and still write; the new boundary regression
failed with `Missing expected rejection: action changed after enqueue must refuse
before writes` before the correction. The fixtures mock only the kill-switch
filesystem read and use fake Graph writers; they never alter the real stop marker.
Coverage includes activation after enqueue and after dry-run artifact creation.

The three required mutations (original-drift-only impact, trusted ceiling, skipped
promotion policy version) and two added mutations (skipped current action and
skipped execution kill switch) each failed the boundary suite with exit 1. All
mutated files were restored byte-for-byte after each check.
