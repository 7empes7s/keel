/**
 * Least-privilege onboarding prerequisite registry (roadmap task-74).
 *
 * This module declares — explicitly, one workload at a time — what a KEEL
 * onboarding plan is allowed to ask for. Four grant kinds are distinguished,
 * because they are satisfied by four different authorities and must never be
 * conflated:
 *
 *   graph-permission     Microsoft Graph application permissions, satisfied
 *                        (and ONLY satisfiable) by admin consent against the
 *                        KEEL app registration's requiredResourceAccess.
 *   workload-rbac        workload-side role assignments (e.g. an Intune RBAC
 *                        role). No Graph consent prompt assigns these.
 *   pim-activation       privileged Entra role elevation for the OPERATOR
 *                        performing onboarding (PIM eligibility/activation or
 *                        a standing assignment). Consent can never bypass a
 *                        privileged role requirement.
 *   keel-app-permission  KEEL-internal capabilities the app registration
 *                        record must carry (keel.collect / keel.restore).
 *
 * Three rules are enforced here, non-negotiably:
 *
 * 1. A grant becomes plannable ONLY through registerWorkloadPrerequisite() —
 *    never inferred from a CATALOG path, a capability claim or a SKU. A plan
 *    request naming a grant no workload registered is refused as an
 *    unrelated/over-broad grant (see assertRequestedGrantsDerived).
 * 2. Collector and restorer identities never share grants (Global
 *    Constraint: read/write credential separation). identity is one of
 *    engine/coverage/capabilities.mjs's CREDENTIAL_MODES, and a collector
 *    registration refuses any ReadWrite scope at the boundary.
 * 3. Every entry cites its documentation source URL and retrieval date
 *    (Global Constraint #8). These are declared prerequisites — fixture-
 *    tested code behavior, not live qualification (Global Constraint #6).
 *
 * The planner in ./plan.mjs consumes this registry; the executor and its
 * journal are task-75's lane. Nothing here provisions anything.
 */

import { CREDENTIAL_MODES } from '../coverage/capabilities.mjs';
import { ROLE_TEMPLATES } from '../coverage/diagnosis.mjs';

export const BOOTSTRAP_CONTRACT_VERSION = 1;

export const GRANT_KINDS = Object.freeze([
  'graph-permission', 'workload-rbac', 'pim-activation', 'keel-app-permission',
]);

// Admin consent satisfies graph-permission grants ONLY. It is never
// workload-rbac authority, never a PIM activation, never a KEEL-internal
// permission — one consent cannot provision every workload.
export const CONSENT_SATISFIES = Object.freeze(['graph-permission']);

// The Microsoft Graph first-party service principal app id — a Microsoft-
// global constant, identical in every tenant (the same constant the Graph
// permissions reference documents for programmatic permission lookup).
export const GRAPH_RESOURCE_APP_ID = '00000003-0000-0000-c000-000000000000';

// Well-known Entra role template ids beyond engine/coverage/diagnosis.mjs's
// ROLE_TEMPLATES set — Microsoft-global constants, identical in every tenant.
export const BOOTSTRAP_ROLE_TEMPLATES = Object.freeze({
  ...ROLE_TEMPLATES,
  applicationAdministrator: '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3',
  cloudApplicationAdministrator: '158c047a-c907-4556-b7ef-446551a6b5f7',
});

// A privileged operator role is also held by an operator with a role that
// includes all of its permissions: Global Administrator can do everything
// Privileged Role Administrator can, so asking for both would be redundant.
export const ROLES_INCLUDED_BY = Object.freeze({
  [BOOTSTRAP_ROLE_TEMPLATES.privilegedRoleAdministrator]: Object.freeze([BOOTSTRAP_ROLE_TEMPLATES.globalAdministrator]),
});

/** Template ids that satisfy a required operator role: the role itself and any role that includes it. */
export function rolesSatisfying(templateId) {
  return [templateId, ...(ROLES_INCLUDED_BY[templateId] ?? [])];
}

// Grants a least-privilege onboarding plan may NEVER request, regardless of
// which workload asks: content-access and whole-directory write grants are
// outside KEEL's configuration-only scope (plan header §1: no file/message
// content). Registration AND plan-time requests both refuse these.
export const FORBIDDEN_BROAD_GRANTS = Object.freeze([
  'Directory.ReadWrite.All',
  'Directory.AccessAsUser.All',
  'Files.ReadWrite.All',
  'Mail.ReadWrite',
  'full_access_as_app',
]);

export const WORKLOAD_ROLE_RESOLUTIONS = Object.freeze([
  // Resolved against a Microsoft-global directory role template id.
  'directory-role-template',
  // Resolved per-tenant at execution time (task-75) — workload role
  // definition ids are tenant objects, so the plan names the role and defers
  // the id lookup rather than inventing a GUID.
  'workload-lookup',
]);

const REGISTRY = new Map(); // workload -> frozen prerequisite record

function assertStringList(name, values) {
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || v.length === 0)) {
    throw new TypeError(`${name} must be non-empty strings`);
  }
}

/**
 * Declares the prerequisites of onboarding one workload. This is the ONLY
 * way a grant becomes plannable. `identity` is the credential mode the
 * workload's app registration belongs to ('collector' or 'restorer'); a
 * collector registration carrying a ReadWrite scope is refused, so read and
 * write credentials can never collapse into one registration.
 */
export function registerWorkloadPrerequisite({
  workload, identity,
  graphPermissions = [], workloadRoles = [], pimActivations = [], keelAppPermissions = [],
  source,
}) {
  if (typeof workload !== 'string' || workload.length === 0) {
    throw new TypeError('workload must be a non-empty string');
  }
  if (REGISTRY.has(workload)) {
    throw new Error(`${workload}: prerequisite already registered — extend the existing entry, never a parallel one`);
  }
  if (!CREDENTIAL_MODES.includes(identity)) {
    throw new TypeError(`${workload}: identity must be one of ${CREDENTIAL_MODES.join('/')} — collector and restorer credentials stay separate`);
  }
  assertStringList(`${workload}: graphPermissions`, graphPermissions);
  for (const scope of graphPermissions) {
    if (FORBIDDEN_BROAD_GRANTS.includes(scope)) {
      throw new TypeError(`${workload}: '${scope}' is a forbidden broad grant — least-privilege onboarding never requests it`);
    }
    if (identity === 'collector' && scope.split('.').includes('ReadWrite')) {
      throw new TypeError(`${workload}: '${scope}' is a write scope — the collector identity is read-only, write grants belong to the restorer identity`);
    }
  }
  if (!Array.isArray(workloadRoles) || workloadRoles.some((r) => typeof r?.displayName !== 'string' || r.displayName.length === 0
    || !WORKLOAD_ROLE_RESOLUTIONS.includes(r?.resolution)
    || (r.resolution === 'directory-role-template' && (typeof r?.templateId !== 'string' || r.templateId.length === 0)))) {
    throw new TypeError(`${workload}: workloadRoles must name { displayName, resolution } pairs (templateId required for directory-role-template)`);
  }
  if (!Array.isArray(pimActivations) || pimActivations.some((r) => typeof r?.templateId !== 'string' || r.templateId.length === 0
    || typeof r?.displayName !== 'string' || r.displayName.length === 0)) {
    throw new TypeError(`${workload}: pimActivations must name { templateId, displayName } pairs`);
  }
  assertStringList(`${workload}: keelAppPermissions`, keelAppPermissions);
  for (const permission of keelAppPermissions) {
    if (!/^keel\.[a-z][a-z-]*$/.test(permission)) {
      throw new TypeError(`${workload}: keelAppPermissions must be keel.* capability names, got '${permission}'`);
    }
  }
  if (typeof source?.url !== 'string' || !source.url.startsWith('https://')
    || typeof source?.retrievedAt !== 'string' || Number.isNaN(Date.parse(source.retrievedAt))) {
    throw new TypeError(`${workload}: a prerequisite requires its source { url, retrievedAt } — declared facts cite their documentation`);
  }
  REGISTRY.set(workload, Object.freeze({
    contractVersion: BOOTSTRAP_CONTRACT_VERSION,
    workload,
    identity,
    graphPermissions: Object.freeze([...graphPermissions]),
    workloadRoles: Object.freeze(workloadRoles.map((r) => Object.freeze({ ...r }))),
    pimActivations: Object.freeze(pimActivations.map((r) => Object.freeze({ templateId: r.templateId, displayName: r.displayName }))),
    keelAppPermissions: Object.freeze([...keelAppPermissions]),
    source: Object.freeze({ url: source.url, retrievedAt: new Date(source.retrievedAt).toISOString() }),
  }));
}

export function prerequisiteForWorkload(workload) {
  return REGISTRY.get(workload) ?? null;
}

/** Every registered workload prerequisite, in registration order (task-76 setup page). */
export function registeredWorkloads() {
  return [...REGISTRY.values()];
}

/**
 * Every grant name a set of registered workloads may request, per kind. This
 * is the derivation the plan's requested grants are checked against — a
 * requested grant outside this set is unrelated and refused.
 */
export function derivedGrantsFor(requirements) {
  const derived = new Set();
  for (const requirement of requirements) {
    for (const scope of requirement.graphPermissions) derived.add(`graph-permission:${scope}`);
    for (const role of requirement.workloadRoles) derived.add(`workload-rbac:${role.displayName}`);
    for (const role of requirement.pimActivations) derived.add(`pim-activation:${role.displayName}`);
    for (const permission of requirement.keelAppPermissions) derived.add(`keel-app-permission:${permission}`);
  }
  return derived;
}

/**
 * Refuses any requested grant that no registered workload derived. The plan
 * may request less than the derived set (a scoped-down onboarding), never
 * more — an unrelated broad grant is rejected here even if it would be a
 * valid Graph scope.
 */
export function assertRequestedGrantsDerived(requirements, requestedGrants) {
  assertStringList('requestedGrants', requestedGrants);
  const derived = derivedGrantsFor(requirements);
  for (const grant of requestedGrants) {
    if (FORBIDDEN_BROAD_GRANTS.includes(grant)) {
      throw new TypeError(`requested grant '${grant}' is a forbidden broad grant — least-privilege onboarding never requests it`);
    }
    const isDerived = GRANT_KINDS.some((kind) => derived.has(`${kind}:${grant}`));
    if (!isDerived) {
      throw new TypeError(`requested grant '${grant}' is not derived from any registered workload prerequisite — unrelated grants are rejected`);
    }
  }
  return requestedGrants;
}

// --- Explicit registrations -------------------------------------------------
// Declared prerequisites with their documentation source (Global Constraint
// #8: URLs re-checked and retrieval date recorded at implementation). These
// are declared facts exercised by fixtures — not live-qualified tenant
// evidence. Read scopes below match the read prerequisites task-53's
// diagnosis registry declares for the same endpoints.

registerWorkloadPrerequisite({
  workload: 'entra-collect',
  identity: 'collector',
  graphPermissions: [
    'User.Read.All',
    'Group.Read.All',
    'RoleManagement.Read.Directory',
    'Policy.Read.All',
  ],
  keelAppPermissions: ['keel.collect'],
  source: {
    url: 'https://learn.microsoft.com/en-us/graph/permissions-reference',
    retrievedAt: '2026-09-25',
  },
});

registerWorkloadPrerequisite({
  workload: 'intune-collect',
  identity: 'collector',
  graphPermissions: [
    'DeviceManagementConfiguration.Read.All',
    'DeviceManagementManagedDevices.Read.All',
  ],
  // Intune RBAC is a separate authority from Graph consent: the collector SP
  // needs a least-privileged Intune role, and built-in Intune role ids are
  // per-tenant objects — the plan names the role and defers the id lookup.
  workloadRoles: [
    { displayName: 'Read Only Operator', resolution: 'workload-lookup' },
  ],
  keelAppPermissions: ['keel.collect'],
  source: {
    url: 'https://learn.microsoft.com/en-us/intune/intune-service/fundamentals/role-based-access-control',
    retrievedAt: '2026-09-25',
  },
});

registerWorkloadPrerequisite({
  workload: 'entra-restore',
  identity: 'restorer',
  graphPermissions: [
    'Group.ReadWrite.All',
    'Policy.ReadWrite.ConditionalAccess',
    'RoleManagement.ReadWrite.Directory',
  ],
  // Assigning privileged roles and consenting RoleManagement write scopes
  // requires a privileged OPERATOR role. PIM activation is a named manual
  // prerequisite — admin consent can never bypass it.
  pimActivations: [
    { templateId: BOOTSTRAP_ROLE_TEMPLATES.privilegedRoleAdministrator, displayName: 'Privileged Role Administrator' },
  ],
  keelAppPermissions: ['keel.restore'],
  source: {
    url: 'https://learn.microsoft.com/en-us/graph/permissions-reference',
    retrievedAt: '2026-09-25',
  },
});
