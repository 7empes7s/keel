import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { completeSnapshot, connect, createSnapshot, insertResourceVersion } from '../engine/store/db.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';
import { createIsolatedTestDatabase } from '../engine/test/dbTestHelper.mjs';
import { main, runPlan } from './keel-plan.mjs';

const noopLogger = { log() {}, error() {} };

function fakeGraphDependencies() {
  return {
    getToken: async () => ({ accessToken: 'fake-target-token' }),
    GraphReader: class FakeGraphReader {
      constructor(token) {
        this.token = token;
      }
    },
    collectM1: async () => [],
  };
}

// The collector and planner use the one shared derivation, so a fixture tenant has
// precisely one byte-identical reference in both paths.
const tenantId = `keel-plan-test-${process.pid}`;
const tenantRef = tenantRefFor(tenantId);
const collectorTenantRef = `sha256:${createHash('sha256').update(tenantId).digest('hex').slice(0, 16)}`;
assert.equal(tenantRef, collectorTenantRef);
assert.match(tenantRef, /^sha256:[0-9a-f]{16}$/);

// The real planner path finds the snapshot the collector derivation seeded in the
// local test database. Its target reader and token are entirely fake.
{
  const database = await createIsolatedTestDatabase(import.meta.url);
  let client;
  try {
    const admin = await database.connect();
    try {
      await admin.query(readFileSync(new URL('../engine/store/schema.sql', import.meta.url), 'utf8'));
    } finally {
      await admin.end();
    }

    client = await connect(database.url);
    const rawTenantId = `${tenantId}-raw-only`;
    const rawSnapshotId = await createSnapshot(client, { tenantRef: `sha256:${rawTenantId}` });
    await completeSnapshot(client, { id: rawSnapshotId, status: 'complete' });

    const untruncatedSnapshotId = await createSnapshot(client, {
      tenantRef: `sha256:${createHash('sha256').update(tenantId).digest('hex')}`,
    });
    await completeSnapshot(client, { id: untruncatedSnapshotId, status: 'complete' });

    const snapshotId = await createSnapshot(client, { tenantRef });
    await insertResourceVersion(client, {
      snapshotId,
      resource: {
        naturalKey: 'group:Fixture', resourceType: 'group', payload: { displayName: 'Fixture' },
        payloadHash: 'fixture-hash', criticality: 'tier1', blastRadius: 'access-affecting',
        fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
    await completeSnapshot(client, { id: snapshotId, status: 'complete' });

    const configs = new Map([
      ['/fixtures/source.json', JSON.stringify({ tenantId })],
      ['/fixtures/target.json', JSON.stringify({ tenantId: 'target-tenant' })],
    ]);
    const result = await main({
      argv: [
        'node', 'keel-plan.mjs', '--source-config', '/fixtures/source.json',
        '--target-config', '/fixtures/target.json', '--db-url', database.url,
      ],
      readFile: (path) => configs.get(path),
      dependencies: fakeGraphDependencies(),
      logger: noopLogger,
    });
    assert.equal(
      result.snapshot.tenant_ref,
      collectorTenantRef,
      'collector and planner tenant references are byte-identical',
    );
    assert.equal(result.snapshot.id, snapshotId, 'the planner selects the shared tenant reference');
    const { rows: plans } = await client.query('SELECT source_snapshot FROM plan');
    assert.equal(plans.length, 1);
    assert.equal(plans[0].source_snapshot, snapshotId);

    const rawOnlyConfigs = new Map([
      ['/fixtures/source.json', JSON.stringify({ tenantId: rawTenantId })],
      ['/fixtures/target.json', JSON.stringify({ tenantId: 'target-tenant' })],
    ]);
    let tokenCalls = 0;
    await assert.rejects(
      () => main({
        argv: [
          'node', 'keel-plan.mjs', '--source-config', '/fixtures/source.json',
          '--target-config', '/fixtures/target.json', '--db-url', database.url,
        ],
        readFile: (path) => rawOnlyConfigs.get(path),
        dependencies: {
          ...fakeGraphDependencies(),
          getToken: async () => { tokenCalls += 1; return { accessToken: 'must-not-be-used' }; },
        },
        logger: noopLogger,
      }),
      /no snapshot found for sha256:/,
      'a sha256:<tenant-id> row is never accepted as a fallback',
    );
    assert.equal(tokenCalls, 0, 'a missing shared reference stops before token acquisition');
  } finally {
    await client?.end();
    await database.cleanup();
  }
}

// Invalid source tenant ids fail before a database call or token acquisition.
for (const tenantId of [undefined, '', 42]) {
  let connectCalls = 0;
  let tokenCalls = 0;
  await assert.rejects(
    () => runPlan({
      sourceConfig: { tenantId },
      targetConfig: { tenantId: 'target-tenant' },
      dbUrl: 'postgres://unused',
      dependencies: {
        connect: async () => { connectCalls += 1; throw new Error('must not connect'); },
        getToken: async () => { tokenCalls += 1; throw new Error('must not acquire a token'); },
      },
      logger: noopLogger,
    }),
    /tenantId must be a non-empty string/,
  );
  assert.equal(connectCalls, 0);
  assert.equal(tokenCalls, 0);
}

// The client closes for both snapshot lookup and later planning failures.
{
  let closed = false;
  await assert.rejects(
    () => runPlan({
      sourceConfig: { tenantId: 'lookup-failure-tenant' },
      targetConfig: { tenantId: 'target-tenant' },
      dbUrl: 'postgres://unused',
      dependencies: {
        connect: async () => ({ end: async () => { closed = true; } }),
        getLatestSnapshot: async () => { throw new Error('fixture snapshot lookup failure'); },
      },
      logger: noopLogger,
    }),
    /fixture snapshot lookup failure/,
  );
  assert.equal(closed, true, 'the client closes when snapshot lookup fails');
}

{
  let closed = false;
  await assert.rejects(
    () => runPlan({
      sourceConfig: { tenantId: 'planning-failure-tenant' },
      targetConfig: { tenantId: 'target-tenant' },
      dbUrl: 'postgres://unused',
      dependencies: {
        connect: async () => ({ end: async () => { closed = true; } }),
        getLatestSnapshot: async () => ({ id: 'fixture-snapshot' }),
        getResourceVersions: async () => [],
        getReferences: async () => [],
        ...fakeGraphDependencies(),
        collectM1: async () => { throw new Error('fixture later planning failure'); },
      },
      logger: noopLogger,
    }),
    /fixture later planning failure/,
  );
  assert.equal(closed, true, 'the client closes when later planning fails');
}

console.log('keel-plan.test.mjs — all assertions passed');
