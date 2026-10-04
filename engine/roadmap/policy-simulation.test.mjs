/**
 * Roadmap task-95 boundary tests: bounded proposed-policy scenario evaluation.
 * Exercises engine/safety/policyScenario.mjs, simulationGate.mjs#proposedPolicyGate,
 * the restore sign-in path gate, cli/keel-policy-scenario.mjs over the isolated test
 * database and tools/qualification/conditionalAccess.mjs. Fixture-tested only: no
 * Microsoft call is made and no Conditional Access policy is changed.
 *
 * Acceptance:
 *  - combined fixture policies expose a lockout missing from the isolated diff;
 *  - an unsupported session condition yields unknown;
 *  - budget truncation is visible;
 *  - a passing sample is labelled sampled;
 *  - the existing sign-in path gate cannot be bypassed.
 *
 * Required mutation checks (each must fail a test here):
 *  - Evaluate each policy independently only.
 *  - Turn an unsupported predicate into allow.
 *  - Treat a live What If read as proposed-state proof.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { ThrottleGovernor } from '../restore/throttleGovernor.mjs';
import { GLOBAL_ADMINISTRATOR, recordBreakGlassLifecycle, registerBreakGlassAccount } from '../safety/breakGlassReadiness.mjs';
import {
  BUILT_IN_STRENGTHS, DEFAULT_SCENARIO_BUDGET, LIVE_POLICY_READ, attachLiveReads, capabilitiesFromMethodEvidence,
  combinePolicySet, evaluatePrincipalMatrix, evaluateProposedPolicySet, readLiveWhatIf,
} from '../safety/policyScenario.mjs';
import { compareSignInPaths } from '../safety/signInPathGate.mjs';
import { evaluatePromotion, proposedPolicyGate } from '../safety/simulationGate.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { main as policyScenarioCli } from '../../cli/keel-policy-scenario.mjs';
import { checkWhatIfEvidence, runBenchmark } from '../../tools/qualification/conditionalAccess.mjs';

const BG = 'b9500000-0000-4000-8000-000000000001';
const BG2 = 'b9500000-0000-4000-8000-000000000002';
const HQ = { id: '10500000-0000-4000-8000-000000000001', label: 'Head office', trusted: true };

const emergency = (extra = {}) => ({
  id: BG,
  label: 'emergency-1',
  capabilities: { mfa: true, compliantDevice: false, domainJoinedDevice: false, authenticationStrengths: [BUILT_IN_STRENGTHS.phishingResistant] },
  ...extra,
});

const policy = (name, conditions, grantControls, extra = {}) => ({
  naturalKey: `conditionalAccessPolicy:${name}`,
  payload: {
    id: `ca-${name}`,
    displayName: name,
    state: 'enabled',
    conditions: { applications: { includeApplications: ['All'] }, clientAppTypes: ['all'], ...conditions },
    grantControls,
    ...extra,
  },
});

const allUsers = { users: { includeUsers: ['All'] } };
// Existing, enforced: block every sign-in from outside trusted locations.
const blockOutsideTrusted = policy('Block outside trusted', {
  ...allUsers, locations: { includeLocations: ['All'], excludeLocations: ['AllTrusted'] },
}, { operator: 'OR', builtInControls: ['block'] });
// Proposed: require a compliant device at trusted locations.
const compliantAtTrusted = policy('Compliant device at trusted sites', {
  ...allUsers, locations: { includeLocations: ['AllTrusted'] },
}, { operator: 'OR', builtInControls: ['compliantDevice'] });

const evaluate = (currentPolicies, changes, extra = {}) => evaluateProposedPolicySet({
  currentPolicies, changes, principals: [emergency()], locations: [HQ], ...extra,
});

test('combined fixture policies expose a lockout the isolated diff misses', () => {
  const evaluation = evaluate([blockOutsideTrusted], [{ verb: 'create', ...compliantAtTrusted }]);
  const [result] = evaluation.principals;
  assert.equal(evaluation.scope, 'proposed-combined-policy-set');
  assert.equal(result.verdict, 'lockout', JSON.stringify(result));
  assert.equal(result.coverage.selection, 'complete');
  assert.equal(result.counts.blocked, result.coverage.matrixSize);
  // Both policies take part in the blocked paths: outside by the block, inside by the device.
  assert.deepEqual(result.blockingPolicies, { [blockOutsideTrusted.naturalKey]: 10, [compliantAtTrusted.naturalKey]: 10 });

  // The per-change diff alone leaves the path outside trusted locations open.
  assert.deepEqual(evaluation.isolated, [{ policy: compliantAtTrusted.naturalKey, principal: BG, verdict: 'pass', basis: 'sampled' }]);
  assert.deepEqual(evaluation.combinationOnly, [{ principal: BG, label: 'emergency-1', combined: 'lockout', isolated: 'pass' }]);
  assert.equal(evaluation.overall, 'lockout');
  const gate = proposedPolicyGate(evaluation);
  assert.equal(gate.outcome, 'refuse');
  assert.match(gate.reason, /emergency-1/);

  // Each policy alone, through the same evaluator, leaves a path open.
  for (const single of [blockOutsideTrusted, { ...compliantAtTrusted, origin: 'create' }]) {
    assert.equal(evaluatePrincipalMatrix([single], emergency(), { locations: [HQ] }).verdict, 'pass');
  }

  // Excluding the emergency account from the proposed policy reopens the trusted path.
  const excluded = policy('Compliant device at trusted sites', {
    users: { includeUsers: ['All'], excludeUsers: [BG] }, locations: { includeLocations: ['AllTrusted'] },
  }, { operator: 'OR', builtInControls: ['compliantDevice'] });
  const fixed = evaluate([blockOutsideTrusted], [{ verb: 'create', ...excluded }]);
  assert.equal(fixed.principals[0].verdict, 'pass');
  assert.equal(fixed.principals[0].allowedPaths[0].scenario.location, 'Head office');

  // Deleting the existing block in the same proposal also reopens a path; a report-only
  // policy never decides access.
  const deleted = evaluate([blockOutsideTrusted], [{ verb: 'create', ...compliantAtTrusted }, { verb: 'delete', naturalKey: blockOutsideTrusted.naturalKey }]);
  assert.equal(deleted.principals[0].verdict, 'pass');
  const reportOnly = evaluate([blockOutsideTrusted], [{ verb: 'create', ...compliantAtTrusted, payload: { ...compliantAtTrusted.payload, state: 'enabledForReportingButNotEnforced' } }]);
  assert.equal(reportOnly.principals[0].verdict, 'pass');

  // The proposal is checked against the current set, not guessed.
  assert.throws(() => combinePolicySet([blockOutsideTrusted], [{ verb: 'update', ...compliantAtTrusted }]), /does not match a current policy/);
  assert.throws(() => combinePolicySet([blockOutsideTrusted], [{ verb: 'create', ...blockOutsideTrusted }]), /already exists/);
});

test('an unsupported condition or session control yields unknown, never allow', () => {
  const session = (sessionControls) => policy('Session controlled', allUsers, { operator: 'OR', builtInControls: ['mfa'] }, { sessionControls });
  const cae = evaluate([], [{ verb: 'create', ...session({ continuousAccessEvaluation: { mode: 'strictLocation' } }) }]);
  const [result] = cae.principals;
  assert.equal(result.verdict, 'unknown', JSON.stringify(result));
  assert.equal(result.counts.unknown, result.coverage.matrixSize);
  assert.ok(result.unknownReasons.includes('unsupported-session-control:continuousAccessEvaluation'));
  assert.equal(proposedPolicyGate(cae).outcome, 'review');
  // A supported session control does not decide access.
  assert.equal(evaluate([], [{ verb: 'create', ...session({ signInFrequency: { value: 4, type: 'hours', isEnabled: true } }) }]).principals[0].verdict, 'pass');

  // An unsupported condition on a block policy: KEEL cannot tell whether it applies.
  const deviceFilter = policy('Block filtered devices', {
    ...allUsers, devices: { deviceFilter: { mode: 'include', rule: 'device.trustType -eq "ServerAD"' } },
  }, { operator: 'OR', builtInControls: ['block'] });
  const filtered = evaluate([], [{ verb: 'create', ...deviceFilter }]);
  assert.equal(filtered.principals[0].verdict, 'unknown');
  assert.equal(filtered.principals[0].counts.allowed, 0);
  assert.ok(filtered.principals[0].unknownReasons.includes('unsupported-condition:devices'));
  // An empty condition object as Graph returns it is not a condition.
  const emptyDevices = policy('MFA with empty device condition', {
    ...allUsers, devices: { deviceFilter: null, includeDevices: [] }, insiderRiskLevels: null,
  }, { builtInControls: ['mfa'] }, { sessionControls: { cloudAppSecurity: { isEnabled: false, cloudAppSecurityType: null } } });
  assert.equal(evaluate([], [{ verb: 'create', ...emptyDevices }]).principals[0].verdict, 'pass');

  // An unknown capability, an unread exclusion group and a guest condition stay unknown too.
  const deviceUnknown = evaluateProposedPolicySet({
    currentPolicies: [], changes: [{ verb: 'create', ...compliantAtTrusted }],
    principals: [{ id: BG, label: 'emergency-1', capabilities: {}, paths: { locations: [{ id: HQ.id, label: HQ.label, trusted: true }] } }],
  });
  assert.equal(deviceUnknown.principals[0].verdict, 'unknown');
  assert.ok(deviceUnknown.principals[0].unknownReasons.includes('unknown-capability:compliantDevice'));
  const unreadGroup = policy('Block except group', { users: { includeUsers: ['All'], excludeGroups: ['g-unread'] } }, { builtInControls: ['block'] });
  assert.equal(evaluate([], [{ verb: 'create', ...unreadGroup }]).principals[0].verdict, 'unknown');
  const readGroup = evaluateProposedPolicySet({
    currentPolicies: [], changes: [{ verb: 'create', ...unreadGroup }], locations: [HQ],
    principals: [emergency({ groups: { 'g-unread': true } })],
  });
  assert.equal(readGroup.principals[0].verdict, 'pass');
  const strangeApp = policy('Block suite', { ...allUsers, applications: { includeApplications: ['Office365'] } }, { builtInControls: ['block'] });
  assert.equal(evaluate([], [{ verb: 'create', ...strangeApp }]).principals[0].verdict, 'unknown');

  // No covered policy collection: every verdict is unknown.
  const noInventory = evaluateProposedPolicySet({ currentPolicies: null, changes: [], principals: [emergency()] });
  assert.equal(noInventory.overall, 'unknown');
  assert.equal(noInventory.principals[0].reason, 'policy-inventory-unavailable');
});

test('budget truncation is visible and never reads as lockout or pass', () => {
  const locations = Array.from({ length: 40 }, (_, i) => ({ id: `10500000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, label: `Site ${i}`, trusted: false }));
  const blockAll = policy('Block everyone', allUsers, { builtInControls: ['block'] });
  const allowOnlyAtLastSite = policy('Block outside last site', {
    ...allUsers, locations: { includeLocations: ['All'], excludeLocations: [locations[39].id] },
  }, { builtInControls: ['block'] });

  const sampled = evaluateProposedPolicySet({
    currentPolicies: [allowOnlyAtLastSite], changes: [], principals: [emergency()], locations, budget: { maxScenarios: 16 },
  });
  const [result] = sampled.principals;
  assert.equal(result.coverage.truncated, true);
  assert.equal(result.coverage.selection, 'sampled');
  assert.deepEqual(result.coverage.truncatedBy, ['max-scenarios']);
  assert.equal(result.coverage.evaluated, 16);
  assert.equal(result.coverage.untested, result.coverage.matrixSize - 16);
  // Whatever the sample found, an all-blocked sample is not a lockout and not a pass.
  if (result.counts.allowed === 0) {
    assert.equal(result.verdict, 'unknown');
    assert.match(result.reason, /budget-truncated/);
  }
  assert.notEqual(result.verdict, 'lockout');

  const exhausted = evaluateProposedPolicySet({
    currentPolicies: [blockAll], changes: [], principals: [emergency()], locations: [HQ], budget: { maxSteps: 20 },
  });
  assert.equal(exhausted.principals[0].verdict, 'unknown');
  assert.deepEqual(exhausted.principals[0].coverage.truncatedBy, ['max-steps']);
  assert.ok(exhausted.principals[0].coverage.untested > 0);

  // With the whole matrix in budget, the same block is a lockout.
  const full = evaluateProposedPolicySet({ currentPolicies: [blockAll], changes: [], principals: [emergency()], locations: [HQ] });
  assert.equal(full.principals[0].verdict, 'lockout');

  assert.throws(() => evaluatePrincipalMatrix([], emergency(), { budget: { maxScenarios: 0 } }), /maxScenarios/);
  assert.throws(() => evaluatePrincipalMatrix([], emergency(), { budget: { maxSteps: 1e12 } }), /maxSteps/);
  assert.equal(DEFAULT_SCENARIO_BUDGET.maxScenarios, 256);

  const benchmark = runBenchmark({ seed: 7, policies: 40, locations: 300, maxScenarios: 32 });
  assert.equal(benchmark.synthetic, true);
  assert.equal(benchmark.tenantFigures, null);
  assert.equal(benchmark.coverage.truncated, true);
  assert.equal(benchmark.coverage.evaluated, 32);
});

test('a passing sample is labelled sampled and never universal', () => {
  const mfaForAll = policy('Require MFA', allUsers, { operator: 'OR', builtInControls: ['mfa'] });
  const evaluation = evaluate([mfaForAll], []);
  const [result] = evaluation.principals;
  assert.equal(result.coverage.selection, 'complete');
  assert.equal(result.verdict, 'pass');
  assert.equal(result.basis, 'sampled');
  assert.equal(result.universalSafety, 'not-asserted');
  assert.equal(evaluation.universalSafety, 'not-asserted');
  assert.equal(evaluation.overall, 'sampled-pass');
  assert.deepEqual(result.allowedPaths[0].controls, [mfaForAll.naturalKey]);
  const gate = proposedPolicyGate(evaluation);
  assert.equal(gate.outcome, 'sampled-pass');
  assert.equal(gate.authorizesWrite, false);
  assert.equal(gate.signInPathCheck, 'still-required');
  assert.ok(!('allowed' in gate) && !('simulationPassed' in gate));
  const verdicts = JSON.stringify(evaluation);
  assert.doesNotMatch(verdicts, /"verdict":"(safe|proven|exact)"/);

  // Emergency-account capabilities come only from method evidence; none is unknown.
  assert.deepEqual(capabilitiesFromMethodEvidence(null), {});
  assert.deepEqual(capabilitiesFromMethodEvidence({ methods: ['fido2'] }).mfa, true);
  assert.deepEqual(capabilitiesFromMethodEvidence({ methods: ['password'] }), { mfa: false, authenticationStrengths: [] });
});

test('a live What If read is separate evidence, never proof of the proposed state', async () => {
  const proposal = evaluate([blockOutsideTrusted], [{ verb: 'create', ...compliantAtTrusted }]);
  const whatIf = readLiveWhatIf({ value: [{ id: 'ca-Block outside trusted', displayName: 'Block outside trusted', policyApplies: false, grantControls: { builtInControls: ['block'] } }] }, {
    principalId: BG, readAt: '2026-10-03T00:00:00Z', scenario: { location: 'Head office' },
  });
  assert.equal(whatIf.kind, LIVE_POLICY_READ);
  assert.equal(whatIf.evaluates, 'current-live-policies');
  assert.equal(whatIf.provesProposedState, false);
  assert.equal(whatIf.liveOutcome, 'not-blocked-by-live-policy');
  const withRead = attachLiveReads(proposal, [whatIf]);
  assert.equal(withRead.liveReads.length, 1);
  assert.equal(withRead.principals[0].verdict, 'lockout');
  assert.equal(withRead.overall, 'lockout');
  assert.equal(proposedPolicyGate(withRead).outcome, 'refuse');
  // An unknown proposed verdict stays unknown whatever the live read says.
  const unknown = evaluate([], [{ verb: 'create', ...policy('CAE', allUsers, { builtInControls: ['mfa'] }, { sessionControls: { continuousAccessEvaluation: { mode: 'disabled' } } }) }]);
  const unknownWithRead = attachLiveReads(unknown, [whatIf]);
  assert.equal(unknownWithRead.principals[0].verdict, 'unknown');
  assert.equal(proposedPolicyGate(unknownWithRead).outcome, 'review');
  assert.throws(() => attachLiveReads(proposal, [{ ...whatIf, provesProposedState: true }]), /live-policy-read/);
  assert.throws(() => readLiveWhatIf({ value: [{ id: 'x' }] }, { principalId: BG, readAt: '2026-10-03T00:00:00Z' }), /policyApplies/);

  const checked = checkWhatIfEvidence({ principalId: BG, readAt: '2026-10-03T00:00:00Z', response: { value: [] } });
  assert.equal(checked.provesProposedState, false);
  assert.equal(checked.read.synthetic, true);

  // The delegated What If prototype labels its result a live read as well.
  const live = await evaluatePromotion({ whatIf: async () => [] }, { principalMatrix: [{ label: 'bg', userId: BG }], breakGlassUserIds: [BG] });
  assert.equal(live.provesProposedState, false);
  assert.equal(live.evidence, LIVE_POLICY_READ);
});

test('the existing sign-in path gate and lockout-delete refusal cannot be bypassed', async () => {
  const passing = evaluate([policy('Require MFA', allUsers, { builtInControls: ['mfa'] })], []);
  const gate = proposedPolicyGate(passing);
  assert.equal(gate.outcome, 'sampled-pass');

  // A changed sign-in path still fails the post-write gate, whatever was evaluated.
  let grantControls = ['mfa'];
  const reader = {
    collect: async (version, path) => {
      if (path === '/identity/conditionalAccess/policies') return { items: [{ id: 'ca-1', grantControls: { builtInControls: grantControls } }], capped: false, error: null };
      if (path.startsWith('/roleManagement/directory/roleAssignments?')) return { items: [], capped: false, error: null };
      throw new Error(`unexpected ${path}`);
    },
    get: async (version, path) => {
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: BG, accountEnabled: true } };
      return { ok: true, status: 200, body: { id: path } };
    },
  };
  const writer = {
    write: async () => { grantControls = ['block']; return { ok: true, status: 204, body: null }; },
    read: async () => ({ ok: true, status: 200, body: { id: 'group-id', displayName: 'Gate test' } }),
  };
  const result = await applyWave(writer, { acquire: async () => {} }, [{
    naturalKey: 'group:gate-test', resourceType: 'group', targetId: 'group-id', verb: 'update', payload: { displayName: 'Gate test' },
  }], { targetTenant: 'target', mode: 'enforce', signInPathGate: { reader, protectedPrincipalIds: [BG] }, policyScenario: passing, ...gate });
  assert.equal(result.failed.at(-1)?.naturalKey, 'sign-in-path-gate', JSON.stringify(result));
  assert.equal(compareSignInPaths({ a: 1 }, { a: 2 }, gate).allowed, false);

  // A tenant-lockout delete still needs the explicit simulation flag, which no gate result sets.
  const deleteWriter = { calls: 0, write: async () => { deleteWriter.calls += 1; return { ok: true, status: 204 }; }, read: async () => ({ ok: false, status: 404 }) };
  const refused = await applyWave(deleteWriter, new ThrottleGovernor({ 'target/entra/write': { capacity: 10, refillPerSecond: 10 } }), [{
    naturalKey: 'roleAssignment:Global-Administrator', resourceType: 'roleAssignment', targetId: 'ra-1', verb: 'delete',
    blastRadius: 'tenant-lockout', payload: { id: 'ra-1' }, references: [],
  }], {
    targetTenant: 'target', mode: 'enforce', ...gate,
    deletionGuardOptions: { breakGlassUserIds: [BG], keelAppIds: [], caPolicies: [] },
    rollbackClient: { query: async () => {} }, runId: 'policy-scenario-lockout-delete',
  });
  assert.equal(deleteWriter.calls, 0);
  assert.match(refused.skipped[0].reason, /simulationPassed must be true/);

  // No production CLI passes a simulation flag, and the scenario CLI cannot write.
  const cliDir = new URL('../../cli/', import.meta.url);
  for (const file of readdirSync(cliDir).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))) {
    assert.doesNotMatch(readFileSync(new URL(file, cliDir), 'utf8'), /simulationPassed/, file);
  }
  const scenarioCli = readFileSync(new URL('keel-policy-scenario.mjs', cliDir), 'utf8');
  assert.doesNotMatch(scenarioCli, /GraphWriter|applyWave|getToken/);
});

test('CLI evaluates a proposal against collected state and registered emergency accounts', async (t) => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
  await client.query(schema);
  const unique = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows: [admin] } = await client.query('INSERT INTO principal(email) VALUES ($1) RETURNING *', [`scenario-admin-${unique}@example.invalid`]);
  await grantRole(client, { principalId: admin.id, role: 'admin', grantedBy: 'fixture', activeFrom: new Date(Date.now() - 60_000) });

  const tenantRef = `tenant-scenario-${unique}`;
  const types = ['conditionalAccessPolicy', 'namedLocation', 'roleAssignment'];
  const resources = [
    { type: 'conditionalAccessPolicy', ...blockOutsideTrusted },
    { type: 'namedLocation', naturalKey: 'namedLocation:Head office', payload: { id: HQ.id, displayName: HQ.label, isTrusted: true, '@odata.type': '#microsoft.graph.ipNamedLocation' } },
    { type: 'roleAssignment', naturalKey: `roleAssignment:GlobalAdministrator@${BG}@/`, payload: { id: 'ra-1', principalId: BG, roleDefinitionId: GLOBAL_ADMINISTRATOR, directoryScopeId: '/' } },
  ];
  const { rows: [snapshot] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest) VALUES ($1,'complete',now(),now(),$2) RETURNING id`,
    [tenantRef, Object.fromEntries(types.map((type) => [type, 1]))],
  );
  for (const resource of resources) {
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1,$2,$3,$4,'fixture','tier1','access-affecting','full','{}')`,
      [snapshot.id, resource.naturalKey, resource.type, resource.payload],
    );
  }
  for (const [id, label] of [[BG, 'emergency-1'], [BG2, 'emergency-2']]) {
    await registerBreakGlassAccount(client, { tenantRef, actor: admin.id, accountId: id, label });
  }
  await recordBreakGlassLifecycle(client, { tenantRef, actor: admin.id, accountId: BG, kind: 'methods-attested', methods: ['fido2'], occurredAt: new Date(Date.now() - 1000) });

  const files = {
    'lockout.json': { changes: [{ verb: 'create', ...compliantAtTrusted }], principals: [{ id: BG, capabilities: { compliantDevice: false } }, { id: BG2, capabilities: { mfa: true, compliantDevice: false } }] },
    'excluded.json': { changes: [{ verb: 'create', ...compliantAtTrusted, payload: { ...compliantAtTrusted.payload, conditions: { ...compliantAtTrusted.payload.conditions, users: { includeUsers: ['All'], excludeUsers: [BG, BG2] } } } }] },
    'whatif.json': { principalId: BG, readAt: '2026-10-03T00:00:00Z', response: { value: [] } },
  };
  const run = async (argv) => {
    const lines = [];
    const code = await policyScenarioCli({
      argv: [...argv, '--tenant-ref', tenantRef, '--db-url', db.url],
      readFile: (path) => JSON.stringify(files[path]),
      connectFn: async () => db.connect(),
      logger: { log: (line) => lines.push(line) },
    });
    return { code, output: lines.length ? JSON.parse(lines.at(-1)) : null };
  };

  const lockout = await run(['evaluate', '--proposal', 'lockout.json', '--what-if', 'whatif.json']);
  assert.equal(lockout.code, 1);
  assert.equal(lockout.output.gate.outcome, 'refuse');
  const byId = Object.fromEntries(lockout.output.evaluation.principals.map((entry) => [entry.principal, entry]));
  assert.equal(byId[BG].verdict, 'lockout');
  assert.equal(byId[BG2].verdict, 'lockout');
  assert.equal(lockout.output.evaluation.inventory.conditionalAccessPolicy.status, 'covered');
  assert.equal(lockout.output.evaluation.liveReads[0].provesProposedState, false);
  assert.equal(lockout.output.evaluation.combinationOnly.length, 2);

  // Both accounts excluded from the new policy: the trusted path stays open; a pass
  // is still only a sampled pass.
  const excluded = await run(['evaluate', '--proposal', 'excluded.json']);
  assert.equal(excluded.output.evaluation.principals.find((entry) => entry.principal === BG).verdict, 'pass');
  assert.equal(excluded.output.evaluation.principals.find((entry) => entry.principal === BG).basis, 'sampled');
  assert.equal(excluded.code, 0, JSON.stringify(excluded.output.gate));

  // A tenant with no covered collection is unknown, never a pass.
  const otherRef = `tenant-scenario-empty-${unique}`;
  await registerBreakGlassAccount(client, { tenantRef: otherRef, actor: admin.id, accountId: BG, label: 'emergency-1' });
  const lines = [];
  const code = await policyScenarioCli({
    argv: ['evaluate', '--proposal', 'excluded.json', '--tenant-ref', otherRef, '--db-url', db.url],
    readFile: (path) => JSON.stringify(files[path]),
    connectFn: async () => db.connect(),
    logger: { log: (line) => lines.push(line) },
  });
  assert.equal(code, 1);
  const empty = JSON.parse(lines.at(-1));
  assert.equal(empty.evaluation.overall, 'unknown');
  assert.equal(empty.evaluation.principals[0].reason, 'policy-inventory-unavailable');
  assert.equal(empty.gate.outcome, 'review');

  const usage = [];
  assert.equal(await policyScenarioCli({ argv: ['apply'], logger: { log: (line) => usage.push(line) } }), 2);
});
