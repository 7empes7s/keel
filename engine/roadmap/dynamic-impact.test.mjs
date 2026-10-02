/**
 * Roadmap task-60 boundary tests: bounded dynamic-group impact prediction.
 * Exercises the production predictor (engine/graph/dynamicImpact.mjs), its
 * refusal policy (engine/safety/blastRadius.mjs), its disclosure into a task-59
 * impact analysis, and the scale/sizing harness
 * (tools/qualification/dynamicGroups.mjs) — including the three required
 * mutation checks:
 *
 * - Interpret unsupported expression as false.
 * - Ignore work budget.
 * - Omit dynamic reverse impact.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  predictDynamicImpact, parseMembershipRule, discloseDynamicImpact, UnsupportedRuleError, SUPPORTED_RULE_SUBSET,
} from '../graph/dynamicImpact.mjs';
import { buildImpactGraph, analyzeImpact } from '../graph/impact.mjs';
import { dynamicImpactPolicy } from '../safety/blastRadius.mjs';
import {
  runSyntheticBenchmark, generateSyntheticTenant, collectSizingEvidence, sizingReport, main,
} from '../../tools/qualification/dynamicGroups.mjs';

const TENANT = 'sha256:' + 'a'.repeat(64);

const salesToEng = (extra = {}) => ({
  naturalKey: 'user:alice',
  subject: 'user',
  before: { attributes: { department: 'Sales', country: 'US', accountEnabled: true }, memberOf: ['d-sales'], memberOfComplete: true },
  after: { attributes: { department: 'Engineering', country: 'US', accountEnabled: true } },
  ...extra,
});
const dyn = (naturalKey, sourceId, membershipRule, extra = {}) => ({ naturalKey, sourceId, membershipRule, processingState: 'On', ...extra });
const resultFor = (prediction, key) => prediction.results.find((r) => r.naturalKey === key);

// ------------------------------------------------- direct and indirect effects

test('an attribute edit predicts direct joins and leaves, never exact membership', () => {
  const p = predictDynamicImpact({
    principal: salesToEng(),
    groups: [
      dyn('group:Sales', 'd-sales', 'user.department -eq "Sales"'),
      dyn('group:Eng', 'd-eng', '(user.department -eq "engineering") -and (user.country -in ["US","FR"])'),
      dyn('group:France', 'd-fr', 'user.country -eq "FR"'),
    ],
  });
  assert.equal(p.exactMembership, false);
  assert.deepEqual(p.caveats, ['rule-processing-delay']);
  assert.equal(resultFor(p, 'group:Sales').outcome, 'predicted-change');
  assert.equal(resultFor(p, 'group:Sales').direction, 'leave');
  assert.equal(resultFor(p, 'group:Eng').direction, 'join');
  assert.equal(resultFor(p, 'group:France').outcome, 'no-predicted-change');
  assert.deepEqual(p.summary.bounds, { atLeastPredicted: 2, atMost: 2 });
});

test('an attribute edit discovers an indirectly affected dynamic group (memberOf) and static parents above it', () => {
  // "group:A-..." sorts before "group:Sales": the dependent is evaluated first,
  // so only reverse propagation from Sales' change can discover it.
  const p = predictDynamicImpact({
    principal: salesToEng(),
    groups: [
      dyn('group:Sales', 'd-sales', 'user.department -eq "Sales"'),
      dyn('group:A-SalesAlumniLink', 'd-link', 'user.memberof -any (group.objectId -in ["d-sales"])'),
      dyn('group:A-SecondHop', 'd-hop2', 'user.memberof -any (group.objectId -in ["d-link"])'),
    ],
    nesting: [{ parentSourceId: 'p-1', parentNaturalKey: 'group:StaticParent', memberSourceId: 'd-hop2' }],
  });
  const link = resultFor(p, 'group:A-SalesAlumniLink');
  assert.equal(link.outcome, 'predicted-change');
  assert.equal(link.indirect, true);
  assert.deepEqual(link.via, ['group:Sales']);
  const hop2 = resultFor(p, 'group:A-SecondHop');
  assert.equal(hop2.outcome, 'predicted-change');
  assert.deepEqual(hop2.via, ['group:A-SalesAlumniLink']);
  const parent = resultFor(p, 'group:StaticParent');
  assert.equal(parent.outcome, 'possibly-affected', 'other paths into a static parent are not modelled');
  assert.equal(parent.kind, 'static-nesting');
  assert.deepEqual(parent.reasons, ['nested-membership']);
});

test('a rule over another subject or an unchanged attribute is not affected', () => {
  const p = predictDynamicImpact({
    principal: salesToEng(),
    groups: [dyn('group:Windows', 'd-win', 'device.deviceOSType -eq "Windows"'), dyn('group:US', 'd-us', 'user.country -eq "US"')],
  });
  assert.equal(resultFor(p, 'group:Windows').outcome, 'no-predicted-change');
  assert.equal(resultFor(p, 'group:US').outcome, 'no-predicted-change');
});

// --------------------------------------------- unsupported -> bounded unknown

test('an unsupported expression is possibly-affected, never treated as non-matching', () => {
  const p = predictDynamicImpact({
    principal: salesToEng(),
    groups: [
      dyn('group:Regex', 'd-rx', 'user.department -match "^Eng.*"'),
      dyn('group:Licensed', 'd-lic', 'user.assignedPlans -any (assignedPlan.capabilityStatus -eq "Enabled")'),
      dyn('group:B-DependsOnRegex', 'd-dep', 'user.memberof -any (group.objectId -in ["d-rx"])'),
    ],
  });
  for (const key of ['group:Regex', 'group:Licensed']) {
    assert.equal(resultFor(p, key).outcome, 'possibly-affected');
    assert.deepEqual(resultFor(p, key).reasons, ['unsupported-expression']);
  }
  const dependent = resultFor(p, 'group:B-DependsOnRegex');
  assert.equal(dependent.outcome, 'possibly-affected', 'a rule over an unsupported group inherits the unknown');
  assert.ok(dependent.reasons.includes('unknown-membership:d-rx'));
  assert.equal(p.summary.bounds.atMost, 3);
  assert.equal(p.summary.bounds.atLeastPredicted, 0);
});

test('the supported subset parses; anything outside it is refused by the parser', () => {
  assert.doesNotThrow(() => parseMembershipRule('-not (USER.Department -EQ "x") -or user.city -notIn ["a", "b"] -and user.mail -startsWith "a"'));
  for (const rule of ['user.department -match "x"', 'user.employeeHireDate -le 2020', 'user.department', '', 'mail -eq "x"', 'user.x.y -eq "1"']) {
    assert.throws(() => parseMembershipRule(rule), UnsupportedRuleError, rule);
  }
  assert.ok(SUPPORTED_RULE_SUBSET.operators.includes('-in'));
});

test('missing attributes, a paused rule and stale principal data all widen to possibly-affected', () => {
  const missing = predictDynamicImpact({
    principal: salesToEng(),
    groups: [dyn('group:EngManagers', 'd-m', 'user.department -eq "Engineering" -and user.jobTitle -eq "Manager"')],
  });
  assert.deepEqual(resultFor(missing, 'group:EngManagers').reasons, ['unknown-attribute:jobtitle']);
  assert.equal(resultFor(missing, 'group:EngManagers').outcome, 'possibly-affected');

  const paused = predictDynamicImpact({
    principal: salesToEng(),
    groups: [dyn('group:Eng', 'd-eng', 'user.department -eq "Engineering"', { processingState: 'Paused' })],
  });
  assert.deepEqual(resultFor(paused, 'group:Eng').reasons, ['rule-processing-paused']);

  const stale = predictDynamicImpact({
    principal: salesToEng({ observedAt: '2026-09-01T00:00:00Z' }), now: new Date('2026-09-30T00:00:00Z'),
    groups: [dyn('group:Eng', 'd-eng', 'user.department -eq "Engineering"'), dyn('group:US', 'd-us', 'user.country -eq "US"')],
  });
  assert.deepEqual(resultFor(stale, 'group:Eng').reasons, ['stale-member-data']);
  assert.equal(resultFor(stale, 'group:US').outcome, 'no-predicted-change', 'a rule over unchanged attributes stays unchanged');
});

// ----------------------------------------------------------------- budgets

test('an exhausted step budget yields a bounded unknown, not a confident answer', () => {
  const groups = Array.from({ length: 20 }, (_, i) => dyn(`group:g${String(i).padStart(2, '0')}`, `d${i}`, 'user.department -eq "Engineering"'));
  const p = predictDynamicImpact({ principal: salesToEng(), groups, budget: { maxSteps: 5 } });
  assert.equal(p.complete, false);
  assert.equal(p.budget.exhausted, 'steps');
  assert.equal(p.summary.bounds.atMost, null, 'no upper bound is claimed from a cut-short run');
  assert.ok(p.results.every((r) => r.outcome === 'possibly-affected'));
  assert.ok(p.results.every((r) => r.reasons.includes('work-budget-exhausted')));
  assert.ok(p.budget.steps <= 6);
});

test('an exhausted time budget is enforced through the injected clock', () => {
  let t = 0;
  const clock = () => { t += 10; return t; };
  const groups = Array.from({ length: 10 }, (_, i) => dyn(`group:t${i}`, `t${i}`, 'user.department -eq "Engineering"'));
  const p = predictDynamicImpact({ principal: salesToEng(), groups, budget: { maxMs: 25 }, clock });
  assert.equal(p.complete, false);
  assert.equal(p.budget.exhausted, 'time');
});

// ------------------------------------------------------------------- cycles

test('cyclic rule dependencies and nesting cycles terminate', () => {
  const p = predictDynamicImpact({
    principal: salesToEng(),
    groups: [
      dyn('group:Sales', 'd-sales', 'user.department -eq "Sales"'),
      // X follows Sales-or-Y, Y is NOT X: an oscillating pair.
      dyn('group:X', 'd-x', 'user.memberof -any (group.objectId -in ["d-sales", "d-y"])'),
      dyn('group:Y', 'd-y', '-not (user.memberof -any (group.objectId -in ["d-x"]))'),
    ],
    nesting: [
      { parentSourceId: 'p', parentNaturalKey: 'group:P', memberSourceId: 'd-x' },
      { parentSourceId: 'q', parentNaturalKey: 'group:Q', memberSourceId: 'p' },
      { parentSourceId: 'p', parentNaturalKey: 'group:P', memberSourceId: 'q' },
    ],
  });
  assert.equal(p.complete, true);
  assert.ok(['group:X', 'group:Y'].some((k) => resultFor(p, k).outcome !== 'no-predicted-change'));
  assert.equal(resultFor(p, 'group:P').outcome, 'possibly-affected');
  assert.equal(resultFor(p, 'group:Q').outcome, 'possibly-affected');
});

// -------------------------------------------------------- refusal policy

test('the refusal policy escalates and refuses conservatively', () => {
  const privileged = predictDynamicImpact({
    principal: salesToEng(),
    groups: [dyn('group:Admins', 'd-adm', 'user.department -match "Eng"', { isAssignableToRole: true })],
  });
  const policy = dynamicImpactPolicy(privileged);
  assert.equal(policy.blastRadius, 'tenant-lockout');
  assert.equal(policy.refused, true);
  assert.equal(policy.refusals[0].reason, 'role-assignable-group-unbounded');
  assert.equal(policy.exactMembership, false);

  const ordinary = dynamicImpactPolicy(predictDynamicImpact({ principal: salesToEng(), groups: [dyn('group:Eng', 'd-eng', 'user.department -eq "Engineering"')] }));
  assert.equal(ordinary.blastRadius, 'access-affecting');
  assert.equal(ordinary.refused, false);

  const ceiling = dynamicImpactPolicy(predictDynamicImpact({ principal: salesToEng(), groups: [dyn('group:Rx', 'd-rx', 'user.x -match "y"')] }), { maxPossiblyAffected: 0 });
  assert.equal(ceiling.refusals[0].reason, 'possibly-affected-above-ceiling');

  const incomplete = dynamicImpactPolicy(predictDynamicImpact({
    principal: salesToEng(), groups: [dyn('group:Eng', 'd-eng', 'user.department -eq "Engineering"')], budget: { maxSteps: 1 },
  }));
  assert.ok(incomplete.refusals.some((r) => r.reason === 'dynamic-prediction-incomplete'));

  const none = dynamicImpactPolicy(predictDynamicImpact({ principal: salesToEng(), groups: [dyn('group:US', 'd-us', 'user.country -eq "US"')] }));
  assert.deepEqual([none.blastRadius, none.refused], [null, false]);
  assert.throws(() => dynamicImpactPolicy({ complete: true, results: [{ naturalKey: 'g', outcome: 'maybe' }] }), /unclassified/);
});

test('dynamic predictions are disclosed in the impact analysis and make it non-exact', () => {
  const resources = [{ naturalKey: 'user:alice', resourceType: 'user', references: [] }];
  const analysis = analyzeImpact(buildImpactGraph({ resources }), { operation: 'update', keys: ['user:alice'] });
  assert.equal(analysis.completeness.exact, true);
  const disclosed = discloseDynamicImpact(analysis, predictDynamicImpact({
    principal: salesToEng(), groups: [dyn('group:Eng', 'd-eng', 'user.department -eq "Engineering"')],
  }));
  assert.deepEqual(disclosed.dynamicGroups.map((g) => g.naturalKey), ['group:Eng']);
  assert.equal(disclosed.completeness.exact, false);
  assert.equal(disclosed.completeness.reasons.at(-1).reason, 'dynamic-membership-predicted');
  assert.notEqual(disclosed.fingerprint, analysis.fingerprint);
});

// ---------------------------------------------------- scale & sizing harness

test('the synthetic benchmark is deterministic in input and reports only measured runtime', () => {
  const a = generateSyntheticTenant({ seed: 42, groups: 300, nesting: 50 });
  const b = generateSyntheticTenant({ seed: 42, groups: 300, nesting: 50 });
  assert.deepEqual(a, b, 'same seed, same tenant');
  assert.notDeepEqual(generateSyntheticTenant({ seed: 43, groups: 300, nesting: 50 }).groups, a.groups);

  let t = 1000;
  const clock = () => { t += 7; return t; };
  const report = runSyntheticBenchmark({ seed: 42, groups: 300, nesting: 50, clock, budget: { maxMs: Infinity } });
  assert.equal(report.synthetic, true);
  assert.equal(report.d3, 'unqualified');
  assert.equal(report.tenantFigures, null, 'no tenant figure is invented');
  assert.equal(report.input.groups, 300);
  assert.equal(report.input.nestingEdges, a.nesting.length);
  assert.ok(report.measured.elapsedMs > 0 && report.measured.elapsedMs % 7 === 0, 'runtime comes from the clock, not a constant');
  assert.ok(report.measured.steps > 0);
  assert.equal(runSyntheticBenchmark({ seed: 42, groups: 300, nesting: 50 }).measured.predictedChange, report.measured.predictedChange);
});

test('the read-only sizing pass records what it read, and only real complete evidence is measured', async () => {
  const calls = [];
  const reader = {
    async collect(version, path, options) {
      calls.push({ version, path, options });
      return {
        items: [
          { id: 'g1', displayName: 'Eng', groupTypes: ['DynamicMembership'], membershipRule: 'user.department -eq "Engineering"', membershipRuleProcessingState: 'On' },
          { id: 'g2', displayName: 'Static', groupTypes: [] },
        ],
        pages: 1, status: 200, capped: false, error: null,
      };
    },
  };
  assert.equal(Object.keys(reader).join(), 'collect', 'the harness needs nothing but a read');
  await assert.rejects(() => collectSizingEvidence(reader, { tenantRef: 'raw-tenant-id', synthetic: true }), /derived tenant reference/);
  await assert.rejects(() => collectSizingEvidence(reader, { tenantRef: TENANT }), /explicit synthetic flag/);

  const fixture = await collectSizingEvidence(reader, { tenantRef: TENANT, synthetic: true });
  assert.deepEqual(fixture.counts, { groups: 2, dynamicGroups: 1, observedItems: 2 });
  assert.equal(calls.length, 1);
  assert.deepEqual(sizingReport(fixture).reasons, ['synthetic-or-unlabeled'], 'fixture evidence never measures D3');
  assert.equal(sizingReport(fixture).d3, 'unqualified');

  const real = await collectSizingEvidence(reader, { tenantRef: TENANT, synthetic: false });
  const report = sizingReport(real);
  assert.equal(report.d3, 'measured');
  assert.deepEqual(report.counts, { groups: 2, dynamicGroups: 1 });
  assert.equal(report.measured.predictionElapsedMs, real.measured.predictionElapsedMs);

  const partialReader = { collect: async () => ({ items: [{ id: 'g1', groupTypes: ['DynamicMembership'] }], pages: 1, capped: true, error: null }) };
  const partial = await collectSizingEvidence(partialReader, { tenantRef: TENANT, synthetic: false });
  assert.equal(partial.counts.groups, null, 'an incomplete read is never extrapolated');
  assert.ok(sizingReport(partial).reasons.includes('incomplete-read'));

  const empty = sizingReport({});
  assert.equal(empty.d3, 'unqualified');
  assert.deepEqual(empty.counts, { groups: null, dynamicGroups: null });
  assert.equal(empty.measured.predictionElapsedMs, null);
});

test('the harness CLI prints a benchmark and gates sizing on evidence', () => {
  const lines = [];
  assert.equal(main(['benchmark', '--groups', '50', '--seed', '3'], { log: (l) => lines.push(l) }), 0);
  assert.equal(JSON.parse(lines[0]).input.groups, 50);
  const evidence = { tenantRef: TENANT, capturedAt: '2026-10-01T00:00:00Z', source: 'graph-read', synthetic: false, readComplete: true,
    counts: { groups: 10, dynamicGroups: 3 }, measured: { predictionElapsedMs: 1.5, steps: 9 } };
  assert.equal(main(['sizing', '--evidence', 'x.json'], { log() {}, readFile: () => JSON.stringify(evidence) }), 0);
  assert.equal(main(['sizing', '--evidence', 'x.json'], { log() {}, readFile: () => JSON.stringify({ ...evidence, synthetic: true }) }), 1);
  assert.equal(main(['sizing'], { log() {} }), 2);
});
