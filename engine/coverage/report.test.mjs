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
    'UPDATE snapshot SET coverage_digest = $2 WHERE id = $1', [snapshotId, JSON.stringify(digest)],
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
  for (const type of ['roleAssignment', 'conditionalAccessPolicy']) {
    assert.equal(byType.get(type).status, 'failed', `${type}: error and silence both fail`);
    assert.equal(byType.get(type).covered, false);
    assert.equal(byType.get(type).itemCount, null, 'unknown cardinality is not zero');
  }
  assert.equal(Object.hasOwn(coverageDigest, 'conditionalAccessPolicy'), false);
  assert.equal(report.types.length, CATALOG.length);
  assert.deepEqual(report.summary, {
    covered: DESCRIPTORS.length - 2, failed: 2,
    notCovered: CATALOG.length - DESCRIPTORS.length, neverCollected: 0,
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
    assert.equal(result.status, 'failed');
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
  assert.equal(legacy.types.find((t) => t.type === 'user').status, 'failed');

  // Explicit unsupported fixture continues to exercise the portal contract
  // even when every real catalogue type has a registered adapter.
  const unsupported = await buildCoverageReport(client, {
    ...options, catalog: [...CATALOG, { type: 'unsupportedFixture' }],
  });
  const missingAdapter = unsupported.types.find((t) => t.type === 'unsupportedFixture');
  assert.equal(missingAdapter.status, 'not-covered');
  assert.equal(missingAdapter.covered, false);
  assert.equal(missingAdapter.adapter, null);

  const noSnapshot = await buildCoverageReport(client, { ...options, tenantRef: 'sha256:no-snapshots' });
  assert.equal(noSnapshot.snapshot, null);
  assert.equal(noSnapshot.summary.covered, 0);
  for (const t of noSnapshot.types) {
    if (DESCRIPTORS.some((d) => d.type === t.type)) assert.equal(t.status, 'never-collected');
    assert.equal(t.covered, false);
  }

  // Tier filtering must keep successful empty outcomes for the selected tier,
  // and must not claim coverage for excluded resources.
  const tierRun = await collectSnapshot(client, { reader, tenantRef: 'sha256:tier-only', tenantId: 'fixture-tenant', tier: 'tier1' });
  assert.deepEqual(tierRun.coverageDigest.namedLocation, { outcome: 'complete', itemCount: 0 });
  assert.equal(Object.hasOwn(tierRun.coverageDigest, 'user'), false);
  const stored = await getResourceVersions(client, { snapshotId: tierRun.snapshotId });
  assert.equal(stored.length, 5);
  assert.ok(stored.every((r) => r.criticality === 'tier1'));
} finally {
  await client.end();
}
console.log('report.test.mjs — all assertions passed');
