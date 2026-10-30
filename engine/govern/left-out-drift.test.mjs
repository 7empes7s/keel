/** A kind a baseline left out because Microsoft kept failing on it (#666) is never
 * drift: when Microsoft answers again, its items are not "added". An added drift
 * would plan their deletion (rollbackPlan turns added into delete).
 *
 * Every time here is fixed (NOW, and backups placed relative to it).
 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

import { canonicalHash } from '../cir/canonicalHash.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { insertResourceVersion } from '../store/db.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { seedFromSnapshot } from './baseline.mjs';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const NOW = new Date('2026-10-29T08:00:00Z');
const TENANT = 'sha256:00000000a5c5b666';
const database = await createIsolatedTestDatabase(import.meta.url);
after(() => database.cleanup());

const POLICY = { displayName: 'Block legacy auth', state: 'enabled' };
const TODO = { isExternalJoinEnabled: false, isExternalShareEnabled: false, isPushNotificationEnabled: true };
const GROUP = { displayName: 'KEEL-RT-666', mailNickname: 'keel-rt-666', securityEnabled: true, mailEnabled: false, groupTypes: [] };

test('a left-out kind read again is not drift; a new object of a captured kind still is', async () => {
  const client = await database.connect();
  try {
    await client.query(schemaSql());
    const snapshot = async (completedAt, outcomes = {}) => (await client.query(
      `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
       VALUES ($1, 'complete', $2, $2, $3) RETURNING id`,
      [TENANT, completedAt, Object.fromEntries(DESCRIPTORS.map(({ type }) => [type, { itemCount: 1, ...(outcomes[type] ?? { outcome: 'complete' }) }]))],
    )).rows[0].id;
    const add = (snapshotId, naturalKey, resourceType, payload) => insertResourceVersion(client, {
      snapshotId,
      resource: { naturalKey, resourceType, payload, payloadHash: canonicalHash(payload, resourceType), criticality: 'tier3', blastRadius: 'low', fidelity: 'full', provenance: {} },
    });

    // Captured while To Do settings answered 500: left out of the baseline.
    const captured = await snapshot(new Date(NOW.getTime() - 2 * 86_400_000), { todoSettings: { outcome: 'failed', httpStatus: 500, itemCount: null } });
    await add(captured, 'conditionalAccessPolicy:Block legacy auth', 'conditionalAccessPolicy', POLICY);
    await seedFromSnapshot(client, { tenantRef: TENANT, snapshotId: captured, setBy: 'fixture', label: 'Golden' });

    // Microsoft answers again, and someone added a group.
    const observed = await snapshot(new Date(NOW.getTime() - 3_600_000));
    await add(observed, 'conditionalAccessPolicy:Block legacy auth', 'conditionalAccessPolicy', POLICY);
    await add(observed, 'todoSettings:todoSettings', 'todoSettings', TODO);
    await add(observed, 'group:keel-rt-666', 'group', GROUP);

    await exec(process.execPath, ['cli/keel-drift.mjs', 'detect', '--snapshot-id', observed,
      '--tenant-ref', TENANT, '--db-url', database.url], { cwd: repoRoot });
    const { rows } = await client.query('SELECT natural_key, change_type FROM drift WHERE observed_snapshot = $1 ORDER BY natural_key', [observed]);
    assert.deepEqual(rows.map((row) => [row.natural_key, row.change_type]), [['group:keel-rt-666', 'added']]);
  } finally {
    client.release?.() ?? await client.end?.();
  }
});
