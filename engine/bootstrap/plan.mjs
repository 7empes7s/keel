/**
 * Resumable least-privilege onboarding plan (roadmap task-74).
 *
 * planBootstrap() turns the registered workload prerequisites
 * (./prerequisites.mjs) plus the tenant's CURRENT app/service-principal state
 * — read exclusively through injected read adapters, never through a live
 * Graph call of its own — into a resumable plan. Five rules are enforced
 * here, non-negotiably:
 *
 * 1. Least privilege by construction: the plan asks for exactly the grants
 *    the registered workloads derive, nothing broader. A caller-supplied
 *    requestedGrants list must be a subset of that derivation — an unrelated
 *    or forbidden broad grant is rejected before any state is inspected.
 * 2. Existing correct registrations are REUSED. A preexisting app/SP whose
 *    requiredResourceAccess already covers the derived scopes yields a
 *    satisfied step with action 'reuse-existing' and a reference to the
 *    existing object — the plan never recreates it.
 * 3. Admin consent is not all workload authority. The consent block covers
 *    graph-permission grants ONLY (CONSENT_SATISFIES); workload-rbac
 *    assignments, PIM activations and KEEL app permissions stay explicit
 *    named steps no consent prompt can close, and privileged role
 *    requirements are never bypassed.
 * 4. A purchased SKU is never a substitute for a permission. Observed SKUs
 *    are recorded for operator visibility with an explicit note and are
 *    never consulted to satisfy a step.
 * 5. Secrets never enter the plan. Only object ids, scope names and
 *    credential references are carried, and the finished plan passes
 *    tools/tenant-probe/auth.mjs's assertTokenFree() before it is returned
 *    (Global Constraint #7).
 *
 * The plan is resumable: planId and step ids are content hashes independent
 * of step state, so re-running against fresh observed state closes satisfied
 * steps while pending steps keep their identities. Execution, journaling and
 * any write are task-75's lane — this module plans only. Conditional Access
 * is never enforced here (Global Constraint #2).
 */

import { createHash } from 'node:crypto';

import { CrossTenantObservationError } from '../contracts/observation.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { assertTokenFree } from '../../tools/tenant-probe/auth.mjs';
import {
  BOOTSTRAP_CONTRACT_VERSION, BOOTSTRAP_ROLE_TEMPLATES, CONSENT_SATISFIES, GRANT_KINDS,
  GRAPH_RESOURCE_APP_ID, assertRequestedGrantsDerived, prerequisiteForWorkload,
} from './prerequisites.mjs';

export const PLAN_STEP_STATES = Object.freeze([
  'satisfied', 'pending-consent', 'pending-provisioning', 'pending-manual',
]);

export const PLAN_STEP_KINDS = Object.freeze(['registration', ...GRANT_KINDS]);

// Creating an app registration is itself a privileged operation. The plan
// names the operator role rather than promising the plan can provision its
// own authority.
export const REGISTRATION_OPERATOR_ROLES = Object.freeze([
  { templateId: BOOTSTRAP_ROLE_TEMPLATES.applicationAdministrator, displayName: 'Application Administrator' },
  { templateId: BOOTSTRAP_ROLE_TEMPLATES.cloudApplicationAdministrator, displayName: 'Cloud Application Administrator' },
]);

const READ_ADAPTER_METHODS = Object.freeze([
  'listApplications',
  'listServicePrincipals',
  'listAppRoleAssignments',
  'listRoleAssignments',
  'listRoleEligibilitySchedules',
  'listSubscribedSkus',
]);

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

const appDisplayNameFor = (identity) => `keel-${identity}`;

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function assertReadAdapters(readAdapters) {
  for (const method of READ_ADAPTER_METHODS) {
    if (typeof readAdapters?.[method] !== 'function') {
      throw new TypeError(`planBootstrap requires an injected read adapter '${method}' — the planner never calls Microsoft Graph directly`);
    }
  }
}

function assertSameTenant(records, tenantRef) {
  for (const record of records) {
    if (record?.tenantRef !== undefined && record.tenantRef !== tenantRef) {
      throw new CrossTenantObservationError(record.tenantRef, tenantRef);
    }
  }
  return records;
}

// Reference-only projection of an observed app registration: object ids and
// display name are carried, everything else the adapter returned (including
// any credential-shaped field a buggy adapter might leak) is dropped.
const appReferenceFor = (app) => ({
  objectId: app.id,
  appId: app.appId,
  displayName: app.displayName,
});

function requiredScopesFor(app) {
  const scopes = new Set();
  for (const access of app?.requiredResourceAccess ?? []) {
    if (access?.resourceAppId !== GRAPH_RESOURCE_APP_ID) continue;
    for (const scope of access?.scopes ?? []) scopes.add(scope);
  }
  return scopes;
}

/**
 * Builds the resumable onboarding plan. `readAdapters` is the ONLY window
 * into tenant state (injected fakes in tests; the task-53+ collected-state
 * readers or the probe's read path in production). `operatorPrincipalId`
 * identifies the human performing onboarding so PIM/role prerequisites can be
 * checked; without it they stay pending-manual, never assumed.
 */
export async function planBootstrap({
  tenantRef, workloads, readAdapters, requestedGrants = null, operatorPrincipalId = null, now = new Date(),
}) {
  assertTenantRef(tenantRef);
  if (!Array.isArray(workloads) || workloads.length === 0
    || workloads.some((w) => typeof w !== 'string' || w.length === 0)) {
    throw new TypeError('planBootstrap requires a non-empty workload list');
  }
  assertReadAdapters(readAdapters);

  const requirements = workloads.map((workload) => {
    const requirement = prerequisiteForWorkload(workload);
    if (!requirement) {
      throw new TypeError(`${workload}: no registered workload prerequisite — refusing to plan unregistered (potentially unrelated) grants`);
    }
    return requirement;
  });
  if (requestedGrants !== null) {
    assertRequestedGrantsDerived(requirements, requestedGrants);
  }

  // Inspect preexisting state through the injected read adapters only.
  const observed = {
    applications: assertSameTenant(await readAdapters.listApplications(), tenantRef),
    servicePrincipals: assertSameTenant(await readAdapters.listServicePrincipals(), tenantRef),
    appRoleAssignments: assertSameTenant(await readAdapters.listAppRoleAssignments(), tenantRef),
    roleAssignments: assertSameTenant(await readAdapters.listRoleAssignments(), tenantRef),
    roleEligibilitySchedules: assertSameTenant(await readAdapters.listRoleEligibilitySchedules(), tenantRef),
    subscribedSkus: assertSameTenant(await readAdapters.listSubscribedSkus(), tenantRef),
  };

  const steps = [];
  const step = (kind, identity, workload, name, fields) => {
    const entry = {
      id: `step-${hash({ tenantRef, kind, identity, workload, name })}`,
      kind, identity, workload, name,
      ...fields,
    };
    steps.push(entry);
    return entry;
  };

  const identities = [...new Set(requirements.map((r) => r.identity))].sort();

  for (const identity of identities) {
    const identityRequirements = requirements.filter((r) => r.identity === identity);
    const derivedScopes = [...new Set(identityRequirements.flatMap((r) => r.graphPermissions))].sort();
    const displayName = appDisplayNameFor(identity);

    const app = observed.applications.find((candidate) => candidate?.displayName === displayName) ?? null;
    const servicePrincipal = app
      ? observed.servicePrincipals.find((candidate) => candidate?.appId === app.appId) ?? null
      : null;
    const declaredScopes = requiredScopesFor(app);
    const registrationComplete = app !== null && servicePrincipal !== null
      && derivedScopes.every((scope) => declaredScopes.has(scope));

    // Registration: reuse an existing correct registration; never recreate it.
    step('registration', identity, null, displayName, {
      status: registrationComplete ? 'satisfied' : 'pending-provisioning',
      action: registrationComplete ? 'reuse-existing' : (app ? 'update-required-access' : 'create-registration'),
      reference: app ? appReferenceFor(app) : null,
      servicePrincipalObjectId: servicePrincipal?.id ?? null,
      requiredScopes: derivedScopes,
      missingFromRegistration: derivedScopes.filter((scope) => !declaredScopes.has(scope)),
      operatorRoles: REGISTRATION_OPERATOR_ROLES,
      note: 'Creating or widening an app registration requires a privileged operator role; the plan never recreates an existing correct registration.',
    });

    // Graph permissions: satisfied only by observed consent on THIS identity's
    // service principal. The ONLY kind admin consent can satisfy.
    const consentedScopes = new Set(
      observed.appRoleAssignments
        .filter((grant) => servicePrincipal && grant?.principalId === servicePrincipal.id
          && grant?.resourceAppId === GRAPH_RESOURCE_APP_ID)
        .map((grant) => grant?.scope)
        .filter((scope) => typeof scope === 'string'),
    );
    const missingConsent = derivedScopes.filter((scope) => !consentedScopes.has(scope));
    step('graph-permission', identity, null, `${displayName} admin consent`, {
      status: missingConsent.length === 0 ? 'satisfied' : 'pending-consent',
      action: 'grant-consent',
      resourceAppId: GRAPH_RESOURCE_APP_ID,
      requiredScopes: derivedScopes,
      consentedScopes: [...consentedScopes].sort(),
      missingScopes: missingConsent,
    });

    // Workload RBAC: a separate authority from Graph consent.
    for (const requirement of identityRequirements) {
      for (const role of requirement.workloadRoles) {
        const assigned = servicePrincipal !== null && observed.roleAssignments.some((assignment) => {
          if (assignment?.principalId !== servicePrincipal.id) return false;
          if (role.resolution === 'directory-role-template') return assignment?.roleDefinitionId === role.templateId;
          return assignment?.displayName === role.displayName;
        });
        step('workload-rbac', identity, requirement.workload, role.displayName, {
          status: assigned ? 'satisfied' : 'pending-manual',
          action: 'assign-workload-role',
          resolution: role.resolution,
          note: 'Workload RBAC is assigned in the workload, not by Graph admin consent.',
        });
      }

      // PIM activation: a privileged OPERATOR prerequisite. Consent never
      // bypasses it; without an identified operator it cannot even be checked.
      for (const role of requirement.pimActivations) {
        const standing = operatorPrincipalId !== null && observed.roleAssignments.some(
          (assignment) => assignment?.principalId === operatorPrincipalId && assignment?.roleDefinitionId === role.templateId,
        );
        const eligible = operatorPrincipalId !== null && observed.roleEligibilitySchedules.some(
          (schedule) => schedule?.principalId === operatorPrincipalId && schedule?.roleDefinitionId === role.templateId,
        );
        step('pim-activation', identity, requirement.workload, role.displayName, {
          status: standing || eligible ? 'satisfied' : 'pending-manual',
          action: 'pim-activate',
          templateId: role.templateId,
          note: operatorPrincipalId === null
            ? 'Operator not identified — privileged role standing/eligibility cannot be verified and is never assumed.'
            : 'Privileged role held by the onboarding operator via standing assignment or PIM eligibility; admin consent cannot bypass it.',
        });
      }
    }

    // KEEL-internal app permissions: one step per permission per identity,
    // regardless of how many workloads derive it.
    for (const permission of [...new Set(identityRequirements.flatMap((r) => r.keelAppPermissions))].sort()) {
      const configured = app !== null && (app.keelPermissions ?? []).includes(permission);
      step('keel-app-permission', identity, null, permission, {
        status: configured ? 'satisfied' : 'pending-provisioning',
        action: 'configure-keel-permission',
      });
    }
  }

  const missingConsentByIdentity = Object.fromEntries(identities.map((identity) => [
    identity,
    steps.find((s) => s.kind === 'graph-permission' && s.identity === identity).missingScopes,
  ]));

  const plan = deepFreeze({
    contractVersion: BOOTSTRAP_CONTRACT_VERSION,
    planId: `plan-${hash({ tenantRef, workloads: [...workloads].sort(), steps: steps.map((s) => s.id).sort() })}`,
    tenantRef,
    createdAt: now.toISOString(),
    workloads: [...workloads].sort(),
    identities,
    steps,
    consent: {
      resourceAppId: GRAPH_RESOURCE_APP_ID,
      scopesByIdentity: missingConsentByIdentity,
      satisfiesKinds: CONSENT_SATISFIES,
      neverSatisfies: GRANT_KINDS.filter((kind) => !CONSENT_SATISFIES.includes(kind)),
      statement: 'Admin consent grants the named Microsoft Graph application permissions only. It assigns no workload RBAC role, activates no PIM role and configures no KEEL app permission — one consent cannot provision every workload, and privileged role requirements are never bypassed.',
    },
    manualPrerequisites: steps
      .filter((s) => s.status === 'pending-manual')
      .map((s) => ({ step: s.id, kind: s.kind, name: s.name, action: s.action })),
    licensing: {
      observedSkus: [...new Set(observed.subscribedSkus.map((sku) => sku?.skuPartNumber).filter(Boolean))].sort(),
      note: 'A purchased SKU is recorded for operator visibility only. SKU ownership never satisfies or substitutes for a permission, consent, role assignment or PIM activation.',
    },
    credentials: 'references-only — object ids and credential references are carried, never secret values or tokens',
    resume: {
      resumable: true,
      how: 'Re-run planBootstrap against freshly observed state. planId and step ids are content hashes independent of step state: satisfied steps close, pending steps keep their identities. Execution and journaling belong to task-75.',
    },
    source: requirements.map((r) => ({ workload: r.workload, url: r.source.url, retrievedAt: r.source.retrievedAt })),
  });

  return assertTokenFree(plan, 'bootstrap plan');
}
