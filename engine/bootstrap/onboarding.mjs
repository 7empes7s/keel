// Task 76: the read side of guided onboarding. Turns the task-74 plan and the
// task-75 journal into per-step progress for the portal's setup page, and
// decides whether the first collection may start. Nothing here writes the
// journal, provisions anything or calls Microsoft: readers are injected by the
// host exactly as planBootstrap() requires, and without them a step is
// "not checked", never assumed present or absent.
import { planBootstrap } from './plan.mjs';
import { registeredWorkloads } from './prerequisites.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';

// Two separate setups, one per credential. Read-only setup never asks for a
// write grant, so a pending restore prerequisite cannot hold up collection.
export const SETUP_SCOPES = Object.freeze({ read: 'collector', restore: 'restorer' });

const MANUAL_KINDS = Object.freeze(['pim-activation', 'workload-rbac']);

const emptyReaders = Object.fromEntries(['Applications', 'ServicePrincipals', 'AppRoleAssignments',
  'RoleAssignments', 'RoleEligibilitySchedules', 'SubscribedSkus'].map((n) => [`list${n}`, async () => []]));

export function workloadsForScope(scope) {
  const identity = SETUP_SCOPES[scope];
  if (!identity) throw new TypeError(`unknown setup scope: ${scope}`);
  return registeredWorkloads().filter((r) => r.identity === identity).map((r) => r.workload);
}

/** A non-empty subset of the scope's workloads; anything else is refused. */
export function selectWorkloads(scope, requested) {
  const allowed = workloadsForScope(scope);
  if (requested === undefined || requested === null) return allowed;
  if (!Array.isArray(requested) || requested.length === 0
    || requested.some((w) => !allowed.includes(w)) || new Set(requested).size !== requested.length) {
    throw new TypeError(`setup ${scope}: workloads must be a non-empty subset of ${allowed.join(', ')}`);
  }
  return [...requested].sort();
}

// What the operator sees for one step. 'done' requires observed evidence: a
// verified journal event, a satisfied journal observation, or (before any run)
// a satisfied reader observation. A manual step is never done because someone
// said so, and PIM eligibility alone is not active authority (task-75).
export function stepProgress(step, events = null, { observed = false } = {}) {
  if (events) {
    const last = events.filter((event) => event.step_id === step.id).at(-1);
    if (!last) return 'not-started';
    if (last.state === 'verified') return 'done';
    if (last.state === 'observed') return last.evidence?.status === 'satisfied' ? 'done' : 'to-do';
    if (last.state === 'pending-manual') return 'waiting-for-you';
    if (last.state === 'uncertain') return 'unclear';
    if (last.state === 'desired') return 'in-progress';
    return 'not-started';
  }
  if (!observed) return 'not-checked';
  if (step.status === 'satisfied') return step.kind === 'pim-activation' ? 'waiting-for-you' : 'done';
  if (step.status === 'pending-manual') return 'waiting-for-you';
  if (step.status === 'pending-consent') return 'needs-consent';
  return 'to-do';
}

export function runState(events) {
  const last = events.at(-1)?.state;
  if (last === 'complete') return 'complete';
  if (last === 'stopped') return 'stopped';
  if (last === 'pending-manual') return 'waiting-for-you';
  if (last === 'approved') return 'ready';
  return 'interrupted';
}

async function journalTablesExist(client) {
  const { rows: [row] } = await client.query(
    "SELECT to_regclass('bootstrap_plan') IS NOT NULL AND to_regclass('bootstrap_event') IS NOT NULL AS ready");
  return row.ready === true;
}

// Newest approved run carrying steps for this identity. Legacy task-74 plans
// were never approvals, so they never appear here (task-75 migration note).
async function latestRun(client, tenantRef, identity) {
  const { rows } = await client.query(`SELECT bp.artifact_id, bp.artifact, bp.approved_by, bp.created_at,
      p.display_name, p.email
    FROM bootstrap_plan bp LEFT JOIN principal p ON p.id::text = bp.approved_by
    WHERE bp.tenant_ref = $1 ORDER BY bp.created_at DESC, bp.artifact_id`, [tenantRef]);
  const row = rows.find((candidate) => candidate.artifact?.plan?.steps?.some((s) => s.identity === identity));
  if (!row) return null;
  const { rows: events } = await client.query(`SELECT id, step_id, state, evidence, created_at FROM bootstrap_event
    WHERE tenant_ref = $1 AND artifact_id = $2 ORDER BY id`, [tenantRef, row.artifact_id]);
  return { row, events };
}

const stepView = (step, progress) => ({
  id: step.id, kind: step.kind, identity: step.identity, workload: step.workload ?? null, name: step.name,
  action: step.action, requiredScopes: step.requiredScopes ?? [], missingScopes: step.missingScopes ?? [],
  manual: MANUAL_KINDS.includes(step.kind), progress,
});

async function latestCompletedSnapshot(client, tenantRef) {
  const { rows: [row] } = await client.query(`SELECT id, completed_at, coverage_digest FROM snapshot
    WHERE tenant_ref = $1 AND status = 'complete' AND completed_at IS NOT NULL
    ORDER BY completed_at DESC, started_at DESC, id DESC LIMIT 1`, [tenantRef]);
  return row ?? null;
}

/**
 * Task-76 acceptance: the first collection starts only when the read grants
 * are confirmed. Confirmed means either a collection has already completed
 * for this tenant (the grants demonstrably worked) or the newest read-setup
 * run finished with every step re-observed (task-75 'complete'). Restore
 * prerequisites never block it.
 */
export async function firstCollectReadiness(client, { tenantRef }) {
  assertTenantRef(tenantRef);
  if (await latestCompletedSnapshot(client, tenantRef)) return { allowed: true, basis: 'collected-before', missing: [] };
  if (!await journalTablesExist(client)) return { allowed: false, basis: 'not-set-up', missing: [] };
  const run = await latestRun(client, tenantRef, SETUP_SCOPES.read);
  if (!run) return { allowed: false, basis: 'not-set-up', missing: [] };
  if (runState(run.events) === 'complete') return { allowed: true, basis: 'read-access-confirmed', missing: [] };
  const missing = run.row.artifact.plan.steps
    .filter((step) => step.identity === SETUP_SCOPES.read && stepProgress(step, run.events) !== 'done')
    .map((step) => step.name);
  return { allowed: false, basis: 'read-access-unconfirmed', missing };
}

function firstCollection(snapshot) {
  if (!snapshot) return null;
  const outcomes = Object.values(snapshot.coverage_digest ?? {}).map((entry) => entry?.outcome);
  return {
    snapshotId: snapshot.id,
    completedAt: new Date(snapshot.completed_at).toISOString(),
    read: outcomes.filter((o) => o === 'complete' || o === 'complete-empty').length,
    notRead: outcomes.filter((o) => o && !['complete', 'complete-empty', 'not-requested'].includes(o)).length,
  };
}

/**
 * Everything the setup page shows. `readers` are the host's planBootstrap
 * read adapters; null means the server cannot look at the tenant, and every
 * step without journal evidence is reported 'not-checked'.
 */
export async function loadSetupState(client, { tenantRef, viewerId, readers = null, operatorPrincipalId = null, now = new Date() }) {
  assertTenantRef(tenantRef);
  const journal = await journalTablesExist(client);
  const scopes = [];
  for (const scope of Object.keys(SETUP_SCOPES)) {
    const identity = SETUP_SCOPES[scope];
    const workloads = workloadsForScope(scope);
    const run = journal ? await latestRun(client, tenantRef, identity) : null;
    if (run) {
      const steps = run.row.artifact.plan.steps.filter((step) => step.identity === identity);
      scopes.push({
        scope, workloads, observed: true,
        run: {
          artifactId: run.row.artifact_id,
          state: runState(run.events),
          workloads: run.row.artifact.plan.workloads,
          approvedBy: run.row.approved_by,
          approvedByName: run.row.display_name ?? run.row.email ?? null,
          approvedAt: new Date(run.row.created_at).toISOString(),
          lastEventAt: run.events.length ? new Date(run.events.at(-1).created_at).toISOString() : null,
          resumableByViewer: run.row.approved_by === viewerId,
          build: run.row.artifact.build,
          qualificationMode: run.row.artifact.qualificationMode,
        },
        steps: steps.map((step) => stepView(step, stepProgress(step, run.events))),
      });
      continue;
    }
    const plan = await planBootstrap({ tenantRef, workloads, readAdapters: readers ?? emptyReaders, operatorPrincipalId, now });
    scopes.push({
      scope, workloads, observed: readers !== null, run: null, planId: plan.planId,
      steps: plan.steps.map((step) => stepView(step, stepProgress(step, null, { observed: readers !== null }))),
    });
  }
  return {
    generatedAt: now.toISOString(),
    scopes,
    collect: await firstCollectReadiness(client, { tenantRef }),
    firstCollection: firstCollection(await latestCompletedSnapshot(client, tenantRef)),
  };
}
