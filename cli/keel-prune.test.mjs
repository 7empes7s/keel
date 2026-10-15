import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createSnapshot, insertResourceVersion } from '../engine/store/db.mjs';
import { createBaseline, seedBaselineFromSnapshot } from '../engine/store/governance.mjs';
import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { schemaSql } from '../engine/store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
const url = database.url;

// The CLI derives tenantRef from the tenant config, so give it a config we
// control and derive the same tenantRef here for seeding.
const tenantId = `keel-prune-test-${process.pid}`;
const configDir = mkdtempSync(join(tmpdir(), 'keel-prune-test-'));
const configPath = join(configDir, 'tenant.json');
writeFileSync(configPath, JSON.stringify({ tenantId }));
const tenantRef = `sha256:${createHash('sha256').update(tenantId).digest('hex').slice(0, 16)}`;

const cliPath = new URL('./keel-prune.mjs', import.meta.url).pathname;
function runCli(...extraArgs) {
  return execFileSync('node', [cliPath, '--config', configPath, '--db-url', url, ...extraArgs], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

let client;
try {
  const admin = await database.connect();
  try {
    await admin.query(schemaSql());
  } finally {
    await admin.end();
  }

  client = await connect(url);

const DAY_MS = 24 * 60 * 60 * 1000;
// The default policy keeps the newest snapshot of each day, week, month and year, so
// an earlier snapshot of the same old day is the one that goes.
const oldDay = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
const oldEnough = new Date(`${oldDay}T12:00:00Z`);
const earlierThatDay = new Date(`${oldDay}T10:00:00Z`);

async function seedSnapshot(suffix, startedAt) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: `group:keel-prune-test-${suffix}`,
      resourceType: 'group',
      payload: { displayName: `Prune test ${suffix}` },
      payloadHash: `keel-prune-test-hash-${suffix}`,
      criticality: 'tier1',
      blastRadius: 'access-affecting',
      fidelity: 'full',
      provenance: { adapter: 'test' },
    },
  });
  await client.query(
    'UPDATE snapshot SET started_at = $2, completed_at = $2 WHERE id = $1',
    [snapshotId, startedAt],
  );
  return snapshotId;
}

const snapshotCount = async () =>
  (await client.query('SELECT count(*)::int AS n FROM snapshot')).rows[0].n;
const snapshotExists = async (id) =>
  (await client.query('SELECT 1 FROM snapshot WHERE id = $1', [id])).rows.length === 1;

// Not the newest of its day, week, month or year, referenced by nothing → prunable.
const prunableSnapshotId = await seedSnapshot('prunable', earlierThatDay);
// The newest of that day, and pinned by the ACTIVE BASELINE → must survive.
const baselineSnapshotId = await seedSnapshot('baseline', oldEnough);
const baselineId = await createBaseline(client, { tenantRef, setBy: 'test-operator' });
await seedBaselineFromSnapshot(client, { baselineId, snapshotId: baselineSnapshotId });
// Also that day, and held by an active incident retention pin → must
// survive, and the dry run must not list it either.
const pinnedSnapshotId = await seedSnapshot('pinned', oldEnough);
const { rows: incidentRows } = await client.query(
  `INSERT INTO incident (tenant_ref, title, owner) VALUES ($1, 'prune test', 'test-operator') RETURNING id`,
  [tenantRef],
);
await client.query(
  `INSERT INTO retention_pin (tenant_ref, incident_id, snapshot_id, reason, pinned_by)
   VALUES ($1, $2, $3, 'held', 'test-operator')`,
  [tenantRef, incidentRows[0].id, pinnedSnapshotId],
);
// Today's snapshot → must survive.
const recentSnapshotId = await seedSnapshot('recent', new Date());

// A run without --apply (the schedule's run) and --dry-run both report the
// prunable set, save a report, and delete nothing.
const countBeforeDryRun = await snapshotCount();
for (const dryRunOut of [runCli(), runCli('--dry-run')]) {
  assert.match(dryRunOut, /would prune 1 snapshot\(s\)/);
  assert.match(dryRunOut, /would prune 0 content version\(s\)/);
  assert.match(dryRunOut, /policies: default: 14 daily, 8 weekly, 12 monthly, 7 yearly/);
  assert.ok(dryRunOut.includes(prunableSnapshotId));
  assert.ok(!dryRunOut.includes(pinnedSnapshotId));
}
assert.equal(await snapshotCount(), countBeforeDryRun);
assert.ok(await snapshotExists(prunableSnapshotId));
const { rows: reports } = await client.query(
  'SELECT mode, snapshots_deleted FROM retention_prune_report WHERE tenant_ref = $1 ORDER BY created_at',
  [tenantRef],
);
assert.deepEqual(reports, [{ mode: 'dry-run', snapshots_deleted: 1 }, { mode: 'dry-run', snapshots_deleted: 1 }]);
assert.throws(() => runCli('--apply', '--dry-run'), /cannot be used together/);

// --report writes the same report to a file.
const reportPath = join(configDir, 'report.json');
runCli('--report', reportPath);
const written = JSON.parse(readFileSync(reportPath, 'utf8'));
assert.deepEqual(written.snapshots.delete, [prunableSnapshotId]);
assert.equal(written.mode, 'dry-run');

// --apply prunes exactly the snapshot the dry run listed.
const out = runCli('--apply');
assert.match(out, /pruned 1 snapshot\(s\)/);
assert.ok(out.includes(prunableSnapshotId));
assert.equal(await snapshotExists(prunableSnapshotId), false);
assert.equal(await snapshotExists(baselineSnapshotId), true);
assert.equal(await snapshotExists(recentSnapshotId), true);
assert.equal(await snapshotExists(pinnedSnapshotId), true);

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('keel-prune.test.mjs — all assertions passed');
