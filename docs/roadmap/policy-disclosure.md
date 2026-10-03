# Immutable policy activation preview and reconciliation plan UI (task-92)

Date: 2026-10-03 UTC. Status: implemented, fixture-tested only, against an isolated test
database with only the Graph and token boundary faked. No live tenant was read or written,
and no live qualification is claimed. Conditional Access is never enforced, and the
collector and restorer credentials stay separate (the restore path is unchanged).

## What was built

- `engine/policy/activation.mjs`, the activation preview and activation.
  - `buildActivationPreview` computes what turning an automatic roll-back policy on would
    do now. It uses the machinery a remediation already uses. There is no second planner.
    - **Matched resources.** These are the open drift rows that `policyMatches()` selects,
      split by the enqueue-time `max_blast_radius` guardrail. A matched change above the
      ceiling is listed as "left alone", not acted on.
    - **Closure-expanded impact.** Each baseline group goes through `resolveRestoreScope()`
      (the remediate job's own scope, from `cli/keel-remediate.mjs`). That scope is closed
      with `dependencyClosure()` over `restoreCandidates()`, the dry run's own candidate
      set, and rated with task-55's `maxOperationImpact()`. Every added dependency is listed
      with its impact, what requires it, and whether it is over the policy ceiling.
    - **Current run-as grants.** The preview records whether the run-as principal may
      `remediate` now, and lists every grant active now.
    - **Limits.** The preview shows the ceiling, the rate limit, and whether automation is
      halted (the halt file).
    - **Unsupported operations.** These come from the capability registry
      (`capabilityFor`). A matched change maps to its expected operation. A dependency must
      support both create and update, because only the dry run's live read decides which
      one it needs.
    - **Matching benchmark findings.** These are task-87 `complianceFindings()` whose change
      links (linked or mismatched) contain a matched drift id. An unreadable register is
      shown as unavailable and never blocks.
    - **Ownership.** The current task-89 ownership evidence for every resource the roll back
      would touch.
  - **Frozen intent.** `createActivationPreview` stores the preview in
    `policy_activation_preview` together with four versions and a canonical digest (the
    plan digest's hashing, `canonicalDigest` in `dryRunArtifact.mjs`):
    - policy: task-55's `policyConstraintVersion` plus the match fields;
    - grant: the run-as principal, whether it is disabled or authorized, and its active
      grants;
    - ownership: the current ownership evidence plus the keys that have none;
    - projection: the matched drift rows by content hash, their restore sources, the closed
      operation set, and the field-projection and hash contract versions.
    The row is never updated. Each preview appends `policy-activation-preview` evidence.
  - **Activation.** `activatePolicy` consumes one preview once. The `UNIQUE (preview_id)`
    on `policy_activation` makes it single-use, even under concurrent requests. It refuses
    (`ActivationRefusedError`, with `policy-activation` refusal evidence) in these cases:
    - the preview is missing or belongs to another tenant or policy;
    - it has expired (30 minutes);
    - it was already used, or it was blocked;
    - the policy is already on;
    - a fresh recomputation differs in any version or in the digest (`preview-stale`,
      naming what changed).
    Only then does it call `setPolicyEnabled()`, which re-checks the run-as grant itself.
  - **Blockers.** A preview is blocked when:
    - the run-as account cannot remediate now;
    - automation is halted;
    - the impact is unknown. Impact is unknown when the scope cannot be resolved, a matched
      resource is not in its backup, a reference has no backed-up provider, an impact
      rating is unrecognised, or the change type is unrecognised.
  - `summarizeAutomationOutcomes` and `remediationOutcome` report what a policy has done.
    Only the worker's terminal `executed` counts as rolled back. `queued` is "waiting to run,
    not yet rolled back".
- `engine/restore/dryRunArtifact.mjs` adds two exports:
  - `restoreCandidates()`, the snapshot candidate set. It was moved out of
    `cli/keel-restore.mjs` unchanged, so the preview and the dry run cannot disagree about
    dependencies.
  - `canonicalDigest()`.
- `engine/store/schema.sql` adds two tables, `policy_activation_preview` and
  `policy_activation`. The change is additive and retry-safe, and is applied twice in the
  test.
- **Portal.**
  - `POST /api/policies/<id>/activation-preview` and `POST /api/policies/<id>/activate`
    were added (`portal/lib/policies.ts`). Both are guarded by the `policies` capability
    with recorded attempts, and are registered in `DATA_SURFACES` and the closed route
    inventory test.
  - `POST /api/policies/<id>/enabled` now refuses to turn on an `auto_remediate` policy
    with `409 activation_preview_required`.
  - `POST /api/policies` creates automatic policies turned off, and refuses `enabled: true`
    for them.
  - `portal/components/policy-preview.tsx` shows the preview in the contract's three
    layers. It says what the policy would roll back, what is left alone, everything it
    depends on (marked when above the limit), what cannot be done automatically, what KEEL
    cannot tell, who it acts as and their grants, limits, related benchmark findings, and
    what has happened so far. Every id, version, digest, key and raw code is in the
    preview's "Technical details".
  - "Turn on" sends only the preview id. A refusal says what changed ("The account's
    access changed since the preview. Preview again.").
  - The Policies page (`portal/app/policies/page.tsx`) says when an automatic policy is off
    and will be previewed first.
- **UI harness.** The new route `/policies/p2` (`policy-activation`) passes contract checks
    1 to 7 in both themes, with its record IDs listed. An interaction test covers the
    dependency above the limit, queued-not-rolled-back, and a stale refusal. The allowlist
    stays empty.

## Preserved invariants

The preview and activation never authorize execution:

- `executeAutoRemediation` still re-reads the policy, kill switch, run-as grant, ceiling and
  rate limit at enqueue.
- The worker still re-authorizes before dispatch.
- `runRestore` still re-checks the ceiling after closure (task-55) at the dry run and again
  at promotion.

Nothing in the execution path reads `policy_activation`. The policy → remediate →
`runRestore` path, artifact-only promotion, queued semantics and idempotency are unchanged.
The only change to `cli/keel-restore.mjs` is that it calls the extracted
`restoreCandidates()`, which has identical behaviour.

## Acceptance evidence (fixture-tested, `engine/roadmap/policy-disclosure.test.mjs`)

- **Changed policy, grant or ownership invalidates activation.** A changed rate limit, a
  changed match glob, an added run-as grant, and newly recorded ownership evidence for a
  dependency each refuse with `preview-stale`, naming exactly `policy`, `grant` or
  `ownership`. The policy stays off. An expired, foreign or used preview also refuses.
  Turning a policy off and on needs a new preview.
- **The preview shows dependencies over the ceiling.** A cosmetic `group:Finance` change
  under a cosmetic ceiling expands to `group:Privileged` (tenant-lockout). It is listed with
  `overCeiling: true` and `requiredBy: ['group:Finance']`, the maximum impact is
  `tenant-lockout`, and the evidence counts it.
- **A queued job is not labelled repaired.** After activation, `evaluateOpenDrifts` queues
  one job. The summary reads queued 1, rolled back 0, and the portal reads "1 waiting to
  run, not yet rolled back". The refused run's terminal outcome is failed, never rolled
  back.
- **Unknown impact blocks unsafe activation.** An unresolved reference, a matched resource
  missing from the backup, and an unrecognised impact rating each block, and activation
  refuses with `preview-blocked`. A halted automation blocks too.
- **Execution-time checks stay active.** The activated policy's queued job runs through
  `runRemediate` → `runRestore`. It is refused with `blocked-max-blast-radius` before any
  write, and no dry run is persisted. A grant revoked after activation refuses the next
  enqueue with `run-as-not-authorized` and disables the policy. The halt file refuses with
  `automation-disabled`.

## Limits and decisions

- **Engine callers are trusted.** The portal enforces "preview before turning on".
  `createPolicy()` and `setPolicyEnabled()` in the engine keep their existing contract for
  trusted server-side callers (tests, migrations, and any future CLI), so they can still
  enable a policy without a preview. Execution-time checks apply either way.
- **Existing policies keep running.** A policy turned on before this task has no activation
  row and reads as such (`latestActivation` returns null). It is not turned off by the
  migration: its execution checks are unchanged, and turning it off and on again goes
  through a preview.
- **The preview is a forecast, not a dry run.** It reads no live Microsoft state, so a
  dependency's operation is "create or update" until the dry run reads the target. A
  matched resource that exists in the backup but drifted again live still gets its real
  verdict from the dry run and promotion checks.
- **Any digest change invalidates.** The digest covers everything shown, including
  benchmark findings and the halt state. A new failing control or a new matched change
  between preview and activation therefore forces a new preview. This is deliberate: what
  was shown is what is activated.
- **Grant versions have microsecond precision.** A grant is active when
  `active_from <= now`. A grant written in the same millisecond as a preview may not appear
  until the next preview. That preview then reads the grant and changes the version.
- **No live qualification.** Everything here is fixture-tested only.
