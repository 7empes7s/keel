import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTOMATION_EXECUTION_EVIDENCE_KIND, executeAutoRemediation } from './execute.mjs';
import { createPolicy } from './evaluate.mjs';
import { verifyChain } from '../govern/evidence.mjs';
import { seedFromSnapshot } from '../govern/baseline.mjs';
import { createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
try {
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));

  const tenantRef = 'sha256:policy-execute-test';
  // The admin who creates a policy is who task 25 re-authorizes an automatic job
  // against at execution time — a real principal id, not a display string.
  const adminPrincipalId = '11111111-1111-1111-1111-111111111111';

  let naturalKeyCounter = 0;
  async function makeDrift({ blastRadius = 'access-affecting' } = {}) {
    naturalKeyCounter += 1;
    const naturalKey = `group:execute-test-${naturalKeyCounter}`;
    const baselineSnapshotId = await createSnapshot(client, { tenantRef });
    await insertResourceVersion(client, {
      snapshotId: baselineSnapshotId,
      resource: {
        naturalKey, resourceType: 'group', payload: { displayName: 'Baseline' },
        payloadHash: `${naturalKey}-before`, criticality: 'tier1', blastRadius,
        fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
    const baselineId = await seedFromSnapshot(client, {
      tenantRef, snapshotId: baselineSnapshotId, setBy: adminPrincipalId,
    });
    const observedSnapshotId = await createSnapshot(client, { tenantRef });
    const { rows } = await client.query(
      `INSERT INTO drift
         (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
          before_hash, after_hash, before_payload, after_payload, blast_radius)
       VALUES ($1,$2,$3,$4,'group','modified',$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        tenantRef, baselineId, observedSnapshotId, naturalKey,
        `${naturalKey}-before`, `${naturalKey}-after`,
        { displayName: 'Baseline' }, { displayName: 'Changed' }, blastRadius,
      ],
    );
    return rows[0];
  }

  async function makeAutoRemediatePolicy(overrides = {}) {
    return createPolicy(client, {
      tenantRef, name: 'auto-remediate group changes', resourceType: 'group', action: 'auto_remediate',
      maxBlastRadius: 'tenant-lockout', createdBy: adminPrincipalId, ...overrides,
    });
  }

  async function jobFor(driftId) {
    const { rows } = await client.query(
      `SELECT * FROM job WHERE kind = 'remediate' AND params->'driftIds' @> to_jsonb($1::text)`,
      [driftId],
    );
    return rows[0] ?? null;
  }

  async function evidenceFor(driftId, outcome) {
    const { rows } = await client.query(
      `SELECT subject FROM evidence
       WHERE tenant_ref = $1 AND kind = $2 AND subject->>'driftId' = $3 AND subject->>'outcome' = $4
       ORDER BY seq DESC LIMIT 1`,
      [tenantRef, AUTOMATION_EXECUTION_EVIDENCE_KIND, driftId, outcome],
    );
    return rows[0]?.subject ?? null;
  }

  // --- happy path: a permitted auto_remediate policy enqueues exactly one job ---
  {
    const policy = await makeAutoRemediatePolicy();
    const drift = await makeDrift();
    const result = await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id });
    assert.equal(result.executed, true);
    assert.equal(result.outcome, 'executed');
    assert.ok(result.jobId);

    const job = await jobFor(drift.id);
    assert.ok(job, 'an executed outcome must enqueue exactly one remediate job');
    assert.equal(job.kind, 'remediate');
    assert.equal(job.requested_by, adminPrincipalId, 'the job is requested by the policy\'s own creator');
    assert.deepEqual(job.params, { driftIds: [drift.id], mode: 'enforce' });

    const evidence = await evidenceFor(drift.id, 'executed');
    assert.equal(evidence.policyId, policy.id);
    assert.equal(evidence.jobId, job.id);

    // A second call for the SAME drift and policy must not enqueue a second job — the
    // idempotency key pins it to exactly one.
    const replay = await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id });
    assert.equal(replay.jobId, result.jobId, 'a repeated evaluation of the same drift must not double-enqueue');
    const { rows: allJobs } = await client.query(
      `SELECT id FROM job WHERE kind = 'remediate' AND params->'driftIds' @> to_jsonb($1::text)`,
      [drift.id],
    );
    assert.equal(allJobs.length, 1);
  }

  // --- the kill switch stops every policy, unconditionally ---
  {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'keel-automation-kill-switch-'));
    const killSwitchPath = join(fixtureDir, 'AUTOMATION_DISABLED');
    writeFileSync(killSwitchPath, '');

    const policy = await makeAutoRemediatePolicy();
    const drift = await makeDrift();
    const result = await executeAutoRemediation(client, {
      tenantRef, drift, policyId: policy.id, killSwitchPath,
    });
    assert.equal(result.executed, false);
    assert.equal(result.outcome, 'automation-disabled');
    assert.equal(await jobFor(drift.id), null, 'the kill switch must prevent any job, not merely skip one');
    assert.ok(await evidenceFor(drift.id, 'automation-disabled'), 'a kill-switch refusal is still recorded');
  }

  // --- a disabled policy takes no automatic action ---
  {
    const policy = await makeAutoRemediatePolicy({ enabled: false });
    const drift = await makeDrift();
    const result = await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id });
    assert.equal(result.executed, false);
    assert.equal(result.outcome, 'policy-disabled');
    assert.equal(await jobFor(drift.id), null);
  }

  // --- the max_blast_radius guardrail is re-verified here, not trusted from a caller ---
  {
    const policy = await makeAutoRemediatePolicy({ maxBlastRadius: 'cosmetic' });
    const drift = await makeDrift({ blastRadius: 'tenant-lockout' });
    const result = await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id });
    assert.equal(result.executed, false);
    assert.equal(result.outcome, 'blocked-max-blast-radius');
    assert.equal(await jobFor(drift.id), null);
  }

  // --- the rate limit PAUSES the policy when exceeded, rather than dropping the
  // action silently. This is the mutation target: a "drop it and move on"
  // implementation would still refuse the action but would leave paused_at null. ---
  {
    const policy = await makeAutoRemediatePolicy({ maxActionsPerWindow: 1, windowSeconds: 3600 });

    const firstDrift = await makeDrift();
    const first = await executeAutoRemediation(client, { tenantRef, drift: firstDrift, policyId: policy.id });
    assert.equal(first.executed, true, 'the first action within the window is permitted');

    const secondDrift = await makeDrift();
    const second = await executeAutoRemediation(client, { tenantRef, drift: secondDrift, policyId: policy.id });
    assert.equal(second.executed, false);
    assert.equal(second.outcome, 'rate-limit-paused');
    assert.equal(await jobFor(secondDrift.id), null, 'the action that trips the limit must not enqueue a job');

    const { rows: pausedRows } = await client.query('SELECT paused_at FROM policy WHERE id = $1', [policy.id]);
    assert.ok(pausedRows[0].paused_at, 'exceeding the rate limit must pause the policy, not merely skip this action');

    // A third, otherwise-permitted drift under the SAME policy is refused purely
    // because the policy itself is now paused — proving the whole policy stopped,
    // not just the one action that tripped the limit.
    const thirdDrift = await makeDrift();
    const third = await executeAutoRemediation(client, { tenantRef, drift: thirdDrift, policyId: policy.id });
    assert.equal(third.executed, false);
    assert.equal(third.outcome, 'policy-paused');
    assert.equal(await jobFor(thirdDrift.id), null);
  }

  // A policy with no rate limit configured (max_actions_per_window / window_seconds
  // both null) is never paused — the guardrail is opt-in via configuration, not a
  // hidden default.
  {
    const policy = await makeAutoRemediatePolicy();
    for (let i = 0; i < 3; i += 1) {
      const drift = await makeDrift();
      const result = await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id });
      assert.equal(result.executed, true, `action ${i} must not be rate-limited when no limit is configured`);
    }
    const { rows } = await client.query('SELECT paused_at FROM policy WHERE id = $1', [policy.id]);
    assert.equal(rows[0].paused_at, null);
  }

  // The whole evidence chain, including every refusal above, still verifies.
  assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: true });
} finally {
  await client?.end();
  await database.cleanup();
}
console.log('execute.test.mjs — all assertions passed');
