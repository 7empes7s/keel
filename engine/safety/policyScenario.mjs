/**
 * Roadmap task-95: bounded proposed-policy scenario evaluation.
 *
 * Question answered: "if this proposed Conditional Access change were enforced next to
 * every policy already enforced, which of the sampled sign-in paths of these protected
 * principals would still be open?"
 *
 * Rules this module keeps:
 *
 *  - The PROPOSED COMBINED policy set is evaluated (current enforced policies with the
 *    proposed creates, updates and deletes laid over them), never each policy on its
 *    own. A sign-in path is open only when every applying policy lets it through, so
 *    two policies that each leave a path open can together close every path. The
 *    isolated per-change view is reported next to it, so the difference is visible.
 *  - Only an explicitly supported predicate subset (SUPPORTED_POLICY_SUBSET) is
 *    evaluated, with three-valued logic (true / false / unknown). An unsupported
 *    condition, grant control or session control yields `unknown`, never "does not
 *    apply" and never "allowed".
 *  - Scenarios are generated per principal from a scoped dimension list (applications,
 *    client apps, platforms, named locations, risk levels). Generation and evaluation
 *    are bounded (`maxScenarios`, `maxSteps`). When the matrix is larger than the
 *    budget a deterministic sample is evaluated and the truncation is reported; the
 *    scenarios not evaluated stay untested (unknown).
 *  - A passing result is always labelled `sampled`: it shows that at least one
 *    evaluated path stays open, never that the principal cannot be locked out. There is
 *    deliberately no "universally safe" verdict.
 *  - Microsoft's What If API evaluates the LIVE policies of a tenant. A What If read is
 *    attached as separate `live-policy-read` evidence and never changes a verdict about
 *    the proposed state (`provesProposedState: false`). No live call is made here.
 *  - Nothing here writes to a tenant or replaces an existing gate: the restore sign-in
 *    path gate, the report-only enforcement and the tenant-lockout delete refusal all
 *    stay as they are (see simulationGate.mjs#proposedPolicyGate).
 */
import { createHash } from 'node:crypto';

import { TYPE_COVERAGE_CTES, readCoverageOutcome } from '../coverage/snapshots.mjs';
import { policyTreatment } from './breakGlassInvariant.mjs';
import { loadBreakGlassReadiness, loadGroupMembership } from './breakGlassReadiness.mjs';

export const POLICY_SCENARIO_VERSION = 1;
export const DEFAULT_SCENARIO_BUDGET = Object.freeze({ maxScenarios: 256, maxSteps: 1_000_000 });
export const MAX_SCENARIO_BUDGET = Object.freeze({ maxScenarios: 4_096, maxSteps: 10_000_000 });
export const LIVE_POLICY_READ = 'live-policy-read';

// Built-in authentication strength policy ids (Microsoft documented constants).
export const BUILT_IN_STRENGTHS = Object.freeze({
  multifactor: '00000000-0000-0000-0000-000000000002',
  passwordless: '00000000-0000-0000-0000-000000000003',
  phishingResistant: '00000000-0000-0000-0000-000000000004',
});

export const SUPPORTED_POLICY_SUBSET = Object.freeze({
  states: ['enabled (enforced)', 'disabled and enabledForReportingButNotEnforced (not enforced, skipped)'],
  users: ['includeUsers / excludeUsers (ids, All)', 'includeGroups / excludeGroups (read membership only)', 'includeRoles / excludeRoles (collected active assignments only)'],
  applications: ['includeApplications / excludeApplications: All, None, or the exact application token of the scenario'],
  clientAppTypes: ['all', 'browser', 'mobileAppsAndDesktopClients', 'exchangeActiveSync', 'other'],
  platforms: ['includePlatforms / excludePlatforms: all, android, iOS, windows, windowsPhone, macOS, linux'],
  locations: ['includeLocations / excludeLocations: All, AllTrusted, named location ids'],
  risk: ['userRiskLevels', 'signInRiskLevels'],
  grantControls: ['block', 'mfa', 'compliantDevice', 'domainJoinedDevice', 'approvedApplication', 'compliantApplication', 'passwordChange', 'authenticationStrength (by id)', 'operator AND / OR'],
  sessionControls: ['signInFrequency', 'persistentBrowser (they do not decide access)'],
  unsupported: [
    'guest or external user conditions', 'user actions and authentication contexts', 'application filters',
    'device filters and legacy device states', 'client applications (workload identities)', 'authentication flows',
    'insider and service principal risk', 'terms of use and custom controls',
    'every other session control (continuous access evaluation, app enforced restrictions, Defender for Cloud Apps, resilience defaults, ...)',
    'any condition key KEEL does not know',
  ],
});

const DEFAULT_PATHS = Object.freeze({
  applications: ['MicrosoftAdminPortals'],
  clientAppTypes: ['browser', 'mobileAppsAndDesktopClients'],
  platforms: ['windows', 'macOS', 'iOS', 'android', 'linux'],
  userRiskLevels: ['none'],
  signInRiskLevels: ['none'],
});
const DIMENSIONS = Object.freeze(['application', 'clientAppType', 'platform', 'location', 'userRisk', 'signInRisk']);
const CAPABILITIES = Object.freeze(['mfa', 'compliantDevice', 'domainJoinedDevice', 'approvedApplication', 'compliantApplication', 'passwordChange']);
const SUPPORTED_SESSION = new Set(['signInFrequency', 'persistentBrowser']);
const KNOWN_PLATFORMS = new Set(['all', 'android', 'ios', 'windows', 'windowsphone', 'macos', 'linux']);
const CLIENT_APP_TYPES = new Set(['all', 'browser', 'mobileappsanddesktopclients', 'exchangeactivesync', 'other']);
const RISK_LEVELS = new Set(['none', 'low', 'medium', 'high']);

const T = true;
const F = false;
const U = 'unknown';

const lower = (list) => (Array.isArray(list) ? list.map((value) => String(value).toLowerCase()) : []);
// Whether a condition carries anything: an object of only nulls and empty lists is empty.
function filled(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).some((key) => !key.startsWith('@odata') && filled(value[key]));
  return true;
}

function and(values) {
  if (values.some((value) => value === F)) return F;
  if (values.some((value) => value === U)) return U;
  return T;
}

function or(values) {
  if (values.some((value) => value === T)) return T;
  if (values.some((value) => value === U)) return U;
  return F;
}

const not = (value) => (value === U ? U : !value);

/** A condition KEEL does not evaluate: the policy's applicability becomes unknown. */
function unsupportedPredicate(reason, reasons) {
  reasons.push(reason);
  return U;
}

// ---------------------------------------------------------------- predicates

function usersPredicate(policy, principal, reasons) {
  const users = policy.conditions?.users;
  if (filled(users?.includeGuestsOrExternalUsers) || filled(users?.excludeGuestsOrExternalUsers)) {
    if (principal.userType !== 'member') return unsupportedPredicate('unsupported-condition:guests-or-external-users', reasons);
  }
  const treated = policyTreatment(policy, principal.id, {
    groupMembers: (group) => principal.memberOf(group),
    roleTemplates: principal.roleTemplates,
  });
  if (treated.treatment === 'applies') return T;
  if (treated.treatment === 'excluded' || treated.treatment === 'not-applicable') return F;
  reasons.push(`unknown-users:${treated.reason}`);
  return U;
}

function listMatch(list, value, { all = 'all', none = 'none' } = {}) {
  const values = lower(list);
  if (values.includes(String(value).toLowerCase())) return T;
  if (values.includes(all)) return T;
  if (values.includes(none)) return F;
  return F;
}

function applicationsPredicate(policy, scenario, reasons) {
  const apps = policy.conditions?.applications;
  if (!apps || typeof apps !== 'object') return unsupportedPredicate('unsupported-condition:applications-unreadable', reasons);
  for (const key of Object.keys(apps)) {
    if (key.startsWith('@odata')) continue;
    if (['includeApplications', 'excludeApplications'].includes(key)) continue;
    if (filled(apps[key])) return unsupportedPredicate(`unsupported-condition:applications.${key}`, reasons);
  }
  const app = String(scenario.application).toLowerCase();
  const tokenMatch = (list) => {
    const values = lower(list);
    if (values.includes('all') || values.includes(app)) return T;
    // A suite token (Office365, MicrosoftAdminPortals) or an id other than the
    // scenario's application may or may not contain it: KEEL does not resolve suites.
    const other = values.filter((value) => value !== 'none');
    if (other.some((value) => !/^[0-9a-f-]{36}$/.test(value) || !/^[0-9a-f-]{36}$/.test(app))) return U;
    return F;
  };
  const included = tokenMatch(apps.includeApplications);
  if (included === U) reasons.push('unknown-application-membership');
  const excluded = filled(apps.excludeApplications) ? tokenMatch(apps.excludeApplications) : F;
  if (excluded === U) reasons.push('unknown-application-membership');
  return and([included, not(excluded)]);
}

function clientAppsPredicate(policy, scenario, reasons) {
  const types = lower(policy.conditions?.clientAppTypes);
  if (!types.length || types.includes('all')) return T;
  if (types.some((type) => !CLIENT_APP_TYPES.has(type))) return unsupportedPredicate('unsupported-condition:client-app-type', reasons);
  return types.includes(String(scenario.clientAppType).toLowerCase()) ? T : F;
}

function platformsPredicate(policy, scenario, reasons) {
  const platforms = policy.conditions?.platforms;
  if (!filled(platforms)) return T;
  const include = lower(platforms.includePlatforms);
  const exclude = lower(platforms.excludePlatforms);
  if ([...include, ...exclude].some((value) => !KNOWN_PLATFORMS.has(value))) return unsupportedPredicate('unsupported-condition:platform', reasons);
  const platform = String(scenario.platform).toLowerCase();
  return and([listMatch(include, platform), not(exclude.length ? listMatch(exclude, platform) : F)]);
}

function locationsPredicate(policy, scenario, reasons) {
  const locations = policy.conditions?.locations;
  if (!filled(locations)) return T;
  const location = scenario.location ?? {};
  const matches = (list) => {
    const values = lower(list);
    if (values.includes('all')) return T;
    if (values.includes('alltrusted')) {
      if (location.trusted === true) return T;
      if (location.trusted === null || location.trusted === undefined) return U;
    }
    if (location.id && values.includes(String(location.id).toLowerCase())) return T;
    return F;
  };
  const included = filled(locations.includeLocations) ? matches(locations.includeLocations) : T;
  const excluded = filled(locations.excludeLocations) ? matches(locations.excludeLocations) : F;
  const value = and([included, not(excluded)]);
  if (value === U) reasons.push('unknown-location-trust');
  return value;
}

function riskPredicate(levels, scenarioLevel, label, reasons) {
  const values = lower(levels);
  if (!values.length) return T;
  if (values.some((value) => !RISK_LEVELS.has(value))) return unsupportedPredicate(`unsupported-condition:${label}`, reasons);
  return values.includes(String(scenarioLevel).toLowerCase()) ? T : F;
}

const KNOWN_CONDITIONS = new Set([
  'users', 'applications', 'clientAppTypes', 'platforms', 'locations', 'userRiskLevels', 'signInRiskLevels',
]);

/** Whether `policy` applies to `principal` in `scenario`: true, false or 'unknown'. */
export function policyApplies(policy, principal, scenario, reasons = []) {
  const conditions = policy?.conditions;
  if (!conditions || typeof conditions !== 'object') return unsupportedPredicate('unsupported-condition:conditions-unreadable', reasons);
  const values = [];
  for (const key of Object.keys(conditions)) {
    if (key.startsWith('@odata') || KNOWN_CONDITIONS.has(key) || !filled(conditions[key])) continue;
    values.push(unsupportedPredicate(`unsupported-condition:${key}`, reasons));
  }
  values.push(
    usersPredicate(policy, principal, reasons),
    applicationsPredicate(policy, scenario, reasons),
    clientAppsPredicate(policy, scenario, reasons),
    platformsPredicate(policy, scenario, reasons),
    locationsPredicate(policy, scenario, reasons),
    riskPredicate(conditions.userRiskLevels, scenario.userRisk, 'userRiskLevels', reasons),
    riskPredicate(conditions.signInRiskLevels, scenario.signInRisk, 'signInRiskLevels', reasons),
  );
  return and(values);
}

// ------------------------------------------------------------- grant / session

function capability(principal, name) {
  const value = principal.capabilities?.[name];
  return value === true ? T : value === false ? F : U;
}

/**
 * What one applying policy requires of this principal: 'blocked' (block grant),
 * 'satisfied', 'unsatisfied' (it cannot meet the controls) or 'unknown'.
 */
export function policyGrant(policy, principal, reasons = []) {
  const grant = policy.grantControls;
  const session = policy.sessionControls;
  let sessionValue = T;
  if (session && typeof session === 'object') {
    for (const key of Object.keys(session)) {
      if (key.startsWith('@odata') || SUPPORTED_SESSION.has(key) || !filled(session[key])) continue;
      if (session[key]?.isEnabled === false) continue;
      reasons.push(`unsupported-session-control:${key}`);
      sessionValue = U;
    }
  }
  if (!grant || typeof grant !== 'object') return sessionValue === T ? 'satisfied' : 'unknown';
  const builtIn = lower(grant.builtInControls);
  if (builtIn.includes('block')) return 'blocked';
  const parts = [];
  for (const control of builtIn) {
    const name = CAPABILITIES.find((entry) => entry.toLowerCase() === control);
    if (!name) { reasons.push(`unsupported-grant-control:${control}`); parts.push(U); continue; }
    const value = capability(principal, name);
    if (value === U) reasons.push(`unknown-capability:${name}`);
    parts.push(value);
  }
  if (grant.authenticationStrength) {
    const id = String(grant.authenticationStrength.id ?? '').toLowerCase();
    const strengths = principal.capabilities?.authenticationStrengths;
    if (!id) { reasons.push('unsupported-grant-control:authenticationStrength'); parts.push(U); }
    else if (!Array.isArray(strengths)) { reasons.push('unknown-capability:authenticationStrength'); parts.push(U); }
    else parts.push(lower(strengths).includes(id) ? T : F);
  }
  for (const key of ['termsOfUse', 'customAuthenticationFactors']) {
    if (filled(grant[key])) { reasons.push(`unsupported-grant-control:${key}`); parts.push(U); }
  }
  const operator = String(grant.operator ?? 'OR').toUpperCase();
  const required = parts.length === 0 ? T : operator === 'AND' ? and(parts) : or(parts);
  const value = and([required, sessionValue]);
  if (value === T) return 'satisfied';
  if (required === F) return 'unsatisfied';
  return 'unknown';
}

// ----------------------------------------------------------- combined scenario

/** Enforced policies only; report-only and disabled policies do not decide access. */
function enforcement(policy) {
  const state = policy?.payload?.state;
  if (state === 'enabled') return 'enforced';
  if (state === 'disabled' || state === 'enabledForReportingButNotEnforced') return 'not-enforced';
  return 'unknown';
}

/**
 * One scenario against a policy set taken TOGETHER: the path is open only when every
 * applying policy lets it through. Returns { outcome, steps, decisive, unknown }.
 */
export function evaluateScenario(policies, principal, scenario) {
  let steps = 0;
  const decisive = [];
  const unknown = [];
  const controls = [];
  for (const policy of policies) {
    steps += 1;
    const state = enforcement(policy);
    if (state === 'not-enforced') continue;
    const reasons = [];
    const applies = state === 'unknown' ? unsupportedPredicate('unsupported-condition:policy-state', reasons) : policyApplies(policy.payload, principal, scenario, reasons);
    steps += 7;
    if (applies === F) continue;
    const grant = policyGrant(policy.payload, principal, reasons);
    if (applies === T && (grant === 'blocked' || grant === 'unsatisfied')) {
      decisive.push({ policy: policy.naturalKey, result: grant });
      continue;
    }
    if (grant === 'satisfied') {
      if (applies === T) controls.push(policy.naturalKey);
      continue;
    }
    unknown.push({ policy: policy.naturalKey, applies: applies === T ? 'yes' : 'unknown', result: grant, reasons: [...new Set(reasons)] });
  }
  const outcome = decisive.length ? 'blocked' : unknown.length ? 'unknown' : 'allowed';
  return { outcome, steps, decisive, unknown, controls };
}

// ---------------------------------------------------------- scenario generation

function dimensionValues(principal, locations) {
  const paths = { ...DEFAULT_PATHS, ...(principal.paths ?? {}) };
  const scenarioLocations = principal.paths?.locations ?? [
    ...locations.map((location) => ({ id: location.id, label: location.label ?? location.id, trusted: location.trusted ?? null })),
    { id: null, label: 'outside every named location', trusted: false },
  ];
  return {
    application: [...new Set(paths.applications)],
    clientAppType: [...new Set(paths.clientAppTypes)],
    platform: [...new Set(paths.platforms)],
    location: scenarioLocations,
    userRisk: [...new Set(paths.userRiskLevels)],
    signInRisk: [...new Set(paths.signInRiskLevels)],
  };
}

function scenarioAt(values, index) {
  const scenario = {};
  let rest = index;
  for (const dimension of DIMENSIONS) {
    const list = values[dimension];
    scenario[dimension] = list[rest % list.length];
    rest = Math.floor(rest / list.length);
  }
  return scenario;
}

function indexOf(values, positions) {
  let index = 0;
  let radix = 1;
  for (const dimension of DIMENSIONS) {
    index += (positions[dimension] % values[dimension].length) * radix;
    radix *= values[dimension].length;
  }
  return index;
}

/**
 * The scenario indexes to evaluate. The whole matrix when it fits the budget;
 * otherwise a deterministic sample that first covers every dimension value at least
 * once and then strides evenly through the rest. `selection` says which.
 */
export function selectScenarios(values, maxScenarios) {
  const matrixSize = DIMENSIONS.reduce((size, dimension) => size * values[dimension].length, 1);
  if (matrixSize === 0) return { matrixSize, indexes: [], selection: 'empty' };
  if (matrixSize <= maxScenarios) return { matrixSize, indexes: Array.from({ length: matrixSize }, (_, i) => i), selection: 'complete' };
  const chosen = new Set();
  const widest = Math.max(...DIMENSIONS.map((dimension) => values[dimension].length));
  for (let i = 0; i < widest && chosen.size < maxScenarios; i += 1) {
    chosen.add(indexOf(values, Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, i]))));
  }
  const remaining = maxScenarios - chosen.size;
  for (let k = 0; k < remaining * 4 && chosen.size < maxScenarios; k += 1) {
    chosen.add(Math.floor((k * matrixSize) / Math.max(1, remaining)) % matrixSize);
  }
  for (let i = 0; chosen.size < maxScenarios && i < matrixSize; i += 1) chosen.add(i);
  return { matrixSize, indexes: [...chosen].sort((a, b) => a - b), selection: 'sampled' };
}

function describeScenario(scenario) {
  return {
    application: scenario.application,
    clientAppType: scenario.clientAppType,
    platform: scenario.platform,
    location: scenario.location?.label ?? scenario.location?.id ?? null,
    userRisk: scenario.userRisk,
    signInRisk: scenario.signInRisk,
  };
}

const NORMALIZED = Symbol('normalized-principal');

function normalizePrincipal(principal) {
  if (!principal || typeof principal.id !== 'string' || !principal.id) throw new Error('every principal needs an id');
  const memberOf = typeof principal.memberOf === 'function'
    ? principal.memberOf
    : (group) => {
      const groups = principal.groups;
      if (!groups) return null;
      const known = groups[String(group).toLowerCase()] ?? groups[group];
      return known === true ? true : known === false ? false : null;
    };
  const roleTemplates = principal.roleTemplates instanceof Set
    ? principal.roleTemplates
    : Array.isArray(principal.roleTemplates) ? new Set(lower(principal.roleTemplates)) : null;
  return {
    [NORMALIZED]: true,
    id: principal.id.toLowerCase(),
    label: principal.label ?? principal.id,
    userType: principal.userType === 'guest' ? 'guest' : 'member',
    protected: principal.protected !== false,
    capabilities: principal.capabilities ?? {},
    paths: principal.paths,
    memberOf,
    roleTemplates,
  };
}

function budgetOf(budget = {}) {
  const maxScenarios = budget.maxScenarios ?? DEFAULT_SCENARIO_BUDGET.maxScenarios;
  const maxSteps = budget.maxSteps ?? DEFAULT_SCENARIO_BUDGET.maxSteps;
  if (!Number.isSafeInteger(maxScenarios) || maxScenarios < 1 || maxScenarios > MAX_SCENARIO_BUDGET.maxScenarios) {
    throw new Error(`maxScenarios must be 1 to ${MAX_SCENARIO_BUDGET.maxScenarios}`);
  }
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_SCENARIO_BUDGET.maxSteps) {
    throw new Error(`maxSteps must be 1 to ${MAX_SCENARIO_BUDGET.maxSteps}`);
  }
  return { maxScenarios, maxSteps };
}

/**
 * The scenario matrix of one principal against one policy set (taken together).
 * Verdicts: `pass` (basis always `sampled`: at least one evaluated path is open),
 * `lockout` (the whole matrix was evaluated and every path is blocked) or `unknown`.
 */
export function evaluatePrincipalMatrix(policies, rawPrincipal, { locations = [], budget } = {}) {
  const principal = rawPrincipal?.[NORMALIZED] ? rawPrincipal : normalizePrincipal(rawPrincipal);
  const { maxScenarios, maxSteps } = budgetOf(budget);
  const values = dimensionValues(principal, locations);
  const { matrixSize, indexes, selection } = selectScenarios(values, maxScenarios);
  let steps = 0;
  let stepBudgetExhausted = false;
  const counts = { allowed: 0, blocked: 0, unknown: 0 };
  const allowedPaths = [];
  const blockedPaths = [];
  const unknownPaths = [];
  const reasons = new Set();
  const blockingPolicies = {};
  let evaluated = 0;
  for (const index of indexes) {
    if (steps >= maxSteps) { stepBudgetExhausted = true; break; }
    const scenario = scenarioAt(values, index);
    const result = evaluateScenario(policies, principal, scenario);
    steps += result.steps;
    evaluated += 1;
    counts[result.outcome] += 1;
    const entry = { scenario: describeScenario(scenario) };
    if (result.outcome === 'allowed') {
      if (allowedPaths.length < 10) allowedPaths.push({ ...entry, controls: result.controls });
    } else if (result.outcome === 'blocked') {
      for (const item of result.decisive) blockingPolicies[item.policy] = (blockingPolicies[item.policy] ?? 0) + 1;
      if (blockedPaths.length < 10) blockedPaths.push({ ...entry, by: result.decisive });
    } else {
      for (const item of result.unknown) for (const reason of item.reasons) reasons.add(reason);
      if (unknownPaths.length < 10) unknownPaths.push({ ...entry, unknown: result.unknown });
    }
  }
  const truncated = selection === 'sampled' || stepBudgetExhausted;
  const coverage = {
    matrixSize,
    evaluated,
    untested: matrixSize - evaluated,
    selection: stepBudgetExhausted ? 'sampled' : selection,
    truncated,
    truncatedBy: [selection === 'sampled' ? 'max-scenarios' : null, stepBudgetExhausted ? 'max-steps' : null].filter(Boolean),
    steps,
    dimensions: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, values[dimension].length])),
  };
  let verdict;
  if (counts.allowed > 0) {
    verdict = { verdict: 'pass', basis: 'sampled', reason: 'open-path-in-sample' };
  } else if (evaluated > 0 && counts.blocked === evaluated && !truncated) {
    verdict = { verdict: 'lockout', basis: 'every-scenario-in-matrix', reason: 'no-open-path' };
  } else {
    const why = [];
    if (counts.unknown > 0) why.push('unevaluable-scenarios');
    if (truncated) why.push('budget-truncated');
    if (evaluated === 0) why.push('no-scenario-evaluated');
    verdict = { verdict: 'unknown', basis: 'sampled', reason: why.join(',') || 'no-open-path-found' };
  }
  return {
    principal: principal.id,
    label: principal.label,
    protected: principal.protected,
    ...verdict,
    universalSafety: 'not-asserted',
    counts,
    coverage,
    unknownReasons: [...reasons].sort(),
    blockingPolicies,
    allowedPaths,
    blockedPaths,
    unknownPaths,
  };
}

// ------------------------------------------------------------ proposed set

function digestOf(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(sortKeys(value))).digest('hex')}`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

/**
 * The proposed combined set: current policies with the proposed creates, updates and
 * deletes laid over them by natural key. A change for a policy that does not exist,
 * or a create for one that does, is refused rather than guessed.
 */
export function combinePolicySet(current, changes) {
  const byKey = new Map();
  for (const policy of current ?? []) {
    if (!policy?.naturalKey) throw new Error('every current policy needs a naturalKey');
    byKey.set(policy.naturalKey, { naturalKey: policy.naturalKey, payload: policy.payload, origin: 'current' });
  }
  const changed = [];
  for (const change of changes ?? []) {
    const { verb, naturalKey, payload } = change ?? {};
    if (typeof naturalKey !== 'string' || !naturalKey) throw new Error('every proposed change needs a naturalKey');
    if (!['create', 'update', 'delete'].includes(verb)) throw new Error(`proposed change ${naturalKey}: verb must be create, update or delete`);
    if (changed.some((entry) => entry.naturalKey === naturalKey)) throw new Error(`proposed change ${naturalKey} appears twice`);
    if (verb === 'create' && byKey.has(naturalKey)) throw new Error(`proposed create ${naturalKey} already exists`);
    if (verb !== 'create' && !byKey.has(naturalKey)) throw new Error(`proposed ${verb} ${naturalKey} does not match a current policy`);
    if (verb !== 'delete' && (!payload || typeof payload !== 'object')) throw new Error(`proposed ${verb} ${naturalKey} needs a payload`);
    if (verb === 'delete') byKey.delete(naturalKey);
    else byKey.set(naturalKey, { naturalKey, payload, origin: verb });
    changed.push({ verb, naturalKey, payload: verb === 'delete' ? null : payload });
  }
  const policies = [...byKey.values()].sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));
  return { policies, changed, digest: digestOf(policies.map(({ naturalKey, payload }) => ({ naturalKey, payload }))) };
}

/**
 * The full evaluation of a proposal. `currentPolicies` is the collected set (null
 * when no covered collection exists, which makes every verdict unknown), `changes`
 * the proposal, `principals` the scoped principals (protected ones decide the gate).
 */
export function evaluateProposedPolicySet({
  currentPolicies, changes = [], principals, locations = [], budget, inventory = null, now = new Date(),
}) {
  if (!Array.isArray(principals) || principals.length === 0) throw new Error('policy scenario evaluation needs at least one principal');
  const evaluatedAt = new Date(now).toISOString();
  const normalized = principals.map(normalizePrincipal);
  const budgetUsed = budgetOf(budget);
  const base = {
    version: POLICY_SCENARIO_VERSION,
    evaluatedAt,
    scope: 'proposed-combined-policy-set',
    supportedSubset: 'SUPPORTED_POLICY_SUBSET',
    budget: budgetUsed,
    universalSafety: 'not-asserted',
    liveReads: [],
    inventory,
  };
  if (!Array.isArray(currentPolicies)) {
    return {
      ...base,
      policySet: null,
      changed: (changes ?? []).map(({ verb, naturalKey }) => ({ verb, naturalKey })),
      principals: normalized.map((principal) => ({
        principal: principal.id, label: principal.label, protected: principal.protected,
        verdict: 'unknown', basis: 'sampled', reason: 'policy-inventory-unavailable', universalSafety: 'not-asserted',
      })),
      isolated: [],
      combinationOnly: [],
      overall: 'unknown',
    };
  }
  const combined = combinePolicySet(currentPolicies, changes);
  const results = normalized.map((principal) => evaluatePrincipalMatrix(combined.policies, principal, { locations, budget: budgetUsed }));

  // The isolated view: each changed policy evaluated alone, as a per-policy diff would.
  const isolated = [];
  for (const change of combined.changed.filter((entry) => entry.verb !== 'delete')) {
    const alone = [{ naturalKey: change.naturalKey, payload: change.payload, origin: change.verb }];
    for (const principal of normalized) {
      const result = evaluatePrincipalMatrix(alone, principal, { locations, budget: budgetUsed });
      isolated.push({ policy: change.naturalKey, principal: principal.id, verdict: result.verdict, basis: result.basis });
    }
  }
  const combinationOnly = results
    .filter((result) => result.verdict !== 'pass')
    .filter((result) => {
      const alone = isolated.filter((entry) => entry.principal === result.principal);
      return alone.length > 0 && alone.every((entry) => entry.verdict === 'pass');
    })
    .map((result) => ({ principal: result.principal, label: result.label, combined: result.verdict, isolated: 'pass' }));

  const protectedResults = results.filter((result) => result.protected);
  const overall = protectedResults.some((result) => result.verdict === 'lockout') ? 'lockout'
    : protectedResults.length && protectedResults.every((result) => result.verdict === 'pass') ? 'sampled-pass'
      : 'unknown';
  return {
    ...base,
    policySet: {
      digest: combined.digest,
      policies: combined.policies.length,
      enforced: combined.policies.filter((policy) => enforcement(policy) === 'enforced').length,
      reportOnly: combined.policies.filter((policy) => policy.payload?.state === 'enabledForReportingButNotEnforced').length,
    },
    changed: combined.changed.map(({ verb, naturalKey }) => ({ verb, naturalKey })),
    principals: results,
    isolated,
    combinationOnly,
    overall,
  };
}

// ------------------------------------------------------------ live What If read

/**
 * Read contract for a Microsoft What If evaluation (fixture-tested only; KEEL makes no
 * such call). It evaluates the LIVE policies for one sign-in, so it is evidence about
 * the current tenant, never about the proposed combined set.
 */
export function readLiveWhatIf(response, { principalId, scenario = null, readAt, source = 'fixture' } = {}) {
  const items = Array.isArray(response) ? response : response?.value;
  if (!Array.isArray(items)) throw new Error('What If read: expected a list of policy evaluations');
  if (typeof principalId !== 'string' || !principalId) throw new Error('What If read: principalId is required');
  if (!readAt || Number.isNaN(Date.parse(readAt))) throw new Error('What If read: readAt is required');
  const policies = items.map((item) => {
    if (!item || typeof item.id !== 'string' || typeof item.policyApplies !== 'boolean') {
      throw new Error('What If read: every evaluation needs an id and a boolean policyApplies');
    }
    return {
      id: item.id,
      displayName: typeof item.displayName === 'string' ? item.displayName.slice(0, 256) : null,
      applies: item.policyApplies,
      blocks: item.policyApplies && lower(item.grantControls?.builtInControls).includes('block'),
    };
  });
  return {
    kind: LIVE_POLICY_READ,
    evaluates: 'current-live-policies',
    provesProposedState: false,
    synthetic: source === 'fixture',
    principal: principalId.toLowerCase(),
    scenario,
    readAt: new Date(readAt).toISOString(),
    liveOutcome: policies.some((policy) => policy.blocks) ? 'blocked-by-live-policy' : 'not-blocked-by-live-policy',
    policies,
  };
}

/**
 * Attach live What If reads to an evaluation as separate evidence. Verdicts about the
 * proposed state are unchanged whatever the live read says.
 */
export function attachLiveReads(evaluation, reads) {
  const liveReads = [...(evaluation.liveReads ?? [])];
  for (const read of reads ?? []) {
    if (read?.kind !== LIVE_POLICY_READ || read.provesProposedState !== false) {
      throw new Error('only live-policy-read evidence can be attached');
    }
    liveReads.push(read);
  }
  return { ...evaluation, liveReads };
}

// ------------------------------------------------------------ principal helpers

/**
 * Capabilities an emergency account is known to hold, from task-94 method evidence.
 * A phishing-resistant method satisfies MFA and the three built-in strengths; no
 * evidence leaves every capability unknown. Device capabilities are never inferred.
 */
export function capabilitiesFromMethodEvidence(methodEvidence) {
  if (!methodEvidence || !Array.isArray(methodEvidence.methods)) return {};
  const methods = new Set(methodEvidence.methods);
  const phishingResistant = ['fido2', 'windowsHelloForBusiness', 'x509Certificate', 'platformCredential'].some((method) => methods.has(method));
  const multifactor = phishingResistant || ['microsoftAuthenticator', 'softwareOath', 'phone'].some((method) => methods.has(method));
  return {
    mfa: multifactor,
    authenticationStrengths: [
      ...(multifactor ? [BUILT_IN_STRENGTHS.multifactor] : []),
      ...(phishingResistant ? [BUILT_IN_STRENGTHS.passwordless, BUILT_IN_STRENGTHS.phishingResistant] : []),
    ],
  };
}

// ------------------------------------------------------------ server-side loader

const SCENARIO_INVENTORY = Object.freeze(['conditionalAccessPolicy', 'namedLocation', 'roleAssignment']);

/** The newest covered collection of each type this evaluation reads (read-only). */
async function loadScenarioInventory(client, tenantRef) {
  const { rows } = await client.query(
    `WITH ${TYPE_COVERAGE_CTES}
     SELECT resource_type, coverage_entry, snapshot_id, completed_at FROM latest_type_coverage
      WHERE resource_type = ANY($2)`,
    [tenantRef, SCENARIO_INVENTORY],
  );
  const inventory = {};
  for (const type of SCENARIO_INVENTORY) inventory[type] = { status: 'unavailable', resources: [], observedAt: null };
  for (const row of rows) {
    if (!readCoverageOutcome(row.coverage_entry).covered) continue;
    const { rows: resources } = await client.query(
      `SELECT natural_key AS "naturalKey", payload FROM resource_version
        WHERE snapshot_id = $1 AND resource_type = $2 ORDER BY natural_key`,
      [row.snapshot_id, row.resource_type],
    );
    inventory[row.resource_type] = {
      status: 'covered', resources, observedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null, snapshotId: row.snapshot_id,
    };
  }
  return inventory;
}

function namedLocations(inventory) {
  if (inventory.namedLocation.status !== 'covered') return [];
  return inventory.namedLocation.resources
    .filter((resource) => typeof resource.payload?.id === 'string')
    .map((resource) => ({
      id: resource.payload.id,
      label: resource.payload.displayName ?? resource.naturalKey,
      // A country location has no trust flag and is never trusted; an IP location
      // without the flag collected stays unknown.
      trusted: typeof resource.payload.isTrusted === 'boolean' ? resource.payload.isTrusted
        : String(resource.payload['@odata.type'] ?? '').includes('countryNamedLocation') ? false : null,
    }));
}

function roleTemplatesFor(inventory, principalId) {
  if (inventory.roleAssignment.status !== 'covered') return null;
  return new Set(inventory.roleAssignment.resources
    .filter((resource) => String(resource.payload?.principalId ?? '').toLowerCase() === principalId)
    .map((resource) => String(resource.payload?.roleDefinitionId ?? '').toLowerCase()));
}

/**
 * Evaluate a proposal against a tenant's collected state. Protected principals are the
 * registered task-94 emergency accounts (capabilities from their method evidence) plus
 * any the proposal names; group membership and role templates come from collected
 * reads only, and anything unread stays unknown. Read-only: nothing is written.
 */
export async function evaluateProposalForTenant(client, { tenantRef, proposal = {}, budget, now = new Date() }) {
  if (typeof tenantRef !== 'string' || !tenantRef) throw new Error('tenantRef is required');
  const inventory = await loadScenarioInventory(client, tenantRef);
  const membershipInventory = { conditionalAccessPolicy: { resources: [
    ...inventory.conditionalAccessPolicy.resources,
    ...(proposal.changes ?? []).filter((change) => change?.payload).map((change) => ({ payload: change.payload })),
  ] } };
  const groupMembers = await loadGroupMembership(client, tenantRef, membershipInventory);
  const readiness = await loadBreakGlassReadiness(client, { tenantRef, now });
  const principals = new Map();
  for (const account of readiness.accounts) {
    principals.set(account.accountId, {
      id: account.accountId,
      label: account.label,
      protected: true,
      source: 'registered-emergency-account',
      capabilities: capabilitiesFromMethodEvidence(account.methodEvidence),
    });
  }
  for (const principal of proposal.principals ?? []) {
    if (typeof principal?.id !== 'string') throw new Error('every proposal principal needs an id');
    const id = principal.id.toLowerCase();
    const existing = principals.get(id) ?? {};
    principals.set(id, {
      ...existing,
      ...principal,
      id,
      protected: principal.protected ?? existing.protected ?? true,
      source: existing.source ?? 'proposal',
      capabilities: { ...(existing.capabilities ?? {}), ...(principal.capabilities ?? {}) },
    });
  }
  const scoped = [...principals.values()].map((principal) => ({
    ...principal,
    memberOf: principal.groups ? undefined : (group) => groupMembers(String(group).toLowerCase(), principal.id),
    roleTemplates: principal.roleTemplates ?? roleTemplatesFor(inventory, principal.id),
  }));
  const inventorySummary = Object.fromEntries(SCENARIO_INVENTORY.map((type) => [type, { status: inventory[type].status, observedAt: inventory[type].observedAt }]));
  if (scoped.length === 0) {
    return {
      version: POLICY_SCENARIO_VERSION, evaluatedAt: new Date(now).toISOString(), scope: 'proposed-combined-policy-set',
      overall: 'unknown', reason: 'no-protected-principals', universalSafety: 'not-asserted', inventory: inventorySummary,
      principals: [], isolated: [], combinationOnly: [], liveReads: [],
    };
  }
  return evaluateProposedPolicySet({
    currentPolicies: inventory.conditionalAccessPolicy.status === 'covered' ? inventory.conditionalAccessPolicy.resources : null,
    changes: proposal.changes ?? [],
    principals: scoped,
    locations: namedLocations(inventory),
    budget,
    inventory: inventorySummary,
    now,
  });
}
