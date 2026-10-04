# Bounded proposed-policy scenario evaluation (task 95)

## Status — 2026-10-04

Built on the current HEAD, on top of task 60 (bounded dynamic group impact) and task 94
(emergency account readiness). **Fixture-tested only.** No Microsoft call was made and
no Conditional Access policy was read live or changed: every policy, named location,
role assignment and What If response used here is a synthetic fixture.

## What it answers

"If this proposed Conditional Access change were enforced next to every policy that is
already enforced, which sampled sign-in paths of the protected principals stay open?"

`engine/safety/policyScenario.mjs#evaluateProposedPolicySet` lays the proposal
(`create`, `update`, `delete` by natural key) over the current policy set
(`combinePolicySet`) and evaluates the **combined** set. A sign-in path is open only when
every applying enforced policy lets it through, so two policies that each leave a path
open can together close all of them. The per-change view a diff would give is computed
too (`isolated`), and principals that only the combination locks out are listed in
`combinationOnly`.

A proposal that updates a policy KEEL has not collected, or creates one that exists, is
refused instead of guessed. Report-only and disabled policies never decide access.

## Supported predicate subset

`SUPPORTED_POLICY_SUBSET` is the explicit list. Evaluation is three-valued (true, false,
unknown):

| Part | Evaluated | Unknown |
|---|---|---|
| Users | include/exclude users, `All`; groups only through complete membership reads (task 94 `policyTreatment`); roles only from collected active assignments | unread group membership, uncollected roles, guest or external user conditions for a guest principal |
| Applications | `All`, `None`, the scenario's exact application token | suite tokens (`Office365`, `MicrosoftAdminPortals`) or ids that may contain the scenario's application; user actions, authentication contexts, application filters |
| Client apps | `all`, `browser`, `mobileAppsAndDesktopClients`, `exchangeActiveSync`, `other` | any other value |
| Platforms | include/exclude with known platform names | unknown names |
| Locations | `All`, `AllTrusted`, named location ids | `AllTrusted` against a location whose trust flag was not collected |
| Risk | `userRiskLevels`, `signInRiskLevels` | unknown levels |
| Grant | `block`, `mfa`, `compliantDevice`, `domainJoinedDevice`, `approvedApplication`, `compliantApplication`, `passwordChange`, authentication strength by id, `AND`/`OR` | terms of use, custom controls, other controls, a capability the principal is not known to have or lack |
| Session | `signInFrequency`, `persistentBrowser` (they do not decide access) | every other session control (continuous access evaluation, app enforced restrictions, Defender for Cloud Apps, resilience defaults, ...) |
| Other conditions | — | device filters and legacy device states, client applications, authentication flows, insider and service principal risk, any unknown key |

An unsupported condition makes the policy's applicability **unknown**; it never turns
into "does not apply" or "allowed". A scenario is `blocked` when an applying policy
blocks or demands a control the principal is known not to have; `unknown` when a policy
that might apply could block it or its controls cannot be judged; `allowed` otherwise.

## Scenarios, coverage and budget

Scenarios are generated per principal from scoped dimensions: application (default the
admin portals), client app type (browser, mobile and desktop), platform (Windows,
macOS, iOS, Android, Linux), location (each collected named location with its trust
flag, plus "outside every named location"), user risk and sign-in risk (default
`none`). A proposal may scope any dimension per principal (`paths`).

The budget is `maxScenarios` (default 256, at most 4,096) and `maxSteps` (default
1,000,000, at most 10,000,000). When the matrix is larger than `maxScenarios`, a
deterministic sample covering every dimension value first, then evenly strided, is
evaluated. Every result carries `coverage`: matrix size, evaluated, untested,
`selection` (`complete` or `sampled`), `truncated` and `truncatedBy` (`max-scenarios`,
`max-steps`).

## Verdicts

Per principal:

- `pass`, basis **always `sampled`**: at least one evaluated path is open. It is never a
  claim that the principal cannot be locked out (`universalSafety: 'not-asserted'` on
  every result; there is no "safe" verdict).
- `lockout`: the whole matrix was evaluated (not truncated) and every scenario is
  blocked.
- `unknown`: no open path was found, and some scenarios were unevaluable or untested
  (budget truncation, unsupported conditions, missing inventory).

`simulationGate.mjs#proposedPolicyGate` turns an evaluation into `refuse` (a protected
principal is locked out), `review` (unknown) or `sampled-pass`. It is advisory evidence
for a person: its result always says `authorizesWrite: false`,
`signInPathCheck: 'still-required'` and `reportOnlyEnforcement: 'unchanged'`, and no
write path reads it.

## Existing gates are unchanged

- The restore sign-in path gate (`signInPathGate.mjs`, run by `applyWave` before and
  after writes) is untouched and still fails a run whose sign-in path changed, whatever
  a scenario evaluation said (tested by passing a sampled-pass result into the same
  call).
- A tenant-lockout delete still needs `simulationPassed: true`, which no production
  CLI sets and no gate result carries (tested).
- Restore still forces Conditional Access writes to report-only
  (`conditionalAccessGuard.mjs`).
- The task 94 break-glass coverage precondition and readiness are unchanged.

## Microsoft What If

What If evaluates a tenant's **live** policies for one sign-in. It is a separate read
and never proof of a proposed combined set. `readLiveWhatIf` is a fixture-tested read
contract; its result is `kind: 'live-policy-read'`, `evaluates:
'current-live-policies'`, `provesProposedState: false`. `attachLiveReads` attaches such
reads as evidence and changes no verdict; it refuses anything that claims to prove the
proposed state. The older delegated-credential prototype (`evaluatePromotion`) now
labels its result the same way. No live What If call exists: the API needs delegated
credentials KEEL does not hold.

## Server, CLI and qualification

- **Server.** `evaluateProposalForTenant(client, { tenantRef, proposal, budget })`
  reads the newest covered `conditionalAccessPolicy`, `namedLocation` and
  `roleAssignment` collections and complete group membership reads. Protected
  principals are the registered task 94 emergency accounts, whose MFA and
  authentication strength capabilities come only from their method evidence (none
  means unknown; device capabilities are never inferred), plus any principal the
  proposal names. Read-only.
- **CLI.** `cli/keel-policy-scenario.mjs evaluate --proposal FILE [--tenant-ref REF |
  --config PATH] [--max-scenarios N] [--max-steps N] [--what-if FILE]` prints the gate
  and the evaluation as JSON. It exits 0 only for a sampled pass, 1 for lockout or
  unknown, 2 for usage. It holds no Graph token and has no write path.
- **Qualification.** `tools/qualification/conditionalAccess.mjs benchmark` runs a
  seeded synthetic estate through the production evaluator and reports its coverage and
  measured runtime (synthetic only, `tenantFigures: null`); `what-if --evidence FILE`
  validates captured What If evidence against the read contract and reports that it
  qualifies nothing about a proposed state.
- **UI.** None in this task; the evaluation is reached through the CLI.

## Data and migration

No schema change and no stored data: an evaluation is computed on request. Legacy read:
a tenant with no covered Conditional Access collection evaluates to `unknown`
(`policy-inventory-unavailable`), never a pass; without registered emergency accounts
and without principals in the proposal the result is `unknown`
(`no-protected-principals`). `loadGroupMembership` in `breakGlassReadiness.mjs` is now
exported (no behaviour change).

## Validation (2026-10-04, isolated local PostgreSQL 16)

- `node --test engine/roadmap/policy-simulation.test.mjs engine/restore/*.test.mjs
  engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs
  cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs`:
  37 pass, 0 fail (the new file has 7 tests).
- Related suites (`breakglass-readiness`, `dynamic-impact`, `contract`): 22 pass.
- `node tools/qualification/conditionalAccess.mjs benchmark --policies 200 --locations
  20 --seed 7`: 210-scenario matrix fully evaluated in about 0.12 s on this machine
  (synthetic; not a tenant figure).
- Required mutations, each applied to `engine/safety/policyScenario.mjs`, run and
  reverted:
  - Evaluate each policy independently only: tests 1, 5 and 7 fail.
  - Turn an unsupported predicate into allow: test 2 fails.
  - Treat a live What If read as proposed-state proof: tests 5 and 7 fail.

## Limits

- **Sampled, never universal.** The matrix is a finite, scoped set of paths. Real
  sign-ins vary in ways it does not model (device state, client app details,
  authentication context, token protection, continuous access evaluation). A pass shows
  one sampled open path, not lockout safety.
- **Subset only.** Everything outside the supported subset is unknown, so a tenant that
  relies on device filters, authentication contexts or advanced session controls will
  see many unknowns.
- **Suites are not resolved.** KEEL does not know which applications `Office365` or
  `MicrosoftAdminPortals` contain; such targets are unknown unless the scenario uses the
  same token.
- **Capabilities.** MFA and authentication strengths come from task 94 method evidence
  or the proposal; device compliance and join state are only what the proposal states.
  Custom authentication strengths are matched by id only.
- **Surfaces outside Conditional Access** (security defaults, legacy risk policies, PIM
  activation rules, admin app restrictions) are not evaluated, as in task 94.
- **No live What If.** Only the read contract exists, fixture-tested. Any live read
  describes the current tenant at one instant and is never proof of a proposal.
- **Not wired into restore.** Restore writes Conditional Access policies report-only,
  so its plans do not change the enforced set; the evaluation is for operator-authored
  proposals through the CLI. It never gates or authorizes a write.
