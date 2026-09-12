import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { completeSnapshot, connect, createSnapshot, insertResourceVersion } from '../engine/store/db.mjs';
import { seedFromSnapshot } from '../engine/govern/baseline.mjs';
import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../engine/test/fullSuccessfulCoverage.mjs';
import { runCli } from './keel-baseline-create.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

try {
  client = await database.connect();
  await client.query(readFileSync(new URL('../engine/store/schema.sql', import.meta.url), 'utf8'));

  const tenantRef = 'sha256:keel-baseline-create-cli-test';

  async function createFullSnapshot(tenant) {
    const snapshotId = await createSnapshot(client, { tenantRef: tenant });
    await completeSnapshot(client, {
      id: snapshotId,
      status: 'complete',
      coverageDigest: fullSuccessfulCoverageDigest(),
    });
    return snapshotId;
  }

  async function addGroup(snapshotId, naturalKey) {
    await insertResourceVersion(client, {
      snapshotId,
      resource: {
        naturalKey,
        resourceType: 'group',
        payload: { displayName: naturalKey },
        payloadHash: naturalKey,
        criticality: 'tier1',
        blastRadius: 'access-affecting',
        fidelity: 'full',
        provenance: { adapter: 'fixture' },
      },
    });
  }

  const activeSourceId = await createFullSnapshot(tenantRef);
  await addGroup(activeSourceId, 'group:active');
  const activeBaselineId = await seedFromSnapshot(client, {
    tenantRef,
    snapshotId: activeSourceId,
    setBy: 'test-operator',
    label: 'existing-active-baseline',
  });

  async function assertRefusedByCli(snapshotId, label) {
    let clientClosed = false;
    const errors = [];
    const exitCode = await runCli({
      argv: [
        'node',
        'keel-baseline-create.mjs',
        '--db-url', database.url,
        '--tenant-ref', tenantRef,
        '--snapshot-id', snapshotId,
        '--set-by', 'test-operator',
        '--label', label,
      ],
      dependencies: {
        connect: async (url) => {
          assert.equal(url, database.url, 'the CLI test must use the isolated KEEL_DB_TEST_URL schema');
          const testClient = await connect(url);
          return {
            query: (...args) => testClient.query(...args),
            end: async () => {
              clientClosed = true;
              await testClient.end();
            },
          };
        },
      },
      logger: {
        log() {},
        error(error) { errors.push(error); },
      },
    });

    assert.notEqual(exitCode, 0, `${label} must exit non-zero`);
    assert.equal(clientClosed, true, `${label} must close its test-database client`);
    assert.equal(errors.length, 1, `${label} must report its refusal`);
    const { rows } = await client.query(
      `SELECT id
       FROM baseline
       WHERE tenant_ref = $1 AND active = true`,
      [tenantRef],
    );
    assert.deepEqual(rows.map((row) => row.id), [activeBaselineId]);
  }

  const foreignSnapshotId = await createFullSnapshot('sha256:foreign-cli-baseline-source');
  await addGroup(foreignSnapshotId, 'group:foreign');
  await assertRefusedByCli(foreignSnapshotId, 'foreign-source');

  const runningSnapshotId = await createSnapshot(client, { tenantRef });
  await addGroup(runningSnapshotId, 'group:running');
  await assertRefusedByCli(runningSnapshotId, 'running-source');

  const tierFilteredSnapshotId = await createSnapshot(client, { tenantRef });
  await addGroup(tierFilteredSnapshotId, 'group:tier1');
  await completeSnapshot(client, {
    id: tierFilteredSnapshotId,
    status: 'complete',
    coverageDigest: { group: { outcome: 'complete', itemCount: 1 } },
  });
  await assertRefusedByCli(tierFilteredSnapshotId, 'tier-filtered-source');

  const failedCoverage = fullSuccessfulCoverageDigest();
  failedCoverage.user = { outcome: 'failed', itemCount: null, error: 'fixture failure' };
  const failedCoverageSnapshotId = await createSnapshot(client, { tenantRef });
  await completeSnapshot(client, {
    id: failedCoverageSnapshotId,
    status: 'complete',
    coverageDigest: failedCoverage,
  });
  await assertRefusedByCli(failedCoverageSnapshotId, 'failed-coverage-source');

  const missingCoverage = fullSuccessfulCoverageDigest();
  delete missingCoverage.user;
  const missingCoverageSnapshotId = await createSnapshot(client, { tenantRef });
  await completeSnapshot(client, {
    id: missingCoverageSnapshotId,
    status: 'complete',
    coverageDigest: missingCoverage,
  });
  await assertRefusedByCli(missingCoverageSnapshotId, 'missing-coverage-source');
} finally {
  await client?.end();
  await database.cleanup();
}

console.log('keel-baseline-create.test.mjs — all assertions passed');
