# Emergency (break-glass) account readiness and usage canary (task 94)

## Status — 2026-10-03

Built on the current HEAD, on top of task 83 (acknowledgement deadlines and
escalation), task 88 (bounded audit ingestion) and task 91 (minimized attribution
facts). **Fixture-tested only.** No Microsoft call was made: the collected inventory,
the audit and sign-in entries and the method reads are synthetic fixtures. Nothing in
this task rotates a credential, signs in, or changes a policy.

## What "ready" means

An emergency account is registered by its Entra object id
(`registerBreakGlassAccount`, needs `configuration`). `engine/safety/breakGlassReadiness.mjs#evaluateAccountReadiness`
reports five separate dimensions for it, each `pass`, `fail`, `unknown`, or `due` (the
test dimension only):

| Dimension | Pass when | Evidence |
|---|---|---|
| `cloudOnlyIdentity` | the user is in the newest covered user collection, `onPremisesSyncEnabled` was collected and is not true (task 111's `sourceAuthorityOf` is `cloud`), it is enabled, a member (not a guest), and its sign-in domain is in the domain collection as `Managed` | collected `user` and `domain` |
| `phishingResistantCredential` | the newest method record lists FIDO2/passkey, Windows Hello, a certificate or a platform credential, and the tenant authentication methods policy does not switch the FIDO2 or certificate method off | a `methods-observed` record from a read-only reader, or a `methods-attested` record a person made; collected `authenticationMethodsPolicy` |
| `policyExclusions` | every Conditional Access policy whose state is `enabled` leaves the account out (directly, through an excluded group whose membership was read completely, or through an excluded role it holds) or does not include it | collected `conditionalAccessPolicy`, `transitiveMember` / `member` relationship reads, collected `roleAssignment` |
| `privilegedAccessPath` | an active Global Administrator assignment at directory scope; eligible-only fails (`eligible-only-needs-activation`) | collected `roleAssignment`, `roleEligibilitySchedule` |
| `lastValidation` | a person recorded an emergency sign-in test within the account's interval (default 90 days); stale is `due` (`validation-overdue`), none is `due` (`never-validated`) | `breakglass_lifecycle_event` kind `validated` |

The account is `ready` only when all five pass; any `fail` or `due` makes it
`not-ready`; otherwise any `unknown` makes it `unknown`. **A Conditional Access
exclusion is one dimension of five and never the verdict.** The tenant is `ready` only
with at least two active accounts (the spec §10.4 precondition already enforced by
`assertBreakGlassCoverage`, which is unchanged) that are all ready.

### Unknown stays unknown

- No method record: `unknown` (`no-method-evidence`). A failed or refused method read
  records nothing, so it cannot turn into "nothing registered". An empty list that a
  reader did return is a fact and fails.
- A FIDO2 or certificate method while the tenant methods policy was not collected, or
  its entry is missing: `unknown`.
- An excluded group whose membership was not read completely: the policy's treatment
  is `unknown` (`policyTreatment` in `engine/safety/breakGlassInvariant.mjs`). A direct
  `member` read proves membership when it lists the account but never rules it out
  (nested groups); only a complete `transitiveMember` read does.
- An include or exclude by role while role assignments were not collected: `unknown`.
- A user payload without the `onPremisesSyncEnabled` field, a domain not collected,
  or a type whose newest collection did not complete:
  `unknown`. The newest per-type collection is used, so an older complete collection
  never stands in for a newer failed one.

### Policy surfaces

`evaluateSurfaces` lists every surface that can stand between an emergency account
and a sign-in, each `evaluated`, `unknown` (its inventory was not covered) or
`unsupported` (KEEL has no reader for it):

| Surface | State |
|---|---|
| Conditional Access policies | evaluated from collection |
| Risk conditions in Conditional Access (`userRiskLevels`, `signInRiskLevels`, ...) | evaluated as Conditional Access |
| Authentication methods policy | evaluated from collection |
| Role eligibility | evaluated from collection |
| Role activation rules (PIM role settings) | **unsupported** |
| Legacy Identity Protection user and sign-in risk policies | **unsupported** |
| Security defaults | **unsupported** (read live only by the restore sign-in path gate) |
| Restrictions on admin apps (app-level assignment or app-enforced restrictions) | **unsupported** |

Unsupported surfaces are not part of the verdict and are always shown next to it, on
the page ("KEEL cannot check this") and in the CLI report. A `ready` tenant is ready
for what KEEL can check, and the page says how many areas need a manual check.

## Reminders and the usage canary

`runBreakGlassCanary` (one tenant) and `sweepBreakGlassCanaries` (every tenant with
active accounts, as the scheduler principal) do three things, all through the task 82
alert lifecycle with control `break-glass`:

- **Usage.** Every task 91 `audit_sign_in_fact` whose actor is a registered account,
  and every `audit_change_fact` it made that no such sign-in explains (no sign-in in
  the eight hours before), is a firing observation of condition
  `emergency-account-used` on the account's alert (`resource_key` `user:<label>`). The
  event id is `breakglass-sign-in:<audit event id>` (or `breakglass-change:`), so a
  re-sweep is idempotent and a second use updates the same alert. The detail
  correlates the use: the audit event id, a correlation id, every change the account
  made in the eight hours after the sign-in (resource type and object id, operation,
  activity; at most 20) and whether a person recorded a test within two hours. An
  unplanned use is `critical`; a recorded test still alerts as `warning`, so every
  test proves the canary. A usage alert is resolved by a person after review
  (`resolveAlert`); the next use reopens it as a new occurrence. Task 83 gives each
  occurrence its acknowledgement deadline, owner and escalation.
- **Validation reminder.** A `due` test fires `validation-due`; a new test resolves it.
- **Credential reminder.** When a credential review interval is set, a review older
  than it fires `rotation-due`; recording `credential-rotated` resolves it. KEEL only
  reminds: the rotation is a person's action outside KEEL.

Only registered accounts in the same tenant match: facts are read by `tenant_ref`, so
the same object id signing in to another tenant never alerts this one.

The report also states whether the canary is watching: `watching` when the sign-in
log's newest completed read is less than a day old and the day before it is covered
(task 91's `coverageFromRuns`); `not-watching` otherwise; `not-configured` when no
audit tables exist.

## Data and migration

`engine/store/schema.sql` adds, additively and retry-safely:

- `breakglass_account` (tenant, object id, label, alert resource key, test and
  credential intervals, who registered or retired it and when). Retiring keeps the
  row and its history.
- `breakglass_lifecycle_event`, append-only by trigger: `validated`,
  `credential-rotated`, `methods-attested`, `methods-observed`, each with the instant,
  who recorded it and a bounded detail (method kinds from a closed list, a redacted
  note of at most 500 characters).

Each registration, retirement and person-recorded event is also appended to the
tamper-evident evidence chain (`breakglass.<kind>`). A future-dated record is refused.

Legacy read: an install without these tables reads as `not-configured` (reason
`not-migrated`) in the report, the page and the CLI; the canary and the worker sweep
do nothing. No accounts registered reads as `not-configured`
(`no-accounts-registered`), never as ready.

## Server, CLI and UI

- **Worker.** `cli/keel-worker.mjs#sweepBreakGlassCanary` runs between job polls, at
  most once every five minutes per worker; a failure is logged redacted and retried at
  the next interval.
- **CLI.** `cli/keel-breakglass.mjs`: `report` (JSON; exits 1 when not ready),
  `register`, `retire`, `record --kind validated|credential-rotated|methods-attested`,
  `canary`. Writes need `configuration` on the given principal.
- **Read-only method reader contract.** `observeBreakGlassMethods` takes an injected
  tenant-bound `collector-read-only` reader (`readMethods({ accountId })`), needs
  `collect`, and records `methods-observed`. Only the synthetic fixture reader exists.
- **Portal.** `/readiness` ("Emergency access", in the Restore section, `read`
  tenant-wide only). One card per account with its five checks in words and its
  reminders, one card for the canary and the emergency-account alerts, one for the
  policy surfaces. Codes, object ids, policy keys, alert ids, audit event ids and the
  correlation id are under "Technical details". The alerts inbox explains
  `break-glass` alerts in words. The page only reads; lifecycle writes go through the
  CLI.

## Validation (2026-10-03, isolated local PostgreSQL 16)

- `node --test engine/roadmap/breakglass-readiness.test.mjs engine/restore/*.test.mjs
  engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs
  cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs`:
  37 pass, 0 fail (the new file has 7 tests).
- Portal: `npm run typecheck` clean. Run one file at a time (`npm test` can hang
  locally): `readiness-view` 6/6, `read-page-auth` 5/5, `read-auth` 4/4,
  `experience-contract` 6/6, `nav-links` 1/1, `command-palette` 3/3.
- UI harness (`node ui-harness/build.mjs && npx playwright test -c
  ui-harness/playwright.config.ts`): 109 pass, including two new routes (a11y in both
  themes, the contract checks) and a new interaction test.
- Related engine suites (alert-escalation, alert-state, change-attribution,
  audit-ingestion, portal-experience, recovery-metrics): 44 pass.
- Required mutations, each applied to `engine/safety/breakGlassReadiness.mjs`, run,
  and reverted:
  - Collapse readiness to the CA exclusion boolean: tests 1, 2, 4 and 5 fail.
  - Assume an absent method means secure: tests 1 and 2 fail.
  - Suppress the emergency-account usage event: test 3 fails.

## Limits

- **No live method reader.** Microsoft exposes registered methods per user
  (`/users/{id}/authentication/methods`), but no reader for it exists here; it must be
  built on the read-only contract above and qualified separately. Until then, method
  evidence is a person's attestation (shown as "recorded by a person").
- **No live audit reader**, as in tasks 88 and 91. The canary sees only what ingestion
  stored, so its latency is the ingestion schedule plus the five-minute sweep. A
  sign-in ingested after a newer one for the same account is recorded but not applied
  (task 82's ordering rule); it does not reopen the alert.
- **Certificate methods** count as phishing resistant whenever registered; whether the
  tenant's certificate-based authentication binding makes them multifactor is not
  read. Method policy include and exclude targets are not evaluated.
- **Conditional Access** is evaluated on users, groups and roles only. A policy that
  includes the account but whose other conditions (location, platform, client app)
  might not match it still counts as reaching it, which can only make the verdict
  stricter. Grant controls are not evaluated: an emergency account must be left out.
- **Role activation rules, legacy risk policies, security defaults and admin app
  restrictions** are unsupported and shown as such.
- The test record is a person's statement. It is not corroborated against the
  sign-in log, although an alert for the test sign-in is expected and marked as
  planned when both exist.
- The report reads the newest covered collection per type, so its dimensions may come
  from collections taken at different times; each dimension keeps its collection time.
