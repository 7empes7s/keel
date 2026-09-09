import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createSnapshot, insertResourceVersion } from '../engine/store/db.mjs';
import { createBaseline, seedBaselineFromSnapshot } from '../engine/store/governance.mjs';
import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';

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
    encoding: 'utf8',
  });
}

let client;
try {
  const admin = await database.connect();
  try {
    await admin.query(readFileSync(new URL('../engine/store/schema.sql', import.meta.url), 'utf8'));
  } finally {
    await admin.end();
  }

  client = await connect(url);

const DAY_MS = 24 * 60 * 60 * 1000;
const oldEnough = new Date(Date.now() - 30 * DAY_MS); // beyond the tier1 7-day window

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

// Older than its tier's retention window, referenced by nothing → prunable.
const prunableSnapshotId = await seedSnapshot('prunable', oldEnough);
// Older than the window, but pinned by the ACTIVE BASELINE → must survive.
const baselineSnapshotId = await seedSnapshot('baseline', oldEnough);
const baselineId = await createBaseline(client, { tenantRef, setBy: 'test-operator' });
await seedBaselineFromSnapshot(client, { baselineId, snapshotId: baselineSnapshotId });
// Inside its retention window → must survive.
const recentSnapshotId = await seedSnapshot('recent', new Date());

// --dry-run reports the prunable set but deletes nothing.
const countBeforeDryRun = await snapshotCount();
const dryRunOut = runCli('--dry-run');
assert.match(dryRunOut, /would prune 1 snapshot\(s\)/);
assert.ok(dryRunOut.includes(prunableSnapshotId));
assert.equal(await snapshotCount(), countBeforeDryRun);
assert.ok(await snapshotExists(prunableSnapshotId));

// Real run prunes exactly the unreferenced expired snapshot.
const out = runCli();
assert.match(out, /pruned 1 snapshot\(s\)/);
assert.ok(out.includes(prunableSnapshotId));
assert.equal(await snapshotExists(prunableSnapshotId), false);
assert.equal(await snapshotExists(baselineSnapshotId), true);
assert.equal(await snapshotExists(recentSnapshotId), true);

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('keel-prune.test.mjs — all assertions passed');
