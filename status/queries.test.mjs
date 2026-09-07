import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { connect } from './db.mjs';
import {
  getResourceCounts, getBaselineInfo, getOpenDriftCounts, getLastCollection,
  getEvidenceIntegrity, getRecentDispositionCounts, collectGovernance,
} from './queries.mjs';
import { connect as connectSuperuser, createSnapshot, insertResourceVersion } from '../engine/store/db.mjs';
import { createBaseline, recordDrift, recordDisposition } from '../engine/store/governance.mjs';
import { appendEvidence } from '../engine/govern/evidence.mjs';

const url = process.env.KEEL_DB_TEST_URL;
if (!url) throw new Error('KEEL_DB_TEST_URL not set — source /etc/keel/db.env first');

const TEST_STATUS_PASSWORD = 'status-test-only-not-a-real-secret';
const tenantRef = 'sha256:status-query-test';

const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(
  'DROP TABLE IF EXISTS evidence, evidence_head, disposition, drift, baseline_resource, baseline, '
  + 'resource_reference, rollback_entry, resource_version, plan, snapshot CASCADE',
);
await admin.query(readFileSync(new URL('../engine/store/schema.sql', import.meta.url), 'utf8'));
await admin.query(readFileSync(new URL('./setupRole.sql', import.meta.url), 'utf8'));
await admin.query(`ALTER ROLE keel_status WITH PASSWORD '${TEST_STATUS_PASSWORD}'`);

const superuser = await connectSuperuser(url);

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
  'UPDATE snapshot SET status = $2, completed_at = now() WHERE id = $1',
  [snapshotId, 'complete'],
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

const statusUrl = url.replace(/\/\/[^:]+:[^@]+@/, `//keel_status:${TEST_STATUS_PASSWORD}@`);
const client = await connect(statusUrl);

const resourceCounts = await getResourceCounts(client, { tenantRef });
assert.deepEqual(
  [...resourceCounts.byType].sort((a, b) => a.resourceType.localeCompare(b.resourceType)),
  [{ resourceType: 'group', count: 1 }, { resourceType: 'namedLocation', count: 1 }],
);
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

await client.end();
await superuser.end();
await admin.end();

console.log('queries.test.mjs — all assertions passed');
