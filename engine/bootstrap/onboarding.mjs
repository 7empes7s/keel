// Task 76: the read side of guided onboarding. Turns the task-74 plan and the
// task-75 journal into per-step progress for the portal's setup page, and
// decides whether the first collection may start. Nothing here writes the
// journal, provisions anything or calls Microsoft: readers are injected by the
// host exactly as planBootstrap() requires, and without them a step is
// "not checked", never assumed present or absent.
import { planBootstrap } from './plan.mjs';
import { registeredWorkloads } from './prerequisites.mjs';
import { KEEL_PERMISSIONS, PERMISSION_APIS, PERMISSION_KINDS, PERMISSION_SERVICES } from './permissionCatalog.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { readNamer } from '../insights/anonymity.mjs';
import { displayPerson } from '../insights/people.mjs';
import { readCoverageOutcome, readOutcome } from '../coverage/snapshots.mjs';

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

const stepView = (step, progress, app = null) => ({
  id: step.id, kind: step.kind, identity: step.identity, workload: step.workload ?? null, name: step.name,
  action: step.action, requiredScopes: step.requiredScopes ?? [], missingScopes: step.missingScopes ?? [],
  excessScopes: step.excessScopes ?? [],
  manual: MANUAL_KINDS.includes(step.kind), progress, app,
});

// The app a scope's steps are about: the observed registration's display name and app
// id (identifiers, not secrets), or the app id the host is bound to when the
// registration has not been observed. Only these two fields leave the plan.
function appFor(steps, identity, appIds) {
  const reference = steps.find((step) => step.kind === 'registration')?.reference ?? null;
  const appId = reference?.appId ?? appIds?.[identity] ?? null;
  if (!appId && !reference?.displayName) return null;
  return { displayName: reference?.displayName ?? null, appId };
}

async function latestCompletedSnapshot(client, tenantRef) {
  const { rows: [row] } = await client.query(`SELECT id, completed_at, coverage_digest FROM snapshot
    WHERE tenant_ref = $1 AND status = 'complete' AND completed_at IS NOT NULL
    ORDER BY completed_at DESC, started_at DESC, id DESC LIMIT 1`, [tenantRef]);
  return row ?? null;
}

// The tenant's first finished backup: the Setup "First backup" tile says when it ran,
// so it must not move each time a newer backup finishes.
async function firstCompletedSnapshot(client, tenantRef) {
  const { rows: [row] } = await client.query(`SELECT s.id, s.completed_at, s.coverage_digest,
      (SELECT count(DISTINCT rv.resource_type) FROM resource_version rv WHERE rv.snapshot_id = s.id)::int AS saved_types
    FROM snapshot s
    WHERE s.tenant_ref = $1 AND s.status = 'complete' AND s.completed_at IS NOT NULL
    ORDER BY s.completed_at ASC, s.started_at ASC, s.id ASC LIMIT 1`, [tenantRef]);
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

// How many types the first backup read. Older backups recorded a bare item count or an
// observation-contract entry instead of an outcome, so a read is judged the way What's
// protected judges it (readCoverageOutcome); only an explicit partial or failed read
// counts as not read. A backup whose digest proves no read at all falls back to the
// types it saved settings for (`saved_types`).
export function firstCollection(snapshot) {
  if (!snapshot) return null;
  const digest = snapshot.coverage_digest && typeof snapshot.coverage_digest === 'object' && !Array.isArray(snapshot.coverage_digest)
    ? snapshot.coverage_digest : {};
  const entries = Object.values(digest);
  const failed = (entry) => ['partial', 'failed'].includes(readOutcome(entry))
    || ['partial', 'failed'].includes(entry?.completeness);
  const read = entries.filter((entry) => readCoverageOutcome(entry).covered).length;
  const notRead = entries.filter((entry) => !readCoverageOutcome(entry).covered && failed(entry)).length;
  return {
    snapshotId: snapshot.id,
    completedAt: new Date(snapshot.completed_at).toISOString(),
    // The saved types stand in only when the digest says nothing either way.
    read: read || notRead ? read : Number(snapshot.saved_types) || 0,
    notRead,
  };
}

// The permission table: every permission Keel uses (the catalogue) and, when the host
// can read the tenant, what each app holds right now and what its registration asks
// for. Read fresh on every load, even after a finished setup run, so a grant removed
// later shows as missing.
async function permissionsView(readers) {
  const catalog = { permissions: KEEL_PERMISSIONS, services: PERMISSION_SERVICES, kinds: PERMISSION_KINDS,
    apis: Object.fromEntries(Object.entries(PERMISSION_APIS).map(([key, api]) => [key, api.label])) };
  if (!readers?.listPermissions) return { ...catalog, observed: null };
  const byIdentity = await readers.listPermissions();
  const unchecked = readers.uncheckedKinds ? await readers.uncheckedKinds() : [];
  // Intune roles are read through Intune's own role lists; when those cannot be read,
  // the Intune role rows say "not checked".
  const uncheckedApis = unchecked.includes('workload-rbac') ? ['intune'] : [];
  return { ...catalog, observed: { byIdentity, complete: !unchecked.includes('permissions'), uncheckedApis } };
}

/**
 * Everything the setup page shows. `readers` are the host's planBootstrap
 * read adapters; null means the server cannot look at the tenant, and every
 * step without journal evidence is reported 'not-checked'. `appIds` maps an
 * identity to the app id the host is bound to, so the page can link to the
 * app before its registration has been observed.
 */
export async function loadSetupState(client, { tenantRef, viewerId, readers = null, operatorPrincipalId = null, appIds = null, now = new Date() }) {
  assertTenantRef(tenantRef);
  const journal = await journalTablesExist(client);
  const scopes = [];
  // "Hide people's names": read once, only when a run names who started it.
  let namer;
  for (const scope of Object.keys(SETUP_SCOPES)) {
    const identity = SETUP_SCOPES[scope];
    const workloads = workloadsForScope(scope);
    const run = journal ? await latestRun(client, tenantRef, identity) : null;
    if (run) {
      const steps = run.row.artifact.plan.steps.filter((step) => step.identity === identity);
      const app = appFor(steps, identity, appIds);
      scopes.push({
        scope, workloads, observed: true,
        run: {
          artifactId: run.row.artifact_id,
          state: runState(run.events),
          workloads: run.row.artifact.plan.workloads,
          approvedBy: run.row.approved_by,
          approvedByName: run.row.display_name || run.row.email
            ? displayPerson({ kind: 'person', id: run.row.approved_by, name: run.row.display_name ?? run.row.email, email: run.row.email ?? null, readable: true, system: false }, namer ??= await readNamer(client)).name
            : null,
          approvedAt: new Date(run.row.created_at).toISOString(),
          lastEventAt: run.events.length ? new Date(run.events.at(-1).created_at).toISOString() : null,
          resumableByViewer: run.row.approved_by === viewerId,
          build: run.row.artifact.build,
          qualificationMode: run.row.artifact.qualificationMode,
        },
        steps: steps.map((step) => stepView(step, stepProgress(step, run.events), app)),
      });
      continue;
    }
    const plan = await planBootstrap({ tenantRef, workloads, readAdapters: readers ?? emptyReaders, operatorPrincipalId, now });
    // A host reader may be unable to see one kind of authority (for example
    // Intune roles without an Intune RBAC read grant). Those steps stay
    // "not checked": an unreadable state is never shown as missing or present.
    const unchecked = new Set(readers?.uncheckedKinds ? await readers.uncheckedKinds() : []);
    const app = appFor(plan.steps.filter((step) => step.identity === identity), identity, appIds);
    scopes.push({
      scope, workloads, observed: readers !== null, run: null, planId: plan.planId,
      steps: plan.steps.map((step) => stepView(step,
        stepProgress(step, null, { observed: readers !== null && !unchecked.has(step.kind) }), app)),
    });
  }
  return {
    generatedAt: now.toISOString(),
    scopes,
    permissions: await permissionsView(readers),
    collect: await firstCollectReadiness(client, { tenantRef }),
    firstCollection: firstCollection(await firstCompletedSnapshot(client, tenantRef)),
  };
}
