import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTOMATION_EXECUTION_EVIDENCE_KIND, executeAutoRemediation } from './execute.mjs';
import { createPolicy, setPolicyEnabled } from './evaluate.mjs';
import { verifyChain } from '../govern/evidence.mjs';
import { seedFromSnapshot } from '../govern/baseline.mjs';
import { createSnapshot, insertResourceVersion } from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { runJob } from '../../cli/keel-worker.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
try {
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));

  const tenantRef = 'sha256:policy-execute-test';
  // The admin remains audit provenance only. A separate restorer principal is the
  // explicit executable identity for every auto-remediation policy below.
  const adminPrincipalId = '11111111-1111-1111-1111-111111111111';
  const runAsPrincipalId = '22222222-2222-2222-2222-222222222222';
  await client.query(
    `INSERT INTO principal (id, email, display_name)
     VALUES ($1, 'policy-admin@example.com', 'Policy admin'),
            ($2, 'policy-run-as@example.com', 'Policy run-as')`,
    [adminPrincipalId, runAsPrincipalId],
  );
  await client.query(
    `INSERT INTO role_grant (principal_id, role, granted_by, reason)
     VALUES ($1, 'admin', 'test', 'policy administrator'),
            ($2, 'restorer', 'test', 'policy executable identity')`,
    [adminPrincipalId, runAsPrincipalId],
  );

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
      maxBlastRadius: 'tenant-lockout', createdBy: adminPrincipalId, runAsPrincipalId, ...overrides,
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

  const workerFixtureDir = mkdtempSync(join(tmpdir(), 'keel-policy-worker-fixture-'));
  const workerHandlerPath = join(workerFixtureDir, 'fake-remediate-handler.mjs');
  writeFileSync(workerHandlerPath, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.argv[2], 'handler reached');
  `);

  async function runQueuedRemediation(job, reachedPath) {
    await runJob(client, job, {
      dbUrl: database.url,
      onInFlightChange: () => {},
      handlers: {
        remediate: {
          script: workerHandlerPath,
          argsFor: () => [reachedPath],
        },
      },
    });
  }

  async function addCurrentRestorer(label) {
    const { rows } = await client.query(
      `INSERT INTO principal (email, display_name)
       VALUES ($1, $2)
       RETURNING *`,
      [`${label}-${Date.now()}-${Math.random()}@example.com`, label],
    );
    const principal = rows[0];
    await client.query(
      `INSERT INTO role_grant (principal_id, role, active_from, granted_by, reason)
       VALUES ($1, 'restorer', now() - interval '1 second', 'test', 'temporary policy run-as')`,
      [principal.id],
    );
    return principal;
  }

  // An administrator has policies authority but deliberately has no remediate
  // capability. There is no creator fallback: an admin-only identity cannot create
  // executable automation, and enabling a policy validates its run-as again.
  await assert.rejects(
    () => makeAutoRemediatePolicy({ runAsPrincipalId: adminPrincipalId }),
    /run-as principal must be registered, enabled, and currently authorized for remediate/,
  );
  const disabledButRepairable = await makeAutoRemediatePolicy({ enabled: false });
  const enabled = await setPolicyEnabled(client, { policyId: disabledButRepairable.id, enabled: true });
  assert.equal(enabled.enabled, true, 'a current restorer run-as can enable its policy');
  const expiredRunAs = await addCurrentRestorer('expired-enable-run-as');
  const disabledWithExpiringRunAs = await makeAutoRemediatePolicy({
    enabled: false, runAsPrincipalId: expiredRunAs.id,
  });
  await client.query(
    `UPDATE role_grant
        SET active_until = now() - interval '1 second'
      WHERE principal_id = $1`,
    [expiredRunAs.id],
  );
  await assert.rejects(
    () => setPolicyEnabled(client, { policyId: disabledWithExpiringRunAs.id, enabled: true }),
    /run-as principal must be registered, enabled, and currently authorized for remediate/,
  );

  // Additive/idempotent migration: a legacy automatic policy without a run-as is
  // never bound to its creator. It is disabled, paused, and explicitly marked for
  // operator repair; a second schema application leaves the pause timestamp intact.
  const { rows: legacyRows } = await client.query(
    `INSERT INTO policy
       (tenant_ref, name, enabled, action, max_blast_radius, created_by)
     VALUES ($1, 'legacy missing run-as', true, 'auto_remediate', 'tenant-lockout', $2)
     RETURNING *`,
    [tenantRef, adminPrincipalId],
  );
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const { rows: migratedRows } = await client.query('SELECT * FROM policy WHERE id = $1', [legacyRows[0].id]);
  assert.equal(migratedRows[0].enabled, false);
  assert.equal(migratedRows[0].run_as_repair_required, true);
  assert.ok(migratedRows[0].paused_at, 'legacy automatic policy is paused pending repair');
  const pausedAt = migratedRows[0].paused_at.toISOString();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const { rows: remigratedRows } = await client.query('SELECT * FROM policy WHERE id = $1', [legacyRows[0].id]);
  assert.equal(remigratedRows[0].paused_at.toISOString(), pausedAt, 'migration is idempotent');

  // --- happy path: an admin creator plus an explicitly authorized restorer run-as
  // queues exactly one job, then reaches a fake worker handler under that run-as ---
  {
    const policy = await makeAutoRemediatePolicy();
    const drift = await makeDrift();
    const result = await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id });
    assert.equal(result.executed, false, 'enqueueing is not execution');
    assert.equal(result.outcome, 'queued');
    assert.ok(result.jobId);

    const job = await jobFor(drift.id);
    assert.ok(job, 'a queued outcome must enqueue exactly one remediate job');
    assert.equal(job.kind, 'remediate');
    assert.deepEqual(job.params, { driftIds: [drift.id], mode: 'enforce' });

    const queuedEvidence = await evidenceFor(drift.id, 'queued');
    assert.ok(queuedEvidence, 'enqueue records queued evidence before worker execution');
    assert.equal(queuedEvidence.policyId, policy.id);
    assert.equal(queuedEvidence.jobId, job.id);
    assert.equal(await evidenceFor(drift.id, 'executed'), null, 'queued work is never recorded as executed');

    // A second call for the SAME drift and policy must not enqueue a second job — the
    // idempotency key pins it to exactly one.
    const replay = await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id });
    assert.equal(replay.outcome, 'queued');
    assert.equal(replay.jobId, result.jobId, 'a repeated evaluation of the same drift must not double-enqueue');
    const { rows: allJobs } = await client.query(
      `SELECT id FROM job WHERE kind = 'remediate' AND params->'driftIds' @> to_jsonb($1::text)`,
      [drift.id],
    );
    assert.equal(allJobs.length, 1);

    const reachedPath = join(workerFixtureDir, `reached-${job.id}`);
    await runQueuedRemediation(job, reachedPath);
    assert.equal(existsSync(reachedPath), true, 'the current restorer run-as reaches the fake remediation handler');
    assert.equal(job.requested_by, runAsPrincipalId, 'the job is requested by the explicit run-as principal');
    const { rows: completedRows } = await client.query('SELECT * FROM job WHERE id = $1', [job.id]);
    assert.equal(completedRows[0].status, 'succeeded');
    const executedEvidence = await evidenceFor(drift.id, 'executed');
    assert.equal(executedEvidence.policyId, policy.id);
    assert.equal(executedEvidence.driftId, drift.id);
    assert.equal(executedEvidence.jobId, job.id);
    assert.equal(executedEvidence.jobStatus, 'succeeded');
  }

  // Once a policy job is queued, the worker's existing execution-time check remains
  // authoritative. Deleting, disabling, or expiring the run-as grant makes the job
  // fail before the fake handler and appends the real failed terminal outcome.
  async function assertInvalidatedRunAsFailsBeforeHandler(label, invalidate) {
    const principal = await addCurrentRestorer(`${label}-run-as`);
    const policy = await makeAutoRemediatePolicy({ runAsPrincipalId: principal.id });
    const drift = await makeDrift();
    const queued = await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id });
    assert.equal(queued.outcome, 'queued');
    const job = await jobFor(drift.id);
    await invalidate(principal);

    const reachedPath = join(workerFixtureDir, `must-not-reach-${label}-${job.id}`);
    await runQueuedRemediation(job, reachedPath);
    assert.equal(existsSync(reachedPath), false, `${label}: run-as failure stops before the handler`);
    const { rows: failedRows } = await client.query('SELECT * FROM job WHERE id = $1', [job.id]);
    assert.equal(failedRows[0].status, 'failed');
    assert.match(failedRows[0].error, /requester no longer authorized for kind: remediate/);
    const failedEvidence = await evidenceFor(drift.id, 'failed');
    assert.equal(failedEvidence.policyId, policy.id);
    assert.equal(failedEvidence.driftId, drift.id);
    assert.equal(failedEvidence.jobId, job.id);
    assert.equal(failedEvidence.jobStatus, 'failed');
    assert.equal(await evidenceFor(drift.id, 'executed'), null, `${label}: failure cannot leave false success evidence`);
  }

  await assertInvalidatedRunAsFailsBeforeHandler('revoked', (principal) => client.query(
    'DELETE FROM role_grant WHERE principal_id = $1', [principal.id],
  ));
  await assertInvalidatedRunAsFailsBeforeHandler('disabled', (principal) => client.query(
    'UPDATE principal SET disabled_at = now() WHERE id = $1', [principal.id],
  ));
  await assertInvalidatedRunAsFailsBeforeHandler('expired', (principal) => client.query(
    `UPDATE role_grant
        SET active_until = now() - interval '1 second'
      WHERE principal_id = $1`,
    [principal.id],
  ));

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
    assert.equal(first.executed, false, 'the first action within the window is queued, not yet executed');
    assert.equal(first.outcome, 'queued');

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
      assert.equal(result.outcome, 'queued', `action ${i} must not be rate-limited when no limit is configured`);
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
