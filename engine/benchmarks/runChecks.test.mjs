/** The Compliance page's control checks: run against the newest backups, recorded,
 * and read back by the Compliance reader with their evidence matched. Also runs as
 * part of drift detection after a backup, with or without an active baseline. */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalHash, HASH_VERSION } from '../cir/canonicalHash.mjs';
import { complianceFindings } from '../govern/baselineCompliance.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { listControls } from './registry.mjs';
import { runComplianceChecks } from './runChecks.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const HOUR = 3_600_000;
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
const ROLE = 'keel-custom.role-assignment.admin-count-at-most';
const LOCATION = 'keel-custom.named-location.no-untrusted-all-countries';
const GROUP = 'keel-custom.group.role-assignable-not-synced';
// Every shipped control is checked; the rest (Defender email...) have no read in these tests.
const ALL = listControls().length;
const OTHERS = ALL - 3;

let ready = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!ready) { await client.query(schemaSql()); ready = true; }
  return client;
}

let sequence = 0;
const tenant = () => { sequence += 1; return `sha256:${createHash('sha256').update(`checks-${sequence}`).digest('hex').slice(0, 16)}`; };

/** A completed snapshot; `digest` maps type -> outcome, `resources` are [naturalKey, payload]. */
async function snapshot(client, tenantRef, completedAt, digest, resources = []) {
  const coverage = Object.fromEntries(Object.entries(digest).map(([type, outcome]) => [type, { outcome, itemCount: 0 }]));
  const { rows: [row] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
     VALUES ($1, 'complete', $2, $3, $4) RETURNING id::text AS id`,
    [tenantRef, new Date(completedAt.getTime() - 600_000), completedAt, coverage],
  );
  for (const [naturalKey, payload] of resources) {
    const type = naturalKey.slice(0, naturalKey.indexOf(':'));
    await client.query(
      `INSERT INTO resource_version
         (snapshot_id, natural_key, resource_type, payload, payload_hash, hash_version, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, 'high', 'access-affecting', 'full', '{}')`,
      [row.id, naturalKey, type, payload, canonicalHash(payload, type), HASH_VERSION],
    );
  }
  return row.id;
}

const admins = (count) => Array.from({ length: count }, (_, index) => [
  `roleAssignment:ga-${index}`, { id: `ra-${index}`, roleDefinitionId: GLOBAL_ADMIN, principalId: `user-${index}`, directoryScopeId: '/' },
]);

test('checks every control against the newest complete read of each type and records the result', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const now = new Date();
  // Older snapshot: 7 admins (would fail) and a role-assignable synced group.
  await snapshot(client, tenantRef, new Date(now.getTime() - 2 * HOUR), { roleAssignment: 'complete', group: 'complete' }, [
    ...admins(7),
    ['group:Tier0', { id: 'g1', displayName: 'Tier0', isAssignableToRole: true, onPremisesSyncEnabled: true }],
  ]);
  // Newest snapshot: 2 admins; its group read failed, so the older group read is used.
  const newest = await snapshot(client, tenantRef, new Date(now.getTime() - HOUR), { roleAssignment: 'complete', group: 'failed' }, admins(2));

  const result = await runComplianceChecks(client, { tenantRef, actor: 'scheduler', now });
  assert.equal(result.checked, ALL);
  const byControl = Object.fromEntries(result.evaluations.map((evaluation) => [evaluation.control_id, evaluation]));
  assert.equal(byControl[ROLE].verdict, 'pass', 'the newest complete role read (2 admins) is used');
  assert.equal(byControl[GROUP].verdict, 'fail', 'a failed group read falls back to the newest complete one');
  // Each check records the value it found next to the value it wants.
  assert.deepEqual(byControl[ROLE].details, [
    { subject: 'Global Administrator', setting: 'assignmentCount', value: 2, expected: { atMost: 5 }, ok: true },
  ]);
  assert.deepEqual(byControl[GROUP].details, [
    { subject: 'Tier0', setting: 'onPremisesSyncEnabled', value: true, expected: false, ok: false },
  ]);
  assert.equal(byControl[LOCATION].verdict, 'unknown', 'a type no backup read is never a guessed pass');
  assert.equal(byControl[LOCATION].reason, 'namedLocation:no-observation');
  assert.deepEqual([result.pass, result.fail, result.unknown], [1, 1, 1 + OTHERS]);

  // Each result has its evidence entry, and the Compliance reader matches it to the snapshot it came from.
  const { rows: [{ count }] } = await client.query("SELECT count(*)::int AS count FROM evidence WHERE tenant_ref = $1 AND kind = 'benchmark-evaluation'", [tenantRef]);
  assert.equal(count, ALL);
  const { findings } = await complianceFindings(client, { tenantRef, now });
  assert.equal(findings.length, ALL);
  const role = findings.find((finding) => finding.controlId === ROLE);
  assert.deepEqual(role.evidence.map((entry) => entry.snapshotId), [newest]);
});

test('each identity control records expected and current values for what it checked', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const now = new Date();
  await snapshot(client, tenantRef, new Date(now.getTime() - HOUR), { roleAssignment: 'complete', group: 'complete', namedLocation: 'complete' }, [
    ...admins(6),
    ['group:Cloud', { id: 'g1', displayName: 'Cloud admins', isAssignableToRole: true }],
    ['group:Plain', { id: 'g2', displayName: 'Everyone', isAssignableToRole: false, onPremisesSyncEnabled: true }],
    ['namedLocation:Office', { id: 'l1', displayName: 'Office', isTrusted: true, includeUnknownCountriesAndRegions: false }],
    ['namedLocation:Anywhere', { id: 'l2', displayName: 'Anywhere', isTrusted: true, includeUnknownCountriesAndRegions: true }],
    ['namedLocation:Blocked', { id: 'l3', displayName: 'Blocked', isTrusted: false, includeUnknownCountriesAndRegions: true }],
  ]);
  const result = await runComplianceChecks(client, { tenantRef, actor: 'scheduler', now });
  const byControl = Object.fromEntries(result.evaluations.map((evaluation) => [evaluation.control_id, evaluation]));
  assert.equal(byControl[ROLE].verdict, 'fail');
  assert.deepEqual(byControl[ROLE].details, [
    { subject: 'Global Administrator', setting: 'assignmentCount', value: 6, expected: { atMost: 5 }, ok: false },
  ]);
  // A cloud-only group has no sync flag; it is recorded as not synchronized. A group
  // that cannot hold roles is not checked.
  assert.equal(byControl[GROUP].verdict, 'pass');
  assert.deepEqual(byControl[GROUP].details, [
    { subject: 'Cloud admins', setting: 'onPremisesSyncEnabled', value: false, expected: false, ok: true },
  ]);
  // Only trusted locations are checked, and the failing one comes first.
  assert.equal(byControl[LOCATION].verdict, 'fail');
  assert.deepEqual(byControl[LOCATION].details, [
    { subject: 'Anywhere', setting: 'includeUnknownCountriesAndRegions', value: true, expected: false, ok: false },
    { subject: 'Office', setting: 'includeUnknownCountriesAndRegions', value: false, expected: false, ok: true },
  ]);
  const { findings } = await complianceFindings(client, { tenantRef, now });
  assert.deepEqual(findings.find((finding) => finding.controlId === LOCATION).details.map((line) => line.ok), [false, true]);
});

test('a result stored before passing lines existed reads back as failing lines', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  await client.query(
    `INSERT INTO benchmark_evaluation (tenant_ref, control_id, framework, edition, profile, evaluator_version, verdict, evidence_refs, observation_windows, evaluated_at, details)
     VALUES ($1, $2, 'keel-custom', '1.0.0', 'default', 1, 'fail', '[]', '[]', now(), $3)`,
    [tenantRef, LOCATION, JSON.stringify([{ subject: 'Old', setting: 'includeUnknownCountriesAndRegions', value: true, expected: false }])],
  );
  const { findings } = await complianceFindings(client, { tenantRef, now: new Date() });
  assert.deepEqual(findings[0].details, [{ subject: 'Old', setting: 'includeUnknownCountriesAndRegions', value: true, expected: false, ok: false }]);
});

test('a backup older than the control allows is recorded as could not check', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const now = new Date();
  await snapshot(client, tenantRef, new Date(now.getTime() - 30 * HOUR), { roleAssignment: 'complete' }, admins(1));
  const result = await runComplianceChecks(client, { tenantRef, actor: 'scheduler', now });
  const role = result.evaluations.find((evaluation) => evaluation.control_id === ROLE);
  assert.equal(role.verdict, 'unknown');
  assert.equal(role.reason, 'roleAssignment:stale-observation');
});

test('another tenant\'s backups are never used', async (t) => {
  const client = await schemaClient(t);
  const mine = tenant();
  const other = tenant();
  await snapshot(client, other, new Date(Date.now() - HOUR), { roleAssignment: 'complete' }, admins(9));
  const result = await runComplianceChecks(client, { tenantRef: mine, actor: 'scheduler' });
  assert.equal(result.unknown, ALL);
  const { rows } = await client.query('SELECT DISTINCT tenant_ref FROM benchmark_evaluation WHERE tenant_ref = ANY($1)', [[mine, other]]);
  assert.deepEqual(rows.map((row) => row.tenant_ref), [mine]);
});

test('drift detection after a backup runs the checks, even with no active baseline', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const snapshotId = await snapshot(client, tenantRef, new Date(Date.now() - HOUR), { roleAssignment: 'complete' }, admins(3));
  const run = spawnSync(process.execPath, [join(ROOT, 'cli', 'keel-drift.mjs'), 'detect', '--snapshot-id', snapshotId, '--tenant-ref', tenantRef, '--db-url', database.url], { encoding: 'utf8' });
  assert.match(run.stdout, new RegExp(`compliance checks: ${ALL} run \\(1 pass, 0 fail, ${ALL - 1} could not check\\)`), run.stderr);
  // With no baseline, drift itself still refuses as before.
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no active baseline/);
  const { rows } = await client.query("SELECT actor FROM evidence WHERE tenant_ref = $1 AND kind = 'benchmark-evaluation'", [tenantRef]);
  assert.deepEqual(rows.map((row) => row.actor), Array(ALL).fill('scheduler'));
});

test('a Conditional Access read with no legacy block is recorded as not set up yet', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const now = new Date();
  await snapshot(client, tenantRef, new Date(now.getTime() - HOUR), { conditionalAccessPolicy: 'complete' }, [
    ['conditionalAccessPolicy:KEEL-RT-mfa', { id: 'ca-1', displayName: 'KEEL-RT-mfa', state: 'enabled', conditions: { clientAppTypes: ['all'] }, grantControls: { builtInControls: ['mfa'] } }],
  ]);
  const result = await runComplianceChecks(client, { tenantRef, actor: 'scheduler', now });
  const legacy = result.evaluations.find((evaluation) => evaluation.control_id === 'keel-custom.conditional-access.block-legacy');
  assert.equal(legacy.verdict, 'fail');
  assert.equal(legacy.reason, 'not-configured');
  assert.equal(result.notConfigured, 1);
  const { findings, summary } = await complianceFindings(client, { tenantRef, now });
  assert.equal(findings.find((finding) => finding.controlId === legacy.control_id).reason, 'not-configured');
  assert.equal(summary.notConfigured, 1);
  assert.equal(summary.exposed, 1);
});
