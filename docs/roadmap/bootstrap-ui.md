# Guided onboarding and named prerequisite resolution (task 76)

Date: 2026-10-03 UTC. Status: implemented, fixture-tested only. No Microsoft
identity operation is live-qualified by this change, and no Microsoft transport
is added: the portal composes the task-74 planner and the task-75 executor through
the same injected readers and adapters their own tests use.

## What was built

- **Settings › Setup** (`portal/app/setup/page.tsx`, `portal/components/setup-progress.tsx`,
  words and types in `portal/lib/setup-view.ts`, server loader in `portal/lib/setup.ts`).
  The page sits in the Settings entry of the seven-entry map (no eighth entry), is
  gated on the `configuration` capability (`DATA_SURFACES.setupPage` and
  `setupApi`), and follows the portal experience contract: one verdict sentence
  ("4 steps are left before KEEL can read your tenant." / "Read access is
  confirmed. You can run the first backup."), named steps in plain words, and a
  record layer with the setup run id, plan id, step ids, build and mode.
- **Two separate setups.** Read access for backups (`entra-collect`,
  `intune-collect`, the collector identity) and write access for restores
  (`entra-restore`, the restorer identity) are planned, approved and run
  separately (`SETUP_SCOPES` in `engine/bootstrap/onboarding.mjs`). The task-75
  executor checks every manual authority before its first write, so one combined
  plan would let a missing restore PIM activation hold up read-only onboarding.
  Read setup can also be narrowed to Entra only, so a missing Intune role stops
  only the Intune part.
- **Per-step progress** (`stepProgress`). Each step shows registration and
  consent instructions, existing-state reuse ("KEEL found this app already
  registered … and will reuse it"), the workload it belongs to, and one of: done,
  waiting for you, needs admin consent, not done yet, not sure it worked, in
  progress, not started, not checked. A step is done only on observed evidence: a
  `verified` journal event, a `satisfied` journal observation, or (before any run)
  a satisfied reader observation. There is no control that marks a step done. PIM
  eligibility the planner saw stays "waiting for you", because task-75 treats
  eligibility as not yet active authority.
- **First collection gate** (`firstCollectReadiness`, enforced in
  `guardedAction` for the `collect` and `backup` job kinds in
  `portal/lib/action.ts`). The portal enqueues a collection only when a
  collection has already completed for the tenant, or when the newest run that
  carries read steps finished `complete` (every step re-observed). A newer read
  run that stopped (for example on a revoked prerequisite) withdraws the
  confirmation. Restore runs carry no read steps and never affect the gate. A
  refused request returns 409 `setup_incomplete` with the names of the missing
  steps; the attempt is still recorded in the evidence chain.
- **Provisioning action** (`POST /api/actions/setup`, `guardedSetup`). Requires
  `configuration` and `approve` in the guard (`GuardSpec.alsoRequires`), and the
  task-75 journal re-checks both grants from the database before every step. The
  plan is derived on the server from the host's readers, never accepted from the
  request; approval hashes the whole artifact and binds it to the approving
  principal. `{ scope, workloads? }` starts a run; `{ resume: <run id> }` continues
  one, and only for the principal who approved it (anyone else gets 404).
  Credential pairs are server configuration, never request fields.
- **Read API** (`GET /api/setup`, `guardedSetupState`) returns both setups, the
  gate result, the latest completed collection summary, and whether this server
  can check or change the tenant. The setup page links the first collection's
  result to the Protect page, which lists every type including the
  ones KEEL cannot back up yet.
- `registeredWorkloads()` was added to `engine/bootstrap/prerequisites.mjs` so the
  page lists exactly the registered workloads.

## Host composition

`portal/lib/setup-host.ts` is the single place a deployment supplies planner
readers, provisioning adapters, the collector/restorer reference pair, the build
identifier and the qualification mode. It returns `NO_SETUP_HOST` today because
the repository ships no qualified Microsoft transport (task-75: "A real adapter
requires independent current official API review and tenant-specific
qualification before use"). With no host:

- the page shows every step and its instructions, marked "not checked" until a
  journal exists, and says the server cannot look at or change the tenant;
- `POST /api/actions/setup` returns 409 `provisioning_unavailable` before touching
  the journal;
- the first-collection gate still applies. A new deployment therefore starts its
  first collection from the CLI (`cli/keel-collect.mjs`, which this task does not
  gate) or from a host that has run setup. Existing deployments with a completed
  snapshot are unaffected.

## Acceptance mapping

- *Missing prerequisite stops affected action but permits eligible read-only
  setup:* a read setup including Intune pauses on the Intune role before any write
  and the collect route refuses; the Entra-only read setup completes and the
  collect route then queues; a restore setup paused on PIM never affects either.
- *Retry resumes journal:* a lost acknowledgement stops the run (409
  `setup_stopped`, step shown "not sure it worked"); `resume` re-observes and
  completes with exactly one registration write.
- *Read-only principal cannot provision:* `read` alone, or `configuration`
  without `approve`, is refused by the guard before the journal is created (and
  recorded as a denied attempt); forged headers meet the journal's database
  re-check and are refused too.
- *Session expiry retains progress without bypassing auth:* progress lives only in
  the journal. A request with no principal (an expired Cloudflare Access session
  is not resolved by `proxy.ts`) is refused and adds no journal event; the paused
  run and its steps read back unchanged, and the client tells the operator to sign
  in again because progress is kept.

## Limitations

- Fixture-tested only. The executor runs inside the request (one dedicated
  connection, task-75's advisory lock); long live runs would need a job kind,
  which this task does not add.
- Without readers the page cannot tell what already exists in the tenant; it never
  guesses.
- `Start again` after a stopped run approves a fresh plan rather than reusing the
  stopped approval; the old run's journal is kept.
- Unsupported workloads (SharePoint, Teams, Exchange, OneDrive, Purview) have no
  registered prerequisites, so setup lists none; the Protect page
  reports them.
- Scheduled backups (`cli/keel-scheduler.mjs`) do not pass through the portal and
  are not gated.

## Boundary tests

`engine/roadmap/bootstrap-ui.test.mjs` (5 tests) runs the real planner, executor
and journal in an isolated schema, then the real portal routes and setup page
through tsx, with fake identity adapters. Required mutations, each applied alone
and restored (2026-10-03):

| Mutation | Pass | Fail |
| --- | --- | --- |
| Start collect with missing read grants (gate disabled in `guardedAction`) | 4 | 1 |
| Authorize setup from read capability alone (route guard `read`, no `approve`) | 4 | 1 |
| Authorize setup from read capability alone (journal default capability `read`) | 2 | 3 |
| Convert pending manual step to done (`stepProgress`) | 1 | 4 |

The UI harness gained a `setup` route (axe in both themes, contract checks with
its record ids) and an interaction check that the waiting step has no tick-off
control and that "Continue setup" posts only `{ resume }`.
