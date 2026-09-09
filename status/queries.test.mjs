import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { connect } from './db.mjs';
import {
  getResourceCounts, getBaselineInfo, getOpenDriftCounts, getLastCollection,
  getEvidenceIntegrity, getRecentDispositionCounts, collectGovernance,
} from './queries.mjs';
import { connect as connectSuperuser, createSnapshot, insertResourceVersion } from '../engine/store/db.mjs';
import { createBaseline, recordDrift, recordDisposition } from '../engine/store/governance.mjs';
import { appendEvidence } from '../engine/govern/evidence.mjs';
import {
  createIsolatedTestDatabase, quoteIdentifier,
} from '../engine/test/dbTestHelper.mjs';

const TEST_STATUS_PASSWORD = 'status-test-only-not-a-real-secret';
const tenantRef = 'sha256:status-query-test';
const database = await createIsolatedTestDatabase(import.meta.url);
const role = `keel_status_test_${database.schema.slice('keel_test_'.length)}`;
let admin;
let superuser;
let client;

try {
  admin = await database.connect();
  await admin.query(readFileSync(new URL('../engine/store/schema.sql', import.meta.url), 'utf8'));
  const roleSql = readFileSync(new URL('./setupRole.sql', import.meta.url), 'utf8')
    .replaceAll('keel_status', role)
    .replace('SCHEMA public', `SCHEMA ${quoteIdentifier(database.schema)}`);
  await admin.query(roleSql);
  await admin.query(`ALTER ROLE ${quoteIdentifier(role)} WITH PASSWORD '${TEST_STATUS_PASSWORD}'`);

  superuser = await connectSuperuser(database.url);

const snapshotId = await createSnapshot(superuser, { tenantRef });
await insertResourceVersion(superuser, {
  snapshotId,
  resource: {
    naturalKey: 'group:alpha', resourceType: 'group', payload: { displayName: 'Alpha' },
    criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'full', provenance: { adapter: 'test' },
  },
});
await insertResourceVersion(superuser, {
  snapshotId,
  resource: {
    naturalKey: 'namedLocation:corp', resourceType: 'namedLocation', payload: { displayName: 'Corp' },
    criticality: 'tier2', blastRadius: 'cosmetic', fidelity: 'full', provenance: { adapter: 'test' },
  },
});
await superuser.query(
  'UPDATE snapshot SET status = $2, completed_at = $3, coverage_digest = $4 WHERE id = $1',
  [snapshotId, 'complete', '2026-09-08T10:00:00.000Z', {
    group: { outcome: 'complete', itemCount: 1 },
    namedLocation: { outcome: 'complete', itemCount: 1 },
  }],
);

const baselineId = await createBaseline(superuser, { tenantRef, setBy: 'test' });

const openDriftId = await recordDrift(superuser, {
  tenantRef, baselineId, observedSnapshot: snapshotId, naturalKey: 'group:alpha',
  resourceType: 'group', changeType: 'modified', beforeHash: 'h1', afterHash: 'h2',
  blastRadius: 'access-affecting',
});
const acceptedDriftId = await recordDrift(superuser, {
  tenantRef, baselineId, observedSnapshot: snapshotId, naturalKey: 'namedLocation:corp',
  resourceType: 'namedLocation', changeType: 'added', beforeHash: null, afterHash: 'h3',
  blastRadius: 'cosmetic',
});
await recordDisposition(superuser, {
  driftId: acceptedDriftId, action: 'accept', actor: 'test', reason: 'expected change',
});

await appendEvidence(superuser, { tenantRef, kind: 'collection', subject: { snapshotId }, actor: 'test' });
await appendEvidence(superuser, { tenantRef, kind: 'drift-detected', subject: { driftId: openDriftId }, actor: 'test' });

  const statusUrl = database.urlForRole({ user: role, password: TEST_STATUS_PASSWORD });
  client = await connect(statusUrl);

const resourceCounts = await getResourceCounts(client, { tenantRef });
assert.deepEqual(
  [...resourceCounts.byType].sort((a, b) => a.resourceType.localeCompare(b.resourceType)),
  [
    { resourceType: 'group', count: 1, asOf: new Date('2026-09-08T10:00:00.000Z') },
    { resourceType: 'namedLocation', count: 1, asOf: new Date('2026-09-08T10:00:00.000Z') },
  ],
);
assert.deepEqual(resourceCounts.asOf, new Date('2026-09-08T10:00:00.000Z'));
assert.ok(!JSON.stringify(resourceCounts).includes('payload'), 'must never select payload');

const baseline = await getBaselineInfo(client, { tenantRef });
assert.ok(baseline.setAt);
assert.ok(!('setBy' in baseline) && !('set_by' in baseline), 'must never expose who set the baseline');

const openDrift = await getOpenDriftCounts(client, { tenantRef });
assert.deepEqual(openDrift, [{ changeType: 'modified', blastRadius: 'access-affecting', count: 1 }]);
// The accepted drift must not appear: OPEN_DRIFT_PREDICATE excludes anything with a non-ignore disposition.

const lastCollection = await getLastCollection(client, { tenantRef });
assert.equal(lastCollection.status, 'complete');

const evidence = await getEvidenceIntegrity(client, { tenantRef });
assert.deepEqual(evidence, { ok: true, chainLength: 2 });

const dispositions = await getRecentDispositionCounts(client, { tenantRef });
assert.deepEqual(dispositions, [{ action: 'accept', count: 1 }]);

const combined = await collectGovernance(client, { tenantRef });
assert.deepEqual(
  Object.keys(combined).sort(),
  ['baseline', 'evidence', 'lastCollection', 'openDrift', 'recentDispositions', 'resourceCounts'].sort(),
);

const fullBlob = JSON.stringify(combined);
for (const forbidden of ['group:alpha', 'namedLocation:corp', 'Alpha', 'Corp', 'expected change', 'test']) {
  assert.ok(!fullBlob.includes(forbidden), `aggregate-only guarantee violated: "${forbidden}" leaked into collectGovernance output`);
}

// Persist different counts in successive snapshots, with failures and empty
// successes superseding older non-zero holdings. Query with the read-only role.
const historyTenant = 'sha256:status-history';
const olderAt = new Date('2026-09-08T10:00:00.000Z');
const newerAt = new Date('2026-09-08T11:00:00.000Z');
async function holdingsSnapshot({ at, digest, counts, tenant = historyTenant, status = 'complete', startedAt = at }) {
  const id = await createSnapshot(superuser, { tenantRef: tenant });
  for (const [resourceType, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) {
      await insertResourceVersion(superuser, { snapshotId: id, resource: {
        naturalKey: `${resourceType}:fixture-${i}`, resourceType,
        payload: { displayName: 'Private fixture' },
        criticality: 'tier2', blastRadius: 'cosmetic', fidelity: 'read-only', provenance: { adapter: 'test' },
      } });
    }
  }
  await superuser.query(
    'UPDATE snapshot SET completed_at = $2, coverage_digest = $3, status = $4, started_at = $5 WHERE id = $1',
    [id, at, digest, status, startedAt],
  );
}
await holdingsSnapshot({ at: newerAt, startedAt: '2026-09-08T08:00:00Z', counts: { group: 2 }, digest: {
  group: { outcome: 'complete', itemCount: 2 },
  namedLocation: { outcome: 'complete', itemCount: 0 },
  roleAssignment: { outcome: 'failed', itemCount: null },
  organization: null,
} });
await holdingsSnapshot({ at: olderAt, counts: { group: 9, user: 7, namedLocation: 3, roleAssignment: 4, organization: 1 }, digest: {
  group: { outcome: 'complete', itemCount: 9 },
  user: { outcome: 'complete', itemCount: 7 },
  namedLocation: { outcome: 'complete', itemCount: 3 },
  roleAssignment: { outcome: 'complete', itemCount: 4 },
  organization: { outcome: 'complete', itemCount: 1 },
} });
for (const overrides of [{ tenant: 'sha256:status-other' }, { status: 'running' }, { status: 'failed' }, { at: null }]) {
  await holdingsSnapshot({ at: '2026-09-08T12:00:00Z', startedAt: '2026-09-08T11:30:00Z', ...overrides,
    counts: { user: 8, contact: 1 }, digest: {
      user: { outcome: 'complete', itemCount: 8 }, contact: { outcome: 'complete', itemCount: 1 },
    },
  });
}
// An unmentioned resource row cannot prove an attempted collection.
await holdingsSnapshot({ at: '2026-09-08T11:30:00Z', digest: {}, counts: { contact: 3 } });
let countQueries = 0;
const countedClient = { query: (...args) => { countQueries++; return client.query(...args); } };
const historyCounts = await getResourceCounts(countedClient, { tenantRef: historyTenant });
assert.equal(countQueries, 1, 'holdings must resolve every type in one query');
assert.deepEqual(historyCounts, {
  byType: [
    { resourceType: 'group', count: 2, asOf: newerAt },
    { resourceType: 'namedLocation', count: 0, asOf: newerAt },
    { resourceType: 'organization', count: null, asOf: newerAt },
    { resourceType: 'roleAssignment', count: null, asOf: newerAt },
    { resourceType: 'user', count: 7, asOf: olderAt },
  ],
  asOf: null,
});
assert.deepEqual(await getResourceCounts(client, { tenantRef: 'sha256:status-uncollected' }), { byType: [], asOf: null });

} finally {
  await client?.end();
  await superuser?.end();
  try {
    await database.cleanup();
  } finally {
    await admin?.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
    await admin?.end();
  }
}

console.log('queries.test.mjs — all assertions passed');
