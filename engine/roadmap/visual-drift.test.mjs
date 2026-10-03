/** Roadmap task-98 boundary coverage: decision-focused semantic drift and cross-linked
 * reports. The production semantic comparison and evidence reader
 * (engine/govern/semanticDrift.mjs) run against an isolated database; the real portal
 * loader, page and components then run in the portal's own runtime against the same
 * database. Ownership comes from task 89's resolver with the fixture CMDB adapter and
 * scope from task 90's grants. No live Microsoft calls, writers or tenant reads.
 *
 * Required mutation checks:
 * - show raw full-object diff → "behavioural changes are listed …" and the portal render;
 * - include hidden entity in serialized props → "portal: an entity-scoped reader …";
 * - render unknown before as absent → "an unknown before state is never a deletion".
 */
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { evaluateControl, recordEvaluation } from '../benchmarks/evaluate.mjs';
import { canonicalHash, HASH_VERSION } from '../cir/canonicalHash.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { readObservation } from '../contracts/observation.mjs';
import { seedFromSnapshot } from '../govern/baseline.mjs';
import {
  MAX_SEMANTIC_FIELDS, comparedSettings, driftEvidence, semanticChange, summarizeSemanticDrift,
} from '../govern/semanticDrift.mjs';
import { createFixtureCmdbAdapter } from '../identity/adapters/cmdb.mjs';
import { resolveOwnership } from '../identity/ownership.mjs';
import { createDryRunArtifact } from '../restore/dryRunArtifact.mjs';
import { recordLineage } from '../store/resourceLineage.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
const ROLE_CONTROL = 'keel-custom.role-assignment.admin-count-at-most';
const tenantRefFor = (tenantId) => `sha256:${createHash('sha256').update(tenantId).digest('hex').slice(0, 16)}`;

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
    await client.query(schema);
    await client.query(schema); // retry-safe
    schemaReady = true;
  }
  return client;
}

let unique = 0;
async function person(client, label, grants) {
  unique += 1;
  const { rows } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id::text AS id', [`${label}-${unique}-${randomUUID().slice(0, 8)}@example.invalid`]);
  for (const [role, entityCode] of grants) {
    await grantRole(client, { principalId: rows[0].id, role, grantedBy: 'fixture', activeFrom: new Date(Date.now() - 60_000), entityCode });
  }
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
  for (const [naturalKey, payload] of resources) {
    const type = naturalKey.slice(0, naturalKey.indexOf(':'));
    await client.query(
      `INSERT INTO resource_version
         (snapshot_id, natural_key, resource_type, payload, payload_hash, hash_version, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, 'high', 'access-affecting', 'full', '{}')`,
      [rows[0].id, naturalKey, type, payload, canonicalHash(payload, type), HASH_VERSION],
    );
  }
  return rows[0].id;
}

async function drift(client, { tenantRef, baselineId, snapshotId, naturalKey, changeType = 'modified', before = null, after = null, beforeHash, afterHash, blastRadius = 'access-affecting' }) {
  const type = naturalKey.slice(0, naturalKey.indexOf(':'));
  const { rows } = await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
                        before_hash, after_hash, before_payload, after_payload, blast_radius)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id::text AS id`,
    [tenantRef, baselineId, snapshotId, naturalKey, type, changeType,
      beforeHash === undefined ? (before ? canonicalHash(before, type) : null) : beforeHash,
      afterHash === undefined ? (after ? canonicalHash(after, type) : null) : afterHash,
      before, after, blastRadius],
  );
  return rows[0].id;
}

async function plan(client, tenantRef, snapshotId, closureKeys, requestedBy) {
  const id = randomUUID();
  await createDryRunArtifact(client, {
    id, tenantRef, snapshotId, selection: closureKeys, closureKeys, targetTenantId: 't', collectorConfigPath: 'c', targetConfigPath: 'r',
    reconciliationResources: null, waves: [closureKeys], patches: [], guardRefusals: [], results: { applied: [], skipped: [], failed: [] },
    currentStateFingerprint: 'f', digest: 'd', status: 'completed', requestedBy,
  });
  return id;
}

async function request(client, action, params, requestedBy, status = 'pending') {
  const { rows } = await client.query(
    `INSERT INTO approval_request (action, params, requested_by, status, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id`,
    [action, params, requestedBy, status, new Date(Date.now() + DAY)],
  );
  return rows[0].id;
}

const admins = (count) => Array.from({ length: count }, (_, index) => [
  `roleAssignment:ga-${index}`, { id: `ra-${index}`, roleDefinitionId: GLOBAL_ADMIN, principalId: `user-${index}`, directoryScopeId: '/' },
]);

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

/* ------------------------------------------------------------ semantics -- */

test('behavioural changes are listed; fields Microsoft sets itself are counted and absent', () => {
  const before = {
    '@odata.etag': 'W/"1"', id: '1f0c0000-0000-4000-8000-000000000001', displayName: 'Finance', description: 'Finance team',
    mail: 'finance@contoso.example', modifiedDateTime: '2026-09-01T00:00:00Z', mailEnabled: false,
    owners: ['cfo@contoso.example'], settings: { '@odata.type': '#microsoft.graph.a', visibility: 'Private' },
  };
  // Same object, keys in another order; Microsoft rotated its own fields.
  const after = {
    settings: { visibility: 'Private', '@odata.type': '#microsoft.graph.b' }, owners: ['cfo@contoso.example'], mailEnabled: true,
    modifiedDateTime: '2026-10-01T00:00:00Z', mail: 'finance-renamed@contoso.example', description: 'Finance and payroll',
    displayName: 'Finance', id: '1f0c0000-0000-4000-8000-000000000001', '@odata.etag': 'W/"2"',
  };
  const change = semanticChange({ resourceType: 'group', changeType: 'modified', before, after });
  assert.equal(change.state, 'compared');
  assert.equal(change.rules, 'reviewed');
  assert.deepEqual(change.fields.map((field) => [field.path, field.kind, field.impact]), [
    ['mailEnabled', 'changed', 'fixed'],
    ['description', 'changed', 'behaviour'],
  ]);
  assert.equal(change.total, 2);
  assert.deepEqual(change.groups, { behaviour: 1, fixed: 1, 'unknown-before': 0 });
  assert.equal(change.cosmetic, 4, 'etag, mail, modifiedDateTime and a nested type annotation are counted');
  const serialized = JSON.stringify({ ...change, projected: undefined });
  for (const absent of ['finance-renamed', 'modifiedDateTime', 'etag', '@odata', 'microsoft.graph']) {
    assert.ok(!serialized.includes(absent), `${absent} is not serialized`);
  }
  // What the page hands its client carries none of them either.
  const shown = JSON.stringify(comparedSettings('group', after));
  for (const absent of ['finance-renamed', 'modifiedDateTime', 'etag', '1f0c0000']) assert.ok(!shown.includes(absent), absent);
  assert.ok(shown.includes('Finance and payroll'));

  // Only cosmetic fields differ: zero behavioural settings, the rest counted.
  const cosmeticOnly = semanticChange({
    resourceType: 'group', changeType: 'modified',
    before: { displayName: 'A', modifiedDateTime: 't1' }, after: { modifiedDateTime: 't2', displayName: 'A' },
  });
  assert.deepEqual([cosmeticOnly.total, cosmeticOnly.cosmetic, cosmeticOnly.fields.length], [0, 1, 0]);

  // A type without field rules still leaves out ids and timestamps, and says so.
  const generic = semanticChange({
    resourceType: 'someFutureType', changeType: 'modified',
    before: { id: 'a', lastModifiedDateTime: 't1', enabled: true }, after: { id: 'a', lastModifiedDateTime: 't2', enabled: false },
  });
  assert.equal(generic.rules, 'generic');
  assert.deepEqual(generic.fields.map((field) => field.path), ['enabled']);
  assert.equal(generic.cosmetic, 1);

  // The table is capped; the total still counts every setting.
  const wide = (value) => Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`setting${String(index).padStart(2, '0')}`, value]));
  const capped = semanticChange({ resourceType: 'namedLocation', changeType: 'modified', before: wide(1), after: wide(2) });
  assert.equal(capped.total, 60);
  assert.equal(capped.shown, MAX_SEMANTIC_FIELDS);
  assert.equal(capped.fields.length, MAX_SEMANTIC_FIELDS);
});

test('an unknown before state is never a deletion or an addition', () => {
  const after = { displayName: 'Block legacy auth', state: 'enabled', modifiedDateTime: '2026-10-01T00:00:00Z' };
  const change = semanticChange({ resourceType: 'conditionalAccessPolicy', changeType: 'modified', before: null, after });
  assert.equal(change.state, 'unknown-before');
  assert.deepEqual(change.fields.map((field) => [field.path, field.kind, field.impact]), [
    ['displayName', 'unknown-before', 'unknown-before'],
    ['state', 'unknown-before', 'unknown-before'],
  ]);
  for (const field of change.fields) {
    assert.ok(!('before' in field), 'no earlier value is invented');
    assert.ok(!['removed', 'added'].includes(field.kind));
  }
  assert.deepEqual(change.groups, { behaviour: 0, fixed: 0, 'unknown-before': 2 });

  // A real removal keeps its meaning; an added resource has no earlier copy by design.
  assert.equal(semanticChange({ resourceType: 'group', changeType: 'removed', before: { displayName: 'Old' }, after: null }).state, 'removed');
  assert.equal(semanticChange({ resourceType: 'group', changeType: 'added', before: null, after: { displayName: 'New' } }).state, 'added');
  assert.equal(semanticChange({ resourceType: 'group', changeType: 'modified', before: { displayName: 'A' }, after: null }).state, 'unknown-after');
});

/* ------------------------------------------------------------- evidence -- */

test('linked records state matches and mismatches explicitly, and counts reconcile', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenantRefFor('task-98-evidence');
  const now = new Date();
  const requester = await person(client, 'requester', [['operator', null]]);
  const groupA = ['group:Finance', { displayName: 'Finance', description: 'v1' }];
  const groupB = ['group:Payroll', { displayName: 'Payroll', description: 'v1' }];
  const baselineSnapshot = await snapshot(client, tenantRef, new Date(now.getTime() - 3 * DAY), [groupA, groupB, ...admins(6)]);
  const laterA = { displayName: 'Finance', description: 'v2' };
  const laterB = { displayName: 'Payroll', description: 'v2' };
  const laterSnapshot = await snapshot(client, tenantRef, new Date(now.getTime() - HOUR), [['group:Finance', laterA], ['group:Payroll', laterB], ...admins(7)]);
  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId: baselineSnapshot, setBy: requester, label: 'Golden' });
  const evaluation = await evaluateRoleControl(client, tenantRef, laterSnapshot, now);

  const dA = await drift(client, { tenantRef, baselineId, snapshotId: laterSnapshot, naturalKey: 'group:Finance', before: groupA[1], after: laterA });
  // The stored baseline fingerprint does not match the baseline's copy.
  const dB = await drift(client, { tenantRef, baselineId, snapshotId: laterSnapshot, naturalKey: 'group:Payroll', before: groupB[1], after: laterB, beforeHash: 'not-the-baseline-copy' });
  const dC = await drift(client, { tenantRef, baselineId, snapshotId: laterSnapshot, naturalKey: 'roleAssignment:ga-6', changeType: 'added', after: admins(7)[6][1], blastRadius: 'tenant-lockout' });
  // Observed in a different collection than the finding's evidence.
  const dD = await drift(client, { tenantRef, baselineId, snapshotId: baselineSnapshot, naturalKey: 'roleAssignment:ga-5', before: admins(6)[5][1], after: admins(6)[5][1], afterHash: null, blastRadius: 'tenant-lockout' });

  const remediate = await request(client, 'remediate', { driftIds: [dA, dB] }, requester);
  await client.query(
    "INSERT INTO job (kind, params, requested_by, status, idempotency_key) VALUES ('remediate', $1, $2, 'queued', $3)",
    [{ driftIds: [dA, dB] }, requester, `approval:${remediate}`],
  );
  const linkedPlan = await plan(client, tenantRef, baselineSnapshot, ['group:Finance'], requester);
  const otherPlan = await plan(client, tenantRef, laterSnapshot, ['group:Finance', 'group:Payroll'], requester);
  const restoreRequest = await request(client, 'restore', { artifactId: linkedPlan }, requester, 'approved');
  await client.query(
    `INSERT INTO rollback_entry (run_id, natural_key, prior_state, restore_ref, resource_type, operation, outcome, outcome_at)
     VALUES ('run-1', 'group:Finance', '{}', $1, 'group', 'update', 'succeeded', now())`,
    [linkedPlan],
  );
  // Another tenant's plan for the same name is never linked.
  await plan(client, tenantRefFor('task-98-other-tenant'), baselineSnapshot, ['group:Finance'], requester);

  const { rows: driftRows } = await client.query(
    'SELECT id::text AS id, natural_key, resource_type, change_type, detected_at, blast_radius, before_payload, after_payload FROM drift WHERE tenant_ref = $1 ORDER BY detected_at, id', [tenantRef],
  );
  const items = driftRows.map((row) => ({
    id: row.id, naturalKey: row.natural_key, resourceType: row.resource_type, changeType: row.change_type, detectedAt: row.detected_at, blastRadius: row.blast_radius,
  }));
  const evidence = await driftEvidence(client, { tenantRef, items, now });

  const a = evidence.get(dA);
  assert.equal(a.observation.state, 'matches');
  assert.equal(a.observation.snapshotId, laterSnapshot);
  assert.equal(a.backup.state, 'matches');
  assert.equal(a.backup.snapshotId, baselineSnapshot);
  assert.deepEqual(a.approvals.map((entry) => [entry.id, entry.status, entry.job?.status, entry.others]), [[remediate, 'pending', 'queued', 1]]);
  assert.deepEqual(a.plans.map((entry) => [entry.id, entry.link]).sort(), [[linkedPlan, 'linked'], [otherPlan, 'mismatch']].sort());
  const linked = a.plans.find((entry) => entry.id === linkedPlan);
  assert.equal(linked.outcome.state, 'succeeded');
  assert.deepEqual(linked.approvals.map((entry) => [entry.id, entry.status]), [[restoreRequest, 'approved']]);
  assert.equal(a.plans.find((entry) => entry.id === otherPlan).outcome, null, 'a plan with no write has no result');
  assert.equal(a.mismatches, 1);

  const b = evidence.get(dB);
  assert.equal(b.backup.state, 'mismatch', 'a baseline copy that differs from the recorded fingerprint is not linked');
  assert.equal(b.observation.state, 'matches');
  assert.deepEqual(b.plans.map((entry) => entry.link), ['mismatch']);

  const c = evidence.get(dC);
  assert.equal(c.backup.state, 'not-in-baseline');
  assert.deepEqual(c.findings.map((finding) => [finding.evaluationId, finding.link]), [[evaluation.id, 'linked']]);

  const d = evidence.get(dD);
  assert.deepEqual(d.findings.map((finding) => [finding.evaluationId, finding.link]), [[evaluation.id, 'mismatch']]);
  assert.equal(d.observation.state, 'unchecked', 'no recorded fingerprint is unchecked, not a match');
  assert.equal(d.mismatches, 1);

  // Counts reconcile: each change in one impact group, the groups add up.
  const withSemantics = driftRows.map((row, index) => ({
    ...items[index],
    semantic: semanticChange({ resourceType: row.resource_type, changeType: row.change_type, before: row.before_payload, after: row.after_payload }),
    evidence: evidence.get(row.id),
  }));
  const summary = summarizeSemanticDrift(withSemantics);
  assert.equal(summary.total, 4);
  assert.equal(summary.byImpact.reduce((sum, group) => sum + group.changes, 0), summary.total);
  assert.deepEqual(summary.byImpact.map((group) => [group.blastRadius, group.changes]), [['tenant-lockout', 2], ['access-affecting', 2]]);
  assert.equal(summary.byImpact.reduce((sum, group) => sum + group.settings, 0), summary.behaviouralSettings + summary.fixedSettings);
  assert.equal(summary.behaviouralSettings, 2);
  assert.equal(summary.cosmeticOnly, 1, 'the unchanged role assignment compares equal');
  assert.equal(summary.mismatched, 3);
});

/* --------------------------------------------------------------- portal -- */

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
    const RECORD = /<details class="technical-details" data-layer="record">[\s\S]*?<\/details>/g;
    const visibleText = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '\n').replace(RECORD, '\n').replace(/<[^>]+>/g, '\n');
    const BANNED = ['natural key', 'disposition', 'fidelity', 'qualification', 'capability', 'closure', 'projection',
      'blast radius', 'artifact', 'adapter', 'observation', 'lineage', 'fingerprint'];
    const assertPlain = (text, where) => {
      assert.doesNotMatch(text, /\b[a-z][A-Za-z]+:[A-Za-z0-9]/, where + ': a natural key is outside the record');
      assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, where + ': an id is outside the record');
      assert.doesNotMatch(text, /\b[a-z]+(?:_[a-z0-9]+)+\b/, where + ': a snake_case code is outside the record');
      for (const term of BANNED) assert.doesNotMatch(text, new RegExp('\\b' + term + 's?\\b', 'i'), where + ': "' + term + '" is outside the record');
    };
    ${script}
  `], {
    cwd: new URL('../../portal/', import.meta.url), encoding: 'utf8',
    env: { ...process.env, KEEL_DB_URL: database.url, __NEXT_EXPERIMENTAL_AUTH_INTERRUPTS: '1', ...env },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

const ID = {
  creos: '11111111-1111-4111-8111-111111111198',
  enovos: '22222222-2222-4222-8222-222222222298',
  shared: '33333333-3333-4333-8333-333333333398',
};
const KEY = { creos: 'group:Grid Operations Admins', enovos: 'group:Retail Billing Admins', shared: 'group:Group Finance' };
const CREOS = 'Creos Luxembourg S.A.';
const ENOVOS = 'Enovos Luxembourg S.A.';

test('portal: an entity-scoped reader gets semantic changes and linked records with nothing outside their entities', async (t) => {
  const client = await schemaClient(t);
  const tenantId = 'task-98-portal';
  const tenantRef = tenantRefFor(tenantId);
  const now = new Date();
  const collector = await person(client, 'collector', [['operator', null], ['viewer', null]]);
  const central = await person(client, 'central', [['viewer', null]]);
  const creosViewer = await person(client, 'creos-viewer', [['viewer', 'CREOS']]);

  const observedAt = new Date(now.getTime() - 5 * HOUR);
  for (const name of ['creos', 'enovos', 'shared']) {
    await recordLineage(client, { tenantRef, resourceType: 'group', sourceId: ID[name], naturalKey: KEY[name], observedAt });
  }
  const cmdb = createFixtureCmdbAdapter({
    tenantRef,
    records: [
      { resourceType: 'group', sourceId: ID.creos, recordRef: 'CI-1198', owners: [CREOS] },
      { resourceType: 'group', sourceId: ID.enovos, recordRef: 'CI-2298', owners: [ENOVOS] },
      { resourceType: 'group', sourceId: ID.shared, recordRef: 'CI-3398', owners: [CREOS, ENOVOS] },
    ],
  });
  const config = {
    entities: { CREOS: { cmdbValues: [CREOS], codePrefixes: ['CRE'] }, ENOVOS: { cmdbValues: [ENOVOS], codePrefixes: ['ENO'] } },
    maxEvidenceAgeMs: 4 * HOUR, lookupTimeoutMs: 50,
  };
  for (const name of ['creos', 'enovos', 'shared']) {
    await resolveOwnership(client, { tenantRef, managedTenantRef: tenantRef, requestedBy: collector, resourceType: 'group', sourceId: ID[name], adapter: cmdb, config });
  }

  const base = (name) => ({ id: ID[name], displayName: KEY[name].slice(6), description: 'baseline', mail: `${name}@contoso.example`, modifiedDateTime: '2026-09-01T00:00:00Z' });
  const changed = (name) => ({ ...base(name), description: `changed ${name}`, mail: `${name}-rotated@contoso.example`, modifiedDateTime: '2026-10-01T00:00:00Z' });
  const baselineSnapshot = await snapshot(client, tenantRef, new Date(now.getTime() - 4 * HOUR), ['creos', 'enovos', 'shared'].map((name) => [KEY[name], base(name)]));
  const laterSnapshot = await snapshot(client, tenantRef, new Date(now.getTime() - HOUR), ['creos', 'enovos', 'shared'].map((name) => [KEY[name], changed(name)]));
  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId: baselineSnapshot, setBy: collector, label: 'Golden' });
  const driftId = {};
  for (const name of ['creos', 'enovos']) {
    driftId[name] = await drift(client, { tenantRef, baselineId, snapshotId: laterSnapshot, naturalKey: KEY[name], before: base(name), after: changed(name) });
  }
  // The shared resource's baseline copy was not kept: its earlier values are unknown.
  driftId.shared = await drift(client, { tenantRef, baselineId, snapshotId: laterSnapshot, naturalKey: KEY.shared, before: null, after: changed('shared'), beforeHash: null });
  const remediate = await request(client, 'remediate', { driftIds: [driftId.creos, driftId.enovos] }, collector);
  const rollback = await plan(client, tenantRef, baselineSnapshot, [KEY.creos, KEY.enovos], collector);

  const directory = mkdtempSync(join(tmpdir(), 'keel-task-98-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tenantConfig = join(directory, 'tenant.json');
  writeFileSync(tenantConfig, JSON.stringify({ tenantId }));

  inPortal(String.raw`
    const page = require('./app/drift/page.tsx').default;
    const { displayItems, getDriftData } = require('./lib/portal-data.ts');
    const { SemanticDiff } = require('./components/semantic-diff.tsx');
    const { ChangeEvidencePanel } = require('./components/decision-workbook.tsx');
    const HIDDEN = [${JSON.stringify(KEY.enovos)}, ${JSON.stringify(driftId.enovos)}, 'ENOVOS', 'Enovos', 'Retail Billing', ${JSON.stringify(ID.enovos)}];
    (async () => {
      // Central reader: everything, with the shared owners and the request's other change counted.
      const all = await getDriftData();
      assert.equal(all.items.length, 3);
      const sharedAll = all.items.find((item) => item.id === ${JSON.stringify(driftId.shared)});
      assert.deepEqual(sharedAll.evidence.ownership.sharedWith, ['CREOS', 'ENOVOS']);
      const creosAll = all.items.find((item) => item.id === ${JSON.stringify(driftId.creos)});
      assert.equal(creosAll.evidence.approvals[0].others, 1);
      assert.equal(creosAll.evidence.plans[0].others, 1);

      // Entity-scoped reader: the hidden entity is absent from the data and the props.
      const scoped = await getDriftData({ central: false, entities: ['CREOS'] });
      assert.deepEqual(scoped.items.map((item) => item.naturalKey).sort(), [${JSON.stringify(KEY.creos)}, ${JSON.stringify(KEY.shared)}].sort());
      const serialized = JSON.stringify(scoped) + JSON.stringify(displayItems(scoped.items));
      for (const hidden of HIDDEN) assert.ok(!serialized.includes(hidden), 'serialized data carries ' + hidden);
      const shared = scoped.items.find((item) => item.id === ${JSON.stringify(driftId.shared)});
      assert.deepEqual(shared.evidence.ownership, { state: 'shared', entityCode: null, sharedWith: ['CREOS'], othersWithheld: true });
      const creos = scoped.items.find((item) => item.id === ${JSON.stringify(driftId.creos)});
      assert.deepEqual([creos.evidence.approvals[0].id, creos.evidence.approvals[0].others, creos.evidence.approvals[0].othersWithheld], [${JSON.stringify(remediate)}, null, true]);
      assert.deepEqual([creos.evidence.plans[0].id, creos.evidence.plans[0].link, creos.evidence.plans[0].others, creos.evidence.plans[0].othersWithheld], [${JSON.stringify(rollback)}, 'linked', null, true]);
      assert.equal(creos.evidence.ownership.entityCode, 'CREOS');

      // Counts reconcile with the list the reader sees.
      assert.equal(scoped.summary.total, scoped.items.length);
      assert.equal(scoped.summary.byImpact.reduce((sum, group) => sum + group.changes, 0), scoped.items.length);
      assert.equal(scoped.summary.unknownBefore, 1);

      // Behavioural fields only: the rotated mail and timestamps are absent everywhere.
      assert.deepEqual(creos.semantic.fields.map((field) => field.path), ['description']);
      assert.equal(creos.semantic.cosmetic, 2);
      const props = JSON.stringify(displayItems(scoped.items));
      for (const cosmetic of ['rotated@contoso', 'modifiedDateTime']) assert.ok(!props.includes(cosmetic), 'client props carry ' + cosmetic);

      const at = scoped.generatedAt;
      const [creosShown, sharedShown] = [creos, shared].map((item) => displayItems([item])[0]);
      assert.deepEqual(Object.keys(creosShown.after).sort(), ['description', 'displayName'], 'ids and Microsoft-set fields are not handed to the client');
      const diffHtml = withRouter(createElement(SemanticDiff, { item: creosShown, change: creos.semantic }));
      assert.match(diffHtml, /1 setting differs from the baseline in a way that changes behaviour\./);
      assert.match(diffHtml, /2 settings Microsoft manages itself also differ\. They do not change behaviour and are not shown\./);
      assert.ok(diffHtml.includes('changed creos'));
      for (const cosmetic of ['rotated@contoso', 'modifiedDateTime', '2026-10-01']) assert.ok(!diffHtml.includes(cosmetic), 'rendered ' + cosmetic);
      assertPlain(visibleText(diffHtml), 'semantic diff');

      const unknownHtml = withRouter(createElement(SemanticDiff, { item: sharedShown, change: shared.semantic }));
      assert.match(unknownHtml, /the earlier values are not known\. Nothing is shown as removed\./);
      assert.match(unknownHtml, /Earlier value not known/);
      assert.ok(unknownHtml.includes('>Not known<'));
      const unknownText = visibleText(unknownHtml);
      for (const wrong of ['Removed', 'No longer set', 'Not set in the baseline', 'Added']) assert.ok(!unknownText.includes(wrong), 'unknown before rendered as ' + wrong);

      const evidenceHtml = withRouter(createElement(ChangeEvidencePanel, { evidence: creos.evidence, attribution: creos.attribution, now: at }));
      assert.match(evidenceHtml, /Owned by CREOS\./);
      assert.match(evidenceHtml, /A roll-back request is waiting for a decision\. It also covers other changes\./);
      assert.match(evidenceHtml, /A roll-back plan is ready\. It puts back the baseline&#x27;s copy\. No result is recorded yet\. It also covers other resources\./);
      assert.match(evidenceHtml, /The backup that found this change holds exactly what it recorded\./);
      for (const hidden of HIDDEN) assert.ok(!evidenceHtml.includes(hidden), 'evidence html carries ' + hidden);
      assertPlain(visibleText(evidenceHtml), 'evidence');
      const sharedHtml = withRouter(createElement(ChangeEvidencePanel, { evidence: shared.evidence, attribution: shared.attribution, now: at }));
      assert.match(sharedHtml, /Shared by CREOS and other entities\./);
      for (const hidden of HIDDEN) assert.ok(!sharedHtml.includes(hidden), 'shared html carries ' + hidden);

      // The page itself, as the scoped viewer.
      const { ENTITY_CAPABILITIES_HEADER } = require('./lib/principal.ts');
      const viewerHeaders = new Headers([[PRINCIPAL_ID_HEADER, ${JSON.stringify(creosViewer)}], [ENTITY_CAPABILITIES_HEADER, 'read:CREOS']]);
      const html = withRouter(await render('/drift', page, viewerHeaders));
      assert.match(html, /What the open changes affect/);
      assert.match(html, /All open changes<\/th><td data-label="Changes">2<\/td>/);
      assert.match(html, /1 change has no baseline copy, so earlier values are not known\./);
      for (const hidden of HIDDEN) assert.ok(!html.includes(hidden), 'page carries ' + hidden);
      assertPlain(visibleText(html), 'Changes page');

      const centralHtml = withRouter(await render('/drift', page, new Headers([[PRINCIPAL_ID_HEADER, ${JSON.stringify(central)}], [CAPABILITIES_HEADER, 'read']])));
      assert.match(centralHtml, /All open changes<\/th><td data-label="Changes">3<\/td>/);
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `, { KEEL_TENANT_CONFIG_PATH: tenantConfig });
});
