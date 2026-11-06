/**
 * Issue #1057 (Recheck 1, build 128b0e3b): a record delete planned on its own
 * (no administrative type in the same restore) failed "the snapshot's
 * configurationPolicy collection is not recorded", because the restore CLI read
 * the source snapshot's coverage digest only when the plan also deleted a
 * governed administrative type. The digest is read through the CLI's own
 * observedCoverageFor from an isolated test database; Graph is the in-memory
 * fixture, so no tenant is read or written.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { observedCoverageFor } from '../../cli/keel-restore.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { applyWave } from './applyEngine.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const OPTIONS = {
  targetTenant: 'fixture-tenant',
  mode: 'enforce',
  deletionGuardOptions: { breakGlassUserIds: ['break-glass-1'], keelAppIds: [], caPolicies: [] },
  readAfterWriteOptions: { attempts: 1, delayMs: 0 },
};
const PATH = '/deviceManagement/configurationPolicies/policy-1';
const POLICY = { id: 'policy-1', name: 'KEEL-RT-Old settings', platforms: 'windows10', technologies: 'mdm', settings: [] };

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

test('a configuration policy delete on its own is authorised by the source snapshot\'s coverage digest', async (t) => {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(schemaSql());
  const { rows } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, coverage_digest, completed_at) VALUES ($1, 'complete', $2, now()) RETURNING id`,
    ['tenant-a', { configurationPolicy: { outcome: 'complete', itemCount: 3 } }],
  );
  const graph = idoFakeGraph({ seed: { [PATH]: POLICY } });
  const resources = [{
    naturalKey: 'configurationPolicy:KEEL-RT-Old settings', resourceType: 'configurationPolicy', verb: 'delete', references: [],
    blastRadius: 'access-affecting', payload: POLICY, live: { state: 'present', targetId: 'policy-1', payload: POLICY },
  }];

  const observedCoverage = await observedCoverageFor(client, { resources, snapshotId: rows[0].id, tenantRef: 'tenant-a' });
  assert.equal(observedCoverage?.configurationPolicy?.outcome, 'complete');
  const result = await applyWave(graph, governor, resources, { ...OPTIONS, observedCoverage });
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 1);
  assert.equal(graph.objects.has(PATH), false);

  // A plan with no delete needs no evidence, so nothing is read.
  const untouched = { query: async () => { throw new Error('no query expected'); } };
  assert.equal(await observedCoverageFor(untouched, { resources: [{ ...resources[0], verb: 'update' }], snapshotId: rows[0].id, tenantRef: 'tenant-a' }), null);
});
