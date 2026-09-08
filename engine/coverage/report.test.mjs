import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { connect, getResourceVersions } from '../store/db.mjs';
import { buildCoverageReport } from './report.mjs';
import { collectSnapshot } from '../collect/snapshot.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';

const url = process.env.KEEL_DB_TEST_URL;
if (!url) throw new Error('KEEL_DB_TEST_URL not set — source /etc/keel/db.env first');
const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(
  'DROP TABLE IF EXISTS evidence, disposition, drift, baseline_resource, baseline, resource_reference, rollback_entry, resource_version, plan, snapshot CASCADE',
);
await admin.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
await admin.end();

const client = await connect(url);
const tenantRef = 'sha256:coverage-test';
const now = new Date('2026-09-08T12:00:00.000Z');
const reader = {
  async collect(version, path) {
    if (path.startsWith('/groups?')) return { items: Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, mailNickname: `group-${i}` })) };
    if (path.startsWith('/users?')) return { items: [{ id: 'u1', userPrincipalName: 'user@example.test' }] };
    if (path === '/roleManagement/directory/roleAssignments') return { items: [], error: { status: 403, error: 'denied' } };
    return { items: [], error: null };
  },
};

try {
  // Exercise the actual collector -> persistence -> report path. Most types
  // are completed empty reads; one fails, and a distinct type is then omitted
  // from the persisted digest to model silence (e.g. an older collector).
  const { snapshotId, coverageDigest } = await collectSnapshot(client, { reader, tenantRef, tenantId: 'fixture-tenant' });
  assert.deepEqual(coverageDigest.namedLocation, { outcome: 'complete', itemCount: 0 });
  assert.equal(coverageDigest.roleAssignment.outcome, 'failed');
  assert.equal((await getResourceVersions(client, { snapshotId })).length, 6);
  delete coverageDigest.conditionalAccessPolicy;
  const saveDigest = async (digest) => client.query(
    'UPDATE snapshot SET coverage_digest = $2, completed_at = $3 WHERE id = $1',
    [snapshotId, JSON.stringify(digest), now],
  );
  await saveDigest(coverageDigest);

  const options = { tenantRef, catalog: CATALOG, descriptors: DESCRIPTORS, now };
  const report = await buildCoverageReport(client, options);
  const byType = new Map(report.types.map((t) => [t.type, t]));
  const group = byType.get('group');
  assert.equal(group.status, 'covered');
  assert.equal(group.covered, true);
  assert.equal(group.itemCount, 5);
  assert.ok(group.lastCollectedAt);
  assert.equal(group.adapter, 'graph-native/group');
  assert.equal(group.criticality, 'tier1');
  assert.equal(group.blastRadius, 'access-affecting');
  assert.equal(group.remappable, true);
  assert.deepEqual(group.fidelity, { declared: 'full', verifiedBy: null });
  assert.deepEqual(byType.get('user').fidelity, { declared: 'read-only', verifiedBy: null });

  const empty = byType.get('namedLocation');
  assert.equal(empty.status, 'covered', 'a completed empty read is coverage');
  assert.equal(empty.covered, true);
  assert.equal(empty.itemCount, 0);
  assert.equal(byType.get('roleAssignment').status, 'failed');
  assert.equal(byType.get('conditionalAccessPolicy').status, 'never-collected');
  assert.equal(byType.get('conditionalAccessPolicy').lastCollectedAt, null);
  for (const type of ['roleAssignment', 'conditionalAccessPolicy']) {
    assert.equal(byType.get(type).covered, false);
    assert.equal(byType.get(type).itemCount, null, 'unknown cardinality is not zero');
  }
  assert.equal(Object.hasOwn(coverageDigest, 'conditionalAccessPolicy'), false);
  assert.equal(report.types.length, CATALOG.length);
  assert.deepEqual(report.summary, {
    covered: DESCRIPTORS.length - 2, failed: 1,
    notCovered: CATALOG.length - DESCRIPTORS.length, neverCollected: 1,
    stale: 0,
  });
  assert.equal(report.tenantRef, tenantRef);
  assert.equal(report.generatedAt, now.toISOString());

  // The outcome, not mere presence/count, must drive the decision. Run the
  // same report after changing ONLY that field, then after removing the key.
  for (const entry of [{ itemCount: 0 }, { outcome: 'failed', itemCount: 0 }, { outcome: 'failed', itemCount: 5 }, { itemCount: 5 }, undefined]) {
    const changed = structuredClone(coverageDigest);
    if (entry === undefined) delete changed.namedLocation;
    else changed.namedLocation = entry;
    await saveDigest(changed);
    const result = (await buildCoverageReport(client, options)).types.find((t) => t.type === 'namedLocation');
    assert.equal(result.status, entry === undefined ? 'never-collected' : 'failed');
    assert.equal(result.covered, false);
  }
  // A claimed completion with missing/invalid cardinality also fails closed.
  for (const itemCount of [null, -1, '0', 0.5]) {
    await saveDigest({ namedLocation: { outcome: 'complete', itemCount } });
    assert.equal((await buildCoverageReport(client, options)).summary.covered, 0);
  }
  await saveDigest({ group: 5, namedLocation: 0 });
  const legacy = await buildCoverageReport(client, options);
  assert.equal(legacy.types.find((t) => t.type === 'group').status, 'covered');
  assert.equal(legacy.types.find((t) => t.type === 'namedLocation').status, 'failed', 'legacy zero lacks an outcome');
  assert.equal(legacy.types.find((t) => t.type === 'user').status, 'never-collected');

  // Explicit unsupported fixture continues to exercise the portal contract
  // even when every real catalogue type has a registered adapter.
  const unsupported = await buildCoverageReport(client, {
    ...options, catalog: [...CATALOG, { type: 'unsupportedFixture' }],
  });
  const missingAdapter = unsupported.types.find((t) => t.type === 'unsupportedFixture');
  assert.equal(missingAdapter.status, 'not-covered');
  assert.equal(missingAdapter.covered, false);
  assert.equal(missingAdapter.adapter, null);
  assert.equal(missingAdapter.stale, false);

  const noSnapshot = await buildCoverageReport(client, { ...options, tenantRef: 'sha256:no-snapshots' });
  assert.equal(noSnapshot.snapshot, null);
  assert.equal(noSnapshot.summary.covered, 0);
  for (const t of noSnapshot.types) {
    if (DESCRIPTORS.some((d) => d.type === t.type)) assert.equal(t.status, 'never-collected');
    assert.equal(t.covered, false);
    assert.equal(t.stale, false);
  }

  // Tier filtering must keep successful empty outcomes for the selected tier,
  // and must not claim coverage for excluded resources.
  const tierRun = await collectSnapshot(client, { reader, tenantRef: 'sha256:tier-only', tenantId: 'fixture-tenant', tier: 'tier1' });
  assert.deepEqual(tierRun.coverageDigest.namedLocation, { outcome: 'complete', itemCount: 0 });
  assert.equal(Object.hasOwn(tierRun.coverageDigest, 'user'), false);
  const stored = await getResourceVersions(client, { snapshotId: tierRun.snapshotId });
  assert.equal(stored.length, 5);
  assert.ok(stored.every((r) => r.criticality === 'tier1'));

  // Different tiers must resolve independently, ordered by completion rather
  // than start/insertion time. No resources are needed to prove an empty read.
  const historyTenant = 'sha256:coverage-history';
  const olderAt = new Date('2026-09-08T10:00:00.000Z');
  const newerAt = new Date('2026-09-08T11:00:00.000Z');
  const insertSnapshot = async ({ digest, at, status = 'complete', tenant = historyTenant, startedAt = at }) => {
    const { rows } = await client.query(
      `INSERT INTO snapshot (tenant_ref, started_at, completed_at, status, coverage_digest)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenant, startedAt, at, status, digest],
    );
    return rows[0].id;
  };
  const newestId = await insertSnapshot({ at: newerAt, startedAt: '2026-09-08T08:00:00Z', digest: {
    group: { outcome: 'complete', itemCount: 2 },
    roleAssignment: { outcome: 'failed', itemCount: null },
    namedLocation: { outcome: 'complete', itemCount: 0 },
    organization: null,
  } });
  await insertSnapshot({ at: olderAt, digest: {
    user: { outcome: 'complete', itemCount: 7 },
    group: { outcome: 'complete', itemCount: 9 },
    roleAssignment: { outcome: 'complete', itemCount: 4 },
    namedLocation: { outcome: 'complete', itemCount: 3 },
    organization: { outcome: 'complete', itemCount: 1 },
  } });
  // Neither another tenant nor unfinished/failed runs may override evidence.
  for (const overrides of [{ tenant: 'sha256:other-tenant' }, { status: 'running' }, { status: 'failed' }, { at: null }]) {
    await insertSnapshot({ at: now, startedAt: now, ...overrides, digest: {
      user: { outcome: 'complete', itemCount: 99 },
      contact: { outcome: 'complete', itemCount: 88 },
    } });
  }
  let snapshotQueries = 0;
  const countedClient = { query: (...args) => {
    if (/\bFROM snapshot\b/.test(args[0])) snapshotQueries++;
    return client.query(...args);
  } };
  const history = await buildCoverageReport(countedClient, { ...options, tenantRef: historyTenant });
  assert.equal(snapshotQueries, 1, 'all 52 types must resolve in one snapshot query');
  assert.equal(history.snapshot.id, newestId);
  assert.deepEqual(history.snapshot.completedAt, newerAt);
  const historyByType = new Map(history.types.map((t) => [t.type, t]));
  for (const [type, status, itemCount, at] of [
    ['user', 'covered', 7, olderAt],
    ['group', 'covered', 2, newerAt],
    ['roleAssignment', 'failed', null, newerAt],
    ['namedLocation', 'covered', 0, newerAt],
    ['organization', 'failed', null, newerAt],
    ['contact', 'never-collected', null, null],
  ]) {
    const entry = historyByType.get(type);
    assert.equal(entry.status, status, `${type}: newest mention decides the outcome`);
    assert.equal(entry.itemCount, itemCount, `${type}: count comes from that mention`);
    assert.deepEqual(entry.lastCollectedAt, at, `${type}: timestamp comes from that mention`);
  }
  assert.equal(historyByType.get('user').criticality, 'tier2');

  // Pin literal boundary instants independently of the production constants.
  // A newer unrelated tier must not refresh this type's collection clock.
  for (const [type, tier, collectedAt] of [
    ['group', 'tier1', '2026-09-08T09:00:00.000Z'],
    ['user', 'tier2', '2026-09-05T12:00:00.000Z'],
    ['contact', 'tier3', '2026-08-18T12:00:00.000Z'],
  ]) {
    const tenant = `sha256:staleness-${tier}`;
    const descriptor = DESCRIPTORS.find((d) => d.type === type);
    assert.equal(descriptor.criticality, tier);
    const id = await insertSnapshot({ tenant, at: collectedAt, digest: {
      [type]: { outcome: 'complete', itemCount: 6 },
    } });
    await insertSnapshot({ tenant, at: '2026-09-08T11:45:00.000Z', digest: {
      [type === 'group' ? 'user' : 'group']: { outcome: 'complete', itemCount: 55 },
    } });
    const staleOptions = { tenantRef: tenant, descriptors: [descriptor], catalog: [] };
    for (const [offset, expected] of [[-1, false], [0, false], [1, true]]) {
      const result = await buildCoverageReport(client, { ...staleOptions, now: new Date(now.getTime() + offset) });
      const entry = result.types[0];
      assert.equal(entry.stale, expected, `${tier}: stale at threshold ${offset >= 0 ? '+' : ''}${offset}ms`);
      assert.equal(entry.status, 'covered', 'staleness must not introduce a new status');
      assert.equal(entry.covered, true);
      assert.equal(entry.itemCount, 6);
      assert.deepEqual(entry.lastCollectedAt, new Date(collectedAt));
      assert.deepEqual(result.summary, { covered: 1, failed: 0, notCovered: 0, neverCollected: 0, stale: Number(expected) });
    }
    // Failed observations age too; stale is not a substitute for failure.
    await client.query('UPDATE snapshot SET coverage_digest = $2 WHERE id = $1', [id, {
      [type]: { outcome: 'failed', itemCount: null },
    }]);
    const failed = await buildCoverageReport(client, { ...staleOptions, now: new Date(now.getTime() + 1) });
    assert.equal(failed.types[0].status, 'failed');
    assert.equal(failed.types[0].stale, true);
    assert.deepEqual(failed.summary, { covered: 0, failed: 1, notCovered: 0, neverCollected: 0, stale: 1 });
  }
} finally {
  await client.end();
}
console.log('report.test.mjs — all assertions passed');
