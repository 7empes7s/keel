#!/usr/bin/env node
/**
 * Six end-to-end acceptance journeys (roadmap task-112).
 *
 *   node tools/release/journeys.mjs run --db-url <isolated test database URL> [--out <file>]
 *
 * Each journey drives the production modules of its owner tasks against local
 * fakes and an isolated database, then returns a claim: the terminal object a
 * user would look at and the evidence links that lead to it. The claim is never
 * trusted. `assessJourney` re-reads the terminal object and every link from the
 * database and decides:
 *
 * - the terminal outcome must be a verified, user-visible state of that object.
 *   A queued, running, pending or awaiting state never passes, whatever the
 *   runner says about it;
 * - every link the journey's definition requires must be present, resolve to a
 *   row of the journey's tenant, and point at its parent link (ancestry);
 * - links into the evidence chain must match the stored record hash and the
 *   tenant's chain must verify.
 *
 * The results are fixture results. They prove code behavior against fakes, not
 * Microsoft behavior or a live recovery; the release ledger
 * (tools/release/acceptanceLedger.mjs) keeps them apart from live acceptance.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { grantRole, revokeRole } from '../../engine/authz/administration.mjs';
import { planBootstrap } from '../../engine/bootstrap/plan.mjs';
import { BootstrapJournal, migrateBootstrapJournal } from '../../engine/bootstrap/journal.mjs';
import { approveBootstrapPlan, executeBootstrap } from '../../engine/bootstrap/execute.mjs';
import { firstCollectReadiness } from '../../engine/bootstrap/onboarding.mjs';
import { canonicalHash } from '../../engine/cir/canonicalHash.mjs';
import { exportSnapshot } from '../../engine/export/configExport.mjs';
import { sha256Hex } from '../../engine/export/manifest.mjs';
import { seedFromSnapshot } from '../../engine/govern/baseline.mjs';
import { baselineCompliance } from '../../engine/govern/baselineCompliance.mjs';
import { appendEvidence, verifyChain } from '../../engine/govern/evidence.mjs';
import { assessSnapshot, openIncident, recordCompromiseInterval } from '../../engine/govern/incidents.mjs';
import { claimNext, enqueue } from '../../engine/jobs/queue.mjs';
import { CHANGE_INTENT_EVIDENCE_KIND, createChangeIntent, settleChangeIntents } from '../../engine/policy/changeIntent.mjs';
import { createPolicy } from '../../engine/policy/evaluate.mjs';
import { executeAutoRemediation } from '../../engine/policy/execute.mjs';
import { answerQuestion } from '../../engine/query/execute.mjs';
import { COMPLETION_EVIDENCE_KIND, completeItem, listCompletionItems, resourceCompletionState } from '../../engine/restore/completion.mjs';
import { canonicalDigest, getDryRunArtifactById } from '../../engine/restore/dryRunArtifact.mjs';
import { buildRecoveryManifest, currentSchemaPin } from '../../engine/storage/recoveryManifest.mjs';
import { completeSnapshot, connect, createSnapshot, insertResourceVersion } from '../../engine/store/db.mjs';
import { seedSchedules } from '../../engine/store/scheduleSeed.mjs';
import { fullSuccessfulCoverageDigest } from '../../engine/test/fullSuccessfulCoverage.mjs';
import { fakeGraph } from '../qualification/operations.mjs';
import { createDisposableTarget, reconstructRecovery } from '../recovery/reconstruct.mjs';
import { runRestore } from '../../cli/keel-restore.mjs';
import { JOB_HANDLERS, runJob } from '../../cli/keel-worker.mjs';

export const JOURNEY_CONTRACT_VERSION = 1;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const quiet = { log() {}, error() {} };
const quietSink = () => {};

/**
 * States that record an action asked for or in flight, never its result. A
 * terminal outcome in one of these is refused before any journey-specific
 * check, so no definition can accept one by listing it.
 */
export const UNVERIFIED_STATES = Object.freeze([
  'queued', 'running', 'pending', 'pending-manual', 'requested', 'awaiting-detection',
  'configuration-restored', 'service-validation-pending', 'waiting-for-you', 'not-set-up',
  'read-access-unconfirmed', 'unknown',
]);

/**
 * The six journeys. `terminal` names the object a user reads and the states of
 * it that count as a verified outcome; `links` names the evidence the outcome
 * must be reachable from, with each link's parent (the link it must point at).
 */
export const JOURNEYS = Object.freeze([
  Object.freeze({
    id: 'J1', title: 'Onboarding with missing prerequisites',
    owners: ['task-74', 'task-75', 'task-76'],
    terminal: { store: 'first-collect-readiness', verified: ['read-access-confirmed'] },
    links: [
      { slot: 'setup-run', store: 'bootstrap-plan' },
      { slot: 'manual-step-observed', store: 'bootstrap-event', parent: 'setup-run', field: 'artifact_id' },
    ],
  }),
  Object.freeze({
    id: 'J2', title: 'Collection, drift, compliance and investigation',
    owners: ['task-47', 'task-62', 'task-87', 'task-99'],
    terminal: { store: 'investigation-answer', verified: ['complete', 'partial'] },
    links: [
      { slot: 'collection', store: 'snapshot' },
      { slot: 'detection-job', store: 'job', verified: ['succeeded'] },
      { slot: 'drift', store: 'drift', parent: 'collection', field: 'observed_snapshot' },
      { slot: 'compliance', store: 'baseline-compliance', parent: 'collection', field: 'changesSinceCapture.comparedSnapshotId', verified: ['compared-with-changes'] },
    ],
  }),
  Object.freeze({
    id: 'J3', title: 'Approved emergency deviation',
    owners: ['task-93', 'task-95'],
    terminal: { store: 'evidence', kind: CHANGE_INTENT_EVIDENCE_KIND, field: 'currentState', verified: ['matches-baseline'] },
    links: [
      { slot: 'emergency-drift', store: 'drift' },
      { slot: 'intent', store: 'change-intent', parent: 'emergency-drift', field: 'sourceDriftId' },
      { slot: 'suppression', store: 'evidence', parent: 'emergency-drift', field: 'driftId' },
      { slot: 'settlement', store: 'evidence', parent: 'intent', field: 'intentId' },
    ],
  }),
  Object.freeze({
    id: 'J4', title: 'Malicious-change recovery',
    owners: ['task-71', 'task-64', 'task-78'],
    terminal: { store: 'evidence', kind: 'incident-recovery-check', field: 'checks', verified: ['passed'] },
    links: [
      { slot: 'incident', store: 'incident' },
      { slot: 'restore-artifact', store: 'dry-run-artifact', parent: 'incident', field: 'incidentId', verified: ['completed'] },
      { slot: 'post-restore-check', store: 'evidence', parent: 'restore-artifact', field: 'artifactId' },
    ],
  }),
  Object.freeze({
    id: 'J5', title: 'Partial restore plus human completion',
    owners: ['task-65', 'task-70'],
    terminal: { store: 'completion', verified: ['verified-complete'] },
    links: [
      { slot: 'restore-artifact', store: 'dry-run-artifact', verified: ['completed'] },
      { slot: 'completion-evidence', store: 'evidence', parent: 'restore-artifact', field: 'restoreRef' },
    ],
  }),
  Object.freeze({
    id: 'J6', title: 'KEEL reconstruction',
    owners: ['task-67', 'task-68'],
    terminal: { store: 'reconstruction', verified: ['recovered'] },
    links: [
      { slot: 'source-checkpoint', store: 'evidence' },
      { slot: 'reconstructed-head', store: 'reconstructed-evidence-head', parent: 'source-checkpoint', field: 'head_hash' },
    ],
  }),
]);

export function journeyDefinition(id) {
  const journey = JOURNEYS.find((entry) => entry.id === id);
  if (!journey) throw new Error(`unknown journey: ${id}`);
  return journey;
}

// ------------------------------------------------------------------ helpers

async function principal(client, role, label = 'journey') {
  const { rows: [row] } = await client.query(
    'INSERT INTO principal (email, display_name) VALUES ($1, $2) RETURNING id',
    [`${label}-${randomUUID()}@journeys.example`, label],
  );
  const grant = role ? await grantRole(client, { principalId: row.id, role, grantedBy: row.id }) : null;
  return { id: row.id, grantId: grant?.id ?? null };
}

async function seedGroups(client, tenantRef, groups, { at = null, coverage = fullSuccessfulCoverageDigest() } = {}) {
  const snapshotId = await createSnapshot(client, { tenantRef });
  for (const payload of groups) {
    await insertResourceVersion(client, {
      snapshotId,
      resource: {
        naturalKey: `group:${payload.mailNickname}`, resourceType: 'group', payload, payloadHash: canonicalHash(payload, 'group'),
        criticality: 'tier1', blastRadius: 'cosmetic', fidelity: 'full', provenance: { adapter: 'journey-fixture' },
      },
    });
  }
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: coverage });
  if (at) {
    await client.query(
      `UPDATE snapshot SET started_at = $2::timestamptz - interval '5 minutes', completed_at = $2::timestamptz WHERE id = $1`,
      [snapshotId, at],
    );
  }
  return snapshotId;
}

async function evidenceLink(client, { tenantRef, kind, where }) {
  const { rows } = await client.query(
    'SELECT seq, record_hash, subject FROM evidence WHERE tenant_ref = $1 AND kind = $2 ORDER BY seq',
    [tenantRef, kind],
  );
  const row = rows.reverse().find((entry) => Object.entries(where).every(([key, value]) => String(entry.subject?.[key]) === String(value)));
  if (!row) throw new Error(`journey: no ${kind} evidence matching ${JSON.stringify(where)}`);
  return { seq: Number(row.seq), recordHash: row.record_hash };
}

const restoreConfigs = new Map([
  ['/fixtures/collector.json', JSON.stringify({ tenantId: 'journeys', clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
  ['/fixtures/restorer.json', JSON.stringify({ tenantId: 'journeys', clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
]);
const readConfig = (path) => {
  if (!restoreConfigs.has(path)) throw new Error(`unexpected config read: ${path}`);
  return restoreConfigs.get(path);
};

function groupsOf(graph) {
  return [...graph.objects].filter(([key]) => key.startsWith('/groups/')).map(([, body]) => body);
}

/** The in-memory Microsoft fake the restore CLI reads and writes through. */
function restoreDependencies(graph) {
  class Reader {
    async collect(version, path) {
      if (path.startsWith('/directory/deletedItems/')) return { items: [], capped: false, error: null };
      if (path.startsWith('/groups')) return { items: groupsOf(graph), capped: false, error: null };
      return { items: [], capped: false, error: null };
    }

    async get(version, path) {
      if (path === '/policies/authenticationMethodsPolicy') return { ok: true, status: 200, body: { id: 'authenticationMethodsPolicy' } };
      if (path === '/policies/identitySecurityDefaultsEnforcementPolicy') return { ok: true, status: 200, body: { id: 'identitySecurityDefaultsEnforcementPolicy', isEnabled: true } };
      if (path.startsWith('/users/')) return { ok: true, status: 200, body: { id: 'break-glass-id', accountEnabled: true } };
      throw new Error(`unexpected read: ${path}`);
    }
  }
  return {
    getToken: async () => ({ accessToken: 'fake-token' }),
    GraphReader: Reader,
    GraphWriter: class { constructor() { return graph; } },
    collectM1: async () => [],
    canonicalizeAll: () => [
      { naturalKey: 'roleAssignment:GlobalAdministrator:break-glass', resourceType: 'roleAssignment', sourceId: 'ra-1', payload: { principalId: 'break-glass-id' } },
      ...groupsOf(graph).map((group) => ({ naturalKey: `group:${group.mailNickname}`, resourceType: 'group', sourceId: group.id, payload: group })),
    ],
  };
}

function restoreRunner(ctx, graph) {
  const run = (options) => runRestore({ readFile: readConfig, dbUrl: ctx.dbUrl, dependencies: restoreDependencies(graph), logger: quiet, ...options });
  return {
    async dryRun({ snapshotId, selection, incidentId, requestedBy }) {
      const artifactId = randomUUID();
      await run({
        snapshotId, selection, incidentId, mode: 'dry-run', persistArtifactId: artifactId, requestedBy,
        collectorConfig: JSON.parse(restoreConfigs.get('/fixtures/collector.json')),
        targetConfig: JSON.parse(restoreConfigs.get('/fixtures/restorer.json')),
        collectorConfigPath: '/fixtures/collector.json', targetConfigPath: '/fixtures/restorer.json',
      });
      return artifactId;
    },
    promote: (artifactId) => run({ artifactId, mode: 'enforce' }),
  };
}

/** Runs one job through the production worker entry (re-authorization included). */
async function runThroughWorker(client, ctx, jobId) {
  const job = await claimNext(client, { workerId: `journeys-${randomUUID()}`, eventSink: quietSink });
  if (!job || String(job.id) !== String(jobId)) throw new Error(`journey: worker claimed ${job?.id ?? 'nothing'}, expected ${jobId}`);
  await runJob(client, job, { dbUrl: ctx.dbUrl, onInFlightChange() {}, handlers: ctx.handlers ?? JOB_HANDLERS, eventSink: quietSink });
  const { rows: [row] } = await client.query('SELECT id, status, error FROM job WHERE id = $1', [jobId]);
  return row;
}

// ----------------------------------------------------------------- journeys

const bootstrapCredentials = {
  collector: { credentialRef: 'vault:collector', identityRef: 'collector-app' },
  restorer: { credentialRef: 'vault:restorer', identityRef: 'restorer-app' },
};
const bootstrapReaders = Object.fromEntries(['Applications', 'ServicePrincipals', 'AppRoleAssignments',
  'RoleAssignments', 'RoleEligibilitySchedules', 'SubscribedSkus'].map((name) => [`list${name}`, async () => []]));

/** The fake identity tenant of task-75/76: manual steps are satisfied only once the operator did them. */
export function fakeIdentityTenant(tenantRef, { loseFirstAck = false } = {}) {
  const state = new Map();
  const manualDone = new Set();
  const writes = [];
  let loseAck = loseFirstAck;
  const adapters = {
    async prerequisites() { return { revision: 'prerequisites-v1', allowed: true, killSwitch: false }; },
    async qualify({ step, credentialRef, intentHash }) {
      return { tenantRef, credentialRef, intentHash, operation: step.action, build: 'fixture-v1', projection: 'identity-v1',
        status: 'fixture-tested', expiresAt: new Date(Date.now() + 60000).toISOString() };
    },
    async observe({ step }) {
      if (['pim-activation', 'workload-rbac'].includes(step.kind)) {
        return { tenantRef, status: manualDone.has(step.name) ? 'satisfied' : 'absent' };
      }
      return state.get(step.id) ?? { tenantRef, status: 'absent' };
    },
    async ensure({ step }) {
      writes.push(step.id);
      state.set(step.id, { tenantRef, status: 'satisfied', objectId: `${step.identity}-${step.kind}`,
        ...(step.kind === 'registration' ? { appId: `${step.identity}-app`, servicePrincipalId: `${step.identity}-sp` } : {}) });
      if (loseAck) { loseAck = false; throw new Error('simulated lost acknowledgement'); }
    },
  };
  return { adapters, manualDone, writes };
}

/** J1: read setup stops at a manual prerequisite, survives a lost acknowledgement, resumes once it is done. */
async function journeyOnboarding(client, ctx) {
  const tenantRef = `sha256:journey-j1-${randomUUID()}`;
  const owner = await principal(client, 'admin', 'setup-owner');
  await grantRole(client, { principalId: owner.id, role: 'approver', grantedBy: owner.id });
  await migrateBootstrapJournal(client);
  const journal = new BootstrapJournal({ client, tenantRef, principalId: owner.id });
  const tenant = fakeIdentityTenant(tenantRef, { loseFirstAck: true });
  const plan = await planBootstrap({ tenantRef, workloads: ['entra-collect', 'intune-collect'], readAdapters: bootstrapReaders });
  const artifactId = await approveBootstrapPlan({ journal, plan, credentials: bootstrapCredentials, adapters: tenant.adapters,
    build: 'fixture-v1', qualificationMode: 'fixture-tested' });
  // Each attempt is a fresh process view of the journal, as a resumed run would be.
  const execute = () => executeBootstrap({ journal: new BootstrapJournal({ client, tenantRef, principalId: owner.id }), artifactId,
    adapters: tenant.adapters, build: 'fixture-v1', qualificationMode: 'fixture-tested' });
  const steps = [];

  // The manual prerequisite is missing: nothing is written and collection stays blocked.
  const paused = await execute();
  const blocked = await firstCollectReadiness(client, { tenantRef });
  steps.push({ step: 'missing-prerequisite', outcome: paused.status, missing: blocked.missing, collectAllowed: blocked.allowed, writes: tenant.writes.length });
  // The operator does it. The first write's acknowledgement is lost: the journal records it uncertain.
  const manual = plan.steps.find((step) => step.identity === 'collector' && ['pim-activation', 'workload-rbac'].includes(step.kind));
  tenant.manualDone.add(manual.name);
  const crashed = await execute().then(() => null, (error) => error);
  steps.push({ step: 'lost-acknowledgement', outcome: crashed && /uncertain/.test(crashed.message) ? 'uncertain' : 'no-crash' });
  // Retry: resumes by observed identity without a duplicate write.
  const resumed = await execute();
  steps.push({ step: 'resume', outcome: resumed.status, writes: tenant.writes.length, distinctWrites: new Set(tenant.writes).size });

  const { rows } = await client.query(
    `SELECT id FROM bootstrap_event WHERE tenant_ref = $1 AND artifact_id = $2 AND step_id = $3 AND state = 'observed'
      ORDER BY id DESC LIMIT 1`,
    [tenantRef, artifactId, manual.id],
  );
  return {
    journey: 'J1', tenantRef, steps,
    terminal: { ref: tenantRef },
    links: { 'setup-run': { ref: artifactId }, 'manual-step-observed': { ref: rows[0]?.id ?? null } },
  };
}

const J2_BASE = { displayName: 'Payroll approvers', mailNickname: 'payroll-approvers', mailEnabled: false, securityEnabled: true, groupTypes: [], description: 'Approves payroll runs' };

/** J2: two collections, detection through the worker, compliance and an investigation answer over the result. */
async function journeyCollectionToInvestigation(client, ctx) {
  const tenantRef = `sha256:journey-j2-${randomUUID()}`;
  const operator = await principal(client, 'operator', 'collection-operator');
  const steps = [];
  const baselineSnapshot = await seedGroups(client, tenantRef, [J2_BASE], { at: new Date(Date.now() - 2 * HOUR).toISOString() });
  await seedFromSnapshot(client, { tenantRef, snapshotId: baselineSnapshot, setBy: operator.id });
  const changed = { ...J2_BASE, description: 'Approves payroll runs and vendor payments' };
  const collection = await seedGroups(client, tenantRef, [changed]);
  steps.push({ step: 'collection', outcome: 'complete', snapshotId: collection });

  // Detection runs as a queued job through the worker's production handler.
  const job = await enqueue(client, { kind: 'drift-detect', params: { snapshotId: collection, tenantRef }, requestedBy: operator.id });
  const finished = await runThroughWorker(client, ctx, job.id);
  steps.push({ step: 'detection', outcome: finished.status, error: finished.error ?? null });
  const { rows: [drift] } = await client.query(
    'SELECT id FROM drift WHERE tenant_ref = $1 AND observed_snapshot = $2 ORDER BY id DESC LIMIT 1', [tenantRef, collection],
  );

  const [compliance] = await baselineCompliance(client, { tenantRef });
  steps.push({ step: 'compliance', outcome: compliance?.changesSinceCapture?.state ?? 'none', changes: compliance?.changesSinceCapture?.total ?? 0 });
  const answer = await answerQuestion(client, {
    tenantRef, scope: { central: true, entities: [] }, request: { intent: 'changes', params: { period: 'this-week' } },
  });
  steps.push({ step: 'investigation', outcome: answer.status, records: answer.records.length });
  return {
    journey: 'J2', tenantRef, steps,
    terminal: { ref: { request: { intent: 'changes', params: { period: 'this-week' } }, driftId: drift ? String(drift.id) : null } },
    links: {
      collection: { ref: collection },
      'detection-job': { ref: job.id },
      drift: { ref: drift?.id ?? null },
      compliance: { ref: compliance?.id ?? null },
    },
  };
}

const J3_BASE = { displayName: 'Finance', mailNickname: 'Finance', visibility: 'Private' };

/** J3: an approved field change is not rolled back in its window; it is settled against a fresh observation. */
async function journeyEmergencyDeviation(client, ctx) {
  const tenantRef = `sha256:journey-j3-${randomUUID()}`;
  const admin = await principal(client, 'admin', 'policy-admin');
  const runAs = await principal(client, 'restorer', 'policy-run-as');
  const approver = await principal(client, 'approver', 'change-approver');
  const owner = await principal(client, 'operator', 'on-call');
  const steps = [];
  const observe = async (payload) => {
    const snapshotId = await createSnapshot(client, { tenantRef });
    await insertResourceVersion(client, {
      snapshotId,
      resource: {
        naturalKey: 'group:Finance', resourceType: 'group', payload, payloadHash: canonicalDigest(payload),
        criticality: 'tier1', blastRadius: 'cosmetic', fidelity: 'full', provenance: { adapter: 'journey-fixture' },
      },
    });
    await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: fullSuccessfulCoverageDigest() });
    return snapshotId;
  };
  const baselineSnapshot = await observe(J3_BASE);
  const baselineId = await seedFromSnapshot(client, { tenantRef, snapshotId: baselineSnapshot, setBy: admin.id });
  const policy = await createPolicy(client, {
    tenantRef, name: 'Roll back group changes', resourceType: 'group', action: 'auto_remediate', enabled: true,
    maxBlastRadius: 'cosmetic', createdBy: admin.id, runAsPrincipalId: runAs.id,
  });
  const emergencyPayload = { ...J3_BASE, visibility: 'Public' };
  const emergencySnapshot = await observe(emergencyPayload);
  const { rows: [drift] } = await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
       before_hash, after_hash, before_payload, after_payload, blast_radius)
     VALUES ($1,$2,$3,'group:Finance','group','modified',$4,$5,$6,$7,'cosmetic') RETURNING *`,
    [tenantRef, baselineId, emergencySnapshot, canonicalDigest(J3_BASE), canonicalDigest(emergencyPayload), J3_BASE, emergencyPayload],
  );
  const t0 = new Date();
  const end = new Date(t0.getTime() + HOUR);
  const killSwitchPath = join(ctx.workdir, `AUTOMATION_DISABLED-${randomUUID()}`);
  const intent = await createChangeIntent(client, {
    tenantRef, approverPrincipalId: approver.id, ownerPrincipalId: owner.id, driftId: drift.id, fields: ['visibility'],
    reason: 'INC-4410: open the group to responders', externalChangeId: 'CHG0031337', windowStart: t0, windowEnd: end, now: t0,
  });
  const suppressed = await executeAutoRemediation(client, {
    tenantRef, drift, policyId: policy.id, killSwitchPath, now: new Date(t0.getTime() + 10 * 60 * 1000),
  });
  steps.push({ step: 'in-window', outcome: suppressed.outcome, executed: suppressed.executed });
  // The owner puts the setting back during the window; the next collection observes it.
  await observe(J3_BASE);
  const [settled] = await settleChangeIntents(client, { tenantRef, now: end, killSwitchPath });
  steps.push({ step: 'settlement', outcome: settled?.currentState ?? 'none', remediations: settled?.remediations?.length ?? 0 });
  const settlement = await evidenceLink(client, { tenantRef, kind: CHANGE_INTENT_EVIDENCE_KIND, where: { intentId: intent.id, outcome: 'settled' } });
  const suppression = await evidenceLink(client, { tenantRef, kind: 'automation-execution', where: { driftId: drift.id, outcome: 'change-intent-approved' } });
  return {
    journey: 'J3', tenantRef, steps,
    terminal: { ref: settlement },
    links: {
      'emergency-drift': { ref: drift.id },
      intent: { ref: intent.id },
      suppression: { ref: suppression },
      settlement: { ref: settlement },
    },
  };
}

const J4_BOARD = { displayName: 'Board', mailNickname: 'board', mailEnabled: false, securityEnabled: true, groupTypes: [], description: 'Board members' };
const J4_BACKDOOR = { displayName: 'Helpdesk Tier 0', mailNickname: 'backdoor', mailEnabled: false, securityEnabled: true, groupTypes: [], description: 'granted Global Administrator by the attacker' };

/**
 * J4: the only collection after the attack captured it. The investigator clears it with
 * the attacker's objects excluded; the newest collection stays compromised and is
 * refused. The first restore leaves the backdoor live, so its post-restore checks fail
 * visibly; once the operator removes it, a fresh restore passes every check.
 */
async function journeyMaliciousChangeRecovery(client, ctx) {
  const tenantRef = `sha256:journey-j4-${randomUUID()}`;
  const investigator = await principal(client, 'investigator', 'investigator');
  const requester = await principal(client, 'restorer', 'restorer');
  const steps = [];
  const at = (days) => new Date(Date.now() - days * DAY).toISOString();
  const captured = await seedGroups(client, tenantRef, [{ ...J4_BOARD, description: 'pwned' }, J4_BACKDOOR], { at: at(1), coverage: {} });
  const newest = await seedGroups(client, tenantRef, [{ ...J4_BOARD, description: 'pwned' }, J4_BACKDOOR], { at: at(0.1), coverage: {} });
  const incident = await openIncident(client, { tenantRef, title: 'Admin consent phishing', actorId: investigator.id });
  await recordCompromiseInterval(client, { tenantRef, incidentId: incident.id, startsAt: at(2), reason: 'first malicious sign-in', actorId: investigator.id });
  await assessSnapshot(client, { tenantRef, incidentId: incident.id, snapshotId: newest, verdict: 'compromised', rationale: 'attacker still active', actorId: investigator.id });
  await assessSnapshot(client, {
    tenantRef, incidentId: incident.id, snapshotId: captured, verdict: 'clean', rationale: 'everything else predates the attacker', actorId: investigator.id,
    exclusions: [
      { naturalKey: 'group:backdoor', field: null, reason: 'attacker-created group granted Global Administrator' },
      { naturalKey: 'group:board', field: 'description', reason: 'defaced by the attacker' },
    ],
  });
  const graph = fakeGraph();
  graph.objects.set('/groups/board-id', { ...J4_BOARD, displayName: 'Board (renamed)', description: 'pwned', id: 'board-id' });
  graph.objects.set('/groups/backdoor-id', { ...J4_BACKDOOR, id: 'backdoor-id' });
  const restore = restoreRunner(ctx, graph);

  const refused = await restore.dryRun({ snapshotId: newest, selection: ['group:board'], incidentId: incident.id, requestedBy: requester.id })
    .then(() => 'accepted', () => 'refused');
  steps.push({ step: 'compromised-point', outcome: refused });
  const first = await restore.dryRun({ snapshotId: captured, selection: ['group:board'], incidentId: incident.id, requestedBy: requester.id });
  const firstOutcome = await restore.promote(first).then(() => 'passed', (error) => (/incident-check-failed/.test(error.message) ? 'checks-failed' : `error: ${error.message}`));
  steps.push({ step: 'restore-with-backdoor-live', outcome: firstOutcome });
  // The operator removes the attacker's group and the defacement, then restores again.
  graph.objects.delete('/groups/backdoor-id');
  graph.objects.set('/groups/board-id', { ...graph.objects.get('/groups/board-id'), description: 'Board members' });
  const artifactId = await restore.dryRun({ snapshotId: captured, selection: ['group:board'], incidentId: incident.id, requestedBy: requester.id });
  steps.push({ step: 'review', outcome: (await getDryRunArtifactById(client, { id: artifactId }))?.status ?? 'missing' });
  const promoted = await restore.promote(artifactId);
  steps.push({ step: 'promote', outcome: promoted.results?.failed?.length ? 'failed' : 'applied', restored: graph.objects.get('/groups/board-id')?.displayName,
    checks: (promoted.incidentChecks ?? []).map((check) => check.outcome) });
  const check = await evidenceLink(client, { tenantRef, kind: 'incident-recovery-check', where: { artifactId } });
  return {
    journey: 'J4', tenantRef, steps,
    terminal: { ref: check },
    links: { incident: { ref: incident.id }, 'restore-artifact': { ref: artifactId }, 'post-restore-check': { ref: check } },
  };
}

const J5_GROUP = { displayName: 'Finance approvers', mailNickname: 'finance-approvers', mailEnabled: false, securityEnabled: true, groupTypes: [] };

/** J5: a recreate restores configuration only; people close the remaining items with evidence. */
async function journeyPartialRestoreCompletion(client, ctx) {
  const tenantRef = `sha256:journey-j5-${randomUUID()}`;
  const operator = await principal(client, 'restorer', 'restore-operator');
  const steps = [];
  const snapshotId = await seedGroups(client, tenantRef, [J5_GROUP], { coverage: {} });
  const graph = fakeGraph();
  const restore = restoreRunner(ctx, graph);
  const artifactId = await restore.dryRun({ snapshotId, selection: ['group:finance-approvers'], requestedBy: operator.id });
  const promoted = await restore.promote(artifactId);
  let items = await listCompletionItems(client, { tenantRef, restoreRef: artifactId });
  steps.push({ step: 'restore', outcome: resourceCompletionState(items), failed: promoted.results?.failed?.length ?? 0, items: items.length });
  // A completer who lost the grant is refused; a current one closes each item with evidence.
  const revoked = await principal(client, 'restorer', 'former-operator');
  await revokeRole(client, { principalId: revoked.id, grantId: revoked.grantId, revokedBy: operator.id });
  const refusal = await completeItem(client, { tenantRef, itemId: items[0].id, actorId: revoked.id, evidence: { type: 'ticket', reference: 'CHG-1' } })
    .then(() => 'accepted', () => 'refused');
  steps.push({ step: 'revoked-completer', outcome: refusal });
  for (const item of items) {
    await completeItem(client, { tenantRef, itemId: item.id, actorId: operator.id, evidence: { type: 'ticket', reference: `CHG-${item.kind}` } });
  }
  items = await listCompletionItems(client, { tenantRef, restoreRef: artifactId });
  steps.push({ step: 'human-completion', outcome: resourceCompletionState(items) });
  const completion = await evidenceLink(client, { tenantRef, kind: COMPLETION_EVIDENCE_KIND, where: { restoreRef: artifactId } });
  return {
    journey: 'J5', tenantRef, steps,
    terminal: { ref: artifactId },
    links: { 'restore-artifact': { ref: artifactId }, 'completion-evidence': { ref: completion } },
  };
}

// The tables a reconstruction carries, in foreign-key-safe order (as task-68's fixture).
const DUMP_TABLES = [
  ['principal', ['id', 'external_id', 'email', 'display_name', 'disabled_at']],
  ['role_grant', ['id', 'principal_id', 'role', 'scope', 'active_from', 'active_until', 'granted_by', 'reason']],
  ['schedule', ['id', 'tenant_ref', 'job_kind', 'tier', 'cadence', 'cron_override', 'enabled', 'next_due_at', 'last_job_id', 'created_at', 'updated_at']],
  ['evidence', ['seq', 'tenant_ref', 'occurred_at', 'kind', 'subject', 'actor', 'prev_hash', 'record_hash']],
  ['evidence_head', ['tenant_ref', 'head_seq', 'head_hash', 'record_count', 'updated_at']],
];

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return `'${value.toISOString()}'::timestamptz`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object') return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function renderTenantDump(client, tenantRef) {
  const statements = ['-- keel journey J6 dump'];
  for (const [table, columns] of DUMP_TABLES) {
    const scoped = columns.includes('tenant_ref');
    const { rows } = await client.query(
      `SELECT ${columns.join(', ')} FROM ${table} ${scoped ? 'WHERE tenant_ref = $1' : ''} ORDER BY 1`, scoped ? [tenantRef] : [],
    );
    if (rows.length === 0) continue;
    const values = rows.map((row) => `(${columns.map((column) => sqlLiteral(row[column])).join(', ')})`);
    statements.push(`INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${values.join(',\n')};`);
  }
  // Literal values, as pg_dump writes them: the import accepts no other setval.
  const { rows: [{ max }] } = await client.query('SELECT max(seq)::text AS max FROM evidence');
  if (max !== null) statements.push(`SELECT setval('evidence_seq_seq', ${max}, true);`);
  return statements.join('\n');
}

/** J6: KEEL's own history is rebuilt read-only from independent artifacts and matches the checkpoint. */
async function journeyReconstruction(client, ctx) {
  const tenantRef = `sha256:journey-j6-${randomUUID()}`;
  const steps = [];
  const directory = mkdtempSync(join(ctx.workdir, 'j6-'));
  await principal(client, 'operator', 'recovery-source');
  await seedSchedules(client, { tenantRef });
  await appendEvidence(client, { tenantRef, kind: 'backup-complete', subject: { dump: 'journey' }, actor: 'journey', eventSink: quietSink });
  const snapshotId = await createSnapshot(client, { tenantRef });
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey: 'user:ana@example.test', resourceType: 'user', payload: { id: 'u1', userPrincipalName: 'ana@example.test', displayName: 'Fixture User' },
      payloadHash: 'fixture-hash', criticality: 'tier1', blastRadius: 'access-affecting', fidelity: 'read-only',
      provenance: { adapter: 'journey-fixture', collectedAt: new Date().toISOString(), fidelity: 'read-only' },
    },
  });
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: { ...fullSuccessfulCoverageDigest(), user: { outcome: 'complete', itemCount: 1 } } });
  const { exportDir } = await exportSnapshot(client, { tenantRef, snapshotId, exportRoot: join(directory, 'export') });
  const exportManifestBytes = await readFile(join(exportDir, 'manifest.json'));
  const exportManifest = JSON.parse(exportManifestBytes.toString('utf8'));
  const dumpBytes = gzipSync(await renderTenantDump(client, tenantRef));
  const dumpPath = join(directory, 'dump.sql.gz');
  await writeFile(dumpPath, dumpBytes);
  const { rows: [head] } = await client.query('SELECT head_seq, head_hash, record_count FROM evidence_head WHERE tenant_ref = $1', [tenantRef]);
  const checkpoint = { headSeq: Number(head.head_seq), headHash: head.head_hash, recordCount: Number(head.record_count) };
  const build = { revision: 'c'.repeat(40), schemaPin: await currentSchemaPin() };
  const manifest = buildRecoveryManifest({
    tenantRef, build,
    dump: { path: dumpPath, sha256: sha256Hex(dumpBytes), bytes: dumpBytes.length },
    observationIds: Object.keys(exportManifest.types).map((type) => `${snapshotId}:${type}`),
    configExport: { manifestPath: join(exportDir, 'manifest.json'), manifestSha256: sha256Hex(exportManifestBytes) },
    evidenceCheckpoint: checkpoint,
    residency: { provider: 'local-disk', region: 'journey fixture volume' },
    keyRecovery: { heldBy: 'security officer', location: 'offline safe, envelope #7', instructions: 'Retrieve envelope #7; the passphrase is held separately.' },
  });
  const manifestPath = join(directory, 'recovery.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  steps.push({ step: 'independent-artifacts', outcome: 'written' });

  const options = {
    tenantRef, manifestPath, dumpPath, configExportDir: exportDir, expectedBuild: build, expectedCheckpoint: checkpoint,
    identity: { principalId: 'recovery-officer@example.test', credentialRef: 'break-glass token reference: safe #7' },
    authenticator: async () => true,
    credentials: {
      recoveryKeyMaterial: 'sealed envelope #7, offline safe',
      artifactStorageRead: 'backup service account reference: keel-backup@service-accounts',
      tenantRecoveryAuthorization: 'change record CR-2026-1004 signed by the security officer',
    },
    createTargetDatabase: ctx.createTargetDatabase,
  };
  // An anonymous emergency identity is refused before any artifact is read.
  const anonymous = await reconstructRecovery({ ...options, identity: { anonymous: true } });
  steps.push({ step: 'anonymous-identity', outcome: anonymous.ok ? 'accepted' : 'refused' });
  const result = await reconstructRecovery(options);
  steps.push({ step: 'reconstruct', outcome: result.stage, readOnly: result.readOnly === true });
  rmSync(directory, { recursive: true, force: true });
  return {
    journey: 'J6', tenantRef, steps,
    terminal: { ref: { result, checkpoint } },
    links: {
      'source-checkpoint': { ref: { seq: checkpoint.headSeq, recordHash: checkpoint.headHash } },
      'reconstructed-head': { ref: { result } },
    },
  };
}

export const JOURNEY_RUNNERS = Object.freeze({
  J1: journeyOnboarding,
  J2: journeyCollectionToInvestigation,
  J3: journeyEmergencyDeviation,
  J4: journeyMaliciousChangeRecovery,
  J5: journeyPartialRestoreCompletion,
  J6: journeyReconstruction,
});

/**
 * Run one journey. `ctx`: { dbUrl (isolated, schema applied), createTargetDatabase,
 * workdir, handlers? }. The returned claim is input to assessJourney, never a verdict.
 */
export async function runJourney(client, id, ctx) {
  journeyDefinition(id);
  return JOURNEY_RUNNERS[id](client, ctx);
}

// --------------------------------------------------------------- assessment

/**
 * Store readers. Each re-reads its object for the claimed tenant only and
 * returns { row, state } or null. They are the only source of the states the
 * assessment compares: nothing the runner reported is used as a state.
 */
const STORE_READERS = {
  async 'first-collect-readiness'(client, { tenantRef, ref }) {
    if (ref !== tenantRef) return null;
    const readiness = await firstCollectReadiness(client, { tenantRef });
    return { row: readiness, state: readiness.basis };
  },
  async 'bootstrap-plan'(client, { tenantRef, ref }) {
    const { rows: [row] } = await client.query('SELECT artifact_id FROM bootstrap_plan WHERE tenant_ref = $1 AND artifact_id::text = $2', [tenantRef, String(ref)]);
    return row ? { row, state: 'approved' } : null;
  },
  async 'bootstrap-event'(client, { tenantRef, ref }) {
    const { rows: [row] } = await client.query('SELECT id, artifact_id, state, evidence FROM bootstrap_event WHERE tenant_ref = $1 AND id::text = $2', [tenantRef, String(ref)]);
    if (!row) return null;
    return { row, state: row.state === 'observed' && row.evidence?.status === 'satisfied' ? 'observed-satisfied' : row.state };
  },
  async snapshot(client, { tenantRef, ref }) {
    const { rows: [row] } = await client.query('SELECT id, status FROM snapshot WHERE tenant_ref = $1 AND id::text = $2', [tenantRef, String(ref)]);
    return row ? { row, state: row.status } : null;
  },
  async job(client, { ref }) {
    // Jobs carry no tenant column; tenant-bound job params are checked by the parent link.
    const { rows: [row] } = await client.query('SELECT id, kind, status, params FROM job WHERE id::text = $1', [String(ref)]);
    return row ? { row, state: row.status } : null;
  },
  async drift(client, { tenantRef, ref }) {
    const { rows: [row] } = await client.query('SELECT id, observed_snapshot FROM drift WHERE tenant_ref = $1 AND id::text = $2', [tenantRef, String(ref)]);
    return row ? { row, state: 'recorded' } : null;
  },
  async 'baseline-compliance'(client, { tenantRef, ref }) {
    const entries = await baselineCompliance(client, { tenantRef });
    const entry = entries.find((candidate) => String(candidate.id) === String(ref));
    if (!entry) return null;
    const changes = entry.changesSinceCapture;
    return { row: entry, state: changes?.state === 'compared' && changes.total > 0 ? 'compared-with-changes' : changes?.state ?? 'unknown' };
  },
  async 'investigation-answer'(client, { tenantRef, ref }) {
    if (!ref?.request || !ref.driftId) return null;
    const answer = await answerQuestion(client, { tenantRef, scope: { central: true, entities: [] }, request: ref.request });
    // Verified only when the answer actually names the detected change, with its source.
    const named = answer.records.some((record) => String(record.id) === String(ref.driftId) && record.source?.kind === 'change');
    return { row: answer, state: named ? answer.status : 'unknown' };
  },
  async 'change-intent'(client, { tenantRef, ref }) {
    const { rows: [row] } = await client.query(
      `SELECT i.id, i.source_drift_id AS "sourceDriftId" FROM change_intent i WHERE i.tenant_ref = $1 AND i.id::text = $2`,
      [tenantRef, String(ref)],
    );
    return row ? { row, state: 'approved' } : null;
  },
  async incident(client, { tenantRef, ref }) {
    const { rows: [row] } = await client.query('SELECT id FROM incident WHERE tenant_ref = $1 AND id::text = $2', [tenantRef, String(ref)]);
    return row ? { row, state: 'open' } : null;
  },
  async 'dry-run-artifact'(client, { tenantRef, ref }) {
    const artifact = await getDryRunArtifactById(client, { id: String(ref) });
    if (!artifact || (artifact.tenantRef ?? artifact.tenant_ref) !== tenantRef) return null;
    return { row: { ...artifact, incidentId: artifact.incidentRecovery?.incidentId ?? null }, state: artifact.status };
  },
  async completion(client, { tenantRef, ref }) {
    const items = await listCompletionItems(client, { tenantRef, restoreRef: String(ref) });
    if (items.length === 0) return null;
    return { row: { items }, state: resourceCompletionState(items) };
  },
  async evidence(client, { tenantRef, ref, kind, field }) {
    if (!ref || typeof ref !== 'object') return null;
    const { rows: [row] } = await client.query(
      'SELECT seq, kind, subject, record_hash FROM evidence WHERE tenant_ref = $1 AND seq = $2', [tenantRef, ref.seq],
    );
    if (!row || row.record_hash !== ref.recordHash) return null;
    if (kind && row.kind !== kind) return null;
    return { row: { ...row.subject, head_hash: row.record_hash }, state: evidenceState(row.subject, field), chained: true };
  },
  async 'reconstructed-evidence-head'(client, { tenantRef, ref }) {
    const access = ref?.result?.access;
    if (!access) return null;
    const { rows: [row] } = await access.query('SELECT head_seq, head_hash, record_count FROM evidence_head WHERE tenant_ref = $1', [tenantRef]);
    if (!row) return null;
    const chain = await verifyChain(access, { tenantRef });
    return { row, state: chain.ok ? 'verified' : 'broken' };
  },
  async reconstruction(client, { tenantRef, ref }) {
    const result = ref?.result;
    if (!result?.ok || !result.access || result.readOnly !== true || result.writersDisabled !== true) {
      return { row: result ?? null, state: result?.stage ?? 'unknown' };
    }
    const { rows: [row] } = await result.access.query('SELECT head_seq, head_hash, record_count FROM evidence_head WHERE tenant_ref = $1', [tenantRef]);
    const matches = row && Number(row.head_seq) === ref.checkpoint.headSeq && row.head_hash === ref.checkpoint.headHash
      && Number(row.record_count) === ref.checkpoint.recordCount;
    return { row: result, state: matches ? result.stage : 'checkpoint-mismatch' };
  },
};

/** A list of checks passes only when it is non-empty and every check passed. */
function evidenceState(subject, field) {
  if (!field) return 'recorded';
  const value = subject?.[field];
  if (Array.isArray(value)) {
    if (value.length === 0) return 'no-checks';
    return value.every((entry) => entry?.outcome === 'passed') ? 'passed' : 'failed';
  }
  return value === undefined || value === null ? 'unknown' : String(value);
}

function linkValue(row, field) {
  return field.split('.').reduce((value, key) => (value == null ? value : value[key]), row);
}

/**
 * Independently decide whether a journey claim passed. Returns
 * { journey, ok, terminalState, failures, links: { slot: state } }.
 */
export async function assessJourney(client, claim) {
  const failures = [];
  const journey = journeyDefinition(claim?.journey);
  const tenantRef = claim.tenantRef;
  if (typeof tenantRef !== 'string' || !tenantRef.startsWith('sha256:')) failures.push('claim has no tenant reference');
  const links = claim.links ?? {};
  const resolved = {};
  let chained = false;

  for (const spec of journey.links) {
    const link = links[spec.slot];
    if (!link || link.ref === null || link.ref === undefined) {
      failures.push(`missing evidence link: ${spec.slot}`);
      continue;
    }
    const read = await STORE_READERS[spec.store](client, { tenantRef, ref: link.ref, links, field: null });
    if (!read) {
      failures.push(`evidence link does not resolve for this tenant: ${spec.slot}`);
      continue;
    }
    if (UNVERIFIED_STATES.includes(read.state) && spec.verified) failures.push(`link ${spec.slot} is only ${read.state}`);
    else if (spec.verified && !spec.verified.includes(read.state)) failures.push(`link ${spec.slot} is ${read.state}, not ${spec.verified.join('/')}`);
    resolved[spec.slot] = read;
    chained ||= read.chained === true;
  }
  // Ancestry: every link points at the link it descends from.
  for (const spec of journey.links.filter((entry) => entry.parent)) {
    const child = resolved[spec.slot];
    const parentLink = links[spec.parent];
    const parent = resolved[spec.parent];
    if (!child || !parent) {
      if (child && !parent) failures.push(`evidence ancestry broken: ${spec.slot} has no resolved ${spec.parent}`);
      continue;
    }
    const expected = parentLink.ref && typeof parentLink.ref === 'object' && 'recordHash' in parentLink.ref
      ? parentLink.ref.recordHash
      : parent.row?.id ?? parent.row?.artifact_id ?? parentLink.ref;
    const actual = linkValue(child.row, spec.field);
    if (actual === null || actual === undefined || String(actual) !== String(expected)) {
      failures.push(`evidence ancestry inconsistent: ${spec.slot}.${spec.field} does not point at ${spec.parent}`);
    }
  }

  const terminal = await STORE_READERS[journey.terminal.store](client, {
    tenantRef, ref: claim.terminal?.ref, links, kind: journey.terminal.kind, field: journey.terminal.field,
  });
  const terminalState = terminal?.state ?? 'missing';
  if (!terminal) failures.push('terminal outcome does not resolve for this tenant');
  else if (UNVERIFIED_STATES.includes(terminalState)) failures.push(`terminal outcome is only ${terminalState}: a queued or pending action is not a verified outcome`);
  else if (!journey.terminal.verified.includes(terminalState)) failures.push(`terminal outcome is ${terminalState}, not ${journey.terminal.verified.join('/')}`);
  chained ||= terminal?.chained === true;

  if (chained || journey.terminal.store === 'evidence') {
    const chain = await verifyChain(client, { tenantRef });
    if (!chain.ok) failures.push(`evidence chain broken at seq ${chain.brokenAtSeq}`);
  }
  return {
    journey: journey.id, title: journey.title, owners: journey.owners, ok: failures.length === 0, terminalState, failures,
    links: Object.fromEntries(journey.links.map((spec) => [spec.slot, resolved[spec.slot]?.state ?? 'unresolved'])),
    steps: claim.steps ?? [],
  };
}

/** Run and assess every journey. One journey failing never stops the others. */
export async function runAllJourneys(client, ctx, { ids = JOURNEYS.map((journey) => journey.id) } = {}) {
  const results = [];
  for (const id of ids) {
    let claim;
    try {
      claim = await runJourney(client, id, ctx);
    } catch (error) {
      const journey = journeyDefinition(id);
      results.push({ journey: id, title: journey.title, owners: journey.owners, ok: false, terminalState: 'error', failures: [`journey run failed: ${error.message}`], links: {}, steps: [] });
      continue;
    }
    try {
      results.push(await assessJourney(client, claim));
    } finally {
      await claim?.terminal?.ref?.result?.access?.client?.end().catch(() => {});
    }
  }
  return results;
}

/** Fixture result record for the release ledger: kept apart from live acceptance by construction. */
export function journeyFixtureRecord(results, { build = null, ranAt = new Date() } = {}) {
  return {
    contractVersion: JOURNEY_CONTRACT_VERSION,
    kind: 'keel-journey-fixture-results',
    evidenceLevel: 'fixture-tested',
    synthetic: true,
    build,
    ranAt: ranAt.toISOString(),
    journeys: results.map(({ journey, title, owners, ok, terminalState, failures, links }) => ({
      journey, title, owners, outcome: ok ? 'passed' : 'failed', terminalState, failures, links,
    })),
  };
}

// --------------------------------------------------------------------- CLI

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
}

async function main() {
  if (process.argv[2] !== 'run') {
    console.error('usage: journeys.mjs run --db-url <isolated test database URL> [--out <file>] [--build <rev>]');
    process.exit(2);
  }
  const url = arg('db-url', process.env.KEEL_DB_TEST_URL);
  if (!url) throw new Error('journeys need --db-url or KEEL_DB_TEST_URL (an isolated test database)');
  if (process.env.KEEL_DB_URL && url === process.env.KEEL_DB_URL) throw new Error('refusing to run journeys against KEEL_DB_URL');
  const schema = `keel_journeys_${randomUUID().replaceAll('-', '')}`;
  const admin = await connect(url);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scoped = new URL(url);
  scoped.searchParams.set('options', `-c search_path="${schema}"`);
  const workdir = mkdtempSync(join(tmpdir(), 'keel-journeys-'));
  const targets = [];
  const client = await connect(scoped.toString());
  try {
    await client.query(readFileSync(new URL('../../engine/store/schema.sql', import.meta.url), 'utf8'));
    const results = await runAllJourneys(client, {
      dbUrl: scoped.toString(), workdir,
      createTargetDatabase: async () => { const target = await createDisposableTarget({ targetUrl: url }); targets.push(target); return target; },
    });
    const record = journeyFixtureRecord(results, { build: arg('build', null) });
    const out = arg('out');
    if (out) writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    console.log(JSON.stringify(record, null, 2));
    process.exitCode = results.every((result) => result.ok) ? 0 : 1;
  } finally {
    await client.end();
    for (const target of targets) await target.cleanup().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    rmSync(workdir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
