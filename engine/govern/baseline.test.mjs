import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  acceptDrift, seedFromSnapshot, listBaselines, getBaselineByLabel, activateBaseline,
  resnapshotBaseline, reinstateBaseline,
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

// --- Live gate #148 (Q43): reinstating a superseded baseline version ---
// A superseded version is never activated again, so putting it back means a NEW latest
// version that holds the same resources. The version it supersedes is superseded in turn
// (history is append-only), the new version is active, and the change is in the audit
// record. It needs no source snapshot, and the current version cannot be reinstated.
const reinstateTenantRef = 'sha256:baseline-reinstate-test';
const reinstateSnapshotV1 = await createFullSnapshot(reinstateTenantRef);
await addGroup(reinstateSnapshotV1, 'group:keep', 'Keep');
await addGroup(reinstateSnapshotV1, 'group:fixture', 'Fixture');
const reinstateV1 = await seedFromSnapshot(client, {
  tenantRef: reinstateTenantRef,
  snapshotId: reinstateSnapshotV1,
  setBy: 'reinstate-operator',
  label: 'Golden state',
});
const reinstateSnapshotV2 = await createFullSnapshot(reinstateTenantRef);
await addGroup(reinstateSnapshotV2, 'group:keep', 'Keep');
await client.query(
  "UPDATE snapshot SET completed_at = (SELECT completed_at + interval '1 minute' FROM snapshot WHERE id = $2) WHERE id = $1",
  [reinstateSnapshotV2, reinstateSnapshotV1],
);
const reinstateV2 = await resnapshotBaseline(client, {
  tenantRef: reinstateTenantRef,
  baselineId: reinstateV1,
  snapshotId: reinstateSnapshotV2,
  setBy: 'reinstate-operator',
});
assert.equal(reinstateV2.version, 2);
assert.equal(reinstateV2.active, true);
await assert.rejects(
  () => activateBaseline(client, { tenantRef: reinstateTenantRef, baselineId: reinstateV1 }),
  /superseded/,
);

const baselineResources = async (id) => (await client.query(
  'SELECT natural_key, resource_version_id FROM baseline_resource WHERE baseline_id = $1 ORDER BY natural_key',
  [id],
)).rows;
const v1Resources = await baselineResources(reinstateV1);
assert.equal(v1Resources.length, 2);

const reinstated = await reinstateBaseline(client, {
  tenantRef: reinstateTenantRef,
  baselineId: reinstateV1,
  actor: 'reinstate-operator',
  reason: 'put the pre-delete-step baseline back',
});
assert.equal(reinstated.version, 3);
assert.equal(reinstated.supersedesId, reinstateV2.id);
assert.equal(reinstated.reinstatedId, reinstateV1);
assert.equal(reinstated.reinstatedVersion, 1);
assert.deepEqual(await baselineResources(reinstated.id), v1Resources, 'v3 holds exactly v1\'s resources');
assert.deepEqual(await baselineResources(reinstateV1), v1Resources, 'v1 is untouched');

const { rows: reinstateRows } = await client.query(
  'SELECT id, version, active, superseded_at, supersedes_id, label, source_snapshot_id FROM baseline WHERE tenant_ref = $1 ORDER BY version',
  [reinstateTenantRef],
);
assert.deepEqual(reinstateRows.map((row) => [row.version, row.active, row.superseded_at !== null]), [
  [1, false, true],
  [2, false, true],
  [3, true, false],
], 'the old active version reads superseded and only the reinstated version is active');
assert.equal(String(reinstateRows[2].supersedes_id), reinstateV2.id);
assert.equal(reinstateRows[2].label, 'Golden state (v3)');
assert.equal(String(reinstateRows[2].source_snapshot_id), reinstateSnapshotV1);

const { rows: reinstateEvidence } = await client.query(
  "SELECT subject, actor FROM evidence WHERE tenant_ref = $1 AND kind = 'baseline-reinstate'",
  [reinstateTenantRef],
);
assert.equal(reinstateEvidence.length, 1);
assert.equal(reinstateEvidence[0].actor, 'reinstate-operator');
assert.equal(reinstateEvidence[0].subject.baselineId, reinstated.id);
assert.equal(reinstateEvidence[0].subject.reinstatedBaselineId, reinstateV1);
assert.equal(reinstateEvidence[0].subject.supersedesBaselineId, reinstateV2.id);
assert.equal(reinstateEvidence[0].subject.resourceCount, 2);
assert.equal(reinstateEvidence[0].subject.reason, 'put the pre-delete-step baseline back');

// The current version cannot be reinstated, whichever way it is named.
await assert.rejects(
  () => reinstateBaseline(client, { tenantRef: reinstateTenantRef, baselineId: reinstated.id, actor: 'reinstate-operator' }),
  /current version/,
);
await assert.rejects(
  () => reinstateBaseline(client, { tenantRef: reinstateTenantRef, baselineId: reinstateV1, version: 3, actor: 'reinstate-operator' }),
  /current version/,
);
await assert.rejects(
  () => reinstateBaseline(client, { tenantRef: reinstateTenantRef, baselineId: reinstateV1, version: 9, actor: 'reinstate-operator' }),
  /no version 9/,
);
await assert.rejects(
  () => reinstateBaseline(client, { tenantRef: 'sha256:some-other-tenant', baselineId: reinstateV1, actor: 'reinstate-operator' }),
  /not found/,
);
assert.equal((await client.query('SELECT count(*)::int AS count FROM baseline WHERE tenant_ref = $1', [reinstateTenantRef])).rows[0].count, 3);

// Any version of the chain plus --version N picks the version to copy.
const reinstatedV2 = await reinstateBaseline(client, {
  tenantRef: reinstateTenantRef, baselineId: reinstated.id, version: 2, actor: 'reinstate-operator',
});
assert.equal(reinstatedV2.version, 4);
assert.equal(reinstatedV2.reinstatedId, reinstateV2.id);
assert.deepEqual(await baselineResources(reinstatedV2.id), await baselineResources(reinstateV2.id));
assert.deepEqual(
  (await client.query('SELECT id FROM baseline WHERE tenant_ref = $1 AND active = true', [reinstateTenantRef])).rows.map((row) => row.id),
  [reinstatedV2.id],
);

// A baseline seeded before snapshots were recorded (no source_snapshot_id, no
// captured_at) cannot be re-versioned from a snapshot, but it reinstates fine.
const legacyTenantRef = 'sha256:baseline-reinstate-legacy';
const legacySnapshot = await createFullSnapshot(legacyTenantRef);
await addGroup(legacySnapshot, 'group:legacy', 'Legacy');
const legacyV1 = await seedFromSnapshot(client, {
  tenantRef: legacyTenantRef, snapshotId: legacySnapshot, setBy: 'legacy-operator', label: 'Legacy',
});
await client.query(
  'UPDATE baseline SET source_snapshot_id = NULL, captured_at = NULL, observation_scope = NULL WHERE id = $1',
  [legacyV1],
);
const legacySnapshot2 = await createFullSnapshot(legacyTenantRef);
const legacyV2 = await resnapshotBaseline(client, {
  tenantRef: legacyTenantRef, baselineId: legacyV1, snapshotId: legacySnapshot2, setBy: 'legacy-operator',
});
assert.deepEqual(await baselineResources(legacyV2.id), []);
const legacyReinstated = await reinstateBaseline(client, {
  tenantRef: legacyTenantRef, baselineId: legacyV1, actor: 'legacy-operator',
});
assert.equal(legacyReinstated.version, 3);
assert.deepEqual(await baselineResources(legacyReinstated.id), await baselineResources(legacyV1));
const { rows: [legacyRow] } = await client.query(
  'SELECT active, source_snapshot_id, captured_at FROM baseline WHERE id = $1', [legacyReinstated.id],
);
assert.equal(legacyRow.active, true);
assert.equal(legacyRow.source_snapshot_id, null);
assert.equal(legacyRow.captured_at, null);

} finally {
  await client?.end();
  await database.cleanup();
}
console.log('baseline.test.mjs — all assertions passed');
