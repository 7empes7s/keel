// Backlog B12 and D16 (UI audit, 31 Oct 2026): the Approved setup page read a put-back
// version as "older" than the one it replaced, and said "Capture new version" was off
// with no reason. The engine now names the version a put-back copies, and says why the
// newest backup cannot be a baseline source, kind by kind.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { baselineSourceGap, newestBackupGap, reinstateBaseline, resnapshotBaseline, seedFromSnapshot } from './baseline.mjs';
import { baselineCompliance } from './baselineCompliance.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { completeSnapshot, createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const [first, second, third, fourth] = DESCRIPTORS.map(({ type }) => type);
const tier3 = DESCRIPTORS.find(({ criticality }) => criticality === 'tier3').type;

test('a source gap lists the kinds a backup missed, by why', () => {
  assert.deepEqual(baselineSourceGap({ coverage_digest: fullSuccessfulCoverageDigest() }), { notInBackup: [], partial: [], failed: [] });
  const digest = fullSuccessfulCoverageDigest();
  delete digest[first];
  digest[second] = { outcome: 'not-requested' };
  digest[third] = { outcome: 'partial' };
  digest[fourth] = { outcome: 'failed', httpStatus: 403 };
  // A minor kind Microsoft kept failing on is left out of the baseline, not a gap (#666).
  digest[tier3] = { outcome: 'failed', httpStatus: 502 };
  const gap = baselineSourceGap({ coverage_digest: digest });
  assert.deepEqual(gap.notInBackup, [first, second].sort());
  assert.deepEqual(gap.partial, [third]);
  assert.deepEqual(gap.failed, [fourth]);
});

test('newest backup gap and put-back versions, against the database', async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  try {
    await client.query(schemaSql());
    const tenantRef = 'sha256:baseline-versions-test';
    let minute = 0;
    const snapshot = async (digest, types = ['group']) => {
      const id = await createSnapshot(client, { tenantRef });
      await completeSnapshot(client, { id, status: 'complete', coverageDigest: digest });
      // Set relative to the run, one minute apart, so "newest" never depends on the clock.
      minute += 1;
      await client.query("UPDATE snapshot SET completed_at = now() - interval '1 day' + ($2 || ' minutes')::interval WHERE id = $1", [id, String(minute)]);
      for (const type of types) {
        await insertResourceVersion(client, {
          snapshotId: id,
          resource: { naturalKey: `${type}:one`, resourceType: type, payload: { v: minute }, payloadHash: `${type}:${minute}`,
            criticality: 'tier1', blastRadius: 'cosmetic', fidelity: 'full', provenance: { adapter: 'test' } },
        });
      }
      return id;
    };

    assert.equal(await newestBackupGap(client, { tenantRef }), null, 'no backup has finished');
    const s1 = await snapshot(fullSuccessfulCoverageDigest());
    const v1 = await seedFromSnapshot(client, { tenantRef, snapshotId: s1, setBy: 'tester', label: 'Golden' });
    const s2 = await snapshot(fullSuccessfulCoverageDigest(), ['group', 'user']);
    const v2 = await resnapshotBaseline(client, { tenantRef, baselineId: v1, snapshotId: s2, setBy: 'tester' });
    assert.equal(await newestBackupGap(client, { tenantRef }), null, 'the newest backup is complete');
    const v3 = await reinstateBaseline(client, { tenantRef, baselineId: v1, actor: 'tester', reason: 'test' });

    const byVersion = new Map((await baselineCompliance(client, { tenantRef })).map((entry) => [entry.version, entry]));
    assert.deepEqual(byVersion.get(3).reinstatedFrom, { id: v1, version: 1 }, 'v3 is a copy of v1');
    assert.equal(byVersion.get(3).id, v3.id);
    assert.equal(byVersion.get(2).reinstatedFrom, null, 'a re-snapshot is not a put-back');
    assert.equal(byVersion.get(1).reinstatedFrom, null);
    assert.equal(byVersion.get(2).id, v2.id);
    // Its settings are v1's, so its capture is older than v2's though it was approved later.
    assert.ok(Date.parse(byVersion.get(3).capture.capturedAt) < Date.parse(byVersion.get(2).capture.capturedAt));

    // Capturing a new version right after a put-back can take the same backup v2 came
    // from: that is a new capture, not a copy of v2.
    const v4 = await resnapshotBaseline(client, { tenantRef, baselineId: v3.id, snapshotId: s2, setBy: 'tester' });
    // Putting back a version that was itself put back names the version picked.
    const v5 = await reinstateBaseline(client, { tenantRef, baselineId: v3.id, actor: 'tester', reason: 'test' });
    const after = new Map((await baselineCompliance(client, { tenantRef })).map((entry) => [entry.version, entry]));
    assert.equal(after.get(4).id, v4.id);
    assert.equal(after.get(4).reinstatedFrom, null, 'a capture from the same backup as v2 is not a put-back');
    assert.deepEqual(after.get(5).reinstatedFrom, { id: v3.id, version: 3 });
    assert.equal(after.get(5).id, v5.id);

    // Versions put back before the column existed take it from their audit record.
    await client.query('UPDATE baseline SET reinstated_from_id = NULL WHERE tenant_ref = $1', [tenantRef]);
    await client.query(schemaSql());
    const backfilled = new Map((await baselineCompliance(client, { tenantRef })).map((entry) => [entry.version, entry.reinstatedFrom]));
    assert.deepEqual([backfilled.get(3), backfilled.get(4), backfilled.get(5)], [{ id: v1, version: 1 }, null, { id: v3.id, version: 3 }]);

    // A newer backup that missed kinds: the page can say what, and still compares with
    // the newest complete one.
    const digest = fullSuccessfulCoverageDigest();
    digest[third] = { outcome: 'partial' };
    digest[fourth] = { outcome: 'not-requested' };
    const s3 = await snapshot(digest);
    const gap = await newestBackupGap(client, { tenantRef });
    assert.equal(gap.id, s3);
    assert.deepEqual([gap.partial, gap.notInBackup, gap.failed], [[third], [fourth], []]);
    assert.match(gap.completedAt, /^\d{4}-\d\d-\d\dT/);
    const compared = (await baselineCompliance(client, { tenantRef })).find((entry) => entry.version === 2);
    assert.equal(compared.changesSinceCapture.state, 'compared');
    assert.equal(compared.changesSinceCapture.comparedSnapshotId, s2);
  } finally {
    await client.end();
    await database.cleanup();
  }
});

test('changes since capture find the newest complete backup behind more than 50 tier backups', async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  try {
    await client.query(schemaSql());
    const tenantRef = 'sha256:baseline-versions-deep-test';
    const full = await createSnapshot(client, { tenantRef });
    await completeSnapshot(client, { id: full, status: 'complete', coverageDigest: fullSuccessfulCoverageDigest() });
    await client.query("UPDATE snapshot SET completed_at = now() - interval '2 days' WHERE id = $1", [full]);
    await seedFromSnapshot(client, { tenantRef, snapshotId: full, setBy: 'tester' });
    const tierDigest = { [first]: { outcome: 'complete', itemCount: 0 } };
    for (let index = 0; index < 55; index += 1) {
      const id = await createSnapshot(client, { tenantRef });
      await completeSnapshot(client, { id, status: 'complete', coverageDigest: tierDigest });
      await client.query("UPDATE snapshot SET completed_at = now() - interval '1 day' + ($2 || ' minutes')::interval WHERE id = $1", [id, String(index)]);
    }
    const [entry] = await baselineCompliance(client, { tenantRef });
    assert.equal(entry.changesSinceCapture.state, 'compared');
    assert.equal(entry.changesSinceCapture.comparedSnapshotId, full);
    const gap = await newestBackupGap(client, { tenantRef });
    assert.equal(gap.notInBackup.length, DESCRIPTORS.length - 1);
  } finally {
    await client.end();
    await database.cleanup();
  }
});
