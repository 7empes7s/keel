# Resumable Microsoft identity provisioning journal (task 75)

Implemented against task 74's current `planBootstrap` and prerequisite registry.
The executor is fixture-tested; no Microsoft identity operation is live-qualified
by this change. No live adapter, provisioning command, portal route, worker job
kind or service activation is installed. Conditional Access is never enforced.
The only actions admitted are the existing planner's identity prerequisite
operations; configuration restore and remediation retain their existing engines.

## Entry points and approval

`cli/keel-bootstrap.mjs` exports `runBootstrap` for authenticated host composition:
`plan` (the default), `approve`, `execute`, and `status`. The host creates a
`BootstrapJournal` using a dedicated PostgreSQL connection, its configured
`tenantRef` and authenticated `principalId`. Never construct that context from
untrusted request parameters. Each read/write rechecks the existing `configuration`
capability; approval and subsequent artifact use also require the existing
`approve` capability. No new capability matrix or portal inventory is introduced.
The current portal gates are `portal/lib/action.ts` and `portal/lib/read.ts`;
this task adds no portal surface (guided UI is task 76).

Approval takes the planner output, separate collector/restorer reference pairs,
a build identifier, and current authoritative prerequisites. The executor checks
intent against the existing workload prerequisite registry both at approval and
execution. The entire artifact, including observations, reference bindings,
prerequisite revision, run-as principal, build and qualification mode, is hashed
with canonical SHA-256. Execution loads only that stored artifact, freezes it and
rechecks its hash; mutable planId alone is not an approval. Edits require fresh
approval. The journal never overwrites an approved artifact.

Both credential pairs contain only `credentialRef` and `identityRef`. References
must be distinct for collector and restorer; every identity write is passed the
restorer credential reference. An observed appId must match its approved identity
reference. The adapter must resolve those references to the intended distinct
identities and authenticate without exposing any credential value to this API.
For new app registrations the host must establish that reference binding before
approval; guessing an app identity or adopting an unrelated app is unsupported.

## Adapter boundary

All adapter methods are injected; the repository ships no Microsoft transport for
this executor. The host must trust/qualify an implementation before injecting it.
No external API route or API permission claim has been introduced by this task;
the source URLs and retrieval dates for declared grants remain in task 74's
prerequisite registry. A real adapter requires independent current official API
review and tenant-specific qualification before use.

- `prerequisites(context)` returns `{revision, allowed, killSwitch}`. `allowed`
  must reflect current Microsoft grants, active operator authority (PIM eligibility
  alone is insufficient), reference resolution, source authority and host limits.
  The revision fingerprints those prerequisites, excluding expected provisioning
  progress. Revocation or any changed revision stops the run. This is checked
  before observation, before each write, after writes and at final verification.
  The executor additionally honors the existing `AUTOMATION_KILL_SWITCH_PATH`.
- `qualify({...context, step, credentialRef, intentHash})` must return matching
  tenantRef, credentialRef, operation (step.action), intentHash, build, projection
  (`identity-v1`), status and a future expiresAt. intentHash binds identity,
  workload and exact least-privilege scope derivation, not merely an action name.
  Default status/mode is `live-qualified`; tests explicitly use `fixture-tested`,
  which cannot execute an artifact in live-qualified mode. Declared, unsupported,
  unknown or expired qualification refuses a write. Qualification is a trusted
  host evidence boundary, not a self-certification by an HTTP caller.
- `observe({...context, step})` performs authoritative reconciliation, returning
  tenantRef, status (`absent`, `partial`, `satisfied`) and reference-only objectId,
  appId and servicePrincipalId as applicable. A satisfied registration requires
  all three identifiers. Empty successful reads can mean absent; errors, unknown,
  ambiguous matches and cross-tenant results must fail. A satisfied consent step
  means every desired privilege was verified for that identity, not just that an
  assignment request was accepted. Manual steps require observed completion.
- `ensure({...context, step, credentialRef, observed, idempotencyKey})` converges
  only the approved operation, reusing partial apps/SPs and existing privileges.
  It must honor the stable tenant/plan/step idempotency key and authoritative
  observed references. Return values never constitute proof: every write is
  followed by fresh observation. Internal multi-call adapters must recheck live
  authority and reconcile before retrying individual calls. Transport retries
  must never blindly POST an identity or privilege twice.

The executor checks manual authorities before writing anything, so pending manual
steps return `pending-manual`, never `complete`. It commits desired and observed
evidence before ensure; exceptions retain an uncertain outcome without recording
raw adapter errors. Resume always reads journal history and fresh observations.
A lost acknowledgement after successful creation therefore verifies the observed
object instead of recreating it. A disappeared previously verified grant stops
execution instead of silently re-granting it. Three uncertain writes exhaust the
per-artifact/step retry budget; there are no automatic transport retries. The
finite approved step set bounds the operation scope. Every step is reobserved
before completion. Adapter quotas/impact limits must also be reflected by the
current prerequisite gate.

Tenant advisory locking serializes all bootstrap runs across DB connections;
use one dedicated connection per journal execution, outside an enclosing DB
transaction so evidence is committed before remote effects. Locks release on
exit or connection loss. Correctness across a lost DB connection and an in-flight
remote request also depends on the qualified adapter's idempotent ensure contract.

## Migration and evidence

`migrateBootstrapJournal(client)` is an explicit additive, retry-safe local schema
migration creating `bootstrap_plan` and `bootstrap_event`. Both have tenant_ref;
events have a composite tenant/approved-artifact foreign key. No earlier executor
tables existed at implementation HEAD. Existing task-74 plan JSON remains readable
through the planner, but is not migrated into an approval. Unknown artifact
versions fail closed; migration does not rewrite historical evidence.

Evidence is reference-only and token-checked. Arbitrary observation properties
and adapter error messages are excluded. If authorization is revoked immediately
after a remote write, the next journal write is refused too: earlier desired and
observed events intentionally remain unresolved. A currently authorized operator
must establish fresh approval/authority before reconciling. Completed fake evidence
is labelled fixture-tested and makes no live Microsoft support claim.

The standalone CLI accepts `[--mode plan] --fixture FILE` and prints an offline
plan. The fixture supplies tenantRef, workloads, optional operatorPrincipalId,
and six explicit observed arrays (applications, servicePrincipals,
appRoleAssignments, roleAssignments, roleEligibilitySchedules, subscribedSkus).
It never loads tenant credentials or opens a network connection. Execution modes
are available only through the authenticated host function with injected adapters.

## Verification

`engine/roadmap/bootstrap-executor.test.mjs` exercises the production executor,
planner, journal, CLI seam and existing authorization tables using fake identity
adapters and isolated schemas from `engine/test/dbTestHelper.mjs`. Tests include
lost acknowledgements, partial creation, local/Microsoft revocation, changed
prerequisites, distinct credentials, immutable approvals, tenant isolation,
manual holds, qualification mismatch/expiry, failed verification, retry limits,
concurrent workers, the existing kill switch, and additive migration preservation.

Required validation from `/opt/keel`:

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/bootstrap-executor.test.mjs engine/authz/*.test.mjs engine/jobs/*.test.mjs
```

Live provisioning/rehearsal is reserved for the orchestrating session. This task
does not clear qualification gates, restart services or commit changes.

Mutation review (2026-09-26, each mutation restored before the next):

- Retry creation without authoritative journal reconciliation: exit 1, 15 pass /
  3 fail (lost acknowledgement, partial registration, invalid observations).
- Proceed after grant revocation by removing execution and journal reauthorization:
  exit 1, 17 pass / 1 fail (revoked local grant).
- Share collector credential for writes: exit 1, 16 pass / 2 fail (credential
  separation and qualification scoping).

Additional adversarial review covered disappearing verified privileges, prerequisite
revocation immediately after a write, cross-connection execution locks, and bounded
uncertain retries. All mutation edits were restored; no exemptions were added.

Requeue verification (2026-09-26): the production cross-tenant observation check
and final all-step observation loop were already present and are preserved.
The earlier foreign-tenant fixture also lacked registration identifiers, so it
could fail for the wrong reason. New boundary fixtures supply complete valid
identifiers and change only tenantRef, targeting every step independently across
collector/restorer registrations, consent, KEEL permissions, workload RBAC and
PIM. Another fixture makes each outcome disappear only on final observation;
each run must stop without completion. A successful run also verifies persisted
final observations for all steps immediately before the completion event. Resume
now has an explicit failure fixture for unavailable persisted journal history.

Each mutation below was run separately with the full required validation command,
then restored byte-for-byte. Counts include nested boundary cases:

| Mutation | Exit | Pass | Fail |
| --- | --- | --- | --- |
| Accept complete cross-tenant observations | 1 | 33 | 9 |
| Skip final all-step re-observation | 1 | 33 | 9 |
| Retry without persisted journal history | 1 | 39 | 3 |
| Proceed after prerequisite grant revocation | 1 | 40 | 2 |
| Use collector credential for identity writes | 1 | 40 | 2 |
| Automate pending manual authority steps | 1 | 41 | 1 |

The unmutated full validation passes 42 tests with zero failures or skips. This
remains fixture/local-test-database evidence only, not live qualification.

Requeue verification (2026-09-27): the incomplete-registration and approved-appId
guards were already implemented; the remaining gap was independent boundary
coverage. New fixtures remove objectId, appId or servicePrincipalId individually
from otherwise valid satisfied registrations, and separately substitute either
the other approved identity's appId or an unrelated appId with all identifiers
present. Both collector and restorer registrations are exercised during initial
reconciliation, post-write verification and final verification. Each case must
stop execution, reject the invalid observation before journaling it, and never
record completion or additional writes. Valid earlier evidence remains intact.

Each mutation was run separately with the full required validation command and
the production executor restored byte-for-byte afterward. Counts include parent
tests that fail when their nested cases fail:

| Mutation | Exit | Pass | Fail |
| --- | --- | --- | --- |
| Accept incomplete satisfied registrations | 1 | 55 | 19 |
| Accept appId outside its approved identity binding | 1 | 61 | 13 |
| Retry without persisted journal history | 1 | 71 | 3 |
| Proceed after prerequisite grant revocation | 1 | 72 | 2 |
| Use collector credential for identity writes | 1 | 72 | 2 |

The expanded unmutated full validation passes 74 tests with zero failures or
skips. These checks use injected fakes and the isolated local test database only;
they add no live qualification or Microsoft API support claim.

Requeue verification (2026-09-27, local grant revocation): the executor already
reloads the approved journal artifact after qualification and before ensure.
The missing evidence was revocation within that interval. New isolated-database
fixtures delete either the admin or approver role_grant during a successful
qualification, before the first or second write, while external prerequisites
remain valid. Execution must reject authorization without the pending write,
without changing its observed object, and without appending further evidence or
completion. Earlier authorized writes and journal evidence remain intact.

The exact required validation command was run for each mutation independently;
the executor was restored byte-for-byte after each run:

| Mutation | Exit | Pass | Fail |
| --- | --- | --- | --- |
| Remove journal.load from guard (proceed after local grant revocation) | 1 | 74 | 5 |
| Skip satisfied-observation short-circuit before ensure (retry creation) | 1 | 39 | 40 |
| Bind write qualification to collector credential | 1 | 77 | 2 |

The local-revocation mutation produces one unauthorized extra write in each of
the four new cases; all four assertions and their parent test fail. The restored
validation passes 79 tests with zero failures or skips. Production behavior is
preserved under Global Constraint 12; this change adds boundary coverage and
fixture evidence only. No live tenant writes, service restarts, or Conditional
Access enforcement were performed.

Requeue verification (2026-09-27, credential extra fields and adapter kill switch):
production already rejects every collector/restorer property except credentialRef
and identityRef, and requires killSwitch to be exactly false. Those guards are
preserved under Global Constraint 12. New CLI approval boundary cases supply
opaque fixture values under notes and nested metadata for each credential,
requiring rejection before prerequisite adapters run and before any artifact or
event is persisted. These values deliberately do not trip the generic token/key
scanner, so the cases independently exercise the reference-only allowlist.

New prerequisite fixtures omit killSwitch or supply null, 0, an empty string,
"false", "true", or an object. Each is tested at approval, execution entry and
after successful qualification immediately before a write. Invalid responses
must prevent approval persistence or stop execution without writes, verified
outcomes or completion. Existing valid-false cases still complete successfully.

Each mutation below used the full required validation command independently;
the executor was restored byte-for-byte after every run. Failure counts include
parent tests whose nested cases fail:

| Mutation | Exit | Pass | Fail |
| --- | --- | --- | --- |
| Block only killSwitch === true (fail open) | 1 | 84 | 22 |
| Remove collector/restorer extra-key restriction | 1 | 101 | 5 |
| Retry without persisted journal history | 1 | 103 | 3 |
| Remove journal.load reauthorization from guard | 1 | 101 | 5 |
| Bind write qualification to collector credential | 1 | 104 | 2 |

Unmutated validation passes 106 tests with no failures or skips. Evidence is
limited to injected adapters and isolated local test schemas; no live tenant
writes, service restarts, Conditional Access enforcement or qualification changes
were performed.

Requeue verification (2026-09-29): the existing implementation passed all 106
tests before changes; no missing production requirement was found. Preserved
the implementation under Global Constraint 12 and added boundary evidence that
desired and observed journal events are visible from a separate database
connection before every provisioning write. Qualification now has an explicit
wrong-projection rejection fixture in addition to the existing scope checks.

Each mutation used the full required validation command and was restored
byte-for-byte before the next run:

| Mutation | Exit | Pass | Fail |
| --- | --- | --- | --- |
| Retry without persisted journal history | 1 | 104 | 3 |
| Remove journal.load reauthorization from guard | 1 | 102 | 5 |
| Bind write qualification to collector credential | 1 | 105 | 2 |
| Omit desired evidence before provisioning | 1 | 105 | 2 |
| Accept qualification for a different projection | 1 | 106 | 1 |

These checks use only injected fakes and isolated local test database schemas.
They do not establish live qualification or activate provisioning.
