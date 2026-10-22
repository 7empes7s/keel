/** Spec §10.1. Fails loud on an unknown type — a silent default would be the
 * dangerous direction (a mis-classified tenant-lockout resource treated as
 * cosmetic bypasses every gate that follows). */
const BLAST_RADIUS = {
  user: 'access-affecting',
  authenticationStrengthPolicy: 'tenant-lockout',
  group: 'access-affecting',
  roleAssignment: 'tenant-lockout',
  namedLocation: 'tenant-lockout',
  conditionalAccessPolicy: 'tenant-lockout',
};

export function blastRadiusOf(type) {
  const c = BLAST_RADIUS[type];
  if (!c) throw new Error(`no blast-radius classification for resource type "${type}"`);
  return c;
}

const BLAST_ORDER = ['cosmetic', 'access-affecting', 'tenant-lockout'];

/**
 * Task 60: conservative refusal policy over a dynamic-group impact prediction
 * (engine/graph/dynamicImpact.mjs). A prediction is never exact membership, so
 * this never relaxes anything — it only escalates:
 *  - any group not predicted unchanged is at least access-affecting; a
 *    role-assignable one is tenant-lockout (its members hold directory roles);
 *  - an automated change is refused when the prediction is incomplete (work
 *    budget exhausted), when a role-assignable group is only POSSIBLY affected
 *    (we cannot bound a privileged membership change), or when the number of
 *    possibly-affected groups exceeds the caller's ceiling.
 * An unclassified outcome throws, mirroring blastRadiusOf: a silent default is
 * the dangerous direction.
 */
export function dynamicImpactPolicy(prediction, { maxPossiblyAffected = Infinity } = {}) {
  let blastRadius = null;
  const raise = (level) => {
    if (blastRadius === null || BLAST_ORDER.indexOf(level) > BLAST_ORDER.indexOf(blastRadius)) blastRadius = level;
  };
  const refusals = [];
  let possibly = 0;
  for (const result of prediction.results) {
    if (!['predicted-change', 'possibly-affected', 'no-predicted-change'].includes(result.outcome)) {
      throw new Error(`unclassified dynamic impact outcome "${result.outcome}" for ${result.naturalKey}`);
    }
    if (result.outcome === 'no-predicted-change') continue;
    raise(result.isAssignableToRole ? 'tenant-lockout' : 'access-affecting');
    if (result.outcome === 'possibly-affected') {
      possibly += 1;
      if (result.isAssignableToRole) refusals.push({ reason: 'role-assignable-group-unbounded', group: result.naturalKey, causes: result.reasons });
    }
  }
  if (!prediction.complete) refusals.push({ reason: 'dynamic-prediction-incomplete', exhausted: prediction.budget?.exhausted ?? null });
  if (possibly > maxPossiblyAffected) refusals.push({ reason: 'possibly-affected-above-ceiling', possiblyAffected: possibly, ceiling: maxPossiblyAffected });
  if (!prediction.complete) raise('tenant-lockout');
  return { blastRadius, refused: refusals.length > 0, refusals, exactMembership: false };
}

// Per-rule rating for Conditional Access. The type rating above says what a
// policy COULD do; a stored policy says what it DOES. Rated from the payload,
// never below what the payload proves: anything unread or unrecognised keeps
// the type's 'tenant-lockout'.

/** Apps whose loss locks admins out of the tenant, or that stand for every app. */
const ADMIN_REACH_APPS = new Set([
  'all', 'office365', 'microsoftadminportals',
  '797f4846-ba00-4fd7-ba43-dac1f8f63013', // Windows Azure Service Management API
  'c44b4083-3bb0-49c1-b47d-974e53cbdf3c', // Azure portal
  '00000003-0000-0000-c000-000000000000', // Microsoft Graph
  '00000002-0000-0000-c000-000000000000', // Azure AD Graph
  '14d82eec-204b-4c2f-b7e8-296a70dab67e', // Microsoft Graph Command Line Tools
  '1950a258-227b-4e31-a9cf-717495945fc2', // Azure PowerShell
  '04b07795-8ddb-461a-bbee-02f9e1bf7b46', // Azure CLI
]);

const lowered = (list) => (Array.isArray(list) ? list.map((value) => String(value).toLowerCase()) : []);
const present = (value) => value !== null && value !== undefined && value !== false
  && !(Array.isArray(value) && value.length === 0)
  && !(typeof value === 'object' && !Array.isArray(value) && value.isEnabled === false);

/** True only when the policy names specific apps, none of them an admin way in
 * (no "all apps", no admin portals, no user actions, auth contexts or app filter). */
function appScoped(applications) {
  if (!applications || typeof applications !== 'object') return false;
  const apps = lowered(applications.includeApplications);
  if (apps.length === 0 || apps.some((app) => ADMIN_REACH_APPS.has(app))) return false;
  if (lowered(applications.includeUserActions).length) return false;
  if (lowered(applications.includeAuthenticationContextClassReferences).length) return false;
  if (present(applications.applicationFilter)) return false;
  return true;
}

function hasGrantOrBlock(grant) {
  if (!grant || typeof grant !== 'object') return false;
  return lowered(grant.builtInControls).length > 0
    || present(grant.authenticationStrength)
    || lowered(grant.customAuthenticationFactors).length > 0
    || lowered(grant.termsOfUse).length > 0;
}

function hasSessionControl(session) {
  if (!session || typeof session !== 'object') return false;
  return Object.values(session).some(present);
}

const ONE_LOWER = { 'tenant-lockout': 'access-affecting', 'access-affecting': 'cosmetic', cosmetic: 'cosmetic' };

/**
 * What one Conditional Access policy can do to sign-ins:
 *  - block or grant controls on all apps (or an admin way in) or on admin roles:
 *    'tenant-lockout' (exclusions alone do not lower it: the policy cannot prove
 *    they are the emergency accounts);
 *  - block, grant or session controls on named non-admin apps only (the SharePoint
 *    unmanaged-device rules): 'access-affecting';
 *  - session controls anywhere else, no readable controls or conditions: 'tenant-lockout';
 *  - disabled or report-only: one step lower than when on.
 */
export function conditionalAccessBlastRadius(policy) {
  if (!policy || typeof policy !== 'object') return 'tenant-lockout';
  const conditions = policy.conditions;
  if (!conditions || typeof conditions !== 'object' || !conditions.users || typeof conditions.users !== 'object') return 'tenant-lockout';
  const grant = hasGrantOrBlock(policy.grantControls);
  const session = hasSessionControl(policy.sessionControls);
  let rating = 'tenant-lockout';
  if ((grant || session) && appScoped(conditions.applications) && lowered(conditions.users.includeRoles).length === 0) {
    rating = 'access-affecting';
  }
  const state = String(policy.state ?? '').toLowerCase();
  if (state === 'disabled' || state === 'enabledforreportingbutnotenforced') return ONE_LOWER[rating];
  return rating;
}

/** Types rated per item from their payload; every other type keeps its catalog rating. */
const PER_ITEM = { conditionalAccessPolicy: conditionalAccessBlastRadius };

/** The rating of one stored item: per item where the type is rated so and the
 * payload is there, otherwise the stored (type) rating. */
export function itemBlastRadius(resourceType, payload, stored) {
  const rate = PER_ITEM[resourceType];
  if (!rate || payload === null || payload === undefined) return stored ?? null;
  return rate(payload);
}

/** The strictest of the given labels. An unrecognised label wins, as everywhere
 * else in the engine: it can never slip under a lower one. */
export function strictestBlastRadius(...labels) {
  let worst = null;
  for (const label of labels) {
    if (label === null || label === undefined) continue;
    if (!BLAST_ORDER.includes(label)) return label;
    if (worst === null || BLAST_ORDER.indexOf(label) > BLAST_ORDER.indexOf(worst)) worst = label;
  }
  return worst;
}

/** The rating of one change: the strictest of the rule before and after it, since
 * putting either side back applies that side. Falls back to the stored rating
 * when neither side's payload is there. */
export function changeBlastRadius(resourceType, beforePayload, afterPayload, stored) {
  if (!PER_ITEM[resourceType]) return stored ?? null;
  const sides = [beforePayload, afterPayload].filter((payload) => payload !== null && payload !== undefined);
  if (sides.length === 0) return stored ?? null;
  return strictestBlastRadius(...sides.map((payload) => itemBlastRadius(resourceType, payload, stored)));
}

/** Safety gates (restore lockout guards, automation ceilings) keep the type's
 * rating as a floor: the per-rule rating is what Keel shows, never a way to
 * relax a gate. */
export function gateBlastRadius(resourceType, label) {
  if (!PER_ITEM[resourceType]) return label ?? null;
  return strictestBlastRadius(label ?? 'tenant-lockout', blastRadiusOf(resourceType));
}
