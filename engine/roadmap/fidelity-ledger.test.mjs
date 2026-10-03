/**
 * Roadmap task-63 boundary tests: the per-operation qualification ledger.
 *
 * Exercises engine/coverage/qualification.mjs, the applyWave remapping gate and
 * the tools/qualification/operations.mjs harness/CLI against fakes only. No
 * tenant is read or written. Required mutation checks:
 *
 * - Promote every remappable descriptor to writable.
 * - Omit an unqualified catalog type.
 * - Accept proof for different operation.
 */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { fakeGraph, main as operationsMain, runFixtureHarness } from '../../tools/qualification/operations.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import {
  OPERATIONS, capabilityFor, qualifyLiveEvidence, registerOperationCapability, recordFixtureProof,
} from '../coverage/capabilities.mjs';
import {
  TYPE_DECISIONS, TYPE_DECISION_VALUES, buildOperationLedger, qualificationFor, recordRemappingProof, remappingFor,
} from '../coverage/qualification.mjs';
import { FIELD_PROJECTION_CONTRACT_VERSION } from '../contracts/fieldProjection.mjs';
import { applyWave } from '../restore/applyEngine.mjs';

const ROOT = new URL('../../', import.meta.url);
const governor = { async acquire() {}, observeRetryAfter() {} };

// ------------------------------------------------ explicit decision per type

test('every catalogue type has an explicit known/unknown decision and a row per operation', () => {
  const ledger = buildOperationLedger();
  const types = new Set(ledger.types.map((row) => row.resourceType));
  for (const entry of CATALOG) assert.ok(types.has(entry.type), `${entry.type} must be in the ledger`);
  for (const descriptor of DESCRIPTORS) assert.ok(types.has(descriptor.type), `${descriptor.type} must be in the ledger`);
  assert.equal(ledger.types.length, CATALOG.length);
  for (const row of ledger.types) {
    assert.ok(TYPE_DECISION_VALUES.includes(row.decision), `${row.resourceType}: ${row.decision}`);
    assert.ok(row.reason.length > 0);
    assert.deepEqual(row.operations.map((op) => op.operation), [...OPERATIONS]);
    assert.ok(row.source.graphPath, `${row.resourceType} names its Graph source`);
  }
  // The decision table itself is hand-written: no entry beyond the catalogue.
  assert.deepEqual(Object.keys(TYPE_DECISIONS).sort(), CATALOG.map((entry) => entry.type).sort());
});

test('mutation check: omitting an unqualified catalogue type fails the ledger, never defaults it', () => {
  const { mobileAppConfiguration, ...withoutOne } = TYPE_DECISIONS;
  assert.ok(mobileAppConfiguration);
  assert.throws(() => buildOperationLedger({ decisions: withoutOne }), /no explicit qualification decision for: mobileAppConfiguration/);
  assert.equal(qualificationFor('not-a-type').decision, 'unknown');
});

test('supported rows carry credential, id outcome, idempotency, field classification and proof', () => {
  const ledger = buildOperationLedger();
  const supported = ledger.types.flatMap((row) => row.operations).filter((op) => op.decision === 'supported');
  assert.equal(supported.length, 17, 'group×4, roleAssignment×3, namedLocation×3, conditionalAccessPolicy×3, application×3 and servicePrincipal×1 (task-107)');
  for (const op of supported) {
    assert.equal(op.credentialMode, 'restorer');
    assert.ok(op.idOutcome);
    assert.ok(op.idempotency, `${op.resourceType} ${op.operation} must say why a retry is safe`);
    assert.ok(op.fieldClassification);
    assert.equal(op.fixture.result, 'passed');
    assert.ok(existsSync(new URL(op.fixture.proofRef, ROOT)), `${op.fixture.proofRef} must exist`);
    assert.equal(op.live.result, 'none', 'nothing is live-qualified by fixtures');
  }
  assert.equal(ledger.edges.length, 4);
  assert.ok(ledger.edges.every((edge) => edge.decision === 'supported' && edge.remapping.requirement === 'none'));
  const user = ledger.types.find((row) => row.resourceType === 'user');
  assert.equal(user.decision, 'manual');
  assert.equal(user.operations.find((op) => op.operation === 'restore-soft-deleted').softRestoreCandidate, true);
});

// --------------------------------------------- remappable is not a write gate

test('mutation check: no remappable descriptor becomes writable because it is remappable', () => {
  const ledger = buildOperationLedger();
  const registered = new Set(['group', 'roleAssignment', 'namedLocation', 'conditionalAccessPolicy']);
  const remappableOnly = DESCRIPTORS.filter((descriptor) => descriptor.remappable && !registered.has(descriptor.type));
  assert.ok(remappableOnly.length > 0, 'authenticationStrengthPolicy is remappable but unregistered');
  for (const descriptor of remappableOnly) {
    const row = ledger.types.find((candidate) => candidate.resourceType === descriptor.type);
    assert.notEqual(row.decision, 'automated');
    for (const op of row.operations) {
      assert.notEqual(op.decision, 'supported', `${descriptor.type} ${op.operation}`);
      assert.equal(capabilityFor(descriptor.type, op.operation).claim, 'unsupported');
    }
  }
});

function updateResource(resourceType, payload, references) {
  return { naturalKey: `${resourceType}:fixture`, resourceType, verb: 'update', targetId: 'fixture-existing', payload, references, blastRadius: 'cosmetic' };
}

async function runUpdate({ resourceType, collection, payload, references, existingTargetIds }) {
  const graph = fakeGraph();
  graph.objects.set(`${collection}/fixture-existing`, { ...payload, id: 'fixture-existing', displayName: 'Drifted' });
  const result = await applyWave(graph, governor, [updateResource(resourceType, payload, references)], {
    targetTenant: 'fixture', mode: 'enforce', existingTargetIds,
  });
  return { graph, result };
}

test('remapping a reference to a different id requires proof for exactly that operation', async () => {
  // roleAssignment create remapping is proven; update is not — a create proof never covers update.
  assert.equal(remappingFor('roleAssignment', 'create').qualified, true);
  assert.equal(remappingFor('roleAssignment', 'update').qualified, false);
  const refused = await runUpdate({
    resourceType: 'roleAssignment', collection: '/roleManagement/directory/roleAssignments',
    payload: { principalId: 'source-principal', roleDefinitionId: 'role-1', directoryScopeId: '/' },
    references: [{ field: 'principalId', symbol: 'group:Admins', required: true }],
    existingTargetIds: new Map([['group:Admins', 'target-principal']]),
  });
  assert.match(refused.result.failed[0]?.error ?? '', /unqualified-remapping: roleAssignment update/);
  assert.equal(refused.graph.writes.length, 0);
});

// Remapping proof for conditionalAccessPolicy update (proofRef: this file). Group
// update has none: no writable group field holds a reference, so a remapped
// group update is refused rather than claimed.
test('a conditional access update rewrites a reference to the target id and verifies it; group update remapping stays unproven', async () => {
  const policy = await runUpdate({
    resourceType: 'conditionalAccessPolicy', collection: '/identity/conditionalAccess/policies',
    payload: {
      displayName: 'Block legacy', state: 'enabledForReportingButNotEnforced',
      conditions: { users: { includeUsers: ['All'], excludeGroups: ['source-admins'] }, applications: { includeApplications: ['All'] } },
      grantControls: { operator: 'OR', builtInControls: ['block'] },
    },
    references: [{ field: 'conditions.users.excludeGroups[0]', symbol: 'group:Admins', required: true }],
    existingTargetIds: new Map([['group:Admins', 'target-admins']]),
  });
  assert.deepEqual(policy.result.failed, []);
  const written = policy.graph.objects.get('/identity/conditionalAccess/policies/fixture-existing');
  assert.deepEqual(written.conditions.users.excludeGroups, ['target-admins']);

  const group = await runUpdate({
    resourceType: 'group', collection: '/groups',
    payload: { displayName: 'Finance', mailNickname: 'finance', linkedGroupIds: ['source-privileged'] },
    references: [{ field: 'linkedGroupIds[0]', symbol: 'group:Privileged', required: true }],
    existingTargetIds: new Map([['group:Privileged', 'target-privileged']]),
  });
  assert.equal(remappingFor('group', 'update').qualified, false);
  assert.match(group.result.failed[0]?.error ?? '', /unqualified-remapping: group update/);
  assert.equal(group.graph.writes.length, 0);
});

test('mutation check: proof for a different operation is never accepted', () => {
  assert.throws(() => recordRemappingProof('group', 'delete', 'x'), /writes no references/);
  assert.throws(() => recordRemappingProof('authenticationStrengthPolicy', 'update', 'x'), /requires a registered write capability/);

  // Live evidence for another operation (or a relabelled one) cannot qualify this one.
  const now = new Date('2026-10-03T00:00:00Z');
  const evidence = {
    tenantRef: 'tenant-x', resourceType: 'namedLocation', operation: 'delete', fieldProjectionContractVersion: FIELD_PROJECTION_CONTRACT_VERSION,
    build: 'b1', synthetic: false, observedAt: '2026-10-02T00:00:00Z', proofRef: 'evidence/1',
  };
  const result = qualifyLiveEvidence('namedLocation', 'update', evidence, { tenantRef: 'tenant-x', now });
  assert.equal(result.promoted, false);
  assert.match(result.failures.join(' '), /required 'namedLocation'\/'update'/);
  assert.equal(capabilityFor('namedLocation', 'update').claim, 'fixture-tested');
});

// --------------------------------------------- labels and fakes prove nothing

test('relabelling a type cannot forge a capability or live evidence', () => {
  assert.throws(
    () => buildOperationLedger({ decisions: { ...TYPE_DECISIONS, deviceConfiguration: { decision: 'automated', reason: 'trust me' } } }),
    /deviceConfiguration is marked automated but has no registered write capability/,
  );
  assert.throws(
    () => buildOperationLedger({ decisions: { ...TYPE_DECISIONS, group: { decision: 'unknown', reason: 'hide it' } } }),
    /group has a registered write capability but is marked unknown/,
  );
  assert.equal(capabilityFor('deviceConfiguration', 'update').claim, 'unsupported');
  const ledger = buildOperationLedger();
  assert.ok(ledger.types.flatMap((row) => row.operations).every((op) => op.live.result === 'none'));
});

test('the fixture harness drives every registered operation and never changes a claim', async () => {
  const before = buildOperationLedger().types.map((row) => row.operations.map((op) => op.claim));
  const results = await runFixtureHarness();
  assert.equal(results.length, 17);
  assert.deepEqual(results.filter((result) => result.result !== 'passed'), []);
  assert.ok(results.every((result) => result.synthetic === true));
  assert.deepEqual(buildOperationLedger().types.map((row) => row.operations.map((op) => op.claim)), before);
});

test('the CLI checks completeness and prints the ledger', async () => {
  const lines = [];
  const out = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  assert.equal(await operationsMain({ argv: ['--check'], out }), 0);
  assert.match(lines[0], /^52 catalogue types, each with an explicit decision and an expansion batch$/);
  lines.length = 0;
  assert.equal(await operationsMain({ argv: ['--json'], out }), 0);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.types.length, 52);
  assert.equal(parsed.fixtureHarness, undefined, 'the harness only runs when asked');
});

// The tests below register throwaway capabilities in this process's registry,
// so they run last: a ledger built after them would (correctly) refuse a
// registered type whose decision is not 'automated'.

test('a same-tenant update stays valid with remappable=false: references that resolve to the same id remap nothing', async () => {
  // groupSetting is remappable=false and has no write registration; register an
  // update for this test process only, with no remapping proof at all.
  assert.equal(DESCRIPTORS.find((descriptor) => descriptor.type === 'groupSetting').remappable, false);
  registerOperationCapability({ resourceType: 'groupSetting', operation: 'update', path: '/groupSettings', handler: 'engine/restore/applyEngine.mjs#applyWave', idOutcome: 'preserved' });
  assert.equal(remappingFor('groupSetting', 'update').qualified, false);
  const payload = { displayName: 'Setting', templateId: 'template-1' };
  const same = await runUpdate({
    resourceType: 'groupSetting', collection: '/groupSettings', payload,
    references: [{ field: 'templateId', symbol: 'directorySettingTemplate:t', required: true }],
    existingTargetIds: new Map([['directorySettingTemplate:t', 'template-1']]),
  });
  assert.deepEqual(same.result.failed, [], 'no id changes, so no remapping proof is needed');
  assert.equal(same.result.applied.length, 1);

  const different = await runUpdate({
    resourceType: 'groupSetting', collection: '/groupSettings', payload,
    references: [{ field: 'templateId', symbol: 'directorySettingTemplate:t', required: true }],
    existingTargetIds: new Map([['directorySettingTemplate:t', 'template-2']]),
  });
  assert.match(different.result.failed[0]?.error ?? '', /unqualified-remapping: groupSetting update would rewrite templateId/);
  assert.equal(different.graph.writes.length, 0, 'refused before any write');
});

test('a declared-only registration stays declared, and the ledger then refuses its unchanged decision', () => {
  registerOperationCapability({ resourceType: 'administrativeUnit', operation: 'create', path: '/directory/administrativeUnits', handler: 'engine/restore/applyEngine.mjs#applyWave', idOutcome: 'server-assigned' });
  assert.equal(capabilityFor('administrativeUnit', 'create').claim, 'declared');
  assert.throws(() => recordFixtureProof('administrativeUnit', 'update', 'x'));
  assert.throws(() => buildOperationLedger(), /has a registered write capability but is marked unknown/);
});
