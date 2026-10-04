import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createSnapshot, insertResourceVersion } from './db.mjs';
import {
  createBaseline, seedBaselineFromSnapshot, getActiveBaseline, recordDrift,
  listOpenDrift, recordDisposition,
} from './governance.mjs';
import { createPolicy } from '../policy/evaluate.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

try {
  client = await database.connect();
  await client.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
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

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('governance.test.mjs — all assertions passed');
