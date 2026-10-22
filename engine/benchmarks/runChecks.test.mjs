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
import { runComplianceChecks } from './runChecks.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const HOUR = 3_600_000;
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
const ROLE = 'keel-custom.role-assignment.admin-count-at-most';
const LOCATION = 'keel-custom.named-location.no-untrusted-all-countries';
const GROUP = 'keel-custom.group.role-assignable-not-synced';

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
  assert.equal(result.checked, 3);
  const byControl = Object.fromEntries(result.evaluations.map((evaluation) => [evaluation.control_id, evaluation]));
  assert.equal(byControl[ROLE].verdict, 'pass', 'the newest complete role read (2 admins) is used');
  assert.equal(byControl[GROUP].verdict, 'fail', 'a failed group read falls back to the newest complete one');
  assert.equal(byControl[LOCATION].verdict, 'unknown', 'a type no backup read is never a guessed pass');
  assert.equal(byControl[LOCATION].reason, 'namedLocation:no-observation');
  assert.deepEqual([result.pass, result.fail, result.unknown], [1, 1, 1]);

  // Each result has its evidence entry, and the Compliance reader matches it to the snapshot it came from.
  const { rows: [{ count }] } = await client.query("SELECT count(*)::int AS count FROM evidence WHERE tenant_ref = $1 AND kind = 'benchmark-evaluation'", [tenantRef]);
  assert.equal(count, 3);
  const { findings } = await complianceFindings(client, { tenantRef, now });
  assert.equal(findings.length, 3);
  const role = findings.find((finding) => finding.controlId === ROLE);
  assert.deepEqual(role.evidence.map((entry) => entry.snapshotId), [newest]);
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
  assert.equal(result.unknown, 3);
  const { rows } = await client.query('SELECT DISTINCT tenant_ref FROM benchmark_evaluation WHERE tenant_ref = ANY($1)', [[mine, other]]);
  assert.deepEqual(rows.map((row) => row.tenant_ref), [mine]);
});

test('drift detection after a backup runs the checks, even with no active baseline', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const snapshotId = await snapshot(client, tenantRef, new Date(Date.now() - HOUR), { roleAssignment: 'complete' }, admins(3));
  const run = spawnSync(process.execPath, [join(ROOT, 'cli', 'keel-drift.mjs'), 'detect', '--snapshot-id', snapshotId, '--tenant-ref', tenantRef, '--db-url', database.url], { encoding: 'utf8' });
  assert.match(run.stdout, /compliance checks: 3 run \(1 pass, 0 fail, 2 could not check\)/, run.stderr);
  // With no baseline, drift itself still refuses as before.
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no active baseline/);
  const { rows } = await client.query("SELECT actor FROM evidence WHERE tenant_ref = $1 AND kind = 'benchmark-evaluation'", [tenantRef]);
  assert.deepEqual(rows.map((row) => row.actor), ['scheduler', 'scheduler', 'scheduler']);
});
