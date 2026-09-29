/**
 * Roadmap task-55 boundary tests: automation limits are enforced AFTER dependency
 * expansion. Exercises the production path end to end —
 * engine/policy/execute.mjs (enqueue) -> cli/keel-remediate.mjs -> cli/keel-restore.mjs
 * (dry-run artifact -> promotion) — against an isolated test database with only the
 * Graph/token boundaries faked. Covers the acceptance cases and the three required
 * mutation checks:
 *
 * - Check original drift only.          (scenario A: drift under ceiling, expanded
 *                                        dependency above ceiling refuses before any write)
 * - Trust caller-supplied ceiling.      (scenario D: ceiling lowered between enqueue
 *                                        and execution is re-resolved from the live row)
 * - Skip promotion-time policy version check. (scenario C: policy changed between dry
 *                                        run and promotion refuses)
 */
import { strict as assert } from 'node:assert';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

import {
  exceedsBlastRadiusCeiling, maxOperationImpact, policyConstraintVersion,
} from '../policy/evaluate.mjs';
import { createPolicy } from '../policy/evaluate.mjs';
import {
  AUTOMATION_EXECUTION_EVIDENCE_KIND, AUTOMATION_KILL_SWITCH_PATH, executeAutoRemediation, recordAutoRemediationTerminalOutcome,
} from '../policy/execute.mjs';
import { computePlanDigest } from '../restore/dryRunArtifact.mjs';
import { seedFromSnapshot } from '../govern/baseline.mjs';
import { verifyChain } from '../govern/evidence.mjs';
import {
  completeSnapshot, createSnapshot, getResourceVersions, insertReferences, insertResourceVersion,
} from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';
import { runRemediate } from '../../cli/keel-remediate.mjs';
import { runRestore } from '../../cli/keel-restore.mjs';

const noopLogger = { log() {}, error() {} };

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
try {
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));

  const tenantRef = 'sha256:closure-ceiling-test';
  const adminPrincipalId = '11111111-1111-1111-1111-111111111111';
  const runAsPrincipalId = '22222222-2222-2222-2222-222222222222';
  const secondRunAsPrincipalId = '33333333-3333-3333-3333-333333333333';
  await client.query(
    `INSERT INTO principal (id, email, display_name)
     VALUES ($1, 'closure-admin@example.com', 'Closure admin'),
            ($2, 'closure-run-as@example.com', 'Closure run-as'),
            ($3, 'closure-run-as-2@example.com', 'Closure run-as second')`,
    [adminPrincipalId, runAsPrincipalId, secondRunAsPrincipalId],
  );
  await client.query(
    `INSERT INTO role_grant (principal_id, role, granted_by, reason)
     VALUES ($1, 'admin', 'test', 'policy administrator'),
            ($2, 'restorer', 'test', 'policy executable identity'),
            ($3, 'restorer', 'test', 'replacement policy executable identity')`,
    [adminPrincipalId, runAsPrincipalId, secondRunAsPrincipalId],
  );

  const financePayload = { displayName: 'Finance', mailNickname: 'Finance', members: ['source-privileged-id'] };
  const privilegedPayload = { displayName: 'Privileged', mailNickname: 'Privileged' };
  // The dependency exists in the target but drifted, so remediating it is an UPDATE
  // — an actual tenant-lockout operation the closure-ceiling check must count.
  const driftedPrivilegedTarget = { id: 'target-Privileged', displayName: 'Privileged drifted', mailNickname: 'Privileged' };

  /** Baseline snapshot where the drifted cosmetic group REFERENCES a tenant-lockout
   * group: the dependency closure of a remediation expands beyond the original drift. */
  async function seedBaselineWithPrivilegedDependency() {
    const snapshotId = await createSnapshot(client, { tenantRef });
    const financeVersionId = await insertResourceVersion(client, {
      snapshotId,
      resource: {
        naturalKey: 'group:Finance', resourceType: 'group', payload: financePayload,
        payloadHash: 'finance-baseline', criticality: 'tier1', blastRadius: 'cosmetic',
        fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
    await insertResourceVersion(client, {
      snapshotId,
      resource: {
        naturalKey: 'group:Privileged', resourceType: 'group', payload: privilegedPayload,
        payloadHash: 'privileged-baseline', criticality: 'tier1', blastRadius: 'tenant-lockout',
        fidelity: 'full', provenance: { adapter: 'test' },
      },
    });
    await insertReferences(client, {
      fromVersion: financeVersionId,
      references: [{ field: 'members[0]', symbol: 'group:Privileged', required: true }],
    });
    await completeSnapshot(client, {
      id: snapshotId, status: 'complete', coverageDigest: fullSuccessfulCoverageDigest(),
    });
    const baselineId = await seedFromSnapshot(client, {
      tenantRef, snapshotId, setBy: adminPrincipalId,
    });
    return { snapshotId, baselineId };
  }

  async function insertCosmeticFinanceDrift(baselineId) {
    const observedSnapshotId = await createSnapshot(client, { tenantRef });
    const { rows } = await client.query(
      `INSERT INTO drift
         (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
          before_hash, after_hash, before_payload, after_payload, blast_radius)
       VALUES ($1,$2,$3,'group:Finance','group','modified','finance-baseline','finance-drifted',
               $4,$5,'cosmetic')
       RETURNING *`,
      [tenantRef, baselineId, observedSnapshotId, financePayload, { ...financePayload, displayName: 'Finance drifted' }],
    );
    return rows[0];
  }

  async function makePolicy(overrides = {}) {
    return createPolicy(client, {
      tenantRef, name: 'auto-remediate group changes', resourceType: 'group', action: 'auto_remediate',
      maxBlastRadius: 'cosmetic', createdBy: adminPrincipalId, runAsPrincipalId, ...overrides,
    });
  }

  // --- Fake Graph boundary: only the target tenant reads/writes are faked. -------
  function makeGraphFakes() {
    const globalAdministrator = '62e90394-69f5-4237-9190-012177145e10';
    const breakGlassRoleAssignment = {
      id: 'target-break-glass-role-id', roleDefinitionId: globalAdministrator,
      principalId: 'break-glass-id', directoryScopeId: '/',
    };
    const liveGroups = new Map([['target-Privileged', { ...driftedPrivilegedTarget }]]);
    const state = { writes: [] };

    class FakeReader {
      async collect(version, path) {
        assert.equal(version, 'v1.0');
        if (path.startsWith('/groups?')) return { items: [...liveGroups.values()], capped: false, error: null };
        if (path === '/directory/deletedItems/microsoft.graph.group') return { items: [], capped: false, error: null };
        if (path === '/identity/conditionalAccess/policies') return { items: [], capped: false, error: null };
        if (path.startsWith('/roleManagement/directory/roleAssignments')) return { items: [breakGlassRoleAssignment], capped: false, error: null };
        throw new Error(`unexpected collector read: ${path}`);
      }

      async get(version, path) {
        assert.equal(version, 'v1.0');
        if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'methods' } };
        if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'defaults', isEnabled: false } };
        if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
        throw new Error(`unexpected collector get: ${path}`);
      }
    }

    class FakeWriter {
      async write(version, path, options) {
        assert.equal(version, 'v1.0');
        state.writes.push({ path, method: options.method, body: options.body });
        if (options.method === 'POST' && path === '/groups') {
          const id = `target-${options.body.mailNickname}`;
          liveGroups.set(id, { ...options.body, id });
          return { ok: true, status: 201, body: { id } };
        }
        if (options.method === 'PATCH' && path.startsWith('/groups/')) {
          const id = path.split('/').at(-1);
          liveGroups.set(id, { ...liveGroups.get(id), ...options.body });
          return { ok: true, status: 204, body: null };
        }
        throw new Error(`unexpected Graph write: ${options.method} ${path}`);
      }

      async read(version, path) {
        assert.equal(version, 'v1.0');
        const group = liveGroups.get(path.split('/').at(-1));
        return group
          ? { ok: true, status: 200, body: group }
          : { ok: false, status: 404, body: null };
      }
    }

    return {
      state,
      liveGroups,
      dependencies: {
        getToken: async () => ({ accessToken: 'fake-token' }),
        GraphReader: FakeReader,
        collectM1: async () => [['group', [...liveGroups.values()]], ['roleAssignment', [breakGlassRoleAssignment]]],
        GraphWriter: FakeWriter,
        ThrottleGovernor: class { async acquire() {} },
      },
    };
  }

  const configs = new Map([
    ['/fixtures/collector.json', JSON.stringify({ tenantId: 'target', clientId: 'collector', certPath: '/c.cer', keyPath: '/c.key' })],
    ['/fixtures/restorer.json', JSON.stringify({ tenantId: 'target', clientId: 'restorer', certPath: '/r.cer', keyPath: '/r.key' })],
  ]);
  const readFile = (path) => {
    const config = configs.get(path);
    if (!config) throw new Error(`unexpected config read: ${path}`);
    return config;
  };

  async function jobForDrift(driftId) {
    const { rows } = await client.query(
      `SELECT * FROM job WHERE kind = 'remediate' AND params->'driftIds' @> to_jsonb($1::text)`,
      [driftId],
    );
    return rows[0] ?? null;
  }

  async function automationEvidence(driftId, outcome) {
    const { rows } = await client.query(
      `SELECT subject FROM evidence
        WHERE tenant_ref = $1 AND kind = $2 AND subject->>'outcome' = $3
          AND ($4::text IS NULL OR subject->>'driftId' = $4)
        ORDER BY seq DESC`,
      [tenantRef, AUTOMATION_EXECUTION_EVIDENCE_KIND, outcome, driftId],
    );
    return rows.map((row) => row.subject);
  }

  // ---------------------------------------------------------------------------
  // Scenario A (mutation: "check original drift only"). The original drift is
  // cosmetic and passes the enqueue-time guardrail under a cosmetic ceiling, but
  // its dependency closure pulls in a tenant-lockout group. The automation must
  // refuse with the existing blocked-max-blast-radius outcome BEFORE any write.
  // ---------------------------------------------------------------------------
  {
    const { snapshotId, baselineId } = await seedBaselineWithPrivilegedDependency();
    const drift = await insertCosmeticFinanceDrift(baselineId);
    const policy = await makePolicy({ maxBlastRadius: 'cosmetic' });

    const queued = await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id });
    assert.equal(queued.outcome, 'queued', 'the original cosmetic drift is under the cosmetic ceiling at enqueue');
    const job = await jobForDrift(drift.id);
    assert.ok(job, 'enqueue minted exactly one remediate job');

    const fakes = makeGraphFakes();
    await assert.rejects(
      () => runRemediate({
        driftIds: [drift.id],
        targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
        collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')),
        targetConfigPath: '/fixtures/restorer.json',
        collectorConfigPath: '/fixtures/collector.json',
        mode: 'enforce',
        requestedBy: runAsPrincipalId,
        readFile,
        dbUrl: database.url,
        dependencies: fakes.dependencies,
        logger: noopLogger,
      }),
      /blocked-max-blast-radius/,
      'the expanded closure above the ceiling must refuse, not execute',
    );
    assert.equal(fakes.state.writes.length, 0, 'the refusal happens before any write');

    const { rows: artifacts } = await client.query(
      'SELECT id FROM restore_dry_run WHERE snapshot_id = $1',
      [snapshotId],
    );
    assert.equal(artifacts.length, 0, 'a refused remediation persists no promotable artifact');

    const blocked = await automationEvidence(null, 'blocked-max-blast-radius');
    assert.ok(blocked.length >= 1, 'the existing blocked-max-blast-radius refusal is recorded');
    assert.deepEqual(blocked[0].policyIds, [policy.id]);
    assert.equal(blocked[0].maxImpact, 'tenant-lockout');
    assert.equal(blocked[0].maxBlastRadiusCeiling, 'cosmetic');
    assert.deepEqual(
      [...blocked[0].expandedScope].sort(),
      ['group:Finance', 'group:Privileged'],
      'the refusal evidence names the expanded scope, not only the original drift',
    );
    assert.equal(
      (await automationEvidence(drift.id, 'executed')).length,
      0,
      'a refused automation is never recorded as executed',
    );

    // The worker's terminal outcome closes the loop: failed, never executed.
    const terminal = await recordAutoRemediationTerminalOutcome(client, {
      job, status: 'failed', error: 'blocked-max-blast-radius: expanded closure impact tenant-lockout exceeds the current automation policy ceiling cosmetic',
    });
    assert.equal(terminal.status, 'failed');
    assert.equal((await automationEvidence(drift.id, 'executed')).length, 0);
  }

  // ---------------------------------------------------------------------------
  // Scenario B: within-ceiling automation still works, and the immutable dry-run
  // artifact carries the policy identity/version and the expanded scope as plan
  // evidence. The same artifact then promotes through the artifact-only path.
  // ---------------------------------------------------------------------------
  {
    const { snapshotId, baselineId } = await seedBaselineWithPrivilegedDependency();
    const drift = await insertCosmeticFinanceDrift(baselineId);
    const policy = await makePolicy({ maxBlastRadius: 'tenant-lockout' });

    const queued = await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id });
    assert.equal(queued.outcome, 'queued');
    const job = await jobForDrift(drift.id);

    const fakes = makeGraphFakes();
    await runRemediate({
      driftIds: [drift.id],
      targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
      collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')),
      targetConfigPath: '/fixtures/restorer.json',
      collectorConfigPath: '/fixtures/collector.json',
      mode: 'enforce',
      requestedBy: runAsPrincipalId,
      readFile,
      dbUrl: database.url,
      dependencies: fakes.dependencies,
      logger: noopLogger,
    });

    assert.deepEqual(
      fakes.state.writes.map(({ path, method }) => `${method} ${path}`).sort(),
      [
        'PATCH /groups/target-Privileged',
        'PATCH /groups/target-Privileged',
        'POST /groups',
      ],
      'within-ceiling remediation writes the whole expanded closure (the dependency update, the drifted create, and the wave planner\'s deferred reference patch for the Finance<->Privileged edge)',
    );
    assert.equal(fakes.liveGroups.size, 2);

    const { rows: artifacts } = await client.query(
      'SELECT * FROM restore_dry_run WHERE snapshot_id = $1',
      [snapshotId],
    );
    assert.equal(artifacts.length, 1, 'the remediation persists exactly one immutable artifact');
    const artifact = artifacts[0];
    assert.equal(artifact.status, 'completed');
    const context = artifact.automation_context;
    assert.ok(context, 'the artifact carries automation plan evidence');
    assert.equal(context.policies.length, 1);
    assert.equal(context.policies[0].id, policy.id);
    assert.match(context.policies[0].version, /^[0-9a-f]{64}$/, 'the policy version is a content fingerprint');
    assert.equal(context.maxImpact, 'tenant-lockout');
    assert.equal(context.maxBlastRadiusCeiling, 'tenant-lockout');
    assert.deepEqual(
      [...context.expandedScope].sort(),
      ['group:Finance', 'group:Privileged'],
      'the immutable evidence records the expanded scope the impact was computed over',
    );
    assert.deepEqual(
      context.operations.map((operation) => ({ naturalKey: operation.naturalKey, blastRadius: operation.blastRadius })),
      [
        { naturalKey: 'group:Finance', blastRadius: 'cosmetic' },
        { naturalKey: 'group:Privileged', blastRadius: 'tenant-lockout' },
      ],
    );

    const terminal = await recordAutoRemediationTerminalOutcome(client, { job, status: 'succeeded' });
    assert.equal(terminal.status, 'executed', 'a within-ceiling automation may complete');
    assert.equal((await automationEvidence(drift.id, 'executed')).length, 1);
  }

  // ---------------------------------------------------------------------------
  // Scenario C (mutation: "skip promotion-time policy version check"). A policy
  // whose constraints change between the dry run and promotion invalidates the
  // immutable plan, even when the change does not alter the ceiling outcome.
  // Restoring the original constraints lets the same artifact promote — the
  // refusal came from live policy state, never from artifact corruption.
  // ---------------------------------------------------------------------------
  {
    const { snapshotId } = await seedBaselineWithPrivilegedDependency();
    const policy = await makePolicy({ maxBlastRadius: 'tenant-lockout' });
    const artifactId = '55555555-0000-4000-8000-000000000001';

    const dryRunFakes = makeGraphFakes();
    const dryRun = await runRestore({
      snapshotId,
      selection: ['group:Finance'],
      targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
      collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')),
      targetConfigPath: '/fixtures/restorer.json',
      collectorConfigPath: '/fixtures/collector.json',
      mode: 'dry-run',
      persistArtifactId: artifactId,
      automationPolicyIds: [policy.id],
      requestedBy: runAsPrincipalId,
      readFile,
      dbUrl: database.url,
      dependencies: dryRunFakes.dependencies,
      logger: noopLogger,
    });
    assert.equal(dryRun.artifactId, artifactId);
    assert.equal(dryRunFakes.state.writes.length, 0, 'a dry run never writes');

    // A global stop after planning must also prevent artifact-only promotion.
    const originalExistsSync = fs.existsSync;
    const stoppedPromotionFakes = makeGraphFakes();
    try {
      fs.existsSync = (path) => path === AUTOMATION_KILL_SWITCH_PATH || originalExistsSync(path);
      syncBuiltinESMExports();
      await assert.rejects(() => runRestore({
        artifactId, mode: 'enforce', readFile, dbUrl: database.url,
        dependencies: stoppedPromotionFakes.dependencies, logger: noopLogger,
      }), /automation-disabled/);
      assert.equal(stoppedPromotionFakes.state.writes.length, 0);
    } finally {
      fs.existsSync = originalExistsSync;
      syncBuiltinESMExports();
    }

    // The policy's executable identity changes hands before promotion: the ceiling
    // is unchanged, so only the promotion-time policy version check can catch this.
    await client.query('UPDATE policy SET run_as_principal_id = $1 WHERE id = $2', [secondRunAsPrincipalId, policy.id]);
    const refusedPromotionFakes = makeGraphFakes();
    await assert.rejects(
      () => runRestore({
        artifactId,
        mode: 'enforce',
        readFile,
        dbUrl: database.url,
        dependencies: refusedPromotionFakes.dependencies,
        logger: noopLogger,
      }),
      /automation policy .* constraints changed since the dry run/,
      'a changed policy invalidates promotion even when the ceiling outcome is unchanged',
    );
    assert.equal(refusedPromotionFakes.state.writes.length, 0, 'the refused promotion writes nothing');

    await client.query('UPDATE policy SET run_as_principal_id = $1 WHERE id = $2', [runAsPrincipalId, policy.id]);
    // A policy fingerprint does not capture current role grants. Revoke the
    // unchanged run-as principal after planning; promotion must authorize again.
    await client.query(
      "UPDATE role_grant SET active_until = now() WHERE principal_id = $1",
      [runAsPrincipalId],
    );
    const revokedFakes = makeGraphFakes();
    await assert.rejects(
      () => runRestore({
        artifactId, mode: 'enforce', readFile, dbUrl: database.url,
        dependencies: revokedFakes.dependencies, logger: noopLogger,
      }),
      /run-as-not-authorized/,
      'grant revocation after planning refuses promotion despite an unchanged policy version',
    );
    assert.equal(revokedFakes.state.writes.length, 0);
    await client.query(
      'UPDATE role_grant SET active_until = NULL WHERE principal_id = $1',
      [runAsPrincipalId],
    );
    const promotionFakes = makeGraphFakes();
    await runRestore({
      artifactId,
      mode: 'enforce',
      readFile,
      dbUrl: database.url,
      dependencies: promotionFakes.dependencies,
      logger: noopLogger,
    });
    assert.equal(promotionFakes.state.writes.length, 3, 'the same artifact promotes once the recorded policy constraints are current again');
  }

  // ---------------------------------------------------------------------------
  // Scenario D (mutation: "trust caller-supplied ceiling"). Constraints are
  // re-resolved from the live policy row at execution: a policy disabled, or a
  // ceiling lowered, between enqueue and execution refuses — even though the
  // original drift alone would still pass the new ceiling.
  // ---------------------------------------------------------------------------
  {
    const disabledPolicyBaseline = await seedBaselineWithPrivilegedDependency();
    const disabledDrift = await insertCosmeticFinanceDrift(disabledPolicyBaseline.baselineId);
    const disabledPolicy = await makePolicy({ maxBlastRadius: 'tenant-lockout' });
    assert.equal(
      (await executeAutoRemediation(client, { tenantRef, drift: disabledDrift, policyId: disabledPolicy.id })).outcome,
      'queued',
    );
    await client.query('UPDATE policy SET enabled = false WHERE id = $1', [disabledPolicy.id]);
    const disabledFakes = makeGraphFakes();
    await assert.rejects(
      () => runRemediate({
        driftIds: [disabledDrift.id],
        targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
        collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')),
        targetConfigPath: '/fixtures/restorer.json',
        collectorConfigPath: '/fixtures/collector.json',
        mode: 'enforce',
        requestedBy: runAsPrincipalId,
        readFile,
        dbUrl: database.url,
        dependencies: disabledFakes.dependencies,
        logger: noopLogger,
      }),
      /is disabled — refusing automatic remediation/,
    );
    assert.equal(disabledFakes.state.writes.length, 0);

    const loweredBaseline = await seedBaselineWithPrivilegedDependency();
    const loweredDrift = await insertCosmeticFinanceDrift(loweredBaseline.baselineId);
    const loweredPolicy = await makePolicy({ maxBlastRadius: 'tenant-lockout' });
    assert.equal(
      (await executeAutoRemediation(client, { tenantRef, drift: loweredDrift, policyId: loweredPolicy.id })).outcome,
      'queued',
    );
    // Execution must authorize the current policy identity, even if the queued
    // job's original requester still has its grant.
    await client.query(
      'UPDATE policy SET run_as_principal_id = $1 WHERE id = $2',
      [secondRunAsPrincipalId, loweredPolicy.id],
    );
    await client.query(
      'UPDATE role_grant SET active_until = now() WHERE principal_id = $1',
      [secondRunAsPrincipalId],
    );
    const revokedFakes = makeGraphFakes();
    await assert.rejects(
      () => runRemediate({
        driftIds: [loweredDrift.id],
        targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
        collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')),
        targetConfigPath: '/fixtures/restorer.json',
        collectorConfigPath: '/fixtures/collector.json',
        mode: 'enforce', requestedBy: runAsPrincipalId, readFile,
        dbUrl: database.url, dependencies: revokedFakes.dependencies, logger: noopLogger,
      }),
      /run-as-not-authorized/,
      'execution authorizes the current policy run-as, not just the queued requester',
    );
    assert.equal(revokedFakes.state.writes.length, 0);
    await client.query(
      'UPDATE role_grant SET active_until = NULL WHERE principal_id = $1',
      [secondRunAsPrincipalId],
    );
    await client.query(
      'UPDATE policy SET run_as_principal_id = $1 WHERE id = $2',
      [runAsPrincipalId, loweredPolicy.id],
    );
    // The ceiling drops to access-affecting after enqueue. The DRIFT (cosmetic) is
    // still under the new ceiling — only the expanded closure (tenant-lockout)
    // exceeds it, so a drift-only or caller-trusted check would wrongly proceed.
    await client.query('UPDATE policy SET max_blast_radius = $1 WHERE id = $2', ['access-affecting', loweredPolicy.id]);
    const loweredFakes = makeGraphFakes();
    await assert.rejects(
      () => runRemediate({
        driftIds: [loweredDrift.id],
        targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
        collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')),
        targetConfigPath: '/fixtures/restorer.json',
        collectorConfigPath: '/fixtures/collector.json',
        mode: 'enforce',
        requestedBy: runAsPrincipalId,
        readFile,
        dbUrl: database.url,
        dependencies: loweredFakes.dependencies,
        logger: noopLogger,
      }),
      /blocked-max-blast-radius/,
      'the ceiling is re-resolved from the live policy row at execution, over the expanded closure',
    );
    assert.equal(loweredFakes.state.writes.length, 0);
  }

  // ---------------------------------------------------------------------------
  // Scenario E (derived: "bypass paused_at check in assertExecutableAutomationPolicy").
  // A policy paused between enqueue and execution — the same durable state a rate
  // limit trip or an operator pause produces — must refuse automatic remediation at
  // execution time exactly like a disabled policy, even though enabled stays true.
  // ---------------------------------------------------------------------------
  {
    const { baselineId } = await seedBaselineWithPrivilegedDependency();
    const drift = await insertCosmeticFinanceDrift(baselineId);
    const policy = await makePolicy({ maxBlastRadius: 'tenant-lockout' });
    assert.equal(
      (await executeAutoRemediation(client, { tenantRef, drift, policyId: policy.id })).outcome,
      'queued',
    );
    await client.query('UPDATE policy SET paused_at = now() WHERE id = $1', [policy.id]);
    const pausedFakes = makeGraphFakes();
    await assert.rejects(
      () => runRemediate({
        driftIds: [drift.id],
        targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
        collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')),
        targetConfigPath: '/fixtures/restorer.json',
        collectorConfigPath: '/fixtures/collector.json',
        mode: 'enforce',
        requestedBy: runAsPrincipalId,
        readFile,
        dbUrl: database.url,
        dependencies: pausedFakes.dependencies,
        logger: noopLogger,
      }),
      /is paused — refusing automatic remediation/,
      'a policy paused since enqueue must refuse at execution, even though it is still enabled',
    );
    assert.equal(pausedFakes.state.writes.length, 0, 'the paused refusal happens before any write');
  }

  // ---------------------------------------------------------------------------
  // Scenario F (derived: "allow automationPolicyIds alongside artifactId on
  // promotion"). Promotion's automation context is authoritative from the
  // immutable artifact alone — a caller supplying automationPolicyIds directly
  // on an artifactId promotion must be refused, never silently substituted for or
  // merged with the artifact's own recorded policies.
  // ---------------------------------------------------------------------------
  {
    const { snapshotId } = await seedBaselineWithPrivilegedDependency();
    const policy = await makePolicy({ maxBlastRadius: 'tenant-lockout' });
    const artifactId = '55555555-0000-4000-8000-000000000002';

    const dryRunFakes = makeGraphFakes();
    await runRestore({
      snapshotId,
      selection: ['group:Finance'],
      targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
      collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')),
      targetConfigPath: '/fixtures/restorer.json',
      collectorConfigPath: '/fixtures/collector.json',
      mode: 'dry-run',
      persistArtifactId: artifactId,
      automationPolicyIds: [policy.id],
      requestedBy: runAsPrincipalId,
      readFile,
      dbUrl: database.url,
      dependencies: dryRunFakes.dependencies,
      logger: noopLogger,
    });

    const injectionFakes = makeGraphFakes();
    await assert.rejects(
      () => runRestore({
        artifactId,
        automationPolicyIds: [policy.id],
        mode: 'enforce',
        readFile,
        dbUrl: database.url,
        dependencies: injectionFakes.dependencies,
        logger: noopLogger,
      }),
      /automationPolicyIds is supplied by the dry-run artifact on promotion, never by the caller/,
      'a caller may never inject automationPolicyIds alongside an artifactId promotion',
    );
    assert.equal(injectionFakes.state.writes.length, 0, 'the refused injection attempt writes nothing');
  }

  // ---------------------------------------------------------------------------
  // Missing impact metadata must fail closed at the restore boundary, including
  // when a later operation has a known label. Inject a malformed inventory read;
  // the database itself disallows null blast_radius values.
  {
    const { snapshotId } = await seedBaselineWithPrivilegedDependency();
    const policy = await makePolicy({ maxBlastRadius: 'tenant-lockout' });
    const fakes = makeGraphFakes();
    await assert.rejects(
      () => runRestore({
        snapshotId,
        selection: ['group:Finance'],
        targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
        collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')),
        targetConfigPath: '/fixtures/restorer.json',
        collectorConfigPath: '/fixtures/collector.json',
        mode: 'dry-run',
        persistArtifactId: '55555555-0000-4000-8000-000000000003',
        automationPolicyIds: [policy.id],
        requestedBy: runAsPrincipalId,
        readFile,
        dbUrl: database.url,
        dependencies: {
          ...fakes.dependencies,
          getResourceVersions: async (...args) => (await getResourceVersions(...args))
            .map((row) => row.natural_key === 'group:Finance'
              ? { ...row, blast_radius: null } : row),
        },
        logger: noopLogger,
      }),
      /blocked-max-blast-radius/,
      'an operation with missing impact metadata must not bypass the ceiling',
    );
    assert.equal(fakes.state.writes.length, 0);
    const { rows } = await client.query('SELECT id FROM restore_dry_run WHERE snapshot_id = $1', [snapshotId]);
    assert.equal(rows.length, 0, 'unknown impact cannot produce a promotable artifact');
  }

  // Policy action and the global stop can change while a job waits in the queue.
  // Mock only the filesystem read of the stop marker; never touch the real marker.
  for (const refusal of ['action', 'kill-switch']) {
    const { baselineId } = await seedBaselineWithPrivilegedDependency();
    const drift = await insertCosmeticFinanceDrift(baselineId);
    const policy = await makePolicy({ maxBlastRadius: 'tenant-lockout' });
    assert.equal((await executeAutoRemediation(client, {
      tenantRef, drift, policyId: policy.id,
    })).outcome, 'queued');
    const originalExistsSync = fs.existsSync;
    try {
      if (refusal === 'action') {
        await client.query("UPDATE policy SET action = 'require_approval' WHERE id = $1", [policy.id]);
      } else {
        fs.existsSync = (path) => path === AUTOMATION_KILL_SWITCH_PATH || originalExistsSync(path);
        syncBuiltinESMExports();
      }
      const fakes = makeGraphFakes();
      await assert.rejects(() => runRemediate({
        driftIds: [drift.id],
        targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
        collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')),
        targetConfigPath: '/fixtures/restorer.json',
        collectorConfigPath: '/fixtures/collector.json',
        mode: 'enforce', requestedBy: runAsPrincipalId, readFile,
        dbUrl: database.url, dependencies: fakes.dependencies, logger: noopLogger,
      }), refusal === 'action' ? /no longer auto_remediate/ : /automation-disabled/,
      `${refusal} changed after enqueue must refuse before writes`);
      assert.equal(fakes.state.writes.length, 0);
    } finally {
      fs.existsSync = originalExistsSync;
      syncBuiltinESMExports();
    }
  }

  // Guardrail math: the impact computation counts actual operations only, fails
  // closed on unknown labels, and the policy version tracks constraint fields.
  // ---------------------------------------------------------------------------
  {
    const impact = maxOperationImpact([
      { naturalKey: 'group:A', resourceType: 'group', verb: 'noop', blastRadius: 'tenant-lockout' },
      { naturalKey: 'group:B', resourceType: 'group', verb: 'update', blastRadius: 'cosmetic' },
      { naturalKey: 'group:C', resourceType: 'group', verb: null, blastRadius: 'access-affecting' },
    ], [{ naturalKey: 'group:C', field: 'members[0]', symbol: 'group:B' }]);
    assert.equal(impact.maxBlastRadius, 'access-affecting', 'a deferred patch is an operation; a noop is not');
    assert.deepEqual(impact.operations.map((operation) => operation.naturalKey), ['group:B', 'group:C']);
    assert.equal(impact.operations.find((operation) => operation.naturalKey === 'group:C').verb, 'patch');

    assert.equal(maxOperationImpact([{ naturalKey: 'group:A', verb: 'noop', blastRadius: 'cosmetic' }]).maxBlastRadius, null);
    assert.equal(
      maxOperationImpact([{ naturalKey: 'group:A', verb: 'create', blastRadius: 'mystery' }]).maxBlastRadius,
      'mystery',
      'an unknown blast radius wins the maximum so it cannot slip under a ceiling',
    );
    assert.equal(
      maxOperationImpact([
        { naturalKey: 'group:A', verb: 'create', blastRadius: null },
        { naturalKey: 'group:B', verb: 'update', blastRadius: 'cosmetic' },
      ]).maxBlastRadius,
      null,
      'an unrecognized label seen on the FIRST operation must still win the maximum over a later known-lower label — the "no operation yet" state and a genuine null-label operation cannot be conflated',
    );

    assert.equal(exceedsBlastRadiusCeiling('tenant-lockout', 'cosmetic'), true);
    assert.equal(exceedsBlastRadiusCeiling('cosmetic', 'cosmetic'), false);
    assert.equal(exceedsBlastRadiusCeiling('mystery', 'tenant-lockout'), true, 'unknown impact fails closed');
    assert.equal(exceedsBlastRadiusCeiling('cosmetic', 'mystery'), true, 'unknown ceiling fails closed');

    const { rows: policyRows } = await client.query('SELECT * FROM policy LIMIT 1');
    const base = policyConstraintVersion(policyRows[0]);
    const differentCeiling = policyRows[0].max_blast_radius === 'cosmetic' ? 'tenant-lockout' : 'cosmetic';
    assert.equal(policyConstraintVersion(policyRows[0]), base, 'the version is deterministic');
    assert.notEqual(
      policyConstraintVersion({ ...policyRows[0], max_blast_radius: differentCeiling }), base,
      'a ceiling change is a version change',
    );
    assert.notEqual(
      policyConstraintVersion({ ...policyRows[0], enabled: false }), base,
      'an enable-state change is a version change',
    );
    assert.notEqual(
      policyConstraintVersion({ ...policyRows[0], run_as_principal_id: secondRunAsPrincipalId }), base,
      'a run-as change is a version change',
    );

    // The plan digest folds automation context in only when present, so artifacts
    // planned without it keep exactly their pre-task-55 digest inputs.
    const digestInputs = {
      snapshotId: 's', selection: ['group:A'], closureKeys: ['group:A'], targetTenantId: 't',
      collectorConfigPath: '/c', targetConfigPath: '/r', reconciliationResources: undefined,
      waves: [['group:A']], patches: [],
    };
    assert.equal(
      computePlanDigest(digestInputs),
      computePlanDigest({ ...digestInputs, automationContext: null }),
      'a null automation context never changes the plan digest',
    );
    assert.notEqual(
      computePlanDigest({ ...digestInputs, automationContext: { policies: [] } }),
      computePlanDigest(digestInputs),
      'automation plan evidence is part of the immutable plan identity',
    );
  }

  // The whole evidence chain, including every refusal above, still verifies.
  assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: true });
} finally {
  await client?.end();
  await database.cleanup();
}
console.log('closure-ceiling.test.mjs — all assertions passed');
