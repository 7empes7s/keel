import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { APPROVAL_DECISION_EVIDENCE_KIND, ApprovalClosedError, approveRequest, requestApproval } from './approvals.mjs';
import { setApprovalPolicy } from './approvalPolicy.mjs';
import {
  RESTORE_APPROVALS_OFF_BASIS,
  RESTORE_APPROVALS_OFF_DECIDER,
  WORKLOAD_RESTORE_SERVICES,
  restoreArtifactServices,
  setRestoreApprovalSetting,
} from './restoreApprovalSettings.mjs';
import { grantRole } from '../authz/administration.mjs';
import { createDryRunArtifact } from '../restore/dryRunArtifact.mjs';
import { WORKLOAD_RESTORES } from '../restore/workloads/dispatch.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';
import { createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

// "Approvals off" also skips the restore's own approval: when every service a restore
// writes to has restore approvals off, the request is approved as it is made, by Keel's
// setting (never a person), and the audit record says so. Anything else still waits.
const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

// Each test's tenant: a tenant id and its ref, so a dry run writes back to its own tenant.
const TENANT_IDS = new Map();
const tenant = () => {
  const tenantId = randomUUID();
  const tenantRef = tenantRefFor(tenantId);
  TENANT_IDS.set(tenantRef, tenantId);
  return tenantRef;
};

async function principal(client, role = 'admin') {
  const { rows } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id', [`${randomUUID()}@contoso.example`]);
  await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id });
  return rows[0].id;
}

const RESOURCE_DEFAULTS = { criticality: 'normal', blastRadius: 'contained', fidelity: 'full', provenance: {} };

// A completed dry run of these backed-up objects ([naturalKey, resourceType]).
async function snapshotRestore(client, { tenantRef, requestedBy, objects, status = 'completed', extra = {} }) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  for (const [naturalKey, resourceType] of objects) {
    await insertResourceVersion(client, { snapshotId, resource: { naturalKey, resourceType, payload: { displayName: naturalKey }, payloadHash: `h:${naturalKey}`, ...RESOURCE_DEFAULTS } });
  }
  const keys = objects.map(([key]) => key);
  return createDryRunArtifact(client, {
    id: randomUUID(), tenantRef, snapshotId, selection: keys, closureKeys: keys, targetTenantId: TENANT_IDS.get(tenantRef),
    collectorConfigPath: '/etc/keel/tenant.json', targetConfigPath: '/etc/keel/restorer.json',
    waves: [keys], patches: [], guardRefusals: [], results: { applied: [] },
    currentStateFingerprint: 'f', digest: 'd', status, requestedBy, ...extra,
  });
}

async function workloadRestore(client, { tenantRef, requestedBy, workload, allowTenantWide = false }) {
  return createDryRunArtifact(client, {
    id: randomUUID(), tenantRef, snapshotId: null, selection: [`${workload}:x`], closureKeys: [`${workload}:x`], targetTenantId: TENANT_IDS.get(tenantRef),
    collectorConfigPath: `workload:${workload}`, targetConfigPath: `workload:${workload}`,
    waves: [], patches: [], guardRefusals: [], results: {}, currentStateFingerprint: 'f', digest: 'd', status: 'completed', requestedBy,
    workloadRestore: { workload, operations: [], ...(allowTenantWide ? { allowTenantWide: true } : {}) },
  });
}

async function turnOff(client, tenantRef, services, actor) {
  for (const service of services) await setRestoreApprovalSetting(client, { tenantRef, service, approvalRequired: false, actor });
}

const ask = (client, { tenantRef, artifact, requestedBy, executor = 'worker' }) => requestApproval(client, {
  tenantRef, action: 'restore', params: { artifactId: artifact.id }, requestedBy, executor,
});

async function decisions(client, tenantRef, requestId) {
  const { rows } = await client.query(
    'SELECT subject, actor FROM evidence WHERE tenant_ref = $1 AND kind = $2 ORDER BY seq',
    [tenantRef, APPROVAL_DECISION_EVIDENCE_KIND],
  );
  return rows.filter((row) => row.subject.requestId === requestId);
}

test('every workload Keel can restore is placed in a service', () => {
  assert.deepEqual(Object.keys(WORKLOAD_RESTORE_SERVICES).sort(), Object.keys(WORKLOAD_RESTORES).sort());
});

test('with approvals on (the default) a restore waits for a person, as before', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const requester = await principal(client);
  const artifact = await snapshotRestore(client, { tenantRef, requestedBy: requester, objects: [['group:KEEL-RT-a', 'group']] });
  const request = await ask(client, { tenantRef, artifact, requestedBy: requester });
  assert.equal(request.status, 'pending');
  assert.equal(request.approvalSkippedFor, undefined);
  const { rows } = await client.query("SELECT count(*)::int AS n FROM job WHERE idempotency_key = $1", [`approval:${request.id}`]);
  assert.equal(rows[0].n, 0);
});

test('with approvals off for its service a restore is approved as it is made, by the setting, with an audit record', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  const requester = await principal(client);
  await turnOff(client, tenantRef, ['Entra'], admin);
  const artifact = await snapshotRestore(client, { tenantRef, requestedBy: requester, objects: [['group:KEEL-RT-a', 'group'], ['user:KEEL-RT-b', 'user']] });
  const request = await ask(client, { tenantRef, artifact, requestedBy: requester });

  assert.equal(request.status, 'approved');
  assert.equal(request.decided_by, RESTORE_APPROVALS_OFF_DECIDER);
  assert.notEqual(request.decided_by, requester);
  assert.equal(request.standing_policy, RESTORE_APPROVALS_OFF_BASIS);
  assert.match(request.reason, /Restore approvals are off for Entra/);
  assert.deepEqual(request.approvalSkippedFor, ['Entra']);

  // The same job a person's approval would mint: run as the requester, scope from the artifact.
  const { rows: jobs } = await client.query('SELECT id, kind, requested_by, params FROM job WHERE idempotency_key = $1', [`approval:${request.id}`]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'restore');
  assert.equal(jobs[0].requested_by, requester);
  assert.equal(jobs[0].params.artifactId, artifact.id);
  assert.equal(jobs[0].params.mode, 'enforce');

  const [decision] = await decisions(client, tenantRef, request.id);
  assert.equal(decision.actor, RESTORE_APPROVALS_OFF_DECIDER);
  assert.equal(decision.subject.decision, 'approved');
  assert.equal(decision.subject.basis, RESTORE_APPROVALS_OFF_BASIS);
  assert.deepEqual(decision.subject.services, ['Entra']);
  assert.ok(decision.subject.jobId);

  // Already decided: nobody (the requester least of all) approves it again.
  await assert.rejects(approveRequest(client, { tenantRef, id: request.id, decidedBy: requester }), ApprovalClosedError);
});

test('a restore that also writes to a service with approvals on still waits', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  const requester = await principal(client);
  await turnOff(client, tenantRef, ['Entra'], admin);
  const artifact = await snapshotRestore(client, {
    tenantRef, requestedBy: requester, objects: [['group:KEEL-RT-a', 'group'], ['deviceConfiguration:KEEL-RT-c', 'deviceConfiguration']],
  });
  assert.deepEqual(await restoreArtifactServices(client, artifact), ['Entra', 'Intune']);
  assert.equal((await ask(client, { tenantRef, artifact, requestedBy: requester })).status, 'pending');
  await turnOff(client, tenantRef, ['Intune'], admin);
  assert.equal((await ask(client, { tenantRef, artifact, requestedBy: requester })).status, 'approved');
});

test('an object Keel cannot place, a CA policy turned on, or a two-person rule keeps the restore waiting', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  const requester = await principal(client);
  await turnOff(client, tenantRef, ['Entra', 'Intune', 'Exchange', 'Teams', 'SharePoint', 'Purview', 'Power Platform', 'Defender'], admin);

  // A closure key the backup does not hold: no type, no service, so a person approves it.
  const unplaced = await snapshotRestore(client, { tenantRef, requestedBy: requester, objects: [['group:KEEL-RT-a', 'group']] });
  await client.query("UPDATE restore_dry_run SET closure_keys = closure_keys || '[\"ghost\"]'::jsonb WHERE id = $1", [unplaced.id]);
  unplaced.closureKeys = [...unplaced.closureKeys, 'ghost'];
  assert.equal(await restoreArtifactServices(client, unplaced), null);
  assert.equal((await ask(client, { tenantRef, artifact: unplaced, requestedBy: requester })).status, 'pending');

  // Turning a Conditional Access policy on can lock people out: always a person.
  const enforcement = await snapshotRestore(client, {
    tenantRef, requestedBy: requester, objects: [['conditionalAccessPolicy:KEEL-RT-ca', 'conditionalAccessPolicy']],
    extra: { conditionalAccessEnforcement: { promotes: randomUUID(), naturalKey: 'conditionalAccessPolicy:KEEL-RT-ca' } },
  });
  assert.equal((await ask(client, { tenantRef, artifact: enforcement, requestedBy: requester })).status, 'pending');

  // The customer's two-person rule still holds: a bulk restore needs two people.
  await setApprovalPolicy(client, { tenantRef, actionClass: 'bulk-restore', twoPerson: true, actor: admin });
  const objects = Array.from({ length: 25 }, (_, index) => [`group:KEEL-RT-bulk-${index}`, 'group']);
  const bulk = await snapshotRestore(client, { tenantRef, requestedBy: requester, objects });
  const waiting = await ask(client, { tenantRef, artifact: bulk, requestedBy: requester });
  assert.equal(waiting.status, 'pending');
  assert.equal(waiting.required_approvals, 2);
});

test('a dry run that cannot be promoted is never approved by the setting', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  const requester = await principal(client);
  await turnOff(client, tenantRef, ['Entra'], admin);
  const refused = await snapshotRestore(client, { tenantRef, requestedBy: requester, objects: [['group:KEEL-RT-a', 'group']], status: 'refused' });
  assert.equal((await ask(client, { tenantRef, artifact: refused, requestedBy: requester })).status, 'pending');
});

test('content effects in a service with approvals on keep the restore waiting', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  const requester = await principal(client);
  await turnOff(client, tenantRef, ['Entra'], admin);
  const effects = classifyContentEffects([{
    naturalKey: 'retentionLabel:KEEL-RT-Finance', resourceType: 'retentionLabel', verb: 'update',
    payload: { retentionDuration: { days: 30 } }, live: { state: 'present', payload: { retentionDuration: { days: 2555 } }, targetId: 'id-1' },
  }]).effects;
  assert.ok(effects.length > 0);
  const artifact = await snapshotRestore(client, {
    tenantRef, requestedBy: requester, objects: [['group:KEEL-RT-a', 'group']], extra: { contentEffects: effects },
  });
  assert.equal((await ask(client, { tenantRef, artifact, requestedBy: requester })).status, 'pending');
});

test('workload restores follow their service; a CLI-run restore is approved without a worker job', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  const requester = await principal(client);
  const exchange = await workloadRestore(client, { tenantRef, requestedBy: requester, workload: 'exchange-mail-flow' });
  assert.deepEqual(await restoreArtifactServices(client, exchange), ['Exchange']);
  assert.equal((await ask(client, { tenantRef, artifact: exchange, requestedBy: requester })).status, 'pending');

  await turnOff(client, tenantRef, ['Exchange'], admin);
  const approved = await ask(client, { tenantRef, artifact: exchange, requestedBy: requester, executor: 'cli' });
  assert.equal(approved.status, 'approved');
  assert.deepEqual(approved.approvalSkippedFor, ['Exchange']);
  const { rows } = await client.query('SELECT count(*)::int AS n FROM job WHERE idempotency_key = $1', [`approval:${approved.id}`]);
  assert.equal(rows[0].n, 0);

  const unknown = await workloadRestore(client, { tenantRef, requestedBy: requester, workload: 'not-a-workload' });
  assert.equal(await restoreArtifactServices(client, unknown), null);
});

test('the setting follows the dry run tenant, not another tenant', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const other = tenant();
  const admin = await principal(client);
  const requester = await principal(client);
  await turnOff(client, other, ['Entra'], admin);
  const artifact = await snapshotRestore(client, { tenantRef, requestedBy: requester, objects: [['group:KEEL-RT-a', 'group']] });
  assert.equal((await ask(client, { tenantRef, artifact, requestedBy: requester })).status, 'pending');
});

test('a tenant-wide workload write, a compliance fix, or a restore into another tenant waits for a person', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  const requester = await principal(client);
  await turnOff(client, tenantRef, ['Entra', 'SharePoint'], admin);

  const tenantWide = await workloadRestore(client, { tenantRef, requestedBy: requester, workload: 'sharepoint-site-settings', allowTenantWide: true });
  assert.equal(await restoreArtifactServices(client, tenantWide), null);
  assert.equal((await ask(client, { tenantRef, artifact: tenantWide, requestedBy: requester })).status, 'pending');

  const fix = await snapshotRestore(client, {
    tenantRef, requestedBy: requester, objects: [['group:KEEL-RT-fix', 'group']],
    extra: { complianceFix: { naturalKey: 'group:KEEL-RT-fix', field: 'visibility' } },
  });
  assert.equal((await ask(client, { tenantRef, artifact: fix, requestedBy: requester })).status, 'pending');

  const elsewhere = await snapshotRestore(client, { tenantRef, requestedBy: requester, objects: [['group:KEEL-RT-x', 'group']] });
  await client.query('UPDATE restore_dry_run SET target_tenant_id = $2 WHERE id = $1', [elsewhere.id, randomUUID()]);
  elsewhere.targetTenantId = 'another-tenant';
  assert.equal(await restoreArtifactServices(client, elsewhere), null);
  assert.equal((await ask(client, { tenantRef, artifact: elsewhere, requestedBy: requester })).status, 'pending');
});

test('a kind Keel has not mapped is never placed by its name alone', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const admin = await principal(client);
  const requester = await principal(client);
  await turnOff(client, tenantRef, ['Exchange'], admin);
  const artifact = await snapshotRestore(client, { tenantRef, requestedBy: requester, objects: [['exchangeNotAKindYet:KEEL-RT-a', 'exchangeNotAKindYet']] });
  assert.equal(await restoreArtifactServices(client, artifact), null);
  assert.equal((await ask(client, { tenantRef, artifact, requestedBy: requester })).status, 'pending');
});
