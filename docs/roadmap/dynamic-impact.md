# Bounded dynamic group impact prediction (task-60)

Date: 2026-10-02 UTC. Status: implemented, fixture-tested only. D3 (dynamic
group scale) is **unqualified** until real sizing evidence is measured. Nothing
here writes to a tenant.

## What was built

- `engine/graph/dynamicImpact.mjs` (new) — `predictDynamicImpact()` answers:
  if this principal's attributes change, which dynamic groups might its
  membership change in — directly, through rules that reference other groups
  (`memberof`), and through static nesting above those groups?
  - **Documented rule subset** (`SUPPORTED_RULE_SUBSET`): `user.*`/`device.*`
    with `-eq -ne -startsWith -notStartsWith -contains -notContains -in
    -notIn`, `-and -or -not`, parentheses, string/bool/null/list values, and
    `memberof -any (group.objectId -in [...])`. Comparisons are
    case-insensitive. Everything else (`-match`, `-le`, `-ge`, `-all`, other
    `-any` forms, nested properties) is refused by the parser.
  - **Three-valued evaluation** (true / false / unknown): a missing attribute,
    an unknown membership or an unsupported rule can only widen the bound.
  - **Never exact membership.** Outcomes are `predicted-change` (with
    join/leave), `no-predicted-change` or `possibly-affected` with named
    reasons: `unsupported-expression`, `unknown-attribute:*`,
    `unknown-membership:*`, `rule-processing-paused`, `stale-member-data`,
    `cyclic-rule-dependency`, `work-budget-exhausted`, `nested-membership`.
    Every result carries `exactMembership: false` and the caveat
    `rule-processing-delay` (Entra evaluates rules asynchronously).
  - **Dynamic reverse impact:** the before- and after-worlds are each solved to
    a fixpoint; a changed dynamic membership re-queues every rule referencing
    it, so a group affected only through `memberof` is found (`indirect`,
    `via`). Static parents above any possibly-changed group are reported
    `possibly-affected` (other paths in are not modelled).
  - **Bounded:** `maxSteps` (clause evaluations + nesting hops) and `maxMs`
    (injected clock). An exhausted budget marks everything that could depend
    on the change `possibly-affected`, sets `complete: false` and claims no
    upper bound. Cycles (oscillating rules, nesting loops) terminate via a
    per-group re-evaluation cap and visited sets.
  - `discloseDynamicImpact()` folds a prediction into a task-59 impact
    analysis: affected groups are listed and the claim becomes non-exact.
- `engine/safety/blastRadius.mjs` — `dynamicImpactPolicy()`: any group not
  predicted unchanged is at least access-affecting, a role-assignable one
  tenant-lockout. Automated change is refused when the prediction is
  incomplete, when a role-assignable group is only possibly affected, or when
  possibly-affected groups exceed the caller's ceiling. An unclassified
  outcome throws.
- `tools/qualification/dynamicGroups.mjs` (new):
  - `benchmark`: deterministic synthetic tenant (seeded PRNG) through the
    production predictor; reports generated input size and MEASURED runtime
    and steps only. `synthetic: true`, `d3: 'unqualified'`,
    `tenantFigures: null`.
  - `collectSizingEvidence(reader, …)`: read-only pass over an injected reader
    (`reader.collect` only); counts what it read, times one prediction, never
    extrapolates an incomplete read. Requires a derived tenant ref and an
    explicit `synthetic` flag.
  - `sizing --evidence FILE`: D3 becomes `measured` only for complete,
    non-synthetic, tenant-scoped Graph-read evidence; every reported number is
    copied from the evidence or null. `measured` is not `qualified`: setting
    the D3 ceiling remains an operator decision.

Sample synthetic run in the build sandbox (`benchmark --groups 3000 --nesting
800 --seed 7`): 5,183 clauses, 289 memberof rules, ~94 ms, 14,923 steps. This
is the sandbox's own measurement of synthetic input, not a tenant figure.

## Implementation and proof limitations

- Fixture-tested only. The rule grammar follows the documented Entra dynamic
  membership syntax as known to the builder; the Microsoft docs were not
  reachable from this environment, so the subset was not re-verified against
  the current reference page on this date.
- Device rules are evaluated only for device principals; a user change never
  affects a `device.*` rule. Rules mixing subjects are evaluated per subject.
- No live sizing evidence exists yet: run `collectSizingEvidence` from the
  orchestrating session with collector credentials, then `sizing`.
- The predictor is not yet called from the remediation/restore CLI; callers
  compose it with `discloseDynamicImpact` and `dynamicImpactPolicy`.

## Boundary tests

`engine/roadmap/dynamic-impact.test.mjs` (14 tests). The three required
mutations were each applied and killed:

- Interpret unsupported expression as false.
- Ignore work budget.
- Omit dynamic reverse impact.
