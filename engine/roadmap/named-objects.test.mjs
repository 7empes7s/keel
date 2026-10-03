// Roadmap task-130: named objects (portal experience contract, identification rules).
//
// Every cross-object identifier a page shows is resolved to a name by the engine
// reader, server-side, in one query per kind: a policy's run-as principal, the
// requester and decider of an approval, the dry run a restore promotes, the baseline
// an activation sets, the changes a roll-back reverts, and the requester of a job.
// A reference that cannot be read comes back readable: false — never a bare id.
// Mutation check: returning run_as_principal_id without the resolved reference fails.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { createPolicy, getPolicy, listPolicies } from '../policy/evaluate.mjs';
import { requestApproval, summarizeApprovalRequests, listApprovalRequests } from '../govern/approvals.mjs';
import { enqueue, listJobs, summarizeJobs } from '../jobs/queue.mjs';
import { createDryRunArtifact } from '../restore/dryRunArtifact.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

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

let seq = 0;
const tenant = () => { seq += 1; return `sha256:task-130-${seq}`; };
async function person(client, email, displayName = null) {
  const { rows } = await client.query('INSERT INTO principal (email, display_name) VALUES ($1, $2) RETURNING id::text AS id', [email, displayName]);
  return rows[0].id;
}
async function snapshot(client, tenantRef, completedAt = '2026-10-02T09:12:00Z') {
  const { rows } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', $2, $2) RETURNING id::text AS id`,
    [tenantRef, completedAt],
  );
  return rows[0].id;
}
async function baseline(client, tenantRef, label) {
  const { rows } = await client.query(
    `INSERT INTO baseline (tenant_ref, set_by, active, label) VALUES ($1, 'fixture', false, $2) RETURNING id::text AS id`,
    [tenantRef, label],
  );
  return rows[0].id;
}
async function drift(client, tenantRef, baselineId, snapshotId, naturalKey, blastRadius = 'tenant-lockout') {
  const { rows } = await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, blast_radius)
     VALUES ($1, $2, $3, $4, $5, 'modified', $6) RETURNING id::text AS id`,
    [tenantRef, baselineId, snapshotId, naturalKey, naturalKey.split(':')[0], blastRadius],
  );
  return rows[0].id;
}
async function dryRun(client, tenantRef, snapshotId, requestedBy, closureKeys) {
  const id = crypto.randomUUID();
  await createDryRunArtifact(client, {
    id, tenantRef, snapshotId, selection: closureKeys, closureKeys, targetTenantId: 't', collectorConfigPath: 'c', targetConfigPath: 'r',
    reconciliationResources: null, waves: [closureKeys], patches: [], guardRefusals: [], results: { applied: [], skipped: [], failed: [] },
    currentStateFingerprint: 'f', digest: 'd', status: 'completed', requestedBy,
  });
  return id;
}

test('mutation check: a policy row carries its run-as principal as a name, and its last automatic action', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const runAs = await person(client, 'svc-policy@contoso.com', 'Policy service');
  await grantRole(client, { principalId: runAs, role: 'restorer', grantedBy: runAs });
  const policy = await createPolicy(client, {
    tenantRef, name: 'Auto-remediate cosmetic drift', action: 'auto_remediate', maxBlastRadius: 'cosmetic',
    createdBy: 'admin', runAsPrincipalId: runAs, blastRadius: 'cosmetic', changeType: 'modified',
  });
  const withoutRunAs = await createPolicy(client, { tenantRef, name: 'Alert on lockout', action: 'alert', maxBlastRadius: 'tenant-lockout', createdBy: 'admin' });

  // The most recent automatic action, by the resource it acted on.
  const base = await baseline(client, tenantRef, 'Golden');
  const snap = await snapshot(client, tenantRef);
  const changed = await drift(client, tenantRef, base, snap, 'namedLocation:Branch offices', 'cosmetic');
  const job = await enqueue(client, { kind: 'remediate', params: { driftIds: [changed] }, requestedBy: 'policy-automation' });
  await client.query(
    `INSERT INTO auto_remediation_execution (job_id, tenant_ref, policy_id, drift_id, status, queued_at) VALUES ($1, $2, $3, $4, 'executed', now() - interval '2 hours')`,
    [job.id, tenantRef, policy.id, changed],
  );

  const listed = await listPolicies(client, { tenantRef });
  const row = listed.find((entry) => entry.id === policy.id);
  assert.deepEqual(row.run_as_principal, { id: runAs, email: 'svc-policy@contoso.com', name: 'Policy service', readable: true });
  assert.equal(Object.hasOwn(row, 'run_as_principal_email'), false, 'the join columns are folded into the reference');
  assert.equal(row.last_action_natural_key, 'namedLocation:Branch offices');
  assert.equal(row.last_action_status, 'executed');
  assert.equal(row.actions_last_7_days, 1);
  assert.equal(listed.find((entry) => entry.id === withoutRunAs.id).run_as_principal, null);

  assert.deepEqual((await getPolicy(client, { tenantRef, id: policy.id })).run_as_principal.name, 'Policy service');
  assert.equal(await getPolicy(client, { tenantRef: tenant(), id: policy.id }), null, 'another tenant cannot read the policy');
});

test('approval requests resolve requester, decider, dry run, baseline and changes to names; missing ones are unreadable', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const requester = await person(client, 'requester@contoso.com', 'Rita Requester');
  const approver = await person(client, 'approver@contoso.com');
  const snap = await snapshot(client, tenantRef, '2026-10-02T09:12:00Z');
  const plan = await dryRun(client, tenantRef, snap, requester, ['group:Admins', 'conditionalAccessPolicy:Block legacy auth']);
  const dryRunJob = await enqueue(client, { kind: 'restore', params: { snapshotId: snap, selection: ['group:Admins'], artifactId: plan }, requestedBy: requester });
  const base = await baseline(client, tenantRef, 'Post-migration golden state');
  const foreignBase = await baseline(client, tenant(), 'Another tenant');
  const change = await drift(client, tenantRef, base, snap, 'conditionalAccessPolicy:Block legacy auth');
  const missingPlan = crypto.randomUUID();

  await requestApproval(client, { tenantRef, action: 'restore', params: { artifactId: plan }, requestedBy: requester, justification: 'ransomware clean-up' });
  await requestApproval(client, { tenantRef, action: 'restore', params: { artifactId: missingPlan }, requestedBy: requester });
  await requestApproval(client, { tenantRef, action: 'baseline-activate', params: { baselineId: base }, requestedBy: 'scheduler' });
  await requestApproval(client, { tenantRef, action: 'baseline-activate', params: { baselineId: foreignBase }, requestedBy: requester });
  await requestApproval(client, { tenantRef, action: 'remediate', params: { driftIds: [change] }, requestedBy: requester });
  await client.query(`UPDATE approval_request SET decided_by = $1 WHERE action = 'remediate'`, [approver]);

  const summaries = await summarizeApprovalRequests(client, { tenantRef, requests: await listApprovalRequests(client) });
  const by = (action, predicate) => summaries.find((entry) => entry.action === action && predicate(entry));

  const restore = by('restore', (entry) => entry.params.artifactId === plan);
  assert.equal(restore.references.people.requested_by.name, 'Rita Requester');
  assert.equal(restore.references.plan.readable, true);
  assert.equal(restore.references.plan.resources, 2);
  assert.equal(restore.references.plan.undo, false);
  assert.equal(new Date(restore.references.plan.snapshotAt).toISOString(), '2026-10-02T09:12:00.000Z');
  assert.equal(restore.references.plan.dryRunJobId, dryRunJob.id, 'the reviewer is linked to the dry run that computed the plan');

  const missing = by('restore', (entry) => entry.params.artifactId === missingPlan);
  assert.deepEqual(missing.references.plan, { kind: 'dry-run', id: missingPlan, name: null, readable: false });

  const activation = by('baseline-activate', (entry) => entry.params.baselineId === base);
  assert.equal(activation.references.baseline.name, 'Post-migration golden state');
  assert.equal(activation.references.people.requested_by.name, 'scheduler', 'a system actor is named by itself');
  assert.equal(by('baseline-activate', (entry) => entry.params.baselineId === foreignBase).references.baseline.readable, false,
    "another tenant's baseline never resolves");

  const rollback = by('remediate', () => true);
  assert.equal(rollback.references.changes[0].naturalKey, 'conditionalAccessPolicy:Block legacy auth');
  assert.equal(rollback.references.changes[0].blastRadius, 'tenant-lockout');
  assert.equal(rollback.references.people.decided_by.name, 'approver@contoso.com', 'an account without a display name is named by its email');
});

test('jobs resolve their requester and the plan they promote; an unknown principal id is unreadable, not shown', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const requester = await person(client, 'restorer@contoso.com', 'Rob Restorer');
  const snap = await snapshot(client, tenantRef);
  const plan = await dryRun(client, tenantRef, snap, requester, ['group:Admins']);
  await enqueue(client, { kind: 'restore', params: { artifactId: plan, mode: 'enforce' }, requestedBy: requester });
  const ghost = crypto.randomUUID();
  await enqueue(client, { kind: 'backup', params: { tier: 'tier1' }, requestedBy: ghost });

  // One query per kind for the whole list, whatever its length.
  let queries = 0;
  const counting = { query: (...args) => { queries += 1; return client.query(...args); } };
  const jobs = await summarizeJobs(counting, { tenantRef, jobs: await listJobs(client, { limit: 10 }) });
  assert.ok(queries <= 5, `${queries} queries for ${jobs.length} jobs`);

  const restore = jobs.find((job) => job.kind === 'restore' && job.params.mode === 'enforce');
  assert.equal(restore.references.people.requested_by.name, 'Rob Restorer');
  assert.equal(restore.references.plan.resources, 1);
  const backup = jobs.find((job) => job.kind === 'backup');
  assert.deepEqual(backup.references.people.requested_by, { kind: 'person', id: ghost, name: null, readable: false, email: null, system: false });
});
