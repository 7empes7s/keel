/**
 * Roadmap task-52 boundary tests: evidence-backed operation capability
 * registry. Exercises the production engine/coverage/capabilities.mjs,
 * engine/restore/applyEngine.mjs, engine/reconcile/verb.mjs and
 * engine/coverage/report.mjs against adversarial fixtures — including the
 * three required mutation checks:
 *
 * - Qualify operation from pathFor alone.
 * - Promote fixture proof to live-qualified.
 * - Bypass unsupported-operation check.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  CAPABILITY_CONTRACT_VERSION, CLAIM_LEVELS, CREDENTIAL_MODES, OPERATIONS,
  UnregisteredCapabilityError, capabilityFor, capabilitySummaryFor, graphPathFor,
  isSupportedClaim, qualifyLiveEvidence, recordFixtureProof, registerOperationCapability,
} from '../coverage/capabilities.mjs';
import { FIELD_PROJECTION_CONTRACT_VERSION } from '../contracts/fieldProjection.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { applyPatches, applyWave } from '../restore/applyEngine.mjs';
import { ThrottleGovernor } from '../restore/throttleGovernor.mjs';
import { decideVerb, verbCapability } from '../reconcile/verb.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { collectSnapshot } from '../collect/snapshot.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const REGISTERED = Object.freeze({
  group: ['create', 'update', 'delete', 'restore-soft-deleted'],
  roleAssignment: ['create', 'update', 'delete'],
  namedLocation: ['create', 'update', 'delete'],
  conditionalAccessPolicy: ['create', 'update', 'delete'],
  // Roadmap task-107: the first application/service-principal subset.
  application: ['create', 'update', 'restore-soft-deleted'],
  servicePrincipal: ['create'],
  // Roadmap task-108: custom authentication strengths only.
  authenticationStrengthPolicy: ['create', 'update'],
  // Roadmap task-109: the administrative-configuration subset.
  administrativeUnit: ['update'],
  groupSetting: ['update', 'delete'],
});

function governor() {
  return new ThrottleGovernor({ 'target/entra/write': { capacity: 100, refillPerSecond: 100 } });
}

/** Immediate-converge fake writer: write succeeds, read reflects the write
 * (or an explicit fixed body) with no retry-triggering staleness. */
function fakeWriter({ writeOk = true, writeStatus, writeBody, readBody, readOk = true, readStatus = 200 } = {}) {
  const calls = [];
  let lastWriteBody;
  return {
    calls,
    write: async (version, path, opts) => {
      calls.push({ kind: 'write', version, path, opts });
      lastWriteBody = opts.body;
      if (!writeOk) return { ok: false, status: writeStatus ?? 400, body: { error: 'bad' } };
      return { ok: true, status: writeStatus ?? (opts.method === 'POST' ? 201 : 204), body: writeBody ?? (opts.method === 'POST' ? { id: 'new-id' } : null) };
    },
    read: async (version, path) => {
      calls.push({ kind: 'read', version, path });
      return { ok: readOk, status: readStatus, body: readOk ? (readBody ?? lastWriteBody) : null };
    },
  };
}

/** Fake writer for a delete: write DELETEs, read reports 404 (absent)
 * immediately — the expected terminal state, not staleness. */
function fakeDeleteWriter() {
  const calls = [];
  return {
    calls,
    write: async (version, path, opts) => { calls.push({ kind: 'write', version, path, opts }); return { ok: true, status: 204, body: null }; },
    read: async (version, path) => { calls.push({ kind: 'read', version, path }); return { ok: false, status: 404, body: null }; },
  };
}

// ---------------------------------------------------------------------------
// Contract vocabulary
// ---------------------------------------------------------------------------

test('capability contract exposes a stable version and claim/operation/credential vocabulary', () => {
  assert.equal(CAPABILITY_CONTRACT_VERSION, 1);
  assert.deepEqual([...CLAIM_LEVELS], ['declared', 'fixture-tested', 'live-qualified', 'unsupported', 'unknown']);
  assert.deepEqual([...OPERATIONS], ['create', 'update', 'delete', 'restore-soft-deleted']);
  assert.deepEqual([...CREDENTIAL_MODES], ['collector', 'restorer']);
  assert.deepEqual(
    [true, true, true, false, false],
    ['declared', 'fixture-tested', 'live-qualified', 'unsupported', 'unknown'].map(isSupportedClaim),
  );
});

// ---------------------------------------------------------------------------
// Registered capabilities: every real operation is fixture-tested with a
// named proof, correct handler/path/idOutcome/credentialMode/projection.
// ---------------------------------------------------------------------------

test('every registered operation is fixture-tested with a named proof and correct metadata', () => {
  for (const [resourceType, operations] of Object.entries(REGISTERED)) {
    for (const operation of operations) {
      const capability = capabilityFor(resourceType, operation);
      assert.equal(capability.claim, 'fixture-tested', `${resourceType} ${operation} should be fixture-tested`);
      assert.equal(typeof capability.proofRef, 'string');
      assert.ok(capability.proofRef.length > 0, `${resourceType} ${operation} must name its proof`);
      assert.equal(capability.credentialMode, 'restorer');
      assert.equal(capability.handler, 'engine/restore/applyEngine.mjs#applyWave');
      assert.equal(capability.idOutcome, operation === 'create' ? 'server-assigned' : operation === 'delete' ? 'terminal' : 'preserved');
      assert.equal(capability.path, graphPathFor(resourceType));
      assert.equal(capability.contractVersion, CAPABILITY_CONTRACT_VERSION);
    }
  }
  // group carries sensitiveExport rules (has-rules); the other three are
  // reviewed with nothing to exclude (reviewed-empty) — see fieldProjection.mjs.
  assert.equal(capabilitySummaryFor('group').operations.update.projection, 'has-rules');
  for (const type of ['roleAssignment', 'namedLocation', 'conditionalAccessPolicy']) {
    assert.equal(capabilitySummaryFor(type).operations.update.projection, 'reviewed-empty');
  }
});

test('roleAssignment/namedLocation/conditionalAccessPolicy are not soft-deletable: no restore-soft-deleted capability', () => {
  for (const type of ['roleAssignment', 'namedLocation', 'conditionalAccessPolicy']) {
    const capability = capabilityFor(type, 'restore-soft-deleted');
    assert.equal(capability.claim, 'unsupported', `${type} restore-soft-deleted should be unsupported`);
    assert.equal(capability.proofRef, null);
  }
});

// ---------------------------------------------------------------------------
// Mutation check 1: qualify operation from pathFor alone.
//
// Every one of CATALOG's 52 types has a real Graph collection `path` — path
// existence alone must never imply write capability. Every type outside the
// four explicitly registered above must read 'unsupported' for all four
// operations, even though a read path exists.
// ---------------------------------------------------------------------------

test('mutation pin: a real Graph collection path never implies write capability', () => {
  const registeredTypes = new Set(Object.keys(REGISTERED));
  let checked = 0;
  for (const entry of CATALOG) {
    if (registeredTypes.has(entry.type)) continue;
    assert.ok(typeof entry.path === 'string' && entry.path.length > 0, `${entry.type} must have a real CATALOG path for this pin to mean anything`);
    for (const operation of OPERATIONS) {
      assert.equal(capabilityFor(entry.type, operation).claim, 'unsupported', `${entry.type} ${operation} must be unsupported despite CATALOG path ${entry.path}`);
    }
    assert.equal(graphPathFor(entry.type), null, `${entry.type} must have no registered write path`);
    checked += 1;
  }
  assert.ok(checked > 40, 'this pin must exercise the bulk of the catalogue, not a token sample');
});

test('mutation pin: descriptor.remappable never gates a capability claim', () => {
  // user is remappable: false (descriptors.mjs) and has no registered write
  // path at all — its unsupported claim must come from the absence of
  // registration, not from remappable. Prove independence directly: a
  // throwaway type registered here with a remappable=false-shaped identity
  // (i.e. nothing about remappable is even consulted) still reads
  // 'declared' purely from registration.
  registerOperationCapability({
    resourceType: 'test-remap-independent-widget',
    operation: 'update',
    path: '/testWidgets',
    handler: 'test-only-handler',
    idOutcome: 'preserved',
  });
  assert.equal(capabilityFor('test-remap-independent-widget', 'update').claim, 'declared');
  assert.equal(capabilityFor('user', 'update').claim, 'unsupported', 'user has no registered write path');
});

// ---------------------------------------------------------------------------
// Declared-only capability: registered but not yet fixture-proven.
// ---------------------------------------------------------------------------

test('a declared-only capability is supported (attemptable) but not yet fixture-tested', () => {
  registerOperationCapability({
    resourceType: 'test-declared-only-widget',
    operation: 'create',
    path: '/testDeclaredWidgets',
    handler: 'test-only-handler',
    idOutcome: 'server-assigned',
  });
  const capability = capabilityFor('test-declared-only-widget', 'create');
  assert.equal(capability.claim, 'declared');
  assert.equal(capability.proofRef, null);
  assert.equal(isSupportedClaim(capability.claim), true);
  assert.equal(verbCapability('test-declared-only-widget', 'create').supported, true);

  recordFixtureProof('test-declared-only-widget', 'create', 'engine/roadmap/capability-registry.test.mjs');
  assert.equal(capabilityFor('test-declared-only-widget', 'create').claim, 'fixture-tested');

  assert.throws(
    () => recordFixtureProof('test-declared-only-widget', 'delete', 'x'),
    UnregisteredCapabilityError,
    'cannot attach proof to an operation that was never registered',
  );
});

// ---------------------------------------------------------------------------
// Mutation check 2: promote fixture proof to live-qualified.
// ---------------------------------------------------------------------------

test('live qualification requires matching tenant, operation, projection build and freshness — a synthetic fixture proof can never promote', () => {
  const tenantRef = 'sha256:capability-qualify-test';
  const now = new Date('2026-09-19T12:00:00.000Z');
  const validEvidence = () => ({
    tenantRef, resourceType: 'namedLocation', operation: 'delete',
    fieldProjectionContractVersion: FIELD_PROJECTION_CONTRACT_VERSION,
    build: 'git:abc123', synthetic: false,
    observedAt: now.toISOString(), proofRef: 'evidence-row-1',
  });

  // A synthetic (fixture-harness) proof must never promote.
  const synthetic = qualifyLiveEvidence('namedLocation', 'delete', { ...validEvidence(), synthetic: true }, { tenantRef, now });
  assert.equal(synthetic.promoted, false);
  assert.ok(synthetic.failures.some((f) => /synthetic/i.test(f)));
  assert.equal(capabilityFor('namedLocation', 'delete').claim, 'fixture-tested', 'claim must not move on a rejected promotion');

  // Wrong tenant.
  const wrongTenant = qualifyLiveEvidence('namedLocation', 'delete', { ...validEvidence(), tenantRef: 'sha256:other' }, { tenantRef, now });
  assert.equal(wrongTenant.promoted, false);
  assert.ok(wrongTenant.failures.some((f) => /cross-tenant/i.test(f)));

  // Wrong operation/resourceType.
  const wrongOperation = qualifyLiveEvidence('namedLocation', 'delete', { ...validEvidence(), operation: 'update' }, { tenantRef, now });
  assert.equal(wrongOperation.promoted, false);

  // Stale field-projection contract version.
  const staleProjection = qualifyLiveEvidence('namedLocation', 'delete', { ...validEvidence(), fieldProjectionContractVersion: 999 }, { tenantRef, now });
  assert.equal(staleProjection.promoted, false);
  assert.ok(staleProjection.failures.some((f) => /field-projection contract/i.test(f)));

  // Stale by age (31 days old).
  const staleAge = qualifyLiveEvidence('namedLocation', 'delete', {
    ...validEvidence(), observedAt: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString(),
  }, { tenantRef, now });
  assert.equal(staleAge.promoted, false);
  assert.ok(staleAge.failures.some((f) => /stale/i.test(f)));

  // Future timestamp.
  const future = qualifyLiveEvidence('namedLocation', 'delete', {
    ...validEvidence(), observedAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
  }, { tenantRef, now });
  assert.equal(future.promoted, false);
  assert.ok(future.failures.some((f) => /future/i.test(f)));

  // Missing proofRef.
  const noProof = qualifyLiveEvidence('namedLocation', 'delete', { ...validEvidence(), proofRef: '' }, { tenantRef, now });
  assert.equal(noProof.promoted, false);

  // Cannot qualify an operation that was never fixture-tested.
  registerOperationCapability({
    resourceType: 'test-never-proven-widget', operation: 'update', path: '/x', handler: 'h', idOutcome: 'preserved',
  });
  const neverProven = qualifyLiveEvidence('test-never-proven-widget', 'update', validEvidence(), { tenantRef, now });
  assert.equal(neverProven.promoted, false);
  assert.ok(neverProven.failures.some((f) => /has not been fixture-tested/i.test(f)));

  // Cannot qualify an unregistered pair at all.
  assert.throws(() => qualifyLiveEvidence('domain', 'update', validEvidence(), { tenantRef, now }), UnregisteredCapabilityError);

  // Finally: a fully matching, non-synthetic, fresh proof DOES promote.
  const promoted = qualifyLiveEvidence('namedLocation', 'delete', validEvidence(), { tenantRef, now });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.claim, 'live-qualified');
  assert.equal(capabilityFor('namedLocation', 'delete').claim, 'live-qualified');
  assert.equal(capabilityFor('namedLocation', 'delete').proofRef, 'evidence-row-1');
  // Idempotent: re-qualifying an already live-qualified capability with
  // fresh matching evidence succeeds again rather than being refused.
  const reQualified = qualifyLiveEvidence('namedLocation', 'delete', validEvidence(), { tenantRef, now });
  assert.equal(reQualified.promoted, true);
});

// ---------------------------------------------------------------------------
// verb.mjs integration: verbCapability is independent of decideVerb.
// ---------------------------------------------------------------------------

test('verbCapability answers "can applyWave do this", independent of decideVerb\'s "what does the diff require"', () => {
  assert.equal(verbCapability('group', 'noop').supported, true);
  assert.equal(verbCapability('group', 'noop').capability, null);
  assert.equal(verbCapability('group', 'update').supported, true);
  assert.equal(verbCapability('group', 'restore-soft-deleted').supported, true);
  assert.equal(verbCapability('roleAssignment', 'restore-soft-deleted').supported, false);
  assert.equal(verbCapability('domain', 'update').supported, false);
  assert.equal(verbCapability('domain', 'update').capability.claim, 'unsupported');

  // decideVerb itself is untouched by this task — still a pure diff decision
  // with no resourceType/capability awareness.
  const decision = decideVerb({ desired: { payloadHash: 'a' }, live: { payloadHash: 'b' }, softDeleted: false });
  assert.equal(decision.verb, 'update');
});

// ---------------------------------------------------------------------------
// Mutation check 3: bypass unsupported-operation check.
//
// applyWave must refuse an unsupported (resourceType, verb) pair BEFORE any
// guard, rollback-journal write or writer call — never an uncaught throw
// from the internal pathFor(), and never a silent pass-through.
// ---------------------------------------------------------------------------

test('applyWave refuses an unsupported operation before any writer call, for every verb', async () => {
  for (const verb of ['create', 'update', 'delete', 'restore-soft-deleted']) {
    const writer = fakeWriter();
    const resource = {
      naturalKey: `domain:example-${verb}.test`, resourceType: 'domain', verb,
      targetId: 'domain-id', deletedItemId: 'domain-id', payload: { isDefault: true }, references: [],
      blastRadius: 'tenant-lockout',
    };
    // eslint-disable-next-line no-await-in-loop
    const result = await applyWave(writer, governor(), [resource], { targetTenant: 'target', mode: 'enforce', simulationPassed: true });
    assert.equal(writer.calls.length, 0, `${verb}: must never reach the writer for an unsupported operation`);
    assert.equal(result.applied.length, 0, `${verb}: must never be applied`);
    assert.equal(result.skipped.length, 0, `${verb}: unsupported is a failure, not a guard skip`);
    assert.equal(result.failed.length, 1, `${verb}: must fail closed`);
    assert.match(result.failed[0].error, /unsupported operation: domain/);
  }
});

test('applyWave refuses an unsupported verb even for an otherwise-registered resourceType', async () => {
  const writer = fakeWriter();
  const resource = {
    naturalKey: 'roleAssignment:Owner@group:Ghost', resourceType: 'roleAssignment', verb: 'restore-soft-deleted',
    targetId: 'ra-1', deletedItemId: 'ra-1', payload: { principalId: 'p', roleDefinitionId: 'r', directoryScopeId: '/' }, references: [],
  };
  const result = await applyWave(writer, governor(), [resource], { targetTenant: 'target', mode: 'enforce' });
  assert.equal(writer.calls.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /unsupported operation: roleAssignment restore-soft-deleted/);
});

test('applyWave refuses an unsupported operation before the rollback journal is ever written', async () => {
  const writer = fakeWriter();
  const journalCalls = [];
  const rollbackClient = { query: async (...args) => { journalCalls.push(args); } };
  const resource = {
    naturalKey: 'domain:example.test', resourceType: 'domain', verb: 'update',
    targetId: 'domain-id', payload: { isDefault: true }, references: [],
  };
  const result = await applyWave(writer, governor(), [resource], {
    targetTenant: 'target', mode: 'enforce', rollbackClient, runId: 'unsupported-op-test',
  });
  assert.equal(journalCalls.length, 0, 'the rollback journal must never be touched for an unsupported operation');
  assert.equal(writer.calls.length, 0);
  assert.equal(result.failed.length, 1);
});

test('applyPatches refuses an unsupported operation before any writer call', async () => {
  const writer = fakeWriter();
  const patch = { naturalKey: 'domain:example.test', symbol: 'group:Parent', field: 'parentId', resourceType: 'domain' };
  const appliedIds = new Map([['group:Parent', 'parent-id'], ['domain:example.test', 'domain-id']]);
  const result = await applyPatches(writer, governor(), [patch], { targetTenant: 'target', mode: 'enforce', appliedIds });
  assert.equal(writer.calls.length, 0);
  assert.equal(result.applied.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /unsupported operation: domain update/);
});

// ---------------------------------------------------------------------------
// New adversarial boundary fixtures closing real, pre-existing evidence
// gaps (Step 1): namedLocation had ZERO test coverage for any write
// operation before this task, roleAssignment's update/delete verbs were
// never exercised through the real applyWave write path, and
// conditionalAccessPolicy delete was never exercised at all. Each of these
// establishes the fixture-tested proof this file's capabilities.mjs
// registrations claim above.
// ---------------------------------------------------------------------------

test('namedLocation create: real writer.write POST, verified by re-read hash match', async () => {
  const desired = { displayName: 'HQ Trusted Range', isTrusted: true, countriesAndRegions: ['US'] };
  const writer = fakeWriter({ writeBody: { id: 'nl-new-1' } });
  const resource = { naturalKey: 'namedLocation:HQ Trusted Range', resourceType: 'namedLocation', payload: desired, references: [] };
  const result = await applyWave(writer, governor(), [resource], { targetTenant: 'target', mode: 'enforce' });
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].targetId, 'nl-new-1');
  const writeCall = writer.calls.find((c) => c.kind === 'write');
  assert.equal(writeCall.path, '/identity/conditionalAccess/namedLocations');
  assert.equal(writeCall.opts.method, 'POST');
});

test('namedLocation update: real writer.write PATCH, verified by re-read hash match', async () => {
  const desired = { displayName: 'HQ Trusted Range', isTrusted: true };
  const writer = fakeWriter({ readBody: { ...desired, id: 'nl-1' } });
  const resource = { naturalKey: 'namedLocation:HQ', resourceType: 'namedLocation', targetId: 'nl-1', payload: desired, verb: 'update', references: [] };
  const result = await applyWave(writer, governor(), [resource], { targetTenant: 'target', mode: 'enforce' });
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
  assert.equal(result.applied.length, 1);
  const writeCall = writer.calls.find((c) => c.kind === 'write');
  assert.equal(writeCall.path, '/identity/conditionalAccess/namedLocations/nl-1');
  assert.equal(writeCall.opts.method, 'PATCH');
  assert.deepEqual(writeCall.opts.body, desired);
});

test('namedLocation delete: real writer.write DELETE, verified absent by re-read', async () => {
  const writer = fakeDeleteWriter();
  const resource = {
    naturalKey: 'namedLocation:HQ', resourceType: 'namedLocation', targetId: 'nl-1', verb: 'delete',
    payload: { id: 'nl-1', displayName: 'HQ' }, references: [], blastRadius: 'tenant-lockout',
  };
  const result = await applyWave(writer, governor(), [resource], {
    targetTenant: 'target', mode: 'enforce', simulationPassed: true,
    deletionGuardOptions: { breakGlassUserIds: ['break-glass-id'], keelAppIds: [], caPolicies: [] },
  });
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
  assert.equal(result.applied.length, 1);
  const writeCall = writer.calls.find((c) => c.kind === 'write');
  assert.equal(writeCall.path, '/identity/conditionalAccess/namedLocations/nl-1');
  assert.equal(writeCall.opts.method, 'DELETE');
});

test('roleAssignment update: every real field is immutable — PATCH body is empty and the result is not-remediable, never silently applied nor corrupted', async () => {
  const live = { id: 'ra-1', principalId: 'old-principal-guid', roleDefinitionId: 'role-def-guid', directoryScopeId: '/' };
  const desired = { principalId: 'new-principal-guid', roleDefinitionId: 'role-def-guid', directoryScopeId: '/' };
  const writer = fakeWriter({ readBody: live });
  const resource = {
    naturalKey: 'roleAssignment:Owner@group:FIN-Admins', resourceType: 'roleAssignment',
    targetId: 'ra-1', payload: desired, verb: 'update', references: [],
  };
  const result = await applyWave(writer, governor(), [resource], { targetTenant: 'target', mode: 'enforce' });
  assert.equal(result.applied.length, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(result.notRemediable.length, 1, JSON.stringify(result));
  assert.equal(result.notRemediable[0].naturalKey, resource.naturalKey);
  assert.ok(result.notRemediable[0].immutable.includes('principalId'));
  const patchCall = writer.calls.find((c) => c.kind === 'write' && c.opts.method === 'PATCH');
  assert.ok(patchCall, 'a PATCH is still issued — the capability is exercised, even though nothing in it is writable');
  assert.deepEqual(patchCall.opts.body, {}, 'no immutable field is ever sent in a roleAssignment PATCH body');
});

test('roleAssignment delete: real writer.write DELETE under a passed simulation, verified absent by re-read', async () => {
  const writer = fakeDeleteWriter();
  const resource = {
    naturalKey: 'roleAssignment:GlobalAdministrator@group:Finance@/', resourceType: 'roleAssignment',
    targetId: 'ra-1', verb: 'delete', payload: { id: 'ra-1', roleDefinitionId: 'global-administrator' },
    references: [], blastRadius: 'tenant-lockout',
  };
  const result = await applyWave(writer, governor(), [resource], {
    targetTenant: 'target', mode: 'enforce', simulationPassed: true,
    deletionGuardOptions: { breakGlassUserIds: ['break-glass-id'], keelAppIds: [], caPolicies: [] },
  });
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
  assert.equal(result.applied.length, 1);
  const writeCall = writer.calls.find((c) => c.kind === 'write');
  assert.equal(writeCall.path, '/roleManagement/directory/roleAssignments/ra-1');
  assert.equal(writeCall.opts.method, 'DELETE');
});

test('conditionalAccessPolicy delete: real writer.write DELETE once break-glass exclusions are verified, absent confirmed by re-read', async () => {
  const writer = fakeDeleteWriter();
  const policyPayload = {
    id: 'ca-1', displayName: 'Finance policy',
    conditions: { users: { excludeUsers: ['some-other-excluded-user'] } },
  };
  const resource = {
    naturalKey: 'conditionalAccessPolicy:Finance', resourceType: 'conditionalAccessPolicy',
    targetId: 'ca-1', verb: 'delete', payload: policyPayload, references: [], blastRadius: 'tenant-lockout',
  };
  const result = await applyWave(writer, governor(), [resource], {
    targetTenant: 'target', mode: 'enforce', simulationPassed: true,
    deletionGuardOptions: {
      breakGlassUserIds: ['break-glass-id'], keelAppIds: [],
      caPolicies: [{ naturalKey: resource.naturalKey, payload: policyPayload }],
    },
  });
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
  assert.equal(result.applied.length, 1);
  const writeCall = writer.calls.find((c) => c.kind === 'write');
  assert.equal(writeCall.path, '/identity/conditionalAccess/policies/ca-1');
  assert.equal(writeCall.opts.method, 'DELETE');
});

test('conditionalAccessPolicy delete without a matching caPolicies entry is refused by the pre-existing break-glass guard, not by the capability gate', async () => {
  const writer = fakeDeleteWriter();
  const resource = {
    naturalKey: 'conditionalAccessPolicy:Unverifiable', resourceType: 'conditionalAccessPolicy',
    targetId: 'ca-2', verb: 'delete', payload: { id: 'ca-2', displayName: 'Unverifiable' }, references: [], blastRadius: 'tenant-lockout',
  };
  const result = await applyWave(writer, governor(), [resource], {
    targetTenant: 'target', mode: 'enforce', simulationPassed: true,
    deletionGuardOptions: { breakGlassUserIds: ['break-glass-id'], keelAppIds: [], caPolicies: [] },
  });
  assert.equal(writer.calls.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /cannot verify break-glass exclusions/);
});

// ---------------------------------------------------------------------------
// report.mjs integration: writeCapability surfaces alongside remappable,
// for both a covered descriptor type and a not-covered catalogue entry.
// ---------------------------------------------------------------------------

test('buildCoverageReport surfaces evidence-backed writeCapability per type, independent of remappable', async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  let client;
  try {
    client = await database.connect();
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    const tenantRef = 'sha256:capability-report-test';
    const reader = { async collect() { return { items: [], error: null }; } };
    await collectSnapshot(client, { reader, tenantRef, tenantId: 'fixture-tenant' });

    const report = await buildCoverageReport(client, { tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS, now: new Date('2026-09-19T00:00:00.000Z') });
    const byType = new Map(report.types.map((t) => [t.type, t]));

    const group = byType.get('group');
    assert.equal(group.remappable, true);
    assert.equal(group.writeCapability.resourceType, 'group');
    assert.equal(group.writeCapability.contractVersion, CAPABILITY_CONTRACT_VERSION);
    assert.equal(group.writeCapability.operations.update.claim, 'fixture-tested');
    assert.equal(group.writeCapability.operations.update.projection, 'has-rules');
    assert.equal(group.writeCapability.operations['restore-soft-deleted'].claim, 'fixture-tested');

    const user = byType.get('user');
    assert.equal(user.remappable, false, 'remappable stays a separate, pre-existing field');
    for (const operation of OPERATIONS) {
      assert.equal(user.writeCapability.operations[operation].claim, 'unsupported', 'user has no registered write path — remappable is not consulted');
    }

    // A not-covered catalogue entry (no descriptor) still carries a
    // capability summary, independent of read-coverage status.
    const unsupportedFixtureReport = await buildCoverageReport(client, {
      tenantRef, catalog: [...CATALOG, { type: 'unsupportedFixture' }], descriptors: DESCRIPTORS, now: new Date('2026-09-19T00:00:00.000Z'),
    });
    const missingAdapter = unsupportedFixtureReport.types.find((t) => t.type === 'unsupportedFixture');
    assert.equal(missingAdapter.status, 'not-covered');
    assert.equal(missingAdapter.remappable, null);
    assert.equal(missingAdapter.writeCapability.operations.create.claim, 'unsupported');
  } finally {
    await client?.end();
    await database.cleanup();
  }
});
