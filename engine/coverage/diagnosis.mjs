/**
 * License, consent and role diagnosis without masking failures (roadmap
 * task-53).
 *
 * When a per-type collection read fails with an authorization-shaped error,
 * this module answers one narrow question: is a *named prerequisite* of that
 * read — a tenant license/service plan, a granted consent scope, or an
 * assigned directory role — *confirmed missing* by independent evidence?
 * Four rules are enforced here, non-negotiably:
 *
 * 1. Only a confirmed missing prerequisite yields a named diagnosis. An
 *    ambiguous 403 stays 'unknown' and keeps the original HTTP status and
 *    Graph code untouched; a failure that is not authorization-shaped (500,
 *    throttle, transport) is never re-labeled as a licensing problem.
 * 2. SKU ownership alone is insufficient for user entitlement or consent.
 *    An enabled service plan never *clears* a failure; it only means the
 *    license dimension is not the confirmed cause. Consent and role are
 *    separate dimensions, evidenced separately (oauth2PermissionGrant and
 *    roleAssignment observations), never inferred from licenses.
 * 3. Evidence is time-qualified and tenant-scoped. The newest mention of
 *    each evidence type decides — a newer failed read supersedes every older
 *    success (never resurrect stale evidence). Stale or future observations
 *    are unusable; a cross-tenant observation refuses the join by throwing.
 * 4. Diagnosis never mutates the raw collection outcome. It is an additional
 *    field on a report entry; the raw status/outcome/detail recorded by the
 *    collector stay exactly as observed (see engine/coverage/report.mjs).
 *
 * The registry below is versioned and source-linked: every entry names the
 * catalogue endpoint it belongs to (via tools/tenant-probe/catalog.mjs) and
 * the Microsoft documentation URL with its retrieval date (Global Constraint
 * #8). It records *declared* prerequisites — fixture-tested code behavior,
 * not live qualification.
 */

import { catalogEntryFor } from '../../tools/tenant-probe/catalog.mjs';
import { CrossTenantObservationError } from '../contracts/observation.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';

export const DIAGNOSIS_CONTRACT_VERSION = 1;

export const DIAGNOSIS_STATES = Object.freeze([
  'missing-license', 'disabled-plan', 'missing-scope', 'missing-role', 'unknown',
]);

// SKU, consent and role evidence are all tier1 observations; they qualify a
// diagnosis only while a tier1 observation is fresh — the same staleness
// window engine/coverage/report.mjs applies to tier1 coverage.
export const PREREQUISITE_EVIDENCE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// Microsoft-global directory role template ids, identical in every tenant —
// the same basis as catalog.mjs's directoryRoleTemplate note. unifiedRoleAssignment
// roleDefinitionId values for built-in roles match these template ids.
export const ROLE_TEMPLATES = Object.freeze({
  globalAdministrator: '62e90394-69f5-4237-9190-012177145e10',
  globalReader: 'f2ef992c-3afb-46b9-b7cf-a126ee74c451',
  privilegedRoleAdministrator: 'e8611ab8-c189-46e8-94e1-60213ab1f814',
  directoryReaders: '88d8e3e3-8f55-4a1e-953a-9b9898b8876b',
});

// feature -> frozen prerequisite record
const REGISTRY = new Map();

/**
 * Declares the prerequisites of reading one catalogue feature. This is the
 * ONLY way a feature becomes diagnosable — never inferred from a CATALOG path
 * or an HTTP status. `feature` must be a type the estate actually collects
 * (source-linked through catalogEntryFor); `source` names the documentation
 * URL and retrieval date backing the declared scopes/roles/plan.
 */
export function registerFeaturePrerequisite({
  feature, servicePlan = null, consentScopes = [], requiredRoles = [], source,
}) {
  const catalogEntry = catalogEntryFor(feature);
  if (!catalogEntry) {
    throw new TypeError(`${feature}: prerequisites register against a collected catalogue type, nothing collects this feature`);
  }
  if (servicePlan !== null && typeof servicePlan !== 'string') {
    throw new TypeError(`${feature}: servicePlan must be a service-plan name string or null`);
  }
  if (!Array.isArray(consentScopes) || consentScopes.some((s) => typeof s !== 'string' || s.length === 0)) {
    throw new TypeError(`${feature}: consentScopes must be non-empty scope strings`);
  }
  if (!Array.isArray(requiredRoles) || requiredRoles.some((r) => typeof r?.templateId !== 'string' || r.templateId.length === 0 || typeof r?.displayName !== 'string' || r.displayName.length === 0)) {
    throw new TypeError(`${feature}: requiredRoles must name { templateId, displayName } pairs`);
  }
  if (typeof source?.url !== 'string' || source.url.length === 0
    || typeof source?.retrievedAt !== 'string' || Number.isNaN(Date.parse(source.retrievedAt))) {
    throw new TypeError(`${feature}: a prerequisite requires its source { url, retrievedAt } — declared facts cite their documentation`);
  }
  REGISTRY.set(feature, Object.freeze({
    contractVersion: DIAGNOSIS_CONTRACT_VERSION,
    feature,
    endpoint: catalogEntry.path,
    apiVersion: catalogEntry.version,
    servicePlan,
    // Alternatives: ANY ONE of the listed scopes/roles satisfies the
    // dimension (least-privileged and higher-privileged forms both work).
    consentScopes: Object.freeze([...consentScopes]),
    requiredRoles: Object.freeze(requiredRoles.map((r) => Object.freeze({ templateId: r.templateId, displayName: r.displayName }))),
    source: Object.freeze({ url: source.url, retrievedAt: new Date(source.retrievedAt).toISOString() }),
  }));
}

export function prerequisiteFor(feature) {
  return REGISTRY.get(feature) ?? null;
}

/**
 * Newest-mention selection over an evidence series. The newest observation
 * decides, success or failure — a newer failed read supersedes every older
 * success, so an older success can never be resurrected to justify a
 * diagnosis after the read that would prove it has started failing.
 */
function newestMention(series) {
  return [...series].sort((a, b) => {
    const aTime = Date.parse(a?.observedAt);
    const bTime = Date.parse(b?.observedAt);
    if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return bTime - aTime;
  })[0];
}

/**
 * An evidence series is usable only when its newest mention is a completed
 * read (complete or complete-empty), time-qualified (not stale, not in the
 * future) and from this tenant. A cross-tenant mention refuses the whole
 * join by throwing; every other gap degrades that dimension to unusable —
 * never to a confirmed diagnosis and never to an older success.
 */
function usableEvidence(series, { tenantRef, now, dimension }) {
  if (!Array.isArray(series) || series.length === 0) {
    return { usable: false, reason: 'no-observation' };
  }
  const newest = newestMention(series);
  if (newest.tenantRef !== undefined && newest.tenantRef !== tenantRef) {
    throw new CrossTenantObservationError(newest.tenantRef, tenantRef);
  }
  const observedAt = Date.parse(newest.observedAt);
  if (Number.isNaN(observedAt)) return { usable: false, reason: 'untimed-observation' };
  if (observedAt > now.getTime() + FUTURE_TOLERANCE_MS) return { usable: false, reason: 'future-observation' };
  if (now.getTime() - observedAt > PREREQUISITE_EVIDENCE_MAX_AGE_MS) return { usable: false, reason: 'stale-observation' };
  if (newest.outcome !== 'complete' && newest.outcome !== 'complete-empty') {
    return { usable: false, reason: `newest-read-${newest.outcome ?? 'unknown'}` };
  }
  return { usable: true, observation: newest, dimension };
}

function skuPlanStatuses(skus) {
  const statuses = new Map();
  for (const sku of skus ?? []) {
    for (const plan of sku?.servicePlans ?? []) {
      const name = plan?.servicePlanName;
      if (typeof name !== 'string') continue;
      if (!statuses.has(name)) statuses.set(name, []);
      statuses.get(name).push(plan.provisioningStatus ?? null);
    }
  }
  return statuses;
}

/**
 * Diagnose one failed feature read against the registered prerequisite and
 * the three independent evidence dimensions. `failure` is the raw outcome
 * detail ({ httpStatus, graphCode }) exactly as collected; it is echoed back
 * in `original` on every result, named or unknown. Each evidence dimension is
 * a series of mentions newest-decides:
 *
 *   evidence.sku:     [{ outcome, observedAt, tenantRef, skus: [raw subscribedSku payloads] }]
 *   evidence.consent: [{ outcome, observedAt, tenantRef, grantedScopes: [scope strings] }]
 *   evidence.roles:   [{ outcome, observedAt, tenantRef, assignedRoleIds: [roleDefinitionId strings] }]
 */
export function diagnoseFailure({ feature, failure, evidence = {}, tenantRef, now = new Date() }) {
  assertTenantRef(tenantRef);
  const original = Object.freeze({
    httpStatus: Number.isInteger(failure?.httpStatus) ? failure.httpStatus : null,
    graphCode: typeof failure?.graphCode === 'string' ? failure.graphCode : null,
  });
  const checked = {};

  const unknown = (reason) => Object.freeze({
    contractVersion: DIAGNOSIS_CONTRACT_VERSION,
    feature,
    diagnosis: 'unknown',
    original,
    reason,
    checked: Object.freeze({ ...checked }),
  });
  const named = (diagnosis, confirmed) => Object.freeze({
    contractVersion: DIAGNOSIS_CONTRACT_VERSION,
    feature,
    diagnosis,
    original,
    confirmed: Object.freeze(confirmed),
    checked: Object.freeze({ ...checked }),
    prerequisite: Object.freeze({
      servicePlan: prerequisite.servicePlan,
      consentScopes: prerequisite.consentScopes,
      requiredRoles: prerequisite.requiredRoles,
      source: prerequisite.source,
    }),
  });

  const prerequisite = prerequisiteFor(feature);
  if (!prerequisite) return unknown('no-registered-prerequisite');
  // Only an authorization-shaped failure can be a missing prerequisite. A 500,
  // a throttle or a transport error with the same missing license is still a
  // 500 — classifying it as missing-license would mask the real failure.
  if (original.httpStatus !== 403) return unknown('failure-not-authorization-shaped');

  // License dimension: confirmed missing only when a usable, complete SKU read
  // proves the tenant owns no SKU carrying the plan (missing-license), or owns
  // it only in Disabled form (disabled-plan). An enabled plan does NOT clear
  // the failure — entitlement and consent are separate questions.
  if (prerequisite.servicePlan !== null) {
    const sku = usableEvidence(evidence.sku, { tenantRef, now, dimension: 'license' });
    checked.license = sku.usable ? 'usable' : sku.reason;
    if (sku.usable) {
      const statuses = skuPlanStatuses(sku.observation.skus).get(prerequisite.servicePlan) ?? [];
      if (statuses.length === 0) {
        return named('missing-license', { servicePlan: prerequisite.servicePlan });
      }
      if (statuses.every((status) => status === 'Disabled')) {
        return named('disabled-plan', { servicePlan: prerequisite.servicePlan });
      }
    }
  } else {
    checked.license = 'no-license-prerequisite';
  }

  // Consent dimension: confirmed missing only when a usable, complete consent
  // read grants NONE of the acceptable scopes anywhere in the tenant.
  if (prerequisite.consentScopes.length > 0) {
    const consent = usableEvidence(evidence.consent, { tenantRef, now, dimension: 'consent' });
    checked.consent = consent.usable ? 'usable' : consent.reason;
    if (consent.usable) {
      const granted = new Set(consent.observation.grantedScopes ?? []);
      if (prerequisite.consentScopes.every((scope) => !granted.has(scope))) {
        return named('missing-scope', { consentScopes: prerequisite.consentScopes });
      }
    }
  } else {
    checked.consent = 'no-consent-prerequisite';
  }

  // Role dimension: confirmed missing only when a usable, complete role-
  // assignment read shows NO assignment of ANY acceptable role in the whole
  // tenant — then no principal, the collector included, can hold it. Any
  // existing assignment makes the collector's own standing ambiguous.
  if (prerequisite.requiredRoles.length > 0) {
    const roles = usableEvidence(evidence.roles, { tenantRef, now, dimension: 'roles' });
    checked.roles = roles.usable ? 'usable' : roles.reason;
    if (roles.usable) {
      const assigned = new Set(roles.observation.assignedRoleIds ?? []);
      if (prerequisite.requiredRoles.every((role) => !assigned.has(role.templateId))) {
        return named('missing-role', {
          requiredRoles: prerequisite.requiredRoles.map((role) => role.displayName),
        });
      }
    }
  } else {
    checked.roles = 'no-role-prerequisite';
  }

  // Nothing confirmed missing: the ambiguous 403 stays unknown with its
  // original status and code — the raw failure is never masked.
  return unknown('no-confirmed-missing-prerequisite');
}

// --- Explicit registrations -------------------------------------------------
// Declared prerequisites with their documentation source (Global Constraint
// #8: URL and retrieval date recorded). These are declared facts exercised by
// fixtures — not live-qualified tenant evidence.

registerFeaturePrerequisite({
  feature: 'roleEligibilitySchedule',
  servicePlan: 'AAD_PREMIUM_P2',
  consentScopes: ['RoleEligibilitySchedule.Read.Directory', 'RoleManagement.Read.Directory'],
  requiredRoles: [
    { templateId: ROLE_TEMPLATES.globalReader, displayName: 'Global Reader' },
    { templateId: ROLE_TEMPLATES.privilegedRoleAdministrator, displayName: 'Privileged Role Administrator' },
  ],
  source: {
    url: 'https://learn.microsoft.com/en-us/graph/api/rbacapplication-list-roleeligibilityscheduleinstances?view=graph-rest-1.0',
    retrievedAt: '2026-09-22',
  },
});

registerFeaturePrerequisite({
  feature: 'accessReviewScheduleDefinition',
  servicePlan: 'AAD_PREMIUM_P2',
  consentScopes: ['AccessReview.Read.All'],
  requiredRoles: [
    { templateId: ROLE_TEMPLATES.globalReader, displayName: 'Global Reader' },
    { templateId: ROLE_TEMPLATES.globalAdministrator, displayName: 'Global Administrator' },
  ],
  source: {
    url: 'https://learn.microsoft.com/en-us/graph/api/accessreviewscheduledefinition-list?view=graph-rest-1.0',
    retrievedAt: '2026-09-22',
  },
});

registerFeaturePrerequisite({
  feature: 'roleAssignment',
  servicePlan: null,
  consentScopes: ['RoleManagement.Read.Directory'],
  requiredRoles: [
    { templateId: ROLE_TEMPLATES.globalReader, displayName: 'Global Reader' },
    { templateId: ROLE_TEMPLATES.directoryReaders, displayName: 'Directory Readers' },
  ],
  source: {
    url: 'https://learn.microsoft.com/en-us/graph/api/rbacapplication-list-roleassignments?view=graph-rest-1.0',
    retrievedAt: '2026-09-22',
  },
});
