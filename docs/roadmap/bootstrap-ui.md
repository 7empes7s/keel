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
identifier and the qualification mode. Since 2026-10-04 it composes the
production host in `engine/bootstrap/graphHost.mjs` when the deployment has both
credential files (see the status section below). When either file is missing,
or the configuration is invalid, it returns `NO_SETUP_HOST`:

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

## Status — 2026-10-04: production setup host

The live host reported `canCheck: false`: `setupHost()` returned
`NO_SETUP_HOST`, so no task-76 run could exist and gate 116
([drill-live-acceptance.md › Operator steps](drill-live-acceptance.md#operator-steps),
step 2) could not be captured. This change adds the production host.
Its behavior is fixture-tested. The readers have not yet run against the live
tenant from this change. No write operation is qualified, and every write
operation ships disabled.

### What the host does

`engine/bootstrap/graphHost.mjs` (`createGraphSetupHost`), composed by
`composeSetupHost()` in `portal/lib/setup-host.ts`:

- **Credentials.** It uses the deployment's existing credential files, the same
  ones restores use (`lib/restore-config.ts`):
  - `KEEL_COLLECTOR_CONFIG_PATH`, default `/etc/keel/tenant-target.json`;
  - `KEEL_RESTORER_CONFIG_PATH`, default `/etc/keel/restorer.json`.

  Each file has `tenantId`, `clientId`, `certPath` and `keyPath`. Both must
  belong to the tenant in `KEEL_TENANT_CONFIG_PATH`. They must also use
  different app ids, certificates and keys. The approved artifact carries
  references only: `credentialRef` is `file:<path>` and `identityRef` is the
  app id. Tokens are held in memory and never journaled. A token issued for
  another tenant is refused before anything is read.
- **Readers (strictly read-only).** All reads use `GraphReader`
  (`tools/tenant-probe/graph.mjs`). It cannot send anything but GET, and it
  runs on the Collector credential. The readers look up:
  - each identity's app registration and service principal **by its
    configured app id** (`/applications(appId=…)`, `/servicePrincipals(appId=…)`),
    so an unrelated app is never adopted. The planner matches the
    registration by that binding (`keelIdentity`), so the real display names
    ("KEEL Collector", "KEEL Restorer") are kept;
  - Graph application permissions granted to each service principal
    (`/servicePrincipals/{id}/appRoleAssignments`), with role ids resolved
    against the Microsoft Graph service principal's `appRoles`;
  - directory role assignments for both service principals and the
    onboarding operator (`/roleManagement/directory/roleAssignments`), and
    the operator's PIM eligibility (`/roleManagement/directory/roleEligibilitySchedules`);
  - Intune roles (`/deviceManagement/roleDefinitions`, their
    `roleAssignments`, each assignment's `members`) against the service
    principal's transitive group membership
    (`/servicePrincipals/{id}/transitiveMemberOf/microsoft.graph.group`);
  - `/subscribedSkus`, for visibility only.

  A 404 on a single object means absent. Any other failure throws, because
  unknown is never absent. There are two exceptions. Intune roles need
  `DeviceManagementRBAC.Read.All`, which is not in the Collector's registered
  scopes. If they cannot be read, the Intune step is shown as **not
  checked**, and a run that includes it **stops** rather than pausing. The
  licence list is shown for visibility only. When the whole look fails, the
  setup page shows every step as not checked and says it could not read the
  tenant (`checkFailed`). The page does not fail.
- **Observation (`observe`).** Each call takes a fresh read-only look,
  re-derives the plan and returns the approved step's state:
  - a registration is satisfied with its object id, app id and service
    principal id;
  - Intune role assignments and consent are taken from the fresh plan;
  - PIM is satisfied only by an **active** assignment of the operator, never
    by eligibility.
- **KEEL permission.** A configured credential carries `keel.collect` or
  `keel.restore` by deployment binding: the deployment configured it as that
  role's credential. That binding is the KEEL permission.
- **Grants beyond the plan.** The planner now records `excessScopes` on each
  consent step: Graph permissions the identity holds beyond what setup
  derives (the Restorer's `MailboxSettings.ReadWrite`, for example). The
  setup page shows them on the consent step and says KEEL does not remove
  them. Nothing narrows or removes a grant.
- **Writes (`ensure`), disabled by default.** Only two operations exist:
  - `grant-consent` adds the missing Graph application permissions to the
    identity's service principal;
  - `update-required-access` creates a missing service principal for an
    existing app and adds missing Graph permissions to its declared access.

  Each runs only when the setup config names it with `enabled: true`, a
  `qualification` (`fixture-tested` or `live-qualified`) and an `expiresAt`.
  The qualification must equal the host's `qualificationMode`, or the
  executor refuses. When an operation is disabled, `qualify` returns nothing,
  so the executor stops before any write, and `ensure` refuses again on its
  own before sending a request. Writes use `GraphWriter` with the Restorer
  credential. Two actions are never automated:
  - `create-registration`: a new app's id cannot be bound to a credential
    before approval (task-75);
  - `configure-keel-permission`.
- **Prerequisites.** The revision fingerprints the credential references, the
  operator, the enabled operations, the build and the mode. Changing any of
  them stops a run in progress. The kill switch (`AUTOMATION_KILL_SWITCH_PATH`)
  is honored.

Optional setup config, `KEEL_SETUP_CONFIG_PATH` (default `/etc/keel/setup.json`):

```json
{
  "operatorPrincipalId": "<Entra object id of the person who runs setup>",
  "build": "<deployed build; else KEEL_BUILD, else git rev-parse HEAD>",
  "qualificationMode": "live-qualified",
  "operations": { "grant-consent": { "enabled": false } }
}
```

`qualificationMode` defaults to `live-qualified`, because runs observe the real
tenant. That labels the run; it does not qualify any write. A run on a tenant
that is already consented writes nothing.

### Boundary tests

`engine/roadmap/setup-host.test.mjs` (8 tests) runs against a fixture Graph
(`engine/test/setupGraphFixture.mjs`, which replaces `fetch` and records every
request). It covers:

- the credential and operation configuration rules;
- readers and every observation issuing only GETs;
- a fully satisfied tenant completing a read setup with a run id (the
  artifact id) and a `complete` journal event, with no write;
- a missing Intune role and a merely eligible PIM role giving
  `pending-manual`;
- an unreadable Intune check showing as not checked and stopping the run;
- the Restorer's extra grants reported as `excessScopes` and left in place;
- disabled operations never writing (through the executor and through `ensure`
  directly), a mode mismatch being refused, and an enabled `grant-consent`
  writing only the one missing grant;
- the portal end to end. It composes the host from credential files, checks
  `canCheck`, completes read and restore setup, resumes after PIM activation
  and falls back to not checked on a failed read.

Mutations, each applied alone and restored:

| Mutation | Pass | Fail |
| --- | --- | --- |
| Writes enabled and qualified by default | 7 | 1 |
| PIM eligibility observed as an active role | 6 | 2 |
| Unreadable Intune roles observed as absent | 7 | 1 |
| Unreadable Intune roles not reported | 7 | 1 |
| Registration matched by display name only | 2 | 6 |
| Excess grants not reported | 7 | 1 |

The UI harness has a `setup-checked` route that renders an observed tenant
with the Restorer's extra grant. It passes the axe and contract checks (the
contract allowlist stays empty), and an interaction check confirms the grant
is reported and not shown as fixed.

### Limits

- Graph paths and permissions were checked against the Microsoft Graph v1.0
  reference (`microsoftgraph/microsoft-graph-docs-contrib`, `api-reference/v1.0`,
  retrieved 2026-10-04). They have not been exercised against the live tenant.
- The Collector needs `Application.Read.All` (applications, service principals,
  granted permissions) and `RoleManagement.Read.Directory` (role assignments,
  PIM). Without them the look fails, and the page says so.
- The Intune role check needs `DeviceManagementRBAC.Read.All` on the
  Collector. It is not added to the registered prerequisites. Without it, run
  read setup for Entra only; the first-collection gate accepts that.
- Each observation re-reads the tenant (about 15 GETs), and the executor
  observes each step two or three times. Runs stay in the request, as before.

### Operator steps

1. Confirm `/etc/keel/tenant-target.json` (Collector) and
   `/etc/keel/restorer.json` (Restorer) exist and name this tenant.
   Restart the portal; Settings › Setup should no longer say the server cannot
   look at the tenant.
2. Give the host your Entra object id: `operatorPrincipalId` in
   `/etc/keel/setup.json`, or `KEEL_SETUP_OPERATOR_ID` in the portal's
   environment, then restart the portal. Without it the restore setup's PIM
   step stays "waiting for you" and the restore setup can never finish
   `complete`. Leave `operations` out: no write is needed on a consented
   tenant, and without a setup config every write stays disabled.
3. Read setup: start it for Microsoft Entra settings. Include Intune only if
   the Collector holds `DeviceManagementRBAC.Read.All` **and** an Intune
   "Read Only Operator" role assignment (for example through a group the
   Collector's service principal is a member of). The permission alone only
   lets KEEL read the role; without the assignment the Intune step stays
   "waiting for you" and the run ends `pending-manual`, which gate 116 does
   not accept. It should finish `complete` with every step done. Copy the
   setup run id from the record layer.
4. Restore setup: the account named in step 2 needs an active
   Privileged Role Administrator or Global Administrator assignment, either
   activated in PIM or assigned permanently (eligibility alone stays
   "waiting for you"). Then start it. It should finish with the Restorer's extra grants listed on the consent
   step. Copy its run id.
5. Write `onboarding.json` for gate 116 with both run ids (drill-live-acceptance
   step 2).
