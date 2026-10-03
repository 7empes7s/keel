/**
 * Roadmap task-108 boundary tests: bounded policy configuration restore
 * qualification.
 *
 * Exercises engine/restore/policyOperations.mjs's subtype- and
 * projection-bound operation records through the production applyWave() and
 * applyPatches() writer paths, the policy batch of
 * engine/coverage/qualification.mjs and tools/qualification/operations.mjs's
 * batch runner, against in-memory fakes only. No tenant is read or written.
 * Required mutation checks:
 *
 * - PATCH immutable built-in policy.
 * - Reuse proof across subtype.
 * - Forward unknown fields into writer.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeGraph, main as operationsMain, runExpansionBatch } from '../../tools/qualification/operations.mjs';
import { recordAppliedIds } from '../../cli/keel-restore.mjs';
import { OPERATIONS, capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { FIELD_PROJECTION_CONTRACT_VERSION } from '../contracts/fieldProjection.mjs';
import {
  EXPANSION_INVENTORY, buildExpansionInventory, qualificationFor, qualifiedSubtypesFor, restoreScopeFor,
} from '../coverage/qualification.mjs';
import { createProjection, writableProjection } from '../reconcile/writableProjection.mjs';
import { applyPatches, applyWave } from '../restore/applyEngine.mjs';
import {
  BUILT_IN_AUTHENTICATION_STRENGTH_IDS, POLICY_OPERATION_RECORDS, buildPolicyFamilyLedger, currentProjection,
  policyPatchRefusal, policyProofFor, policySubtypeOf, projectionDigestFor, qualifyPolicyLiveEvidence,
} from '../restore/policyOperations.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const PATH = '/policies/authenticationStrengthPolicies';
const MFA_BUILT_IN = '00000000-0000-0000-0000-000000000002';

/** fakeGraph plus the body of every write, and an optional read-back override. */
function recordingGraph({ readOverride = null } = {}) {
  const graph = fakeGraph();
  const bodies = [];
  const write = graph.write.bind(graph);
  const read = graph.read.bind(graph);
  graph.write = async (version, path, request) => {
    bodies.push({ method: request.method, path, body: request.body });
    return write(version, path, request);
  };
  graph.read = async (version, path) => {
    const result = await read(version, path);
    return readOverride && result.ok ? { ...result, body: readOverride(result.body) } : result;
  };
  graph.bodies = bodies;
  return graph;
}

const customStrength = Object.freeze({
  id: 'source-strength-id',
  displayName: 'Contractors phishing-resistant',
  description: 'FIDO2 or Windows Hello only',
  policyType: 'custom',
  requirementsSatisfied: 'mfa',
  allowedCombinations: ['fido2', 'windowsHelloForBusiness'],
  createdDateTime: '2026-01-01T00:00:00Z',
  modifiedDateTime: '2026-02-01T00:00:00Z',
});

const builtInStrength = Object.freeze({
  id: MFA_BUILT_IN,
  displayName: 'Multifactor authentication',
  description: 'Combinations of methods that satisfy strong authentication',
  policyType: 'builtIn',
  requirementsSatisfied: 'mfa',
  allowedCombinations: ['password,sms', 'password,microsoftAuthenticatorPush'],
});

function strength(verb, payload = customStrength, extra = {}) {
  return {
    naturalKey: `authenticationStrengthPolicy:${payload.displayName}`, resourceType: 'authenticationStrengthPolicy',
    verb, payload, references: [], blastRadius: 'tenant-lockout', ...extra,
  };
}

const run = (graph, wave, options = {}) => applyWave(graph, governor, wave, {
  targetTenant: 'fixture', mode: 'enforce', ...options,
});

// ------------------------------------------------- ledger: the qualified subset and the rest

test('only custom-strength create and update are registered, bound to the custom subtype', () => {
  assert.deepEqual(OPERATIONS.filter((operation) => isSupportedClaim(capabilityFor('authenticationStrengthPolicy', operation).claim)), ['create', 'update']);
  for (const operation of ['create', 'update']) {
    const capability = capabilityFor('authenticationStrengthPolicy', operation);
    assert.equal(capability.claim, 'fixture-tested');
    assert.equal(capability.subtype, 'custom');
    assert.equal(capability.credentialMode, 'restorer');
    assert.equal(capability.proofRef, 'engine/roadmap/policy-fidelity.test.mjs');
  }
  assert.equal(capabilityFor('authenticationStrengthPolicy', 'delete').claim, 'unsupported');
  assert.ok(POLICY_OPERATION_RECORDS.length <= 3, 'the task starts with at most three operation records');
  assert.equal(restoreScopeFor('authenticationStrengthPolicy'), 'partial');
  assert.deepEqual(qualifiedSubtypesFor('authenticationStrengthPolicy'), ['custom']);
  assert.deepEqual(qualifiedSubtypesFor('application'), [], 'types without subtype-bound writes report none');
  const expansion = qualificationFor('authenticationStrengthPolicy').expansion;
  assert.deepEqual({ status: expansion.status, restoreScope: expansion.restoreScope, qualifiedSubtypes: expansion.qualifiedSubtypes },
    { status: 'qualified-subset', restoreScope: 'partial', qualifiedSubtypes: ['custom'] });
});

test('the policy family ledger lists every policy type; the remainder stays research-needed with its reason', () => {
  const ledger = buildPolicyFamilyLedger();
  const policyTypes = Object.entries(EXPANSION_INVENTORY).filter(([, entry]) => entry.batch === 'policy').map(([type]) => type);
  assert.deepEqual(ledger.families.map((family) => family.resourceType).sort(), policyTypes.sort());
  const byType = new Map(ledger.families.map((family) => [family.resourceType, family]));

  const strengthFamily = byType.get('authenticationStrengthPolicy');
  assert.deepEqual(strengthFamily.operations.map((op) => [op.operation, op.subtype, op.proofCurrent]), [['create', 'custom', true], ['update', 'custom', true]]);
  assert.deepEqual(strengthFamily.refusedSubtypes, ['builtIn']);
  assert.deepEqual(byType.get('authenticationStrengthPolicy').operations[1].writableFields, ['description', 'displayName']);

  for (const family of ledger.families) {
    if (['authenticationStrengthPolicy', 'conditionalAccessPolicy', 'namedLocation'].includes(family.resourceType)) continue;
    assert.equal(family.status, 'research-needed', family.resourceType);
    assert.equal(family.restoreScope, 'none', family.resourceType);
    assert.deepEqual(family.operations, [], `${family.resourceType} has no operation record`);
    assert.ok(family.api && family.permission && family.reason.length > 20, `${family.resourceType} names its API, permission and reason`);
    assert.doesNotMatch(family.reason, /^task-108$/, `${family.resourceType} carries a real reason, not a task pointer`);
    for (const operation of OPERATIONS) assert.equal(capabilityFor(family.resourceType, operation).claim, 'unsupported');
  }
  // The batch inventory still validates; a subtype or scope cannot be declared on it.
  buildExpansionInventory();
  const declared = { ...EXPANSION_INVENTORY, authorizationPolicy: { ...EXPANSION_INVENTORY.authorizationPolicy, qualifiedSubtypes: ['custom'] } };
  assert.throws(() => buildExpansionInventory({ inventory: declared }), /unrecognised fields qualifiedSubtypes/);
});

// ------------------------------------------------- built-in immutable policies refuse

test('a built-in strength is never written: update, create and a custom-looking payload on a built-in id all refuse', async () => {
  assert.equal(policySubtypeOf('authenticationStrengthPolicy', builtInStrength), 'builtIn');
  assert.equal(policySubtypeOf('authenticationStrengthPolicy', { policyType: 'custom' }, MFA_BUILT_IN), 'builtIn');
  for (const id of BUILT_IN_AUTHENTICATION_STRENGTH_IDS) assert.equal(policySubtypeOf('authenticationStrengthPolicy', { id }), 'builtIn');

  const graph = recordingGraph();
  graph.objects.set(`${PATH}/${MFA_BUILT_IN}`, { ...builtInStrength, description: 'Drifted' });
  const cases = [
    strength('update', builtInStrength, { targetId: MFA_BUILT_IN }),
    // The snapshot claims custom, but the target is a Microsoft-global built-in id.
    strength('update', { ...builtInStrength, policyType: 'custom' }, { targetId: MFA_BUILT_IN }),
    // Current-state revalidation: the live target reads built-in.
    strength('update', customStrength, { targetId: 'tenant-id-1', live: { targetId: 'tenant-id-1', payload: { ...customStrength, policyType: 'builtIn' } } }),
    strength('create', builtInStrength),
  ];
  for (const resource of cases) {
    const result = await run(graph, [resource]);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.failed, []);
    assert.match(result.skipped[0]?.reason ?? '', /immutable built-in policy/);
  }
  assert.equal(graph.bodies.length, 0, 'no built-in policy ever reaches the writer');
  assert.equal(graph.objects.get(`${PATH}/${MFA_BUILT_IN}`).description, 'Drifted');

  // delete is not registered at all: refused by the capability gate first.
  const deleted = await run(graph, [strength('delete', customStrength, { targetId: 'tenant-id-1' })], { simulationPassed: true });
  assert.match(deleted.failed[0]?.error ?? '', /unsupported operation: authenticationStrengthPolicy delete/);
  assert.equal(graph.bodies.length, 0);
});

// ------------------------------------------------- the configurable subset survives full verification

test('custom strength create sends only proven writable fields and verifies the read-back, subtype included', async () => {
  const graph = recordingGraph();
  const result = await run(graph, [strength('create')]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].unwrittenFields, undefined, 'nothing unknown was dropped');
  const [post] = graph.bodies;
  assert.equal(`${post.method} ${post.path}`, `POST ${PATH}`);
  assert.deepEqual(Object.keys(post.body).sort(), ['allowedCombinations', 'description', 'displayName']);
  const created = graph.objects.get(`${PATH}/${result.applied[0].targetId}`);
  assert.equal(created.policyType, 'custom');
  assert.deepEqual(created.allowedCombinations, customStrength.allowedCombinations);

  const drifted = recordingGraph({ readOverride: (body) => ({ ...body, allowedCombinations: ['password,sms'] }) });
  const mismatch = await run(drifted, [strength('create')]);
  assert.deepEqual(mismatch.applied, []);
  assert.match(mismatch.failed[0]?.error ?? '', /verification hash mismatch/);

  const wrongSubtype = recordingGraph({ readOverride: (body) => ({ ...body, policyType: 'builtIn' }) });
  const refused = await run(wrongSubtype, [strength('create')]);
  assert.deepEqual(refused.applied, []);
  assert.match(refused.failed[0]?.error ?? '', /read back as subtype 'builtIn', not 'custom'/);
});

test('custom strength update PATCHes name and description only; allowedCombinations drift stays not remediable', async () => {
  const graph = recordingGraph();
  graph.objects.set(`${PATH}/tenant-id-1`, { ...customStrength, id: 'tenant-id-1', displayName: 'Renamed', description: 'changed' });
  const result = await run(graph, [strength('update', customStrength, { targetId: 'tenant-id-1' })]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied, [{ naturalKey: `authenticationStrengthPolicy:${customStrength.displayName}`, targetId: 'tenant-id-1' }]);
  assert.deepEqual(graph.bodies, [{ method: 'PATCH', path: `${PATH}/tenant-id-1`, body: { displayName: customStrength.displayName, description: customStrength.description } }]);

  const combos = recordingGraph();
  combos.objects.set(`${PATH}/tenant-id-2`, { ...customStrength, id: 'tenant-id-2', displayName: 'Renamed', allowedCombinations: ['password,sms'] });
  const residual = await run(combos, [strength('update', customStrength, { targetId: 'tenant-id-2' })]);
  assert.deepEqual(residual.failed, []);
  assert.deepEqual(residual.notRemediable.map((entry) => entry.immutable), [['allowedCombinations']]);
  assert.ok(!('allowedCombinations' in combos.bodies[0].body), 'combinations are never PATCHed');

  const tampered = recordingGraph({ readOverride: (body) => ({ ...body, description: 'tampered' }) });
  tampered.objects.set(`${PATH}/tenant-id-3`, { ...customStrength, id: 'tenant-id-3', displayName: 'Renamed' });
  const failed = await run(tampered, [strength('update', customStrength, { targetId: 'tenant-id-3' })]);
  assert.match(failed.failed[0]?.error ?? '', /residual drift after update/);
});

test('a strength recreated in the same run is remapped into a Conditional Access policy, which stays report-only', async () => {
  const graph = recordingGraph();
  const appliedIds = new Map();
  const first = await run(graph, [strength('create')], { appliedIds });
  recordAppliedIds(appliedIds, first.applied);
  const newId = first.applied[0].targetId;

  const ca = {
    naturalKey: 'conditionalAccessPolicy:Contractors', resourceType: 'conditionalAccessPolicy', verb: 'create', blastRadius: 'tenant-lockout',
    payload: {
      displayName: 'Contractors', state: 'enabled',
      conditions: { users: { includeUsers: ['None'] }, applications: { includeApplications: ['None'] } },
      grantControls: { operator: 'AND', authenticationStrength: { id: 'source-strength-id' } },
    },
    references: [{ field: 'grantControls.authenticationStrength.id', symbol: `authenticationStrengthPolicy:${customStrength.displayName}`, required: true }],
  };
  const second = await run(graph, [ca], { appliedIds });
  assert.deepEqual(second.failed, []);
  const post = graph.bodies.at(-1);
  assert.equal(post.path, '/identity/conditionalAccess/policies');
  assert.equal(post.body.grantControls.authenticationStrength.id, newId);
  assert.equal(post.body.state, 'enabledForReportingButNotEnforced', 'the Conditional Access restriction is unchanged');
});

// ------------------------------------------------- unknown fields are never written

test('unknown policy fields are never sent: create drops and reports them, a PATCH body carrying one is refused', async () => {
  const withUnknown = { ...customStrength, combinationConfigurations: [{ id: 'cfg-1' }], futureSetting: { enabled: true } };
  assert.deepEqual(createProjection(withUnknown, 'authenticationStrengthPolicy').unknown.sort(), ['combinationConfigurations', 'futureSetting']);
  assert.deepEqual(Object.keys(writableProjection(withUnknown, 'authenticationStrengthPolicy')).sort(), ['description', 'displayName']);

  const graph = recordingGraph();
  const created = await run(graph, [strength('create', withUnknown)]);
  assert.deepEqual(created.failed, []);
  assert.deepEqual(created.applied[0].unwrittenFields.sort(), ['combinationConfigurations', 'futureSetting']);
  assert.deepEqual(Object.keys(graph.bodies[0].body).sort(), ['allowedCombinations', 'description', 'displayName']);

  // Update: the unknown field is not PATCHed; if the target already matches it
  // the update verifies, if not it is residual drift, never claimed fixed.
  const same = recordingGraph();
  same.objects.set(`${PATH}/t1`, { ...withUnknown, id: 't1', displayName: 'Renamed' });
  const ok = await run(same, [strength('update', withUnknown, { targetId: 't1' })]);
  assert.deepEqual(ok.failed, []);
  assert.deepEqual(Object.keys(same.bodies[0].body).sort(), ['description', 'displayName']);
  const differs = recordingGraph();
  differs.objects.set(`${PATH}/t2`, { ...customStrength, id: 't2', displayName: 'Renamed', futureSetting: { enabled: false } });
  const residual = await run(differs, [strength('update', withUnknown, { targetId: 't2' })]);
  assert.match(residual.failed[0]?.error ?? '', /residual drift after update/);
  assert.ok(!('futureSetting' in differs.bodies[0].body));

  // The writer-boundary check refuses a body with anything beyond the proven fields.
  assert.match(policyPatchRefusal('authenticationStrengthPolicy', { displayName: 'x', futureSetting: {} }), /futureSetting outside the proven writable fields/);
  assert.equal(policyPatchRefusal('authenticationStrengthPolicy', { displayName: 'x', description: 'y' }), null);
});

// ------------------------------------------------- a proof is bound to subtype and projection

test('a proof is never reused across subtypes: missing or other subtypes fail before any write', async () => {
  assert.equal(policyProofFor('authenticationStrengthPolicy', 'update', 'custom').valid, true);
  assert.match(policyProofFor('authenticationStrengthPolicy', 'update', 'unknown').reason, /no proof covers authenticationStrengthPolicy update for subtype 'unknown'/);

  const graph = recordingGraph();
  graph.objects.set(`${PATH}/t1`, { ...customStrength, id: 't1', displayName: 'Renamed' });
  const { policyType: _omitted, ...untyped } = customStrength;
  const missing = await run(graph, [strength('update', untyped, { targetId: 't1' })]);
  assert.match(missing.failed[0]?.error ?? '', /no proof covers authenticationStrengthPolicy update for subtype 'unknown'/);
  const other = await run(graph, [strength('create', { ...customStrength, policyType: 'recommended' })]);
  assert.match(other.failed[0]?.error ?? '', /no proof covers authenticationStrengthPolicy create for subtype 'unknown'/);
  const changed = await run(graph, [strength('update', untyped, { targetId: 't1', live: { targetId: 't1', payload: { ...customStrength, id: 't1' } } })]);
  assert.match(changed.failed[0]?.error ?? '', /subtype change refused: the target is 'custom' and the snapshot is 'unknown'/);
  assert.equal(graph.bodies.length, 0);
});

test('changing the field projection invalidates the proof and refuses the write', () => {
  for (const record of POLICY_OPERATION_RECORDS) {
    assert.equal(projectionDigestFor(record), record.projectionDigest, `${record.operation}: the recorded digest is the current projection`);
  }
  const projection = currentProjection('authenticationStrengthPolicy');
  const widened = { ...projection, knownFields: [...projection.knownFields, 'combinationConfigurations'].sort() };
  const loosened = { ...projection, immutable: projection.immutable.filter((field) => field !== 'allowedCombinations') };
  for (const changed of [widened, loosened]) {
    const proof = policyProofFor('authenticationStrengthPolicy', 'update', 'custom', { projection: changed });
    assert.equal(proof.valid, false);
    assert.match(proof.reason, /proof invalidated: the authenticationStrengthPolicy field projection changed/);
  }
  // A record whose writable fields grew is a different projection too.
  const update = POLICY_OPERATION_RECORDS.find((record) => record.operation === 'update');
  assert.notEqual(projectionDigestFor({ ...update, writableFields: [...update.writableFields, 'allowedCombinations'] }), update.projectionDigest);
  assert.notEqual(projectionDigestFor({ ...update, subtype: 'builtIn' }), update.projectionDigest);
});

test('the live qualification gate requires the record subtype and projection, then the registry gate', () => {
  const update = POLICY_OPERATION_RECORDS.find((record) => record.operation === 'update');
  const now = new Date('2026-10-03T12:00:00Z');
  const evidence = {
    tenantRef: 'tenant-a', resourceType: 'authenticationStrengthPolicy', operation: 'update', subtype: 'custom',
    projectionDigest: update.projectionDigest, fieldProjectionContractVersion: FIELD_PROJECTION_CONTRACT_VERSION,
    build: 'build-1', synthetic: true, observedAt: '2026-10-03T00:00:00Z', proofRef: 'evidence/strength-update.json',
  };
  const otherSubtype = qualifyPolicyLiveEvidence('authenticationStrengthPolicy', 'update', { ...evidence, subtype: 'builtIn' }, { tenantRef: 'tenant-a', now });
  assert.equal(otherSubtype.promoted, false);
  assert.match(otherSubtype.failures.join('\n'), /evidence is for subtype 'builtIn'/);
  const otherProjection = qualifyPolicyLiveEvidence('authenticationStrengthPolicy', 'update', { ...evidence, projectionDigest: 'stale' }, { tenantRef: 'tenant-a', now });
  assert.match(otherProjection.failures.join('\n'), /different field projection/);
  // Matching subtype and projection still meet the registry's own refusal of synthetic evidence.
  const synthetic = qualifyPolicyLiveEvidence('authenticationStrengthPolicy', 'update', evidence, { tenantRef: 'tenant-a', now });
  assert.equal(synthetic.promoted, false);
  assert.match(synthetic.failures.join('\n'), /synthetic fixture proof can never promote/);
  assert.equal(capabilityFor('authenticationStrengthPolicy', 'update').claim, 'fixture-tested');
});

test('a deferred reference patch is never sent for a policy-governed type', async () => {
  const graph = recordingGraph();
  const appliedIds = new Map([['authenticationStrengthPolicy:x', 't1'], ['group:y', 'g1']]);
  const result = await applyPatches(graph, governor, [{
    naturalKey: 'authenticationStrengthPolicy:x', resourceType: 'authenticationStrengthPolicy', symbol: 'group:y', field: 'description',
  }], { targetTenant: 'fixture', mode: 'enforce', appliedIds });
  assert.match(result.failed[0]?.reason ?? '', /no proven deferred reference patch for authenticationStrengthPolicy/);
  assert.equal(graph.bodies.length, 0);
});

// ------------------------------------------------- batch runner and CLI

test('the policy batch runner drives the subset through applyWave and prints the family ledger', async () => {
  const report = await runExpansionBatch('policy', { now: () => new Date('2026-10-03T00:00:00Z') });
  assert.equal(report.synthetic, true);
  assert.equal(report.batch.task, 'task-108');
  const strengthOps = report.operations.filter((op) => op.resourceType === 'authenticationStrengthPolicy');
  assert.deepEqual(strengthOps.map((op) => [op.operation, op.result, op.subtype]), [['create', 'passed', 'custom'], ['update', 'passed', 'custom']]);
  assert.deepEqual(strengthOps[0].writes, [`POST ${PATH}`]);
  assert.deepEqual(strengthOps[1].writes, [`PATCH ${PATH}/fixture-existing`]);
  for (const op of report.operations) assert.equal(op.result, 'passed', `${op.resourceType} ${op.operation}: ${op.detail}`);
  assert.ok(report.refused.some((entry) => entry.resourceType === 'authenticationStrengthPolicy' && entry.operation === 'delete'));
  assert.equal(report.policyLedger.families.length, 16);

  const lines = [];
  const out = { log: (line) => lines.push(line), error: (line) => lines.push(`ERR ${line}`) };
  assert.equal(await operationsMain({ argv: ['--batch', 'policy'], out }), 0);
  const text = lines.join('\n');
  assert.match(text, /authenticationStrengthPolicy create: passed · claim fixture-tested · id server-assigned · subtype custom only/);
  assert.match(text, /authenticationStrengthPolicy update proof: current · writes description, displayName/);
  assert.match(text, /authenticationStrengthPolicy builtIn: refused \(immutable\)/);
  assert.match(text, /authorizationPolicy: research-needed — tenant-wide singleton/);
});
