/**
 * Roadmap task-92 boundary tests: an immutable activation preview before an automatic
 * roll-back policy is turned on. Exercises engine/policy/activation.mjs over the real
 * seams — policy matching and limits (evaluate.mjs), the remediate job's own restore
 * scope (cli/keel-remediate.mjs resolveRestoreScope), the dry run's candidate set and
 * dependency closure (dryRunArtifact.mjs restoreCandidates, selection.mjs), run-as
 * grants (authz), ownership evidence (task 89) and benchmark findings (task 87) — and
 * then the unchanged execution path (execute.mjs, runRemediate -> runRestore with only
 * the Graph/token boundary faked) against an isolated test database.
 *
 * Required mutation checks:
 *
 * - Trust preview as permanent execution authorization.  (a stale preview must refuse;
 *                                                         a used preview cannot be reused;
 *                                                         execution still re-checks)
 * - Omit expanded dependencies.                          (the preview lists the closure's
 *                                                         added dependency over the ceiling)
 * - Report queued remediation as executed.               (queued reads as not rolled back)
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  ACTIVATION_EVIDENCE_KIND, ACTIVATION_PREVIEW_EVIDENCE_KIND, ActivationNotFoundError, ActivationRefusedError,
  activatePolicy, buildActivationPreview, createActivationPreview, getActivationPreview, latestActivation,
  remediationOutcome, summarizeAutomationOutcomes,
} from '../policy/activation.mjs';
import { createPolicy, evaluateOpenDrifts, setPolicyEnabled } from '../policy/evaluate.mjs';
import { executeAutoRemediation, recordAutoRemediationTerminalOutcome } from '../policy/execute.mjs';
import { seedFromSnapshot } from '../govern/baseline.mjs';
import { verifyChain } from '../govern/evidence.mjs';
import {
  completeSnapshot, createSnapshot, insertReferences, insertResourceVersion,
} from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { fullSuccessfulCoverageDigest } from '../test/fullSuccessfulCoverage.mjs';
import { runRemediate } from '../../cli/keel-remediate.mjs';

const noopLogger = { log() {}, error() {} };
const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
const haltDirectory = mkdtempSync(join(tmpdir(), 'keel-activation-'));
// No halt file exists at this path unless a test writes one.
const killSwitchPath = join(haltDirectory, 'AUTOMATION_DISABLED');
after(async () => {
  rmSync(haltDirectory, { recursive: true, force: true });
  await client.end();
  await database.cleanup();
});

const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
await client.query(schema);
await client.query(schema); // additive and retry-safe

const ADMIN = '11111111-1111-4111-8111-111111111111';
const RUN_AS = '22222222-2222-4222-8222-222222222222';
await client.query(
  `INSERT INTO principal (id, email, display_name)
   VALUES ($1, 'policy-admin@example.com', 'Policy admin'), ($2, 'svc-policy@example.com', 'Policy service')`,
  [ADMIN, RUN_AS],
);
await client.query(
  `INSERT INTO role_grant (principal_id, role, granted_by, reason)
   VALUES ($1, 'admin', 'test', 'policy administrator'), ($2, 'restorer', 'test', 'policy run-as')`,
  [ADMIN, RUN_AS],
);

const financePayload = { displayName: 'Finance', mailNickname: 'Finance', linkedGroupIds: ['source-privileged-id'] };
const privilegedPayload = { displayName: 'Privileged', mailNickname: 'Privileged' };

/** A baseline where the cosmetic group Finance references the tenant-lockout group
 * Privileged: rolling Finance back expands to a dependency above a cosmetic ceiling.
 * `dangling` adds a reference no backed-up resource provides. */
async function seedTenant(tenantRef, { dangling = false } = {}) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  const financeVersionId = await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: 'group:Finance', resourceType: 'group', payload: financePayload, payloadHash: 'finance-baseline',
      criticality: 'tier1', blastRadius: 'cosmetic', fidelity: 'full', provenance: { adapter: 'test' },
    },
  });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: 'group:Privileged', resourceType: 'group', payload: privilegedPayload, payloadHash: 'privileged-baseline',
      criticality: 'tier1', blastRadius: 'tenant-lockout', fidelity: 'full', provenance: { adapter: 'test' },
    },
  });
  await insertReferences(client, {
    fromVersion: financeVersionId,
    references: [
      { field: 'linkedGroupIds[0]', symbol: 'group:Privileged', required: true },
      ...(dangling ? [{ field: 'linkedGroupIds[1]', symbol: 'group:Never backed up', required: true }] : []),
    ],
  });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: fullSuccessfulCoverageDigest() });
  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId, setBy: ADMIN });
  return { snapshotId, baselineId };
}

async function insertDrift(tenantRef, baselineId, { naturalKey = 'group:Finance', blastRadius = 'cosmetic', after = 'finance-drifted' } = {}) {
  const observedSnapshotId = await createSnapshot(client, { tenantRef });
  const { rows: [row] } = await client.query(
    `INSERT INTO drift
       (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
        before_hash, after_hash, before_payload, after_payload, blast_radius)
     VALUES ($1,$2,$3,$4,'group','modified','baseline',$5,$6,$7,$8)
     RETURNING *`,
    [tenantRef, baselineId, observedSnapshotId, naturalKey, after, financePayload, { ...financePayload, displayName: after }, blastRadius],
  );
  return row;
}

async function makePolicy(tenantRef, overrides = {}) {
  return createPolicy(client, {
    tenantRef, name: 'Roll back group changes', resourceType: 'group', action: 'auto_remediate', enabled: false,
    maxBlastRadius: 'cosmetic', maxActionsPerWindow: 10, windowSeconds: 3600, createdBy: ADMIN, runAsPrincipalId: RUN_AS,
    ...overrides,
  });
}

const preview = (tenantRef, policyId, extra = {}) => createActivationPreview(client, {
  tenantRef, policyId, requestedBy: ADMIN, killSwitchPath, ...extra,
});
const activate = (tenantRef, policyId, previewId, extra = {}) => activatePolicy(client, {
  tenantRef, policyId, previewId, activatedBy: ADMIN, killSwitchPath, ...extra,
});

async function refusal(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ActivationRefusedError, `expected an activation refusal, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

async function policyRow(id) {
  return (await client.query('SELECT * FROM policy WHERE id = $1', [id])).rows[0];
}

test('the preview discloses matched changes, everything they depend on above the ceiling, run-as grants, limits and findings', async () => {
  const tenantRef = 'sha256:disclosure-a';
  const { snapshotId, baselineId } = await seedTenant(tenantRef);
  const drift = await insertDrift(tenantRef, baselineId);
  const lockout = await insertDrift(tenantRef, baselineId, { naturalKey: 'group:Privileged', blastRadius: 'tenant-lockout', after: 'privileged-drifted' });
  // A failing benchmark control whose evidence is about groups links to the open change.
  await client.query(
    `INSERT INTO benchmark_evaluation
       (tenant_ref, control_id, framework, edition, profile, evaluator_version, verdict, reason, observation_windows, evaluated_at)
     VALUES ($1, 'keel.groups.owner', 'KEEL', '1', 'default', 1, 'fail', 'no owner',
             jsonb_build_array(jsonb_build_object('resourceType','group','startedAt',now() - interval '1 hour','endedAt',now())), now())`,
    [tenantRef],
  );
  const policy = await makePolicy(tenantRef);

  const stored = await preview(tenantRef, policy.id);
  assert.equal(stored.verdict, 'ready');
  assert.deepEqual(stored.blockers, []);
  assert.deepEqual(stored.matched.map((entry) => entry.driftId), [drift.id], 'only the change under the ceiling would be acted on');
  assert.deepEqual(stored.matchedOverCeiling.map((entry) => entry.driftId), [lockout.id], 'a matched change above the ceiling is shown, not acted on');

  // Closure-expanded impact: Privileged is not a matched change, but rolling Finance back depends on it.
  assert.deepEqual(stored.dependencies, [{
    naturalKey: 'group:Privileged', resourceType: 'group', blastRadius: 'tenant-lockout', requiredBy: ['group:Finance'], overCeiling: true,
  }]);
  assert.deepEqual(stored.impact, { maxBlastRadius: 'tenant-lockout', ceiling: 'cosmetic' });
  assert.deepEqual(stored.operations.map((operation) => [operation.naturalKey, operation.verb, operation.role]), [
    ['group:Finance', 'update', 'matched'], ['group:Privileged', 'create-or-update', 'dependency'],
  ]);
  assert.deepEqual(stored.unsupported, [], 'group create/update/delete are registered');

  assert.equal(stored.runAs.authorized, true);
  assert.equal(stored.runAs.name, 'Policy service');
  assert.deepEqual(stored.runAs.grants.map((grant) => grant.role), ['restorer']);
  assert.deepEqual(stored.limits, { maxBlastRadius: 'cosmetic', maxActionsPerWindow: 10, windowSeconds: 3600, automationHalted: false });
  assert.equal(stored.benchmarkFindings.state, 'read');
  assert.deepEqual(stored.benchmarkFindings.findings.map((finding) => [finding.controlId, finding.verdict, finding.exposed]), [['keel.groups.owner', 'fail', true]]);
  assert.ok(stored.benchmarkFindings.findings[0].driftIds.includes(drift.id));
  assert.deepEqual(Object.keys(stored.versions).sort(), ['grant', 'ownership', 'policy', 'projection']);
  assert.match(stored.digest, /^[0-9a-f]{64}$/);

  // Frozen: the stored row reads back exactly, and its evidence names the versions.
  assert.deepEqual(await getActivationPreview(client, { tenantRef, previewId: stored.id }), stored);
  assert.equal(await getActivationPreview(client, { tenantRef: 'sha256:other', previewId: stored.id }), null, 'tenant-scoped');
  const { rows: [evidence] } = await client.query(
    'SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = $2', [tenantRef, ACTIVATION_PREVIEW_EVIDENCE_KIND],
  );
  assert.equal(evidence.subject.previewId, stored.id);
  assert.equal(evidence.subject.dependenciesOverCeiling, 1);
  assert.deepEqual(evidence.subject.versions, stored.versions);
  assert.equal((await verifyChain(client, { tenantRef })).ok, true);

  // Previewing does not touch the policy, and repeating it reproduces the same digest.
  assert.equal((await policyRow(policy.id)).enabled, false);
  const again = await buildActivationPreview(client, { tenantRef, policyId: policy.id, killSwitchPath });
  assert.equal(again.digest, stored.digest);
  assert.ok(snapshotId);

  await assert.rejects(buildActivationPreview(client, { tenantRef: 'sha256:other', policyId: policy.id }), ActivationNotFoundError);
  const alert = await createPolicy(client, { tenantRef, name: 'Alert', action: 'alert', maxBlastRadius: 'cosmetic', createdBy: ADMIN });
  await assert.rejects(buildActivationPreview(client, { tenantRef, policyId: alert.id }), ActivationNotFoundError);
});

test('unknown impact blocks activation; a halted automation and a run-as without grants block too', async () => {
  // A reference no backed-up resource provides: KEEL cannot tell what rolling back affects.
  const dangling = 'sha256:disclosure-dangling';
  const seeded = await seedTenant(dangling, { dangling: true });
  await insertDrift(dangling, seeded.baselineId);
  const policy = await makePolicy(dangling);
  const blocked = await preview(dangling, policy.id);
  assert.equal(blocked.verdict, 'blocked');
  assert.deepEqual(blocked.blockers, ['unknown-impact']);
  assert.deepEqual(blocked.unknowns.map((unknown) => unknown.reason), ['unresolved-reference']);
  await refusal(activate(dangling, policy.id, blocked.id), 'preview-blocked');
  assert.equal((await policyRow(policy.id)).enabled, false, 'a blocked preview never turns the policy on');

  // A matched change whose resource is not in its baseline's backup.
  const missing = 'sha256:disclosure-missing';
  const other = await seedTenant(missing);
  await insertDrift(missing, other.baselineId, { naturalKey: 'group:Created later', after: 'created-later' });
  const missingPolicy = await makePolicy(missing);
  const missingPreview = await preview(missing, missingPolicy.id);
  assert.deepEqual(missingPreview.blockers, ['unknown-impact']);
  assert.equal(missingPreview.unknowns[0].reason, 'scope-unresolved');

  // An unrecognised impact rating is unknown, never under the ceiling.
  const unrated = 'sha256:disclosure-unrated';
  const rated = await seedTenant(unrated);
  await client.query(
    `UPDATE resource_version SET blast_radius = 'unrated' WHERE snapshot_id = $1 AND natural_key = 'group:Privileged'`,
    [rated.snapshotId],
  );
  await insertDrift(unrated, rated.baselineId);
  const unratedPolicy = await makePolicy(unrated);
  const unratedPreview = await preview(unrated, unratedPolicy.id);
  assert.deepEqual(unratedPreview.blockers, ['unknown-impact']);
  assert.deepEqual(unratedPreview.unknowns.map((unknown) => unknown.reason), ['impact-unknown']);
  assert.equal(unratedPreview.dependencies[0].overCeiling, false, 'an unknown rating is reported as unknown, not as over or under');

  // Automation halted by the halt file.
  const halted = 'sha256:disclosure-halted';
  const haltedSeed = await seedTenant(halted);
  await insertDrift(halted, haltedSeed.baselineId);
  const haltedPolicy = await makePolicy(halted);
  writeFileSync(killSwitchPath, '');
  try {
    const haltedPreview = await preview(halted, haltedPolicy.id);
    assert.deepEqual(haltedPreview.blockers, ['automation-halted']);
    assert.equal(haltedPreview.limits.automationHalted, true);
  } finally {
    rmSync(killSwitchPath, { force: true });
  }
});

test('a changed policy, grant or ownership invalidates the preview; a preview is single-use and expires', async () => {
  const tenantRef = 'sha256:disclosure-versions';
  const { baselineId } = await seedTenant(tenantRef);
  await insertDrift(tenantRef, baselineId);
  const policy = await makePolicy(tenantRef);

  // Policy: a limit changed after the preview.
  const beforePolicyChange = await preview(tenantRef, policy.id);
  await client.query('UPDATE policy SET max_actions_per_window = 20 WHERE id = $1', [policy.id]);
  await assert.rejects(activate(tenantRef, policy.id, beforePolicyChange.id), (error) => {
    assert.equal(error.code, 'preview-stale');
    assert.deepEqual(error.changed, ['policy']);
    return true;
  });
  // A match change also changes the policy version.
  const beforeMatchChange = await preview(tenantRef, policy.id);
  await client.query("UPDATE policy SET natural_key_glob = 'group:*' WHERE id = $1", [policy.id]);
  await assert.rejects(activate(tenantRef, policy.id, beforeMatchChange.id), (error) => error.code === 'preview-stale' && error.changed.includes('policy'));

  // Grant: the run-as account gained a grant after the preview.
  const beforeGrant = await preview(tenantRef, policy.id);
  const { rows: [extraGrant] } = await client.query(
    `INSERT INTO role_grant (principal_id, role, granted_by, reason, active_from)
     VALUES ($1, 'approver', 'test', 'widened', now() - interval '1 second') RETURNING id`, [RUN_AS],
  );
  await assert.rejects(activate(tenantRef, policy.id, beforeGrant.id), (error) => {
    assert.equal(error.code, 'preview-stale');
    assert.deepEqual(error.changed, ['grant']);
    return true;
  });
  await client.query('DELETE FROM role_grant WHERE id = $1', [extraGrant.id]);

  // Ownership: ownership evidence appeared for the dependency after the preview.
  const beforeOwnership = await preview(tenantRef, policy.id);
  const { rows: [lineage] } = await client.query(
    `INSERT INTO resource_lineage (tenant_ref, resource_type, source_id) VALUES ($1, 'group', 'target-Privileged') RETURNING id`, [tenantRef],
  );
  await client.query(
    `INSERT INTO resource_ownership_evidence
       (tenant_ref, lineage_id, state, entity_code, entity_codes, source, reason, natural_key, observed_at, expires_at, recorded_by)
     VALUES ($1, $2, 'owned', 'CREOS', '{CREOS}', 'cmdb', 'cmdb-single-owner', 'group:Privileged', now(), now() + interval '1 day', 'test')`,
    [tenantRef, lineage.id],
  );
  await assert.rejects(activate(tenantRef, policy.id, beforeOwnership.id), (error) => {
    assert.equal(error.code, 'preview-stale');
    assert.deepEqual(error.changed, ['ownership']);
    return true;
  });
  assert.equal((await policyRow(policy.id)).enabled, false, 'no stale preview turned the policy on');

  // Expiry and tenant scope.
  const fresh = await preview(tenantRef, policy.id);
  assert.equal(fresh.ownership.resources[0].state, 'owned');
  await refusal(activate(tenantRef, policy.id, fresh.id, { now: new Date(Date.parse(fresh.expiresAt) + 1) }), 'preview-expired');
  await refusal(activate('sha256:other', policy.id, fresh.id), 'preview-not-found');

  // A current preview activates once, through setPolicyEnabled.
  const activated = await activate(tenantRef, policy.id, fresh.id);
  assert.equal(activated.policy.enabled, true);
  assert.equal(activated.activation.previewId, fresh.id);
  assert.deepEqual(activated.activation.versions, fresh.versions);
  assert.deepEqual(await latestActivation(client, { tenantRef, policyId: policy.id }), activated.activation);
  await refusal(activate(tenantRef, policy.id, fresh.id), 'preview-used');

  // Turning it off and on again needs a new preview: the old one is spent.
  await setPolicyEnabled(client, { policyId: policy.id, enabled: false });
  await refusal(activate(tenantRef, policy.id, fresh.id), 'preview-used');
  const second = await preview(tenantRef, policy.id);
  assert.equal((await activate(tenantRef, policy.id, second.id)).policy.enabled, true);
  await refusal(activate(tenantRef, policy.id, (await preview(tenantRef, policy.id)).id), 'already-active');

  const { rows: outcomes } = await client.query(
    `SELECT subject->>'outcome' AS outcome, subject->>'code' AS code FROM evidence
      WHERE tenant_ref = $1 AND kind = $2 ORDER BY seq`, [tenantRef, ACTIVATION_EVIDENCE_KIND],
  );
  assert.deepEqual(outcomes.filter((row) => row.outcome === 'activated').length, 2);
  assert.ok(outcomes.some((row) => row.code === 'preview-stale'), 'refusals are in the audit record');
  assert.equal((await verifyChain(client, { tenantRef })).ok, true);

  // A policy turned on before previews existed reads as having no activation.
  const legacy = await makePolicy(tenantRef, { enabled: true, name: 'Legacy' });
  assert.equal(await latestActivation(client, { tenantRef, policyId: legacy.id }), null);
});

test('after activation execution-time checks stay active and a queued roll back is not reported as done', async () => {
  const tenantRef = 'sha256:disclosure-execution';
  const { snapshotId, baselineId } = await seedTenant(tenantRef);
  const drift = await insertDrift(tenantRef, baselineId);
  const policy = await makePolicy(tenantRef);
  const ready = await preview(tenantRef, policy.id);
  await activate(tenantRef, policy.id, ready.id);

  // The policy acts through the unchanged enqueue path: queued, not rolled back.
  const [evaluation] = await evaluateOpenDrifts(client, { tenantRef });
  assert.deepEqual(evaluation.remediations.map((entry) => [entry.outcome, entry.executed]), [['queued', false]]);
  let summary = await summarizeAutomationOutcomes(client, { tenantRef, policyId: policy.id });
  assert.deepEqual([summary.queued, summary.rolledBack, summary.failed], [1, 0, 0]);
  assert.deepEqual(summary.items.map((item) => [item.status, item.rolledBack, item.finished]), [['queued', false, false]]);
  assert.deepEqual(remediationOutcome('queued'), { status: 'queued', rolledBack: false, finished: false });
  assert.deepEqual(remediationOutcome('executed'), { status: 'executed', rolledBack: true, finished: true });
  assert.equal(remediationOutcome('bogus').rolledBack, false);

  // The queued job runs the normal remediation: the dependency above the ceiling that
  // the preview disclosed is refused again at execution, before any write.
  const writes = [];
  const configs = new Map([
    ['/fixtures/collector.json', JSON.stringify({ tenantId: 'target', clientId: 'collector', certPath: '/c.cer', keyPath: '/c.key' })],
    ['/fixtures/restorer.json', JSON.stringify({ tenantId: 'target', clientId: 'restorer', certPath: '/r.cer', keyPath: '/r.key' })],
  ]);
  const breakGlass = { id: 'bg-role', roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', principalId: 'bg', directoryScopeId: '/' };
  const liveGroups = [{ id: 'target-Privileged', displayName: 'Privileged drifted', mailNickname: 'Privileged' }];
  await assert.rejects(runRemediate({
    driftIds: [drift.id],
    targetConfig: JSON.parse(configs.get('/fixtures/restorer.json')),
    collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')),
    targetConfigPath: '/fixtures/restorer.json',
    collectorConfigPath: '/fixtures/collector.json',
    mode: 'enforce',
    requestedBy: RUN_AS,
    readFile: (path) => configs.get(path),
    dbUrl: database.url,
    logger: noopLogger,
    dependencies: {
      getToken: async () => ({ accessToken: 'fake-token' }),
      GraphReader: class {
        async collect(_version, path) {
          if (path.startsWith('/groups?')) return { items: liveGroups, capped: false, error: null };
          if (path.startsWith('/roleManagement/directory/roleAssignments')) return { items: [breakGlass], capped: false, error: null };
          return { items: [], capped: false, error: null };
        }
        async get() { return { ok: true, status: 200, body: { id: 'x', isEnabled: false, accountEnabled: true } }; }
      },
      collectM1: async () => [['group', liveGroups], ['roleAssignment', [breakGlass]]],
      GraphWriter: class {
        async write(_version, path, options) { writes.push({ path, method: options.method }); return { ok: true, status: 204, body: null }; }
        async read() { return { ok: false, status: 404, body: null }; }
      },
      ThrottleGovernor: class { async acquire() {} },
    },
  }), /blocked-max-blast-radius/);
  assert.equal(writes.length, 0, 'an activation never pre-authorizes a write');
  const { rows: artifacts } = await client.query('SELECT id FROM restore_dry_run WHERE snapshot_id = $1', [snapshotId]);
  assert.equal(artifacts.length, 0);

  const { rows: [job] } = await client.query(`SELECT * FROM job WHERE kind = 'remediate' AND params->'driftIds' @> to_jsonb($1::text)`, [drift.id]);
  await recordAutoRemediationTerminalOutcome(client, { job, status: 'failed', error: 'blocked-max-blast-radius' });
  summary = await summarizeAutomationOutcomes(client, { tenantRef, policyId: policy.id });
  assert.deepEqual([summary.queued, summary.rolledBack, summary.failed], [0, 0, 1], 'a refused roll back is failed, never rolled back');

  // A grant revoked after activation stops the next roll back at enqueue, whatever the preview said.
  const next = await insertDrift(tenantRef, baselineId, { after: 'finance-drifted-again' });
  await client.query(`UPDATE role_grant SET active_until = now() - interval '1 second' WHERE principal_id = $1`, [RUN_AS]);
  try {
    const refused = await executeAutoRemediation(client, { tenantRef, drift: next, policyId: policy.id, killSwitchPath });
    assert.deepEqual(refused, { executed: false, outcome: 'run-as-not-authorized' });
    assert.equal((await policyRow(policy.id)).enabled, false, 'execution disables the policy rather than trusting its activation');
  } finally {
    await client.query('UPDATE role_grant SET active_until = NULL WHERE principal_id = $1', [RUN_AS]);
  }

  // The halt file stops an activated policy too.
  await client.query('UPDATE policy SET enabled = true, paused_at = NULL, run_as_repair_required = false WHERE id = $1', [policy.id]);
  writeFileSync(killSwitchPath, '');
  try {
    const halted = await executeAutoRemediation(client, { tenantRef, drift: next, policyId: policy.id, killSwitchPath });
    assert.equal(halted.outcome, 'automation-disabled');
  } finally {
    rmSync(killSwitchPath, { force: true });
  }
});
