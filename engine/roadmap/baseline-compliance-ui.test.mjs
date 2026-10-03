/** Roadmap task-87 boundary coverage: baseline age, versioned re-snapshot, linked
 * findings, exceptions and storage residency. Real engine readers and writers against
 * an isolated database, then the real portal loaders, authorization, action route and
 * page render in a separate portal runtime. Only the database URL, tenant config and
 * recovery manifest path are replaced. No live Microsoft calls or writers.
 *
 * Required mutation checks:
 * - overwrite previous baseline on recapture → "re-snapshot preserves the old version";
 * - hide expired exception → "an expired exception exposes the finding";
 * - manufacture a cross-link across mismatched observations → "findings link only
 *   to records resting on the same collection".
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { capabilityForJobKind } from '../authz/jobCapabilities.mjs';
import { capabilitiesForRole } from '../authz/permissions.mjs';
import { evaluateControl, recordEvaluation, recordException } from '../benchmarks/evaluate.mjs';
import { canonicalHash, HASH_VERSION } from '../cir/canonicalHash.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { readObservation } from '../contracts/observation.mjs';
import {
  acceptDrift, activateBaseline, replaceBaseline, resnapshotBaseline, seedFromSnapshot,
} from '../govern/baseline.mjs';
import {
  baselineCompliance, complianceFindings, grantComplianceException, storageResidency,
} from '../govern/baselineCompliance.mjs';
import { createDryRunArtifact } from '../restore/dryRunArtifact.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const DAY = 86_400_000;
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
const ROLE_CONTROL = 'keel-custom.role-assignment.admin-count-at-most';
const tenantRefFor = (tenantId) => `sha256:${createHash('sha256').update(tenantId).digest('hex').slice(0, 16)}`;

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

let sequence = 0;
const tenant = () => { sequence += 1; return tenantRefFor(`task-87-${sequence}`); };

async function person(client, email, role) {
  const { rows } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id::text AS id', [email]);
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id });
  return rows[0].id;
}

/** A whole-estate snapshot (every collector complete) holding the given resources. */
async function snapshot(client, tenantRef, completedAt, resources = []) {
  const startedAt = new Date(new Date(completedAt).getTime() - 10 * 60_000);
  const digest = Object.fromEntries(DESCRIPTORS.map(({ type }) => [type, { outcome: 'complete', itemCount: 0 }]));
  const { rows } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
     VALUES ($1, 'complete', $2, $3, $4) RETURNING id::text AS id`,
    [tenantRef, startedAt, completedAt, digest],
  );
  for (const [naturalKey, payload] of resources) await version(client, rows[0].id, naturalKey, payload);
  return rows[0].id;
}

async function version(client, snapshotId, naturalKey, payload) {
  const type = naturalKey.slice(0, naturalKey.indexOf(':'));
  const { rows } = await client.query(
    `INSERT INTO resource_version
       (snapshot_id, natural_key, resource_type, payload, payload_hash, hash_version, criticality, blast_radius, fidelity, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, 'high', 'access-affecting', 'full', '{}') RETURNING id::text AS id`,
    [snapshotId, naturalKey, type, payload, canonicalHash(payload, type), HASH_VERSION],
  );
  return rows[0].id;
}

async function baselineRows(client, baselineId) {
  const { rows } = await client.query(
    'SELECT natural_key, resource_version_id::text AS version FROM baseline_resource WHERE baseline_id = $1 ORDER BY natural_key',
    [baselineId],
  );
  return rows;
}

async function drift(client, tenantRef, baselineId, snapshotId, naturalKey) {
  const { rows } = await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, blast_radius)
     VALUES ($1, $2, $3, $4, $5, 'modified', 'access-affecting') RETURNING id::text AS id`,
    [tenantRef, baselineId, snapshotId, naturalKey, naturalKey.slice(0, naturalKey.indexOf(':'))],
  );
  return rows[0].id;
}

async function pendingRestore(client, tenantRef, snapshotId, closureKeys, requestedBy, { expired = false } = {}) {
  const id = crypto.randomUUID();
  await createDryRunArtifact(client, {
    id, tenantRef, snapshotId, selection: closureKeys, closureKeys, targetTenantId: 't', collectorConfigPath: 'c', targetConfigPath: 'r',
    reconciliationResources: null, waves: [closureKeys], patches: [], guardRefusals: [], results: { applied: [], skipped: [], failed: [] },
    currentStateFingerprint: 'f', digest: 'd', status: 'completed', requestedBy,
  });
  const { rows } = await client.query(
    `INSERT INTO approval_request (action, params, requested_by, status, expires_at)
     VALUES ('restore', $1, $2, 'pending', $3) RETURNING id::text AS id`,
    [{ artifactId: id }, requestedBy, new Date(Date.now() + (expired ? -1 : 1) * DAY)],
  );
  return { dryRunId: id, requestId: rows[0].id };
}

const admins = (count) => Array.from({ length: count }, (_, index) => [
  `roleAssignment:ga-${index}`, { id: `ra-${index}`, roleDefinitionId: GLOBAL_ADMIN, principalId: `user-${index}`, directoryScopeId: '/' },
]);

/** The real evaluation path: the snapshot's own observation of roleAssignment → evaluateControl → recordEvaluation. */
async function evaluateRoleControl(client, tenantRef, snapshotId, now) {
  const { rows: [row] } = await client.query('SELECT * FROM snapshot WHERE id = $1', [snapshotId]);
  const { rows: resources } = await client.query(
    "SELECT payload FROM resource_version WHERE snapshot_id = $1 AND resource_type = 'roleAssignment'", [snapshotId],
  );
  const observation = readObservation(row.coverage_digest.roleAssignment, {
    tenantRef, observationId: `${snapshotId}:roleAssignment`, resourceType: 'roleAssignment',
    snapshotWindow: { startedAt: row.started_at, endedAt: row.completed_at },
  });
  const result = evaluateControl({
    controlId: ROLE_CONTROL, tenantRef, now,
    observations: { roleAssignment: { observation, resources: resources.map((resource) => resource.payload) } },
  });
  return recordEvaluation(client, { tenantRef, result, actor: 'fixture' });
}

test('mutation check: re-snapshot preserves the old version and its evidence', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const operator = await person(client, `operator-${sequence}@contoso.com`, 'operator');
  const now = Date.now();
  const first = await snapshot(client, tenantRef, new Date(now - 10 * DAY), [
    ['conditionalAccessPolicy:Block legacy auth', { id: 'cap1', displayName: 'Block legacy auth', state: 'enabled' }],
    ['group:Finance', { id: 'g1', displayName: 'Finance', mailNickname: 'finance' }],
  ]);
  const second = await snapshot(client, tenantRef, new Date(now - DAY), [
    ['conditionalAccessPolicy:Block legacy auth', { id: 'cap1', displayName: 'Block legacy auth', state: 'disabled' }],
    ['group:Finance', { id: 'g1', displayName: 'Finance', mailNickname: 'finance' }],
    ['group:Payroll', { id: 'g2', displayName: 'Payroll', mailNickname: 'payroll' }],
  ]);
  const original = await seedFromSnapshot(client, { tenantRef, snapshotId: first, setBy: operator, label: 'Golden state' });
  const before = await baselineRows(client, original);
  const openChange = await drift(client, tenantRef, original, second, 'conditionalAccessPolicy:Block legacy auth');

  const created = await replaceBaseline(client, { principalId: operator, tenantRef, baselineId: original, snapshotId: second });
  assert.equal(created.version, 2);
  assert.equal(created.active, true);

  // The old version is still there, row for row, and is now read-only history.
  assert.deepEqual(await baselineRows(client, original), before);
  const { rows: [old] } = await client.query('SELECT * FROM baseline WHERE id = $1', [original]);
  assert.equal(old.version, 1);
  assert.equal(old.active, false);
  assert.ok(old.superseded_at, 'the old version is marked superseded, not replaced');
  assert.equal(old.label, 'Golden state');
  assert.equal(String(old.source_snapshot_id), first);

  const { rows: [next] } = await client.query('SELECT * FROM baseline WHERE id = $1', [created.id]);
  assert.equal(String(next.supersedes_id), original);
  assert.equal(String(next.source_snapshot_id), second);
  assert.equal(next.label, 'Golden state (v2)');
  assert.equal((await baselineRows(client, created.id)).length, 3);
  assert.notDeepEqual((await baselineRows(client, created.id)).map((row) => row.version), before.map((row) => row.version));

  // The transition is in the audit record.
  const { rows: [evidence] } = await client.query(
    "SELECT subject, actor FROM evidence WHERE tenant_ref = $1 AND kind = 'baseline-resnapshot'", [tenantRef],
  );
  assert.equal(evidence.subject.supersedesBaselineId, original);
  assert.equal(evidence.subject.baselineId, created.id);
  assert.equal(evidence.subject.preservedResourceCount, 2);
  assert.equal(evidence.actor, operator);

  // Nothing can rewrite the preserved version afterwards.
  await assert.rejects(acceptDrift(client, { driftId: openChange, actor: operator, reason: 'later' }), /superseded/);
  await assert.rejects(activateBaseline(client, { tenantRef, baselineId: original }), /superseded/);
  await assert.rejects(resnapshotBaseline(client, { tenantRef, baselineId: original, snapshotId: second, setBy: operator }), /already re-snapshotted/);
  await assert.rejects(resnapshotBaseline(client, { tenantRef, baselineId: created.id, snapshotId: second, setBy: operator }), /already captured/);
  await assert.rejects(resnapshotBaseline(client, { tenantRef, baselineId: created.id, snapshotId: first, setBy: operator }), /not newer/);
  assert.deepEqual(await baselineRows(client, original), before);

  const view = await baselineCompliance(client, { tenantRef, now: new Date(now) });
  const oldView = view.find((entry) => entry.id === original);
  assert.equal(oldView.supersededById, created.id);
  assert.equal(view.find((entry) => entry.id === created.id).supersedesId, original);
});

test('read-only viewer cannot replace a baseline; the requester is authorized at the write', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const viewer = await person(client, `viewer-${sequence}@contoso.com`, 'viewer');
  const now = Date.now();
  const first = await snapshot(client, tenantRef, new Date(now - 3 * DAY), [['group:Finance', { id: 'g1', displayName: 'Finance' }]]);
  const second = await snapshot(client, tenantRef, new Date(now - DAY), [['group:Finance', { id: 'g1', displayName: 'Finance (renamed)' }]]);
  const original = await seedFromSnapshot(client, { tenantRef, snapshotId: first, setBy: 'fixture', label: 'Golden' });

  await assert.rejects(replaceBaseline(client, { principalId: viewer, tenantRef, baselineId: original, snapshotId: second }), /forbidden/);
  await assert.rejects(replaceBaseline(client, { principalId: crypto.randomUUID(), tenantRef, baselineId: original, snapshotId: second }), /forbidden/);
  const { rows } = await client.query('SELECT id, superseded_at FROM baseline WHERE tenant_ref = $1', [tenantRef]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].superseded_at, null);

  // The portal route and the worker check the same capability, which a viewer lacks.
  assert.equal(capabilityForJobKind('baseline-create'), 'baseline-create');
  assert.ok(!capabilitiesForRole('viewer').includes('baseline-create'));
});

test('age is measured from the capture, never from the read or the row write', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const now = new Date();
  const captured = new Date(now.getTime() - 10 * DAY);
  const source = await snapshot(client, tenantRef, captured, [['group:Finance', { id: 'g1', displayName: 'Finance' }]]);
  const seeded = await seedFromSnapshot(client, { tenantRef, snapshotId: source, setBy: 'fixture', label: 'Ten days old' });

  // Legacy baseline (no capture columns): its age comes from its resources' snapshots.
  const legacySource = await snapshot(client, tenantRef, new Date(now.getTime() - 5 * DAY), [['group:Payroll', { id: 'g2', displayName: 'Payroll' }]]);
  const { rows: [legacy] } = await client.query(
    "INSERT INTO baseline (tenant_ref, set_by, active, label) VALUES ($1, 'fixture', false, 'Legacy') RETURNING id::text AS id", [tenantRef],
  );
  await client.query(
    'INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id) SELECT $1, natural_key, id FROM resource_version WHERE snapshot_id = $2',
    [legacy.id, legacySource],
  );
  const { rows: [empty] } = await client.query(
    "INSERT INTO baseline (tenant_ref, set_by, active, label) VALUES ($1, 'fixture', false, 'Empty') RETURNING id::text AS id", [tenantRef],
  );

  const view = await baselineCompliance(client, { tenantRef, now });
  const byId = Object.fromEntries(view.map((entry) => [entry.id, entry]));
  assert.equal(byId[seeded].capture.basis, 'source-snapshot');
  assert.equal(byId[seeded].capture.capturedAt, captured.toISOString());
  assert.equal(byId[seeded].capture.ageMs, 10 * DAY);
  assert.equal(byId[seeded].capture.sourceSnapshotId, source);
  assert.deepEqual(byId[seeded].capture.types, DESCRIPTORS.map(({ type }) => type).sort());
  // The row was written just now; the age is still the capture's.
  assert.ok(Date.now() - new Date(byId[seeded].setAt).getTime() < DAY);
  const later = await baselineCompliance(client, { tenantRef, now: new Date(now.getTime() + 60 * 60_000) });
  assert.equal(later.find((entry) => entry.id === seeded).capture.ageMs, 10 * DAY + 60 * 60_000);

  assert.equal(byId[legacy.id].capture.basis, 'legacy-resource-versions');
  assert.equal(byId[legacy.id].capture.ageMs, 5 * DAY);
  assert.deepEqual(byId[legacy.id].capture.types, ['group']);
  assert.equal(byId[empty.id].capture.basis, 'unknown');
  assert.equal(byId[empty.id].capture.ageMs, null);
  assert.equal(byId[empty.id].capture.capturedAt, null);
});

test('a cosmetic-only change is zero drift; a real change is one', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const now = Date.now();
  const policy = { id: 'cap1', displayName: 'Block legacy auth', state: 'enabled', templateId: null };
  const source = await snapshot(client, tenantRef, new Date(now - 3 * DAY), [['conditionalAccessPolicy:Block legacy auth', policy]]);
  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId: source, setBy: 'fixture', label: 'Golden' });

  // Same settings, keys reordered and a field Microsoft sets itself changed.
  await snapshot(client, tenantRef, new Date(now - 2 * DAY), [['conditionalAccessPolicy:Block legacy auth', {
    templateId: 'microsoft-template-7', state: 'enabled', displayName: 'Block legacy auth', id: 'cap1',
  }]]);
  let [entry] = await baselineCompliance(client, { tenantRef, now: new Date(now) });
  assert.equal(entry.id, baselineId);
  assert.equal(entry.changesSinceCapture.state, 'compared');
  assert.equal(entry.changesSinceCapture.total, 0);

  const changed = await snapshot(client, tenantRef, new Date(now - DAY), [['conditionalAccessPolicy:Block legacy auth', { ...policy, state: 'disabled' }]]);
  [entry] = await baselineCompliance(client, { tenantRef, now: new Date(now) });
  assert.equal(entry.changesSinceCapture.comparedSnapshotId, changed);
  assert.equal(entry.changesSinceCapture.modified, 1);
  assert.equal(entry.changesSinceCapture.total, 1);
});

test('mutation check: findings link only to records resting on the same collection', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const now = new Date();
  const evidenceSnapshot = await snapshot(client, tenantRef, new Date(now.getTime() - 60 * 60_000), admins(6));
  const laterSnapshot = await snapshot(client, tenantRef, new Date(now.getTime() - 30 * 60_000), admins(7));
  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId: evidenceSnapshot, setBy: 'fixture', label: 'Golden' });
  const evaluation = await evaluateRoleControl(client, tenantRef, evidenceSnapshot, now);
  assert.equal(evaluation.verdict, 'fail');

  const sameCollection = await drift(client, tenantRef, baselineId, evidenceSnapshot, 'roleAssignment:ga-5');
  const otherCollection = await drift(client, tenantRef, baselineId, laterSnapshot, 'roleAssignment:ga-6');
  await drift(client, tenantRef, baselineId, evidenceSnapshot, 'group:Unrelated');
  const samePlan = await pendingRestore(client, tenantRef, evidenceSnapshot, ['roleAssignment:ga-0'], 'fixture');
  const otherPlan = await pendingRestore(client, tenantRef, laterSnapshot, ['roleAssignment:ga-1'], 'fixture');
  await pendingRestore(client, tenantRef, evidenceSnapshot, ['roleAssignment:ga-2'], 'fixture', { expired: true });

  const { findings, summary } = await complianceFindings(client, { tenantRef, now });
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding.title, 'Global Administrator assignment count stays at or below a set limit');
  assert.equal(finding.links.backup.state, 'linked');
  assert.deepEqual(finding.links.backup.linked.map((entry) => entry.snapshotId), [evidenceSnapshot]);
  assert.deepEqual(finding.links.change.linked.map((change) => change.id), [sameCollection]);
  assert.deepEqual(finding.links.change.mismatched.map((change) => change.id), [otherCollection]);
  assert.deepEqual(finding.links.restorePlan.linked.map((plan) => plan.dryRunId), [samePlan.dryRunId]);
  assert.deepEqual(finding.links.restorePlan.mismatched.map((plan) => plan.dryRunId), [otherPlan.dryRunId]);
  assert.equal(finding.exposed, true);
  assert.equal(summary.exposed, 1);

  // Evidence whose window no stored collection reproduces links to nothing.
  await client.query(
    `UPDATE benchmark_evaluation
     SET observation_windows = jsonb_build_array(jsonb_build_object(
       'resourceType', 'roleAssignment', 'startedAt', '2026-01-01T00:00:00.000Z', 'endedAt', '2026-01-01T00:05:00.000Z'))
     WHERE id = $1`,
    [evaluation.id],
  );
  const [unmatched] = (await complianceFindings(client, { tenantRef, now })).findings;
  assert.equal(unmatched.links.backup.state, 'mismatch');
  assert.equal(unmatched.links.backup.linked.length, 0);
  assert.equal(unmatched.links.change.linked.length, 0);
  assert.equal(unmatched.links.change.state, 'mismatch');
  assert.equal(unmatched.links.restorePlan.linked.length, 0);
});

test('mutation check: an expired exception exposes the finding; an authorized one needs owner, reason and expiry', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const now = new Date();
  const admin = await person(client, `admin-${sequence}@contoso.com`, 'admin');
  const viewer = await person(client, `viewer-x-${sequence}@contoso.com`, 'viewer');
  const source = await snapshot(client, tenantRef, new Date(now.getTime() - 60 * 60_000), admins(6));
  const evaluation = await evaluateRoleControl(client, tenantRef, source, now);
  const expiresAt = new Date(now.getTime() + 2 * DAY);

  await assert.rejects(grantComplianceException(client, {
    principalId: viewer, tenantRef, evaluationId: evaluation.id, owner: 'secops@contoso.com', reason: 'migration', expiresAt,
  }), /forbidden/);
  await assert.rejects(grantComplianceException(client, {
    principalId: admin, tenantRef, evaluationId: evaluation.id, owner: ' ', reason: 'migration', expiresAt,
  }), /owner/);
  await assert.rejects(grantComplianceException(client, {
    principalId: admin, tenantRef, evaluationId: evaluation.id, owner: 'secops@contoso.com', reason: 'migration', expiresAt: null,
  }), /expiry/);
  await assert.rejects(grantComplianceException(client, {
    principalId: admin, tenantRef, evaluationId: evaluation.id, owner: 'secops@contoso.com', reason: 'migration', expiresAt: new Date(now.getTime() - 1000),
  }), /expiry/);

  const granted = await grantComplianceException(client, {
    principalId: admin, tenantRef, evaluationId: evaluation.id, owner: 'secops@contoso.com', reason: 'Two break-glass accounts during migration', expiresAt,
  });
  assert.equal(granted.owner, 'secops@contoso.com');

  let [finding] = (await complianceFindings(client, { tenantRef, now })).findings;
  assert.equal(finding.exceptionState, 'authorized');
  assert.equal(finding.exposed, false);
  assert.equal(finding.verdict, 'fail', 'the stored verdict is never rewritten');

  // The same exception read after its expiry: the finding is exposed and the expired
  // exception is still shown, with its owner and expiry.
  const afterExpiry = new Date(expiresAt.getTime() + 60_000);
  const result = await complianceFindings(client, { tenantRef, now: afterExpiry });
  [finding] = result.findings;
  assert.equal(finding.exceptionState, 'expired');
  assert.equal(finding.exposed, true);
  assert.equal(finding.exception.owner, 'secops@contoso.com');
  assert.equal(finding.exception.expiresAt, expiresAt.toISOString());
  assert.equal(result.summary.exposed, 1);
  assert.equal(result.summary.expiredExceptions, 1);
  assert.equal(result.summary.excepted, 0);

  // An exception recorded before task-87 (no owner, no expiry) never hides a finding.
  const legacyTenant = tenant();
  const legacySource = await snapshot(client, legacyTenant, new Date(now.getTime() - 60 * 60_000), admins(6));
  const legacyEvaluation = await evaluateRoleControl(client, legacyTenant, legacySource, now);
  await recordException(client, { tenantRef: legacyTenant, evaluationId: legacyEvaluation.id, actor: 'fixture', reason: 'old waiver' });
  const [legacyFinding] = (await complianceFindings(client, { tenantRef: legacyTenant, now })).findings;
  assert.equal(legacyFinding.exceptionState, 'incomplete');
  assert.equal(legacyFinding.exposed, true);
});

test('storage residency is reported as configured and never as a certification', () => {
  const local = storageResidency({ manifest: { residency: { provider: 'local-disk', region: 'westeurope' }, generatedAt: '2026-10-02T05:00:00Z' } });
  assert.equal(local.configured, true);
  assert.equal(local.provider, 'local-disk');
  assert.equal(local.region, 'westeurope');
  assert.equal(local.immutability, 'unsupported');
  assert.equal(local.certifies, null);

  const s3 = storageResidency({ manifest: { residency: { provider: 's3-compatible' } } });
  assert.equal(s3.immutability, 'unknown', 'no qualification evidence means not proven');
  const proven = storageResidency({ manifest: { residency: { provider: 's3-compatible' } }, qualification: { qualified: true, evidenceLevel: 'live-qualified' } });
  assert.equal(proven.immutability, 'live-qualified');
  assert.equal(proven.certifies, null);

  const missing = storageResidency({ manifest: null });
  assert.equal(missing.configured, false);
  assert.equal(missing.immutability, 'unknown');
});

// Run a script in the portal's own TypeScript runtime, against this test's database.
function inPortal(script, env) {
  const result = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', String.raw`
    const assert = require('node:assert/strict');
    globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;
    const { createElement } = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { AppRouterContext } = require('next/dist/shared/lib/app-router-context.shared-runtime');
    const { workAsyncStorage } = require('next/dist/server/app-render/work-async-storage.external.js');
    const { workUnitAsyncStorage } = require('next/dist/server/app-render/work-unit-async-storage.external.js');
    const { PRINCIPAL_ID_HEADER, CAPABILITIES_HEADER } = require('./lib/principal.ts');
    const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };
    const withRouter = (element) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element));
    const render = (route, page, headers) => workAsyncStorage.run({ route, forceStatic: false }, () =>
      workUnitAsyncStorage.run({ type: 'request', phase: 'render', headers,
        implicitTags: [], url: { pathname: route, search: '' }, rootParams: {},
        resumeDataCache: null, isHmrRefresh: false, fallbackParams: null,
      }, () => page()));
    const visibleText = (html) => html
      .replace(/<details class="technical-details" data-layer="record">[\s\S]*?<\/details>/g, '\n')
      .replace(/<[^>]+>/g, '\n');
    const records = (html) => (html.match(/<details class="technical-details" data-layer="record">[\s\S]*?<\/details>/g) || []).join('\n');
    const BANNED = ['natural key', 'disposition', 'fidelity', 'qualification', 'qualified', 'capability', 'closure', 'projection',
      'blast radius', 'artifact', 'adapter', 'observation', 'catalog type', 'lineage'];
    const assertPlain = (text, where) => {
      assert.doesNotMatch(text, /\b[a-z][A-Za-z]+:[A-Za-z0-9]/, where + ': a natural key is outside the record');
      assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, where + ': an id is outside the record');
      for (const term of BANNED) assert.doesNotMatch(text, new RegExp('\\b' + term + 's?\\b', 'i'), where + ': "' + term + '" is outside the record');
    };
    ${script}
  `], {
    cwd: new URL('../../portal/', import.meta.url), encoding: 'utf8',
    env: { ...process.env, KEEL_DB_URL: database.url, __NEXT_EXPERIMENTAL_AUTH_INTERRUPTS: '1', ...env },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('portal: Compliance and Baselines render the readers in words; a viewer cannot re-capture', async (t) => {
  const client = await schemaClient(t);
  const tenantId = 'task-87-portal';
  const tenantRef = tenantRefFor(tenantId);
  const now = new Date();
  const viewer = await person(client, 'viewer-portal@contoso.com', 'viewer');
  const evidenceSnapshot = await snapshot(client, tenantRef, new Date(now.getTime() - 10 * DAY), admins(6));
  const laterSnapshot = await snapshot(client, tenantRef, new Date(now.getTime() - 60 * 60_000), admins(7));
  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId: evidenceSnapshot, setBy: viewer, label: 'Golden state' });
  const evaluation = await evaluateRoleControl(client, tenantRef, laterSnapshot, now);
  const linked = await drift(client, tenantRef, baselineId, laterSnapshot, 'roleAssignment:ga-6');
  const mismatched = await drift(client, tenantRef, baselineId, evidenceSnapshot, 'roleAssignment:ga-5');
  const exception = await recordException(client, {
    tenantRef, evaluationId: evaluation.id, actor: 'fixture', owner: 'secops@contoso.com', reason: 'migration', expiresAt: new Date(now.getTime() - DAY),
  });

  const directory = mkdtempSync(join(tmpdir(), 'keel-task-87-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'tenant.json');
  writeFileSync(config, JSON.stringify({ tenantId }));
  const manifest = join(directory, 'recovery.json');
  writeFileSync(manifest, JSON.stringify({ residency: { provider: 'local-disk', region: 'westeurope' }, generatedAt: now.toISOString() }));

  inPortal(String.raw`
    const benchmarks = require('./app/benchmarks/page.tsx').default;
    const baselines = require('./app/baselines/page.tsx').default;
    const { POST } = require('./app/api/actions/baseline/route.ts');
    const { getComplianceData } = require('./lib/portal-data.ts');
    const { complianceVerdict } = require('./lib/compliance-view.ts');
    const viewerHeaders = new Headers([[PRINCIPAL_ID_HEADER, ${JSON.stringify(viewer)}], [CAPABILITIES_HEADER, 'read']]);
    (async () => {
      await assert.rejects(render('/benchmarks', benchmarks, new Headers([[CAPABILITIES_HEADER, 'read']])), (error) => error.digest === 'NEXT_HTTP_ERROR_FALLBACK;403');

      const data = await getComplianceData();
      assert.equal(data.summary.expiredExceptions, 1);
      const verdict = complianceVerdict(data);
      assert.equal(verdict.text, '1 control fails, including one whose exception expired.');
      const html = withRouter(await render('/benchmarks', benchmarks, viewerHeaders));
      assert.ok(html.includes('<p class="verdict-sentence">' + verdict.text + '</p>'));
      assert.equal((html.match(/data-layer="verdict"/g) || []).length, 1);
      assert.match(html, /The exception owned by secops@contoso\.com expired (24 hours|1 day) ago, so this finding is open again\./);
      assert.match(html, /1 open change in the same backup\. 1 open change to these types comes from a different backup, so it is not linked\./);
      assert.match(html, /Backups are configured to be stored on local disk in westeurope\. This storage cannot lock backups against deletion\./);
      assert.match(html, /It is not a certification of compliance with any regulation\./);
      assert.match(html, /Captured 10 days ago from one complete backup/);
      const record = records(html);
      for (const id of [${JSON.stringify(evaluation.id)}, ${JSON.stringify(exception.id)}, ${JSON.stringify(linked)}, ${JSON.stringify(mismatched)}, ${JSON.stringify(laterSnapshot)}]) {
        assert.ok(record.includes(id), 'record keeps ' + id);
      }
      assertPlain(visibleText(html), 'Compliance');

      // Baselines: the age is the capture's; a viewer sees the re-capture disabled.
      const baselineHtml = withRouter(await render('/baselines', baselines, viewerHeaders));
      assert.match(baselineHtml, /The active baseline is “Golden state”, captured 10 days ago\./);
      assert.match(baselineHtml, /<button[^>]*disabled=""[^>]*>Capture new version<\/button>/);
      assert.ok(records(baselineHtml).includes(${JSON.stringify(evidenceSnapshot)}));
      assertPlain(visibleText(baselineHtml), 'Baselines');

      // The action route refuses the viewer before anything is queued.
      const response = await POST(new Request('http://keel.test/api/actions/baseline', {
        method: 'POST', headers: viewerHeaders,
        body: JSON.stringify({ snapshotId: ${JSON.stringify(laterSnapshot)}, supersedesBaselineId: ${JSON.stringify(baselineId)} }),
      }));
      assert.equal(response.status, 403);
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `, { KEEL_TENANT_CONFIG_PATH: config, KEEL_RECOVERY_MANIFEST_PATH: manifest });

  const { rows } = await client.query("SELECT count(*)::int AS count FROM job WHERE kind = 'baseline-create'");
  assert.equal(rows[0].count, 0);
  const { rows: baselineCount } = await client.query('SELECT count(*)::int AS count FROM baseline WHERE tenant_ref = $1', [tenantRef]);
  assert.equal(baselineCount[0].count, 1);
});
