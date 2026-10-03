/**
 * Roadmap task-66 boundary tests: guarding the irreversible effects of
 * configuration changes.
 *
 * Exercises engine/safety/contentEffects.mjs, the applyWave preservation-lock
 * handling and the full cli/keel-restore.mjs dry-run -> approval -> promotion
 * path against the isolated test database and an in-memory fake Graph. No
 * tenant is read or written. Required mutation checks:
 *
 * - Classify hold release as cosmetic.
 * - Reuse approval after effect change.
 * - Retry around preservation lock.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole, revokeRole } from '../authz/administration.mjs';
import { canonicalHash } from '../cir/canonicalHash.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { createDryRunArtifact, getDryRunArtifactById } from '../restore/dryRunArtifact.mjs';
import {
  CONTENT_EFFECTS, ContentEffectApprovalError, approveContentEffects, assertContentEffectApproval, classifyContentEffects,
  contentEffectsDigest, disclosureFor, isPreservationLockFailure,
} from '../safety/contentEffects.mjs';
import { createSnapshot, completeSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { runRestore } from '../../cli/keel-restore.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const TENANT = 'sha256:task-66';
const governor = { async acquire() {}, observeRetryAfter() {} };
const quiet = { log() {}, error() {} };

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    schemaReady = true;
  }
  return client;
}

async function principal(client, email, role) {
  const { rows } = await client.query(`INSERT INTO principal (email) VALUES ($1) RETURNING id`, [email]);
  const grant = role ? await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id }) : null;
  return { id: rows[0].id, grantId: grant?.id ?? null };
}

const update = (resourceType, before, after, naturalKey = `${resourceType}:x`) => ({
  naturalKey, resourceType, verb: 'update', payload: after, live: { state: 'present', payload: before, targetId: 'id-1' },
});

// --------------------------------------------------------------- classification

test('shortened retention, released holds, widened sharing and destroying actions are classified with disclosures', () => {
  const { effects, refusals } = classifyContentEffects([
    update('retentionLabel', { displayName: 'Finance', retentionDuration: { days: 2555 }, actionAfterRetentionPeriod: 'none' },
      { displayName: 'Finance', retentionDuration: { days: 30 }, actionAfterRetentionPeriod: 'delete' }),
    update('group', { displayName: 'Board', visibility: 'Private' }, { displayName: 'Board', visibility: 'Public' }),
    update('authorizationPolicy', { allowInvitesFrom: 'adminsAndGuestInviters' }, { allowInvitesFrom: 'everyone' }),
    update('groupSetting', { values: [{ name: 'AllowGuestsToAccessGroups', value: 'false' }] }, { values: [{ name: 'AllowGuestsToAccessGroups', value: 'true' }] }),
  ]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(effects.map((e) => `${e.resourceType}:${e.field}:${e.effect}`).sort(), [
    'authorizationPolicy:allowInvitesFrom:externally-sharing',
    'group:visibility:externally-sharing',
    'groupSetting:values[AllowGuestsToAccessGroups]:externally-sharing',
    'retentionLabel:actionAfterRetentionPeriod:irreversible',
    'retentionLabel:retentionDuration.days:retention-reducing',
  ]);
  // Disclosure: content is not backed up, and an inverse setting recovers nothing.
  for (const effect of CONTENT_EFFECTS) {
    assert.match(disclosureFor(effect), /backs up configuration, not content/);
    assert.match(disclosureFor(effect), /does not bring it back/);
  }
  assert.ok(effects.every((effect) => effect.disclosure === disclosureFor(effect.effect)));
});

test('mutation check: releasing or deleting a hold is hold-releasing, never cosmetic', () => {
  const released = classifyContentEffects([update('ediscoveryHoldPolicy', { displayName: 'Case 12', isEnabled: true }, { displayName: 'Case 12', isEnabled: false })]);
  assert.deepEqual(released.effects.map((e) => e.effect), ['hold-releasing']);
  const deleted = classifyContentEffects([{ naturalKey: 'ediscoveryHoldPolicy:Case 12', resourceType: 'ediscoveryHoldPolicy', verb: 'delete', payload: null, live: { state: 'present', payload: { isEnabled: true } } }]);
  assert.deepEqual(deleted.effects.map((e) => e.effect), ['hold-releasing']);
});

test('a benign or unchanged setting proceeds with no effect; narrowing is not an effect', () => {
  const { effects, refusals } = classifyContentEffects([
    update('group', { displayName: 'Board', visibility: 'Private' }, { displayName: 'Board members', visibility: 'Private' }),
    update('group', { displayName: 'Old', visibility: 'Public' }, { displayName: 'Old', visibility: 'Private' }),
    update('retentionLabel', { retentionDuration: { days: 30 } }, { retentionDuration: { days: 365 } }),
    update('conditionalAccessPolicy', { state: 'enabled' }, { state: 'enabledForReportingButNotEnforced', conditions: { users: { excludeGuestsOrExternalUsers: { guestOrExternalUserTypes: 'b2bCollaborationGuest' } } } }),
    { naturalKey: 'group:new', resourceType: 'group', verb: 'create', payload: { visibility: 'Public' }, live: null },
  ]);
  assert.deepEqual(effects, []);
  assert.deepEqual(refusals, [], 'reviewed types are judged by their rules, not by field names');
});

test('an unclassified dangerous transition on an unreviewed type refuses until classified', () => {
  const { effects, refusals } = classifyContentEffects([
    update('deviceConfiguration', { displayName: 'Baseline', remoteWipeAfterDays: 0 }, { displayName: 'Baseline', remoteWipeAfterDays: 14 }),
    update('mobileAppConfiguration', { displayName: 'Old name' }, { displayName: 'New name' }),
  ]);
  assert.deepEqual(effects, []);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0].reason, /unclassified-content-effect: deviceConfiguration changes remoteWipeAfterDays/);
});

// ------------------------------------------------- mutation check: preservation lock

test('mutation check: a preservation-locked object is refused at planning and a lock refusal is never retried or worked around', async () => {
  const planned = classifyContentEffects([
    update('retentionLabel', { retentionDuration: { days: 2555 }, isPreservationLocked: true }, { retentionDuration: { days: 2555 }, displayName: 'renamed' }),
  ]);
  assert.match(planned.refusals[0].reason, /preservation-locked/);

  const graph = fakeGraph();
  graph.objects.set('/groups/locked', { id: 'locked', displayName: 'Old', mailNickname: 'locked' });
  let attempts = 0;
  const lockedWriter = {
    writes: graph.writes,
    async write(version, path, options) {
      graph.writes.push({ method: options.method, path });
      attempts += 1;
      return { ok: false, status: 400, body: { error: { code: 'PreservationLockViolation', message: 'Preservation Lock prevents this change' } } };
    },
    read: (version, path) => graph.read(version, path),
  };
  const result = await applyWave(lockedWriter, governor, [{
    naturalKey: 'group:locked', resourceType: 'group', verb: 'update', targetId: 'locked',
    payload: { displayName: 'New', mailNickname: 'locked' }, references: [], blastRadius: 'cosmetic',
  }], { targetTenant: 't', mode: 'enforce' });
  assert.equal(attempts, 1, 'the refused write is sent exactly once');
  assert.deepEqual(graph.writes.map((w) => w.method), ['PATCH'], 'no delete, recreate or other path follows');
  assert.match(result.failed[0].error, /^preservation-lock:/);
  assert.equal(isPreservationLockFailure({ body: { error: { message: 'ok' } } }), false);
});

// ------------------------------------ approval: separate, current, bound to the effects

async function artifactWithEffects(client, { requestedBy, effects }) {
  const snapshotId = await createSnapshot(client, { tenantRef: TENANT });
  return createDryRunArtifact(client, {
    id: crypto.randomUUID(), tenantRef: TENANT, snapshotId, selection: ['x'], closureKeys: ['x'], targetTenantId: 't',
    collectorConfigPath: 'c', targetConfigPath: 'r', waves: [], patches: [], results: {},
    currentStateFingerprint: 'f', digest: 'd', status: 'completed', requestedBy, contentEffects: effects,
  });
}

const shortened = (days) => classifyContentEffects([
  update('retentionLabel', { retentionDuration: { days: 2555 } }, { retentionDuration: { days } }, 'retentionLabel:Finance'),
]).effects;

test('shortened retention requires a separate approval by a current approver who is not the requester', async (t) => {
  const client = await schemaClient(t);
  const requester = await principal(client, 'req@contoso.example', 'approver');
  const approver = await principal(client, 'appr@contoso.example', 'approver');
  const viewer = await principal(client, 'view@contoso.example', 'viewer');
  const effects = shortened(30);
  const artifact = await artifactWithEffects(client, { requestedBy: requester.id, effects });
  const digest = contentEffectsDigest(effects);

  await assert.rejects(assertContentEffectApproval(client, { artifact, effects }), /blocked-content-effect/);
  await assert.rejects(approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: requester.id, effectsDigest: digest, justification: 'mine' }), /someone other than the requester/);
  await assert.rejects(approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: viewer.id, effectsDigest: digest, justification: 'x' }), /currently holding approve/);
  await assert.rejects(approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: approver.id, effectsDigest: digest, justification: '' }), /justification/);

  await approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: approver.id, effectsDigest: digest, justification: 'Legal confirmed 30 days' });
  const used = await assertContentEffectApproval(client, { artifact, effects });
  assert.equal(used.approved_by, approver.id);

  // A grant revoked before execution makes the approval no longer current.
  await revokeRole(client, { principalId: approver.id, grantId: approver.grantId, revokedBy: requester.id });
  await assert.rejects(assertContentEffectApproval(client, { artifact, effects }), ContentEffectApprovalError);
});

test('mutation check: an approval never carries over to changed effects', async (t) => {
  const client = await schemaClient(t);
  const requester = await principal(client, 'req2@contoso.example', 'restorer');
  const approver = await principal(client, 'appr2@contoso.example', 'approver');
  const approvedEffects = shortened(30);
  const artifact = await artifactWithEffects(client, { requestedBy: requester.id, effects: approvedEffects });
  await approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: approver.id, effectsDigest: contentEffectsDigest(approvedEffects), justification: 'ok at 30 days' });
  assert.ok(await assertContentEffectApproval(client, { artifact, effects: approvedEffects }));

  const changed = shortened(7);
  assert.notEqual(contentEffectsDigest(changed), contentEffectsDigest(approvedEffects));
  await assert.rejects(assertContentEffectApproval(client, { artifact, effects: changed }), /blocked-content-effect/);
  // Approving a stale digest is refused too: the approver must see the current effects.
  await assert.rejects(
    approveContentEffects(client, { tenantRef: TENANT, artifactId: artifact.id, approverId: approver.id, effectsDigest: 'stale', justification: 'x' }),
    /no longer match/,
  );
});

// ------------------------------------------------------- full CLI: dry run -> promote

const configs = new Map([
  ['/fixtures/collector.json', JSON.stringify({ tenantId: 'tenant-66', clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
  ['/fixtures/restorer.json', JSON.stringify({ tenantId: 'tenant-66', clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
]);
const readFile = (path) => configs.get(path) ?? (() => { throw new Error(`unexpected config read: ${path}`); })();

function cliDependencies(graph) {
  class Reader {
    async collect(version, path) {
      if (path.startsWith('/groups')) return { items: [...graph.objects].filter(([key]) => key.startsWith('/groups/')).map(([, body]) => body), capped: false, error: null };
      return { items: [], capped: false, error: null };
    }

    async get(version, path) {
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'authenticationMethodsPolicy' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'identitySecurityDefaultsEnforcementPolicy', isEnabled: true } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected read: ${path}`);
    }
  }
  return {
    getToken: async () => ({ accessToken: 'fake-token' }),
    GraphReader: Reader,
    GraphWriter: class { constructor() { return graph; } },
    collectM1: async () => [],
    canonicalizeAll: () => [
      { naturalKey: 'roleAssignment:GlobalAdministrator:break-glass', resourceType: 'roleAssignment', sourceId: 'ra-1', payload: { principalId: 'break-glass-id' } },
    ],
  };
}

async function seedGroup(client, payload) {
  const snapshotId = await createSnapshot(client, { tenantRef: TENANT });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: 'group:board', resourceType: 'group', payload, payloadHash: canonicalHash(payload, 'group'),
      criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'full', provenance: { adapter: 'test' },
    },
  });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  return snapshotId;
}

const dryRun = (snapshotId, graph, artifactId, requestedBy) => runRestore({
  snapshotId, selection: ['group:board'], mode: 'dry-run', persistArtifactId: artifactId, requestedBy,
  collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')), targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
  collectorConfigPath: '/fixtures/collector.json', targetConfigPath: '/fixtures/restorer.json',
  readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger: quiet,
});
const promote = (artifactId, graph) => runRestore({ artifactId, mode: 'enforce', readFile, dbUrl: database.url, dependencies: cliDependencies(graph), logger: quiet });
const board = { displayName: 'Board', mailNickname: 'board', mailEnabled: false, securityEnabled: true, groupTypes: [] };

test('a sharing-widening restore is refused at promotion until separately approved; then it runs', async (t) => {
  const client = await schemaClient(t);
  const requester = await principal(client, 'req3@contoso.example', 'restorer');
  const approver = await principal(client, 'appr3@contoso.example', 'approver');
  const snapshotId = await seedGroup(client, { ...board, visibility: 'Public' });
  const graph = fakeGraph();
  graph.objects.set('/groups/board-id', { ...board, id: 'board-id', visibility: 'Private' });

  const artifactId = crypto.randomUUID();
  const dry = await dryRun(snapshotId, graph, artifactId, requester.id);
  assert.deepEqual(dry.contentEffects.map((e) => [e.naturalKey, e.field, e.effect]), [['group:board', 'visibility', 'externally-sharing']]);
  const artifact = await getDryRunArtifactById(client, { id: artifactId });
  assert.equal(artifact.status, 'completed');
  assert.deepEqual(artifact.contentEffects, dry.contentEffects);

  await assert.rejects(promote(artifactId, graph), /blocked-content-effect/);
  assert.equal(graph.writes.length, 0, 'nothing is written without the separate approval');

  await approveContentEffects(client, { tenantRef: TENANT, artifactId, approverId: approver.id, effectsDigest: contentEffectsDigest(artifact.contentEffects), justification: 'Board site was public before the incident' });
  const result = await promote(artifactId, graph);
  assert.deepEqual(result.results.failed, []);
  assert.equal(graph.objects.get('/groups/board-id').visibility, 'Public');
});

test('a benign restore with no content effect promotes without any extra approval', async (t) => {
  const client = await schemaClient(t);
  const requester = await principal(client, 'req4@contoso.example', 'restorer');
  const snapshotId = await seedGroup(client, { ...board, displayName: 'Board members', visibility: 'Private' });
  const graph = fakeGraph();
  graph.objects.set('/groups/board-id', { ...board, id: 'board-id', visibility: 'Private' });
  const artifactId = crypto.randomUUID();
  const dry = await dryRun(snapshotId, graph, artifactId, requester.id);
  assert.deepEqual(dry.contentEffects, []);
  const result = await promote(artifactId, graph);
  assert.deepEqual(result.results.failed, []);
  assert.equal(graph.objects.get('/groups/board-id').displayName, 'Board members');
});
