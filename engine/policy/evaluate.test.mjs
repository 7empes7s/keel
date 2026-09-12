import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPolicy,
  evaluateOpenDrifts,
  exceedsMaxBlastRadius,
  policyMatches,
  POLICY_EVALUATION_EVIDENCE_KIND,
} from './evaluate.mjs';
import { verifyChain } from '../govern/evidence.mjs';
import { seedFromSnapshot } from '../govern/baseline.mjs';
import { completeSnapshot, createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { recordDrift } from '../store/governance.mjs';
import { enqueue } from '../jobs/queue.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';
import { runJob } from '../../cli/keel-worker.mjs';

// --- pure match / guardrail checks, no database needed ---

assert.equal(
  policyMatches({ resource_type: 'group', blast_radius: null, change_type: null, natural_key_glob: null },
    { resource_type: 'group', blast_radius: 'cosmetic', change_type: 'modified', natural_key: 'group:x' }),
  true,
  'a null match column matches anything',
);
assert.equal(
  policyMatches({ resource_type: 'user', blast_radius: null, change_type: null, natural_key_glob: null },
    { resource_type: 'group', blast_radius: 'cosmetic', change_type: 'modified', natural_key: 'group:x' }),
  false,
  'a mismatched resource_type never matches',
);
assert.equal(
  policyMatches({ resource_type: null, blast_radius: null, change_type: null, natural_key_glob: 'group:FIN-*' },
    { resource_type: 'group', blast_radius: 'cosmetic', change_type: 'modified', natural_key: 'group:FIN-Admins' }),
  true,
  'a natural_key_glob with a wildcard matches a prefix',
);
assert.equal(
  policyMatches({ resource_type: null, blast_radius: null, change_type: null, natural_key_glob: 'group:FIN-*' },
    { resource_type: 'group', blast_radius: 'cosmetic', change_type: 'modified', natural_key: 'group:HR-Admins' }),
  false,
  'a natural_key_glob that does not match the natural key is refused',
);

assert.equal(
  exceedsMaxBlastRadius({ blast_radius: 'tenant-lockout' }, { max_blast_radius: 'access-affecting' }),
  true,
  'tenant-lockout exceeds an access-affecting cap',
);
assert.equal(
  exceedsMaxBlastRadius({ blast_radius: 'cosmetic' }, { max_blast_radius: 'access-affecting' }),
  false,
  'cosmetic does not exceed an access-affecting cap',
);
assert.equal(
  exceedsMaxBlastRadius({ blast_radius: 'access-affecting' }, { max_blast_radius: 'access-affecting' }),
  false,
  'a drift at exactly the cap does not exceed it',
);

// --- evaluateDrift against a real database ---

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
try {
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));

  const tenantRef = 'sha256:policy-evaluate-test';
  const { rows: runAsRows } = await client.query(
    `INSERT INTO principal (email, display_name)
     VALUES ('policy-run-as@example.com', 'Policy run-as')
     RETURNING *`,
  );
  const runAsPrincipalId = runAsRows[0].id;
  await client.query(
    `INSERT INTO role_grant (principal_id, role, granted_by, reason)
     VALUES ($1, 'restorer', 'test', 'policy evaluation test')`,
    [runAsPrincipalId],
  );
  const { rows: policyAdminRows } = await client.query(
    `INSERT INTO principal (email, display_name)
     VALUES ('policy-admin@example.com', 'Policy admin')
     RETURNING *`,
  );
  const policyAdminId = policyAdminRows[0].id;
  await client.query(
    `INSERT INTO role_grant (principal_id, role, granted_by, reason)
     VALUES ($1, 'admin', 'test', 'policy evaluation administrator')`,
    [policyAdminId],
  );

  async function makeDrift({ naturalKey, resourceType, changeType, blastRadius }) {
    const baselineSnapshotId = await createSnapshot(client, { tenantRef });
    await insertResourceVersion(client, {
      snapshotId: baselineSnapshotId,
      resource: {
        naturalKey, resourceType, payload: { displayName: 'Baseline' }, payloadHash: `${naturalKey}-before`,
        criticality: 'tier1', blastRadius, fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
    await completeSnapshot(client, {
      id: baselineSnapshotId,
      status: 'complete',
      coverageDigest: fullSuccessfulCoverageDigest(),
    });
    const baselineId = await seedFromSnapshot(client, {
      tenantRef, snapshotId: baselineSnapshotId, setBy: 'test-operator',
    });
    const observedSnapshotId = await createSnapshot(client, { tenantRef });
    await insertResourceVersion(client, {
      snapshotId: observedSnapshotId,
      resource: {
        naturalKey, resourceType, payload: { displayName: 'Changed' }, payloadHash: `${naturalKey}-after`,
        criticality: 'tier1', blastRadius, fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
    const driftId = await recordDrift(client, {
      tenantRef, baselineId, observedSnapshot: observedSnapshotId, naturalKey, resourceType,
      changeType, beforeHash: `${naturalKey}-before`, afterHash: `${naturalKey}-after`,
      beforePayload: { displayName: 'Baseline' }, afterPayload: { displayName: 'Changed' }, blastRadius,
    });
    const { rows } = await client.query('SELECT * FROM drift WHERE id = $1', [driftId]);
    return rows[0];
  }

  async function evidenceFor(driftId) {
    const { rows } = await client.query(
      `SELECT subject FROM evidence
       WHERE tenant_ref = $1 AND kind = $2 AND subject->>'driftId' = $3
       ORDER BY seq DESC LIMIT 1`,
      [tenantRef, POLICY_EVALUATION_EVIDENCE_KIND, driftId],
    );
    return rows[0]?.subject ?? null;
  }

  // Creating a drift row evaluates it immediately. No enabled policy matches,
  // but the no-match case is still recorded as evidence.
  const unmatchedDrift = await makeDrift({
    naturalKey: 'group:unmatched', resourceType: 'group', changeType: 'modified', blastRadius: 'cosmetic',
  });
  const noMatchEvidence = await evidenceFor(unmatchedDrift.id);
  assert.equal(noMatchEvidence.matched, false, 'the no-match case is recorded, not silently skipped');
  assert.deepEqual(noMatchEvidence.matches, []);

  // A policy enabled after an otherwise-open drift exists gets its evaluation pass
  // through the policy-evaluate worker job. The worker runs the real CLI against this
  // isolated database; only the destructive remediation process-spawn boundary is
  // replaced with a fixture below.
  const afterDriftPolicy = await createPolicy(client, {
    tenantRef, name: 'evaluate existing group drift', resourceType: 'group',
    naturalKeyGlob: 'group:unmatched', action: 'auto_remediate', maxBlastRadius: 'tenant-lockout',
    createdBy: policyAdminId, runAsPrincipalId,
  });
  const policyEvaluateJob = await enqueue(client, {
    kind: 'policy-evaluate', params: { tenantRef }, requestedBy: policyAdminId,
  });
  await runJob(client, policyEvaluateJob, {
    dbUrl: database.url,
    onInFlightChange: () => {},
  });
  const { rows: completedPolicyEvaluateRows } = await client.query(
    'SELECT * FROM job WHERE id = $1', [policyEvaluateJob.id],
  );
  assert.equal(completedPolicyEvaluateRows[0].status, 'succeeded');
  const { rows: queuedRemediationRows } = await client.query(
    `SELECT * FROM job
      WHERE kind = 'remediate' AND params->'driftIds' @> to_jsonb($1::text)`,
    [unmatchedDrift.id],
  );
  const queuedRemediation = queuedRemediationRows[0];
  assert.ok(queuedRemediation, 'the real policy-evaluate path reaches executeAutoRemediation');
  assert.equal(queuedRemediation.requested_by, runAsPrincipalId);

  const workerFixtureDir = mkdtempSync(join(tmpdir(), 'keel-policy-evaluate-worker-'));
  const workerHandlerPath = join(workerFixtureDir, 'fake-remediate-handler.mjs');
  const reachedPath = join(workerFixtureDir, 'remediation-reached');
  writeFileSync(workerHandlerPath, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.argv[2], 'handler reached');
  `);
  await runJob(client, queuedRemediation, {
    dbUrl: database.url,
    onInFlightChange: () => {},
    handlers: {
      remediate: {
        script: workerHandlerPath,
        argsFor: () => [reachedPath],
      },
    },
  });
  assert.equal(
    existsSync(reachedPath),
    true,
    'the resulting remediation reaches a fake handler only at the process-spawn boundary',
  );
  assert.equal(afterDriftPolicy.action, 'auto_remediate');

  // Disabled and unmatched policies leave an open drift without an action, but the
  // rerun still records its no-match evaluation evidence.
  const disabledReplayPolicy = await createPolicy(client, {
    tenantRef, name: 'disabled service principal policy', resourceType: 'servicePrincipal',
    action: 'auto_remediate', maxBlastRadius: 'tenant-lockout', createdBy: policyAdminId,
    runAsPrincipalId, enabled: false,
  });
  const disabledDrift = await makeDrift({
    naturalKey: 'servicePrincipal:disabled-policy', resourceType: 'servicePrincipal',
    changeType: 'modified', blastRadius: 'cosmetic',
  });
  const unmatchedOpenDrift = await makeDrift({
    naturalKey: 'application:no-policy', resourceType: 'application', changeType: 'modified',
    blastRadius: 'cosmetic',
  });
  await evaluateOpenDrifts(client, { tenantRef });
  for (const drift of [disabledDrift, unmatchedOpenDrift]) {
    const evidence = await evidenceFor(drift.id);
    assert.equal(evidence.matched, false, `${drift.natural_key} records a no-match evaluation`);
    assert.deepEqual(evidence.matches, []);
    const { rows: actionRows } = await client.query(
      `SELECT id FROM job
       WHERE kind = 'remediate' AND params->'driftIds' @> to_jsonb($1::text)`,
      [drift.id],
    );
    assert.equal(actionRows.length, 0, `${drift.natural_key} produces no remediation action`);
  }
  assert.equal(disabledReplayPolicy.enabled, false);

  // A matching alert policy recommends 'alert' verbatim.
  const alertPolicy = await createPolicy(client, {
    tenantRef, name: 'alert on group changes', resourceType: 'group', action: 'alert',
    maxBlastRadius: 'tenant-lockout', createdBy: 'admin-1',
  });
  const alertDrift = await makeDrift({
    naturalKey: 'group:alert-me', resourceType: 'group', changeType: 'modified', blastRadius: 'cosmetic',
  });
  const alertEvidence = await evidenceFor(alertDrift.id);
  assert.deepEqual(alertEvidence.matches, [
    { policyId: alertPolicy.id, policyName: alertPolicy.name, action: 'alert', outcome: 'alert' },
  ]);

  // A disabled policy is never matched, whatever its criteria.
  const disabledPolicy = await createPolicy(client, {
    tenantRef, name: 'disabled auto-remediate', resourceType: 'group', action: 'auto_remediate',
    maxBlastRadius: 'tenant-lockout', createdBy: 'admin-1', runAsPrincipalId, enabled: false,
  });
  const disabledCheckDrift = await makeDrift({
    naturalKey: 'group:disabled-check', resourceType: 'group', changeType: 'modified', blastRadius: 'cosmetic',
  });
  const disabledEvidence = await evidenceFor(disabledCheckDrift.id);
  assert.ok(
    !disabledEvidence.matches.some((m) => m.policyId === disabledPolicy.id),
    'a disabled policy must never match',
  );

  // The structural guardrail: an auto_remediate policy whose max_blast_radius is
  // lower than the drift's blast_radius is blocked, not honoured.
  const autoRemediatePolicy = await createPolicy(client, {
    tenantRef, name: 'auto-remediate low blast radius only', resourceType: 'user', action: 'auto_remediate',
    maxBlastRadius: 'access-affecting', createdBy: 'admin-1', runAsPrincipalId,
  });
  const highBlastRadiusDrift = await makeDrift({
    naturalKey: 'user:high-blast', resourceType: 'user', changeType: 'modified', blastRadius: 'tenant-lockout',
  });
  const blockedEvidence = await evidenceFor(highBlastRadiusDrift.id);
  const blockedMatch = blockedEvidence.matches.find((m) => m.policyId === autoRemediatePolicy.id);
  assert.ok(blockedMatch, 'the policy still matches — it is the outcome that is guarded, not the match');
  assert.notEqual(
    blockedMatch.outcome, 'auto_remediate',
    'a high-blast-radius drift must never auto-remediate above the policy\'s max_blast_radius',
  );
  assert.equal(blockedMatch.outcome, 'blocked-max-blast-radius');
  assert.equal(blockedEvidence.matched, true, 'a blocked outcome is still a match, recorded as such');

  // The same policy permits auto_remediate for a drift within its cap.
  const withinCapDrift = await makeDrift({
    naturalKey: 'user:within-cap', resourceType: 'user', changeType: 'modified', blastRadius: 'access-affecting',
  });
  const permittedEvidence = await evidenceFor(withinCapDrift.id);
  const permittedMatch = permittedEvidence.matches.find((m) => m.policyId === autoRemediatePolicy.id);
  assert.equal(permittedMatch.outcome, 'auto_remediate');

  // blast_radius is a match criterion in its own right. A policy scoped to
  // access-affecting rows must not auto-remediate a tenant-lockout row, even
  // where its own cap would otherwise permit it. This kills the task mutation
  // that ignores blast_radius while matching.
  const blastRadiusScopedPolicy = await createPolicy(client, {
    tenantRef, name: 'auto-remediate access-affecting groups only', resourceType: 'group',
    blastRadius: 'access-affecting', action: 'auto_remediate', maxBlastRadius: 'tenant-lockout',
    createdBy: 'admin-1', runAsPrincipalId,
  });
  const highBlastRadiusScopedDrift = await makeDrift({
    naturalKey: 'group:high-blast', resourceType: 'group', changeType: 'modified', blastRadius: 'tenant-lockout',
  });
  const highBlastRadiusScopedEvidence = await evidenceFor(highBlastRadiusScopedDrift.id);
  assert.ok(
    !highBlastRadiusScopedEvidence.matches.some((match) => match.policyId === blastRadiusScopedPolicy.id
      && match.outcome === 'auto_remediate'),
    'a high-blast-radius drift must not auto-remediate through an access-affecting policy match',
  );

  // The whole evidence chain, including every no-match and blocked evaluation
  // written above, still verifies.
  assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: true });
} finally {
  await client?.end();
  await database.cleanup();
}
console.log('evaluate.test.mjs — all assertions passed');
