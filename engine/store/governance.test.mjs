import { strict as assert } from 'node:assert';
import { createSnapshot, insertResourceVersion } from './db.mjs';
import {
  createBaseline, seedBaselineFromSnapshot, getActiveBaseline, recordDrift,
  listOpenDrift, recordDisposition,
} from './governance.mjs';
import { createPolicy, POLICY_EVALUATION_EVIDENCE_KIND } from '../policy/evaluate.mjs';
import { recordAutoRemediationTerminalOutcome } from '../policy/execute.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from './loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

try {
  client = await database.connect();
  await client.query(schemaSql());
const tenantRef = 'sha256:governance-test';
const expiredIgnoreAt = new Date('2000-01-01T00:00:00.000Z');
const unexpiredIgnoreAt = new Date('2099-01-01T00:00:00.000Z');
const snapshotId = await createSnapshot(client, { tenantRef });
const versionId = await insertResourceVersion(client, {
  snapshotId,
  resource: {
    naturalKey: 'group:governance-test',
    resourceType: 'group',
    payload: { displayName: 'Governance test' },
    payloadHash: 'baseline-hash',
    criticality: 'tier1',
    blastRadius: 'access-affecting',
    fidelity: 'full',
    provenance: { adapter: 'test' },
  },
});

const baselineId = await createBaseline(client, { tenantRef, setBy: 'test-operator' });
await seedBaselineFromSnapshot(client, { baselineId, snapshotId });
const activeBaseline = await getActiveBaseline(client, { tenantRef });
assert.equal(activeBaseline.id, baselineId);

const { rows: baselineResources } = await client.query(
  'SELECT * FROM baseline_resource WHERE baseline_id = $1',
  [baselineId],
);
assert.equal(baselineResources.length, 1);
assert.equal(baselineResources[0].resource_version_id, versionId);

await assert.rejects(() =>
  createBaseline(client, { tenantRef, setBy: 'another-operator' }),
);

const observedSnapshot = await createSnapshot(client, { tenantRef });
const expiredDriftId = await recordDrift(client, {
  tenantRef,
  baselineId,
  observedSnapshot,
  naturalKey: 'group:governance-test',
  resourceType: 'group',
  changeType: 'modified',
  beforeHash: 'baseline-hash',
  afterHash: 'expired-ignore-hash',
  beforePayload: { displayName: 'Governance test' },
  afterPayload: { displayName: 'Changed' },
  blastRadius: 'access-affecting',
});
assert.ok(expiredDriftId);

let openDrift = await listOpenDrift(client, { tenantRef });
assert.deepEqual(openDrift.map((row) => row.id), [expiredDriftId]);

await recordDisposition(client, {
  driftId: expiredDriftId,
  action: 'ignore',
  actor: 'test-operator',
  reason: 'expired test ignore',
  expiresAt: expiredIgnoreAt,
});
openDrift = await listOpenDrift(client, { tenantRef });
assert.deepEqual(openDrift.map((row) => row.id), [expiredDriftId]);

const unexpiredDriftId = await recordDrift(client, {
  tenantRef,
  baselineId,
  observedSnapshot,
  naturalKey: 'group:governance-test-unexpired',
  resourceType: 'group',
  changeType: 'modified',
  beforeHash: 'baseline-hash',
  afterHash: 'unexpired-ignore-hash',
  beforePayload: { displayName: 'Governance test' },
  afterPayload: { displayName: 'Changed again' },
  blastRadius: 'access-affecting',
});
await recordDisposition(client, {
  driftId: unexpiredDriftId,
  action: 'ignore',
  actor: 'test-operator',
  reason: 'unexpired test ignore',
  expiresAt: unexpiredIgnoreAt,
});
openDrift = await listOpenDrift(client, { tenantRef });
assert.deepEqual(openDrift.map((row) => row.id), [expiredDriftId]);

// Plan task 19: recordDrift acts on an 'auto_remediate' evaluation immediately —
// enqueuing a remediate job is not a separate wiring step a caller can forget.
const adminPrincipalId = '22222222-2222-2222-2222-222222222222';
const runAsPrincipalId = '33333333-3333-3333-3333-333333333333';
await client.query(
  `INSERT INTO principal (id, email, display_name)
   VALUES ($1, 'governance-run-as@example.com', 'Governance run-as')`,
  [runAsPrincipalId],
);
// An explicit past active_from: the column default is the database's now() (microseconds),
// while createPolicy checks the grant at a JS Date (milliseconds) taken a moment later, so a
// default-dated grant is often not yet active at that instant and the check fails at random.
await client.query(
  `INSERT INTO role_grant (principal_id, role, granted_by, reason, active_from)
   VALUES ($1, 'restorer', 'test', 'governance auto-remediation test', '2020-01-01Z')`,
  [runAsPrincipalId],
);
await createPolicy(client, {
  tenantRef, name: 'auto-remediate governance-test groups', resourceType: 'group',
  action: 'auto_remediate', maxBlastRadius: 'tenant-lockout', createdBy: adminPrincipalId,
  runAsPrincipalId,
});
const autoRemediateDriftId = await recordDrift(client, {
  tenantRef,
  baselineId,
  observedSnapshot,
  naturalKey: 'group:governance-test-auto-remediate',
  resourceType: 'group',
  changeType: 'modified',
  beforeHash: 'baseline-hash',
  afterHash: 'auto-remediate-hash',
  beforePayload: { displayName: 'Governance test' },
  afterPayload: { displayName: 'Changed by attacker' },
  blastRadius: 'access-affecting',
});
const { rows: autoRemediateJobs } = await client.query(
  `SELECT * FROM job WHERE kind = 'remediate' AND params->'driftIds' @> to_jsonb($1::text)`,
  [autoRemediateDriftId],
);
assert.equal(autoRemediateJobs.length, 1, 'an auto_remediate policy match must enqueue exactly one remediate job');
assert.equal(autoRemediateJobs[0].requested_by, runAsPrincipalId);

// The same change seen again while its remediate job is still queued reuses the row and
// queues nothing more. Once that job has failed, the change seen again gets a new row and
// a new remediate job, so a failed auto remediation is tried again on the next run.
const autoRemediateAgain = async () => recordDrift(client, {
  tenantRef, baselineId, observedSnapshot: await createSnapshot(client, { tenantRef }),
  naturalKey: 'group:governance-test-auto-remediate', resourceType: 'group', changeType: 'modified',
  beforeHash: 'baseline-hash', afterHash: 'auto-remediate-hash',
  beforePayload: { displayName: 'Governance test' }, afterPayload: { displayName: 'Changed by attacker' },
  blastRadius: 'access-affecting',
});
const remediateJobs = async () => (await client.query(
  `SELECT id FROM job WHERE kind = 'remediate' AND params->'driftIds' @> to_jsonb($1::text)`, [autoRemediateDriftId],
)).rows;
assert.equal(await autoRemediateAgain(), autoRemediateDriftId, 'a queued remediation keeps the row');
assert.equal((await remediateJobs()).length, 1, 'and is not queued twice');
await client.query("UPDATE job SET status = 'failed' WHERE id = $1", [autoRemediateJobs[0].id]);
await recordAutoRemediationTerminalOutcome(client, { job: { id: autoRemediateJobs[0].id, kind: 'remediate' }, status: 'failed', error: 'Graph 503' });
const retriedDriftId = await autoRemediateAgain();
assert.notEqual(retriedDriftId, autoRemediateDriftId, 'a failed remediation is never the end of the change');
const { rows: retriedJobs } = await client.query(
  `SELECT id FROM job WHERE kind = 'remediate' AND params->'driftIds' @> to_jsonb($1::text)`, [retriedDriftId],
);
assert.equal(retriedJobs.length, 1, 'the change seen again is remediated again');
// A cancelled remediate job leaves its execution 'queued'; the change is still tried again.
await client.query("UPDATE job SET status = 'cancelled' WHERE id = $1", [retriedJobs[0].id]);
const afterCancelId = await autoRemediateAgain();
assert.notEqual(afterCancelId, retriedDriftId, 'a cancelled remediation is never the end of the change');
const { rows: afterCancelJobs } = await client.query(
  `SELECT id FROM job WHERE kind = 'remediate' AND params->'driftIds' @> to_jsonb($1::text)`, [afterCancelId],
);
assert.equal(afterCancelJobs.length, 1);

// A drift-detect run that still sees the same change reuses its row unchanged (first seen,
// first collection), so the table holds one row per change, not one per run. A different
// difference, or a row something acted on, gets a new row.
// A user, so the auto_remediate group policy above does not match it.
const dedupeKey = 'user:governance-test-dedupe';
const dedupeDrift = (snapshot, afterHash = 'dedupe-hash') => recordDrift(client, {
  tenantRef, baselineId, observedSnapshot: snapshot, naturalKey: dedupeKey,
  resourceType: 'user', changeType: 'modified', beforeHash: 'baseline-hash', afterHash,
  beforePayload: { displayName: 'Governance test' }, afterPayload: { displayName: afterHash },
  blastRadius: 'access-affecting',
});
const dedupeRows = async () => (await client.query(
  'SELECT * FROM drift WHERE natural_key = $1 ORDER BY detected_at, id', [dedupeKey],
)).rows;
const evaluations = async (driftId) => Number((await client.query(
  'SELECT count(*) FROM evidence WHERE kind = $1 AND subject->>\'driftId\' = $2', [POLICY_EVALUATION_EVIDENCE_KIND, driftId],
)).rows[0].count);

const firstRun = await createSnapshot(client, { tenantRef });
const firstId = await dedupeDrift(firstRun);
const [firstRow] = await dedupeRows();
const secondRun = await createSnapshot(client, { tenantRef });
assert.equal(await dedupeDrift(secondRun), firstId, 'the same open change keeps its row');
let rowsNow = await dedupeRows();
assert.equal(rowsNow.length, 1, 'no second row for the same open change');
assert.equal(rowsNow[0].observed_snapshot, firstRun, 'the row stays the record of the first sighting');
assert.equal(rowsNow[0].detected_at.getTime(), firstRow.detected_at.getTime(), 'first-seen time is kept');
assert.equal(await evaluations(firstId), 2, 'each run still evaluates the change against policy');
assert.equal(await dedupeDrift(secondRun), firstId, 're-running detect for the same collection is a no-op');
assert.equal(await dedupeDrift(firstRun), firstId, 'detecting an older collection again changes nothing');
assert.equal((await dedupeRows()).length, 1);

const changedRun = await createSnapshot(client, { tenantRef });
const changedId = await dedupeDrift(changedRun, 'dedupe-hash-2');
assert.notEqual(changedId, firstId, 'a different difference is a new change');
assert.equal((await dedupeRows()).length, 2);

await recordDisposition(client, { driftId: changedId, action: 'rollback', actor: 'test-operator', reason: 'rolled back' });
const afterRollbackRun = await createSnapshot(client, { tenantRef });
const reopenedId = await dedupeDrift(afterRollbackRun, 'dedupe-hash-2');
assert.notEqual(reopenedId, changedId, 'a row with a decision is never moved; the change seen again gets a new row');
rowsNow = await dedupeRows();
assert.equal(rowsNow.length, 3);
assert.equal(rowsNow.find((row) => row.id === changedId).observed_snapshot, changedRun, 'the decided row is left as it was');

// An expired ignore is still a decision about the collection it was made on: that row
// reads as open again, but the next run records a new row rather than moving it.
await recordDisposition(client, { driftId: reopenedId, action: 'ignore', actor: 'test-operator', reason: 'brief ignore', expiresAt: expiredIgnoreAt });
const afterExpiryRun = await createSnapshot(client, { tenantRef });
assert.notEqual(await dedupeDrift(afterExpiryRun, 'dedupe-hash-2'), reopenedId);
assert.equal((await dedupeRows()).find((row) => row.id === reopenedId).observed_snapshot, afterRollbackRun);

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('governance.test.mjs — all assertions passed');
