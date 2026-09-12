import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  acceptDrift, seedFromSnapshot, listBaselines, getBaselineByLabel, activateBaseline,
} from './baseline.mjs';
import { completeSnapshot, createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { recordDrift } from '../store/governance.mjs';
import { POLICY_EVALUATION_EVIDENCE_KIND } from '../policy/evaluate.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

try {
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
const tenantRef = 'sha256:baseline-test';

async function createFullSnapshot(tenant) {
  const snapshotId = await createSnapshot(client, { tenantRef: tenant });
  await completeSnapshot(client, {
    id: snapshotId,
    status: 'complete',
    coverageDigest: fullSuccessfulCoverageDigest(),
  });
  return snapshotId;
}

async function addGroup(snapshotId, naturalKey, displayName) {
  return insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey,
      resourceType: 'group',
      payload: { displayName },
      payloadHash: `${naturalKey}:${displayName}`,
      criticality: 'tier1',
      blastRadius: 'access-affecting',
      fidelity: 'full',
      provenance: { adapter: 'test' },
    },
  });
}

const baselineSnapshotId = await createFullSnapshot(tenantRef);
const alphaV1 = await addGroup(baselineSnapshotId, 'group:alpha', 'Alpha');
const betaV1 = await addGroup(baselineSnapshotId, 'group:beta', 'Beta');
const gammaV1 = await addGroup(baselineSnapshotId, 'group:gamma', 'Gamma');

const baselineId = await seedFromSnapshot(client, {
  tenantRef,
  snapshotId: baselineSnapshotId,
  setBy: 'test-operator',
});
const { rows: seededRows } = await client.query(
  `SELECT natural_key, resource_version_id
   FROM baseline_resource
   WHERE baseline_id = $1
   ORDER BY natural_key`,
  [baselineId],
);
assert.deepEqual(seededRows, [
  { natural_key: 'group:alpha', resource_version_id: alphaV1 },
  { natural_key: 'group:beta', resource_version_id: betaV1 },
  { natural_key: 'group:gamma', resource_version_id: gammaV1 },
]);

// A baseline source must be a same-tenant, completed, whole-estate success. Every
// rejection happens before the current active baseline is deactivated or a new one
// is inserted.
async function assertRejectedBaselineSource(snapshotId, label) {
  await assert.rejects(
    () => seedFromSnapshot(client, {
      tenantRef,
      snapshotId,
      setBy: 'test-operator',
      label,
    }),
    /eligible whole-estate baseline source/,
  );
  const { rows: activeRows } = await client.query(
    `SELECT id
     FROM baseline
     WHERE tenant_ref = $1 AND active = true`,
    [tenantRef],
  );
  assert.deepEqual(activeRows.map((row) => row.id), [baselineId]);
}

const foreignSnapshotId = await createFullSnapshot('sha256:foreign-baseline-source');
await addGroup(foreignSnapshotId, 'group:foreign', 'Foreign');
await assertRejectedBaselineSource(foreignSnapshotId, 'foreign-source');

const runningSnapshotId = await createSnapshot(client, { tenantRef });
await addGroup(runningSnapshotId, 'group:running', 'Running');
await assertRejectedBaselineSource(runningSnapshotId, 'running-source');

const noCompletionTimestampSnapshotId = await createSnapshot(client, { tenantRef });
await client.query(
  `UPDATE snapshot
   SET status = 'complete', coverage_digest = $2
   WHERE id = $1`,
  [noCompletionTimestampSnapshotId, fullSuccessfulCoverageDigest()],
);
await assertRejectedBaselineSource(noCompletionTimestampSnapshotId, 'no-completion-timestamp-source');

const tierFilteredSnapshotId = await createSnapshot(client, { tenantRef });
await addGroup(tierFilteredSnapshotId, 'group:tier1', 'Tier 1');
await completeSnapshot(client, {
  id: tierFilteredSnapshotId,
  status: 'complete',
  coverageDigest: { group: { outcome: 'complete', itemCount: 1 } },
});
await assertRejectedBaselineSource(tierFilteredSnapshotId, 'tier-filtered-source');

const failedCoverage = fullSuccessfulCoverageDigest();
failedCoverage.user = { outcome: 'failed', itemCount: null, error: 'fixture denial' };
const failedCoverageSnapshotId = await createSnapshot(client, { tenantRef });
await completeSnapshot(client, {
  id: failedCoverageSnapshotId,
  status: 'complete',
  coverageDigest: failedCoverage,
});
await assertRejectedBaselineSource(failedCoverageSnapshotId, 'failed-coverage-source');

const missingCoverage = fullSuccessfulCoverageDigest();
delete missingCoverage.user;
const missingCoverageSnapshotId = await createSnapshot(client, { tenantRef });
await completeSnapshot(client, {
  id: missingCoverageSnapshotId,
  status: 'complete',
  coverageDigest: missingCoverage,
});
await assertRejectedBaselineSource(missingCoverageSnapshotId, 'missing-coverage-source');

const observedSnapshotId = await createFullSnapshot(tenantRef);
const alphaV2 = await addGroup(observedSnapshotId, 'group:alpha', 'Alpha changed');
const gammaV2 = await addGroup(observedSnapshotId, 'group:gamma', 'Gamma');
const deltaV2 = await addGroup(observedSnapshotId, 'group:delta', 'Delta');

const modifiedDriftId = await recordDrift(client, {
  tenantRef,
  baselineId,
  observedSnapshot: observedSnapshotId,
  naturalKey: 'group:alpha',
  resourceType: 'group',
  changeType: 'modified',
  beforeHash: 'group:alpha:Alpha',
  afterHash: 'group:alpha:Alpha changed',
  beforePayload: { displayName: 'Alpha' },
  afterPayload: { displayName: 'Alpha changed' },
  blastRadius: 'access-affecting',
});
const addedDriftId = await recordDrift(client, {
  tenantRef,
  baselineId,
  observedSnapshot: observedSnapshotId,
  naturalKey: 'group:delta',
  resourceType: 'group',
  changeType: 'added',
  beforeHash: null,
  afterHash: 'group:delta:Delta',
  beforePayload: null,
  afterPayload: { displayName: 'Delta' },
  blastRadius: 'access-affecting',
});
const removedDriftId = await recordDrift(client, {
  tenantRef,
  baselineId,
  observedSnapshot: observedSnapshotId,
  naturalKey: 'group:beta',
  resourceType: 'group',
  changeType: 'removed',
  beforeHash: 'group:beta:Beta',
  afterHash: null,
  beforePayload: { displayName: 'Beta' },
  afterPayload: null,
  blastRadius: 'access-affecting',
});

await acceptDrift(client, {
  driftId: modifiedDriftId,
  actor: 'test-operator',
  reason: 'approved alpha change',
});
const { rows: afterModifiedRows } = await client.query(
  `SELECT natural_key, resource_version_id
   FROM baseline_resource
   WHERE baseline_id = $1
   ORDER BY natural_key`,
  [baselineId],
);
assert.deepEqual(afterModifiedRows, [
  { natural_key: 'group:alpha', resource_version_id: alphaV2 },
  { natural_key: 'group:beta', resource_version_id: betaV1 },
  { natural_key: 'group:gamma', resource_version_id: gammaV1 },
]);
assert.notEqual(gammaV1, gammaV2);

await acceptDrift(client, {
  driftId: addedDriftId,
  actor: 'test-operator',
  reason: 'approved delta addition',
});
await acceptDrift(client, {
  driftId: removedDriftId,
  actor: 'test-operator',
  reason: 'approved beta removal',
});
const { rows: afterAllRows } = await client.query(
  `SELECT natural_key, resource_version_id
   FROM baseline_resource
   WHERE baseline_id = $1
   ORDER BY natural_key`,
  [baselineId],
);
assert.deepEqual(afterAllRows, [
  { natural_key: 'group:alpha', resource_version_id: alphaV2 },
  { natural_key: 'group:delta', resource_version_id: deltaV2 },
  { natural_key: 'group:gamma', resource_version_id: gammaV1 },
]);

const { rows: dispositions } = await client.query(
  `SELECT drift_id, action, actor, reason
   FROM disposition
   ORDER BY decided_at, id`,
);
assert.deepEqual(dispositions, [
  {
    drift_id: modifiedDriftId,
    action: 'accept',
    actor: 'test-operator',
    reason: 'approved alpha change',
  },
  {
    drift_id: addedDriftId,
    action: 'accept',
    actor: 'test-operator',
    reason: 'approved delta addition',
  },
  {
    drift_id: removedDriftId,
    action: 'accept',
    actor: 'test-operator',
    reason: 'approved beta removal',
  },
]);
const { rows: evidence } = await client.query(
  `SELECT tenant_ref, kind, subject, actor, prev_hash, record_hash
   FROM evidence
   ORDER BY seq`,
);
assert.ok(evidence.every((row) => row.tenant_ref === tenantRef));
// Recording a drift first records the policy decision — including the no-match
// decision — then accepting it records the disposition. This ordered chain lets
// an auditor answer both why it was not auto-remediated and who accepted it.
assert.deepEqual(
  evidence.map(({ kind, subject, actor }) => ({
    kind,
    driftId: subject.driftId,
    actor,
    ...(kind === POLICY_EVALUATION_EVIDENCE_KIND ? { matched: subject.matched } : {}),
  })),
  [
    { kind: POLICY_EVALUATION_EVIDENCE_KIND, driftId: modifiedDriftId, actor: 'policy-evaluator', matched: false },
    { kind: POLICY_EVALUATION_EVIDENCE_KIND, driftId: addedDriftId, actor: 'policy-evaluator', matched: false },
    { kind: POLICY_EVALUATION_EVIDENCE_KIND, driftId: removedDriftId, actor: 'policy-evaluator', matched: false },
    { kind: 'disposition', driftId: modifiedDriftId, actor: 'test-operator' },
    { kind: 'disposition', driftId: addedDriftId, actor: 'test-operator' },
    { kind: 'disposition', driftId: removedDriftId, actor: 'test-operator' },
  ],
);
assert.equal(evidence[0].prev_hash, null);
assert.equal(evidence[1].prev_hash, evidence[0].record_hash);
assert.equal(evidence[2].prev_hash, evidence[1].record_hash);
assert.equal(evidence[3].prev_hash, evidence[2].record_hash);
assert.equal(evidence[4].prev_hash, evidence[3].record_hash);
assert.equal(evidence[5].prev_hash, evidence[4].record_hash);

const replacementBaselineId = await seedFromSnapshot(client, {
  tenantRef,
  snapshotId: observedSnapshotId,
  setBy: 'replacement-operator',
});
const { rows: baselines } = await client.query(
  `SELECT id, active
   FROM baseline
   WHERE tenant_ref = $1
   ORDER BY set_at, id`,
  [tenantRef],
);
assert.deepEqual(baselines, [
  { id: baselineId, active: false },
  { id: replacementBaselineId, active: true },
]);

// --- Named baselines: label/description, listBaselines, getBaselineByLabel, activateBaseline ---

const labelTenantRef = 'sha256:baseline-label-test';
const labelSnapshotId = await createFullSnapshot(labelTenantRef);
await addGroup(labelSnapshotId, 'group:one', 'One');

const namedBaselineId = await seedFromSnapshot(client, {
  tenantRef: labelTenantRef,
  snapshotId: labelSnapshotId,
  setBy: 'label-operator',
  label: 'post-audit-2026-q3',
  description: 'Snapshot taken right after the Q3 audit closed.',
});

const fetchedByLabel = await getBaselineByLabel(client, {
  tenantRef: labelTenantRef,
  label: 'post-audit-2026-q3',
});
assert.equal(fetchedByLabel.id, namedBaselineId);
assert.equal(fetchedByLabel.description, 'Snapshot taken right after the Q3 audit closed.');

// Two baselines in the same tenant cannot share a label.
const dupSnapshotId = await createFullSnapshot(labelTenantRef);
await addGroup(dupSnapshotId, 'group:two', 'Two');
await assert.rejects(() => seedFromSnapshot(client, {
  tenantRef: labelTenantRef,
  snapshotId: dupSnapshotId,
  setBy: 'label-operator',
  label: 'post-audit-2026-q3',
}));

// A baseline with NO label is still allowed, and many of them can coexist.
const unlabeledSnapshotA = await createFullSnapshot(labelTenantRef);
await addGroup(unlabeledSnapshotA, 'group:three', 'Three');
const unlabeledBaselineA = await seedFromSnapshot(client, {
  tenantRef: labelTenantRef,
  snapshotId: unlabeledSnapshotA,
  setBy: 'label-operator',
});
const unlabeledSnapshotB = await createFullSnapshot(labelTenantRef);
await addGroup(unlabeledSnapshotB, 'group:four', 'Four');
const unlabeledBaselineB = await seedFromSnapshot(client, {
  tenantRef: labelTenantRef,
  snapshotId: unlabeledSnapshotB,
  setBy: 'label-operator',
});
assert.notEqual(unlabeledBaselineA, unlabeledBaselineB);

const listedBaselines = await listBaselines(client, { tenantRef: labelTenantRef });
assert.equal(listedBaselines.length, 3);
const listedById = new Map(listedBaselines.map((row) => [row.id, row]));
assert.equal(listedById.get(namedBaselineId).label, 'post-audit-2026-q3');
assert.equal(listedById.get(namedBaselineId).resource_count, 1);
assert.equal(listedById.get(unlabeledBaselineA).label, null);

// Newest-first ordering (tie-break-safe: assert relative order, not absolute position).
const orderedIds = listedBaselines.map((row) => row.id);
const idxNamed = orderedIds.indexOf(namedBaselineId);
const idxA = orderedIds.indexOf(unlabeledBaselineA);
const idxB = orderedIds.indexOf(unlabeledBaselineB);
assert.ok(idxNamed > idxA && idxA > idxB, 'listBaselines must return newest first');

// seedFromSnapshot always deactivates the prior active baseline, so the most
// recently seeded (unlabeledBaselineB) is currently the sole active one.
let activeRows = await client.query(
  'SELECT id FROM baseline WHERE tenant_ref = $1 AND active = true',
  [labelTenantRef],
);
assert.deepEqual(activeRows.rows.map((row) => row.id), [unlabeledBaselineB]);

// activateBaseline makes one baseline active and deactivates the previously active one.
await activateBaseline(client, { tenantRef: labelTenantRef, baselineId: namedBaselineId });
activeRows = await client.query(
  'SELECT id FROM baseline WHERE tenant_ref = $1 AND active = true',
  [labelTenantRef],
);
assert.deepEqual(activeRows.rows.map((row) => row.id), [namedBaselineId]);

// Atomicity: if activation fails partway (e.g. target does not exist), the
// tenant must still have exactly one active baseline — never zero.
await assert.rejects(() => activateBaseline(client, {
  tenantRef: labelTenantRef,
  baselineId: '00000000-0000-0000-0000-000000000000',
}));
activeRows = await client.query(
  'SELECT id FROM baseline WHERE tenant_ref = $1 AND active = true',
  [labelTenantRef],
);
assert.deepEqual(activeRows.rows.map((row) => row.id), [namedBaselineId]);

// --- Plan task 16: activation stays atomic when two activations race ---
// Two SEPARATE connections race to activate different baselines of one tenant. The
// transaction and row locks inside activateBaseline must serialize them: both calls
// complete, and the tenant is left with exactly one active baseline — never zero
// (drift detection would throw `no active baseline`) and never two. Drop the
// transaction (the task's named mutation) and the two activate writes interleave
// past the partial unique index, making one call reject — which fails here.
const raceTenantRef = 'sha256:baseline-race-test';
const raceSnapshotId = await createFullSnapshot(raceTenantRef);
await addGroup(raceSnapshotId, 'group:raced', 'Raced');
const raceBaselineA = await seedFromSnapshot(client, {
  tenantRef: raceTenantRef,
  snapshotId: raceSnapshotId,
  setBy: 'race-operator',
});
const raceBaselineB = await seedFromSnapshot(client, {
  tenantRef: raceTenantRef,
  snapshotId: raceSnapshotId,
  setBy: 'race-operator',
});

const raceClientA = await database.connect();
const raceClientB = await database.connect();
try {
  for (let round = 0; round < 25; round += 1) {
    const first = round % 2 === 0 ? raceBaselineA : raceBaselineB;
    const second = round % 2 === 0 ? raceBaselineB : raceBaselineA;
    await Promise.all([
      activateBaseline(raceClientA, { tenantRef: raceTenantRef, baselineId: first }),
      activateBaseline(raceClientB, { tenantRef: raceTenantRef, baselineId: second }),
    ]);
    const { rows: raceActiveRows } = await client.query(
      'SELECT id FROM baseline WHERE tenant_ref = $1 AND active = true',
      [raceTenantRef],
    );
    assert.equal(
      raceActiveRows.length,
      1,
      `round ${round}: exactly one baseline must be active after racing activations`,
    );
    assert.ok(
      raceActiveRows[0].id === first || raceActiveRows[0].id === second,
      `round ${round}: the active baseline must be one of the raced baselines`,
    );
  }
} finally {
  await raceClientA.end();
  await raceClientB.end();
}

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('baseline.test.mjs — all assertions passed');
