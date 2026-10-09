/**
 * Roadmap task-94: emergency (break-glass) account lifecycle readiness and usage canary.
 *
 * Readiness is reported per registered account as five separate dimensions, never as
 * one boolean:
 *
 *   cloudOnlyIdentity            the account is a cloud-only, enabled member account
 *                                on a managed domain (collected user and domain inventory)
 *   phishingResistantCredential  a phishing-resistant method is registered (observed by
 *                                a read-only reader, or attested by a person) and the
 *                                tenant's method policy does not switch it off
 *   policyExclusions             every enforced Conditional Access policy excludes it
 *   privilegedAccessPath         it holds an active (not merely eligible) Global
 *                                Administrator assignment
 *   lastValidation               a person recorded an emergency sign-in test within the
 *                                configured interval; a stale or missing test is `due`
 *
 * Each dimension is `pass`, `fail`, `due` (lastValidation only) or `unknown`. Evidence
 * KEEL does not have is `unknown`, never `pass`: an account with no method evidence is
 * not assumed to hold a secure method, and an excluded group whose membership was not
 * read is not assumed to contain the account. An account is `ready` only when every
 * dimension passes; a Conditional Access exclusion alone never makes it ready.
 *
 * Policy surfaces are reported individually (`evaluated`, `unknown` when the evidence
 * is missing, `unsupported` when KEEL has no reader for it). Unsupported surfaces stay
 * visible next to the verdict; they do not turn into a pass.
 *
 * The usage canary reads task-88/91 minimized audit facts. A sign-in by, or a change
 * made by, a registered account opens (or updates) one correlated alert per account
 * through the task-82 lifecycle, with task-83 deadlines and escalation. Validation and
 * credential reminders are alerts of the same kind. Nothing here rotates a credential,
 * changes a policy or calls Microsoft.
 */
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { TYPE_COVERAGE_CTES, readCoverageOutcome } from '../coverage/snapshots.mjs';
import { appendEvidence } from '../govern/evidence.mjs';
import { coverageFromRuns } from '../identity/attribution.mjs';
import { applyConditionEvent } from '../notify/alerts.mjs';
import { redactSecrets } from '../../tools/tenant-probe/graph.mjs';
import { policyTreatment } from './breakGlassInvariant.mjs';
import { sourceAuthorityOf } from './syncedObjectGuard.mjs';

export const BREAKGLASS_CONTROL = 'break-glass';
export const USAGE_CONDITION = 'emergency-account-used';
export const VALIDATION_DUE_CONDITION = 'validation-due';
export const ROTATION_DUE_CONDITION = 'rotation-due';
export const DIMENSIONS = Object.freeze([
  'cloudOnlyIdentity', 'phishingResistantCredential', 'policyExclusions', 'privilegedAccessPath', 'lastValidation',
]);
export const LIFECYCLE_KINDS = Object.freeze(['validated', 'credential-rotated', 'methods-attested', 'methods-observed']);
export const GLOBAL_ADMINISTRATOR = '62e90394-69f5-4237-9190-012177145e10';
export const MINIMUM_ACCOUNTS = 2;
export const CANARY_LOOKBACK_DAYS = 30;
const CORRELATION_WINDOW_MS = 8 * 60 * 60 * 1000;
const EXPECTED_TEST_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_USAGE_EVENTS = 500;
const MAX_CORRELATED_CHANGES = 20;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const CANARY_WATCH_MS = 24 * 60 * 60 * 1000;
const DAY = 86400000;

const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9@._ -]{0,127}$/;

// Graph authentication method kinds a person or reader may report. Only these four are
// phishing resistant; a password, an app notification, a phone or a one-time code is not.
export const METHOD_KINDS = Object.freeze([
  'password', 'microsoftAuthenticator', 'phone', 'email', 'softwareOath', 'temporaryAccessPass',
  'fido2', 'windowsHelloForBusiness', 'x509Certificate', 'platformCredential',
]);
export const PHISHING_RESISTANT = Object.freeze(['fido2', 'windowsHelloForBusiness', 'x509Certificate', 'platformCredential']);
// The tenant authentication methods policy governs these; the others are not in it.
const METHOD_POLICY_ID = Object.freeze({ fido2: 'fido2', x509Certificate: 'x509certificate' });

// Policy surfaces that can stand between an emergency account and a sign-in.
export const SURFACES = Object.freeze([
  { id: 'conditionalAccess', types: ['conditionalAccessPolicy'] },
  { id: 'conditionalAccessRiskConditions', types: ['conditionalAccessPolicy'] },
  { id: 'authenticationMethodsPolicy', types: ['authenticationMethodsPolicy'] },
  { id: 'roleEligibility', types: ['roleEligibilitySchedule'] },
  { id: 'roleActivationRules', unsupported: 'activation-rules-not-collected' },
  { id: 'identityProtectionRiskPolicies', unsupported: 'legacy-risk-policies-not-collected' },
  { id: 'securityDefaults', unsupported: 'security-defaults-not-collected' },
  { id: 'applicationAccessRestrictions', unsupported: 'application-restrictions-not-collected' },
]);

const INVENTORY_TYPES = Object.freeze([
  'user', 'domain', 'conditionalAccessPolicy', 'roleAssignment', 'roleEligibilitySchedule', 'authenticationMethodsPolicy',
]);

export class BreakGlassAuthorizationError extends Error {
  constructor(message) { super(message); this.name = 'BreakGlassAuthorizationError'; }
}

const ms = (value) => (value instanceof Date ? value.getTime() : Date.parse(value));
const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

function objectId(value) {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new Error('accountId must be an Entra object id');
  return value.toLowerCase();
}

function interval(value, { min, max, label, nullable = false }) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be ${min} to ${max} days`);
  return value;
}

async function authorize(client, actor, capability) {
  const principal = await findPrincipalById(client, actor);
  if (!principal || !(await can(client, principal, capability))) {
    throw new BreakGlassAuthorizationError(`break-glass: ${capability} capability required`);
  }
  return principal;
}

async function tableExists(client, name) {
  const { rows: [row] } = await client.query('SELECT to_regclass($1) AS name', [name]);
  return Boolean(row.name);
}

async function transaction(client, work) {
  await client.query('BEGIN');
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle writes. Each needs a current grant and is recorded as KEEL evidence.
// ---------------------------------------------------------------------------

/** Registers an emergency account by object id. Requires `configuration`. */
export async function registerBreakGlassAccount(client, {
  tenantRef, actor, accountId, label, validationIntervalDays = 90, rotationIntervalDays = null,
}) {
  await authorize(client, actor, 'configuration');
  const id = objectId(accountId);
  if (typeof label !== 'string' || !LABEL.test(label) || redactSecrets(label) !== label) throw new Error('label must be a short plain name');
  const validation = interval(validationIntervalDays, { min: 1, max: 366, label: 'validationIntervalDays' });
  const rotation = interval(rotationIntervalDays, { min: 1, max: 730, label: 'rotationIntervalDays', nullable: true });
  const { rows: [row] } = await client.query(
    `INSERT INTO breakglass_account (tenant_ref, account_id, label, resource_key, validation_interval_days, rotation_interval_days, registered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_ref, account_id) DO UPDATE
       SET label = EXCLUDED.label, validation_interval_days = EXCLUDED.validation_interval_days,
           rotation_interval_days = EXCLUDED.rotation_interval_days,
           retired_at = NULL, retired_by = NULL, retired_reason = NULL
     RETURNING *`,
    [tenantRef, id, label, `user:${label}`, validation, rotation, actor],
  );
  await appendEvidence(client, {
    tenantRef, kind: 'breakglass.registered', actor,
    subject: { accountId: id, label, validationIntervalDays: validation, rotationIntervalDays: rotation },
  });
  return row;
}

/** Stops treating an account as an emergency account. Its history stays. */
export async function retireBreakGlassAccount(client, { tenantRef, actor, accountId, reason }) {
  await authorize(client, actor, 'configuration');
  const id = objectId(accountId);
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('reason is required');
  const { rows: [row] } = await client.query(
    `UPDATE breakglass_account SET retired_at = now(), retired_by = $3, retired_reason = $4
      WHERE tenant_ref = $1 AND account_id = $2 AND retired_at IS NULL RETURNING *`,
    [tenantRef, id, actor, reason],
  );
  if (!row) throw new Error('no active emergency account with that id in this tenant');
  await appendEvidence(client, { tenantRef, kind: 'breakglass.retired', actor, subject: { accountId: id, reason } });
  return row;
}

function methodList(methods) {
  if (!Array.isArray(methods) || methods.length > METHOD_KINDS.length * 4) throw new Error('methods must be a list of method kinds');
  for (const method of methods) if (!METHOD_KINDS.includes(method)) throw new Error(`unknown method kind ${method}`);
  return [...new Set(methods)].sort();
}

/**
 * Records one lifecycle fact a person vouches for: an emergency sign-in test
 * (`validated`), a credential change made outside KEEL (`credential-rotated`), or the
 * registered methods (`methods-attested`, with detail.methods). Requires
 * `configuration`. KEEL records; it never performs the rotation or the test itself.
 */
export async function recordBreakGlassLifecycle(client, {
  tenantRef, actor, accountId, kind, occurredAt = new Date(), note = null, methods = null, now = new Date(),
}) {
  await authorize(client, actor, 'configuration');
  const id = objectId(accountId);
  if (!['validated', 'credential-rotated', 'methods-attested'].includes(kind)) throw new Error('kind must be validated, credential-rotated or methods-attested');
  const at = new Date(occurredAt);
  if (Number.isNaN(at.valueOf()) || at.getTime() > ms(now) + CLOCK_SKEW_MS) throw new Error('occurredAt must be a past instant');
  const detail = {};
  if (note !== null) {
    if (typeof note !== 'string' || note.length > 500) throw new Error('note must be at most 500 characters');
    detail.note = redactSecrets(note);
  }
  if (kind === 'methods-attested') detail.methods = methodList(methods);
  const row = await transaction(client, async () => {
    const { rows: [account] } = await client.query(
      'SELECT * FROM breakglass_account WHERE tenant_ref = $1 AND account_id = $2 AND retired_at IS NULL FOR SHARE', [tenantRef, id],
    );
    if (!account) throw new Error('no active emergency account with that id in this tenant');
    const { rows: [inserted] } = await client.query(
      `INSERT INTO breakglass_lifecycle_event (tenant_ref, account_id, kind, occurred_at, recorded_by, detail)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantRef, id, kind, at, actor, detail],
    );
    return inserted;
  });
  await appendEvidence(client, { tenantRef, kind: `breakglass.${kind}`, actor, subject: { accountId: id, occurredAt: at.toISOString(), ...detail } });
  return row;
}

/**
 * Read-only method observation through an injected, tenant-bound reader:
 *   adapter = { tenantRef, credentialMode: 'collector-read-only', synthetic, readMethods({ accountId, signal }) }
 * returning { methods: [kind] }. Requires `collect`. A failed or malformed read
 * records nothing for that account, so its evidence stays what it was (or unknown).
 */
export async function observeBreakGlassMethods(client, { tenantRef, managedTenantRef, requestedBy, adapter, now = new Date() }) {
  if (!managedTenantRef || tenantRef !== managedTenantRef) throw new Error('tenant mismatch');
  await authorize(client, requestedBy, 'collect');
  if (!adapter || adapter.credentialMode !== 'collector-read-only' || adapter.tenantRef !== tenantRef
    || typeof adapter.synthetic !== 'boolean' || typeof adapter.readMethods !== 'function') {
    throw new Error('tenant-bound read-only method reader required');
  }
  const { rows: accounts } = await client.query(
    'SELECT account_id FROM breakglass_account WHERE tenant_ref = $1 AND retired_at IS NULL ORDER BY account_id', [tenantRef],
  );
  const results = [];
  for (const { account_id: accountId } of accounts) {
    let methods;
    try {
      const page = await adapter.readMethods({ accountId });
      methods = methodList(page?.methods);
    } catch (error) {
      results.push({ accountId, status: [401, 403].includes(error?.status) ? 'read-scope-revoked' : 'read-failed' });
      continue;
    }
    await client.query(
      `INSERT INTO breakglass_lifecycle_event (tenant_ref, account_id, kind, occurred_at, recorded_by, detail)
       VALUES ($1,$2,'methods-observed',$3,$4,$5)`,
      [tenantRef, accountId, new Date(now), requestedBy, { methods, synthetic: adapter.synthetic }],
    );
    results.push({ accountId, status: 'observed', methods });
  }
  return results;
}

/** Fixture reader for tests and the worker's synthetic path: no network, no token. */
export function createFixtureMethodReader({ tenantRef, methods }) {
  return {
    tenantRef, credentialMode: 'collector-read-only', synthetic: true,
    async readMethods({ accountId }) {
      const entry = methods[accountId];
      if (entry instanceof Error) throw entry;
      if (!entry) throw Object.assign(new Error('not found'), { status: 404 });
      return { methods: entry };
    },
  };
}

// ---------------------------------------------------------------------------
// Pure evaluation.
// ---------------------------------------------------------------------------

const dimension = (status, reason, evidence = {}) => ({ status, reason, evidence });

function evaluateIdentity(account, inventory) {
  const users = inventory.user;
  if (!users || users.status !== 'covered') return dimension('unknown', 'user-inventory-unavailable');
  const user = users.resources.find((resource) => String(resource.payload?.id ?? '').toLowerCase() === account.accountId);
  if (!user) return dimension('fail', 'account-not-in-inventory');
  const payload = user.payload ?? {};
  const evidence = { naturalKey: user.naturalKey, observedAt: users.observedAt };
  if (sourceAuthorityOf(user) !== 'cloud') return dimension('fail', 'synchronized-from-on-premises', evidence);
  if (payload.accountEnabled === false) return dimension('fail', 'account-disabled', evidence);
  if (typeof payload.userType === 'string' && payload.userType.toLowerCase() === 'guest') return dimension('fail', 'guest-account', evidence);
  // Graph returns null for a cloud-only account; a payload without the field was not
  // collected with it, which is not evidence of a cloud-only account.
  if (!Object.hasOwn(payload, 'onPremisesSyncEnabled')) return dimension('unknown', 'sync-state-not-collected', evidence);
  const upn = typeof payload.userPrincipalName === 'string' ? payload.userPrincipalName : '';
  const domainName = upn.includes('@') ? upn.slice(upn.lastIndexOf('@') + 1).toLowerCase() : null;
  if (!domainName) return dimension('unknown', 'sign-in-name-not-collected', evidence);
  const domains = inventory.domain;
  if (!domains || domains.status !== 'covered') return dimension('unknown', 'domain-inventory-unavailable', evidence);
  const domain = domains.resources.find((resource) => String(resource.payload?.id ?? '').toLowerCase() === domainName);
  if (!domain) return dimension('unknown', 'domain-not-in-inventory', { ...evidence, domain: domainName });
  if (String(domain.payload?.authenticationType ?? '').toLowerCase() === 'federated') {
    return dimension('fail', 'federated-domain', { ...evidence, domain: domainName });
  }
  if (String(domain.payload?.authenticationType ?? '').toLowerCase() !== 'managed') {
    return dimension('unknown', 'domain-authentication-not-collected', { ...evidence, domain: domainName });
  }
  return dimension('pass', 'cloud-only-member-account', { ...evidence, domain: domainName });
}

function evaluateCredential(account, inventory) {
  const latest = account.methodEvidence;
  if (!latest) return dimension('unknown', 'no-method-evidence');
  const methods = latest.methods ?? [];
  const evidence = { basis: latest.basis, recordedAt: latest.occurredAt, methods };
  const resistant = methods.filter((method) => PHISHING_RESISTANT.includes(method));
  if (!resistant.length) return dimension('fail', 'no-phishing-resistant-method', evidence);
  // Methods outside the tenant methods policy (Windows Hello, platform credential) do
  // not depend on it; the others must not be switched off there.
  const governed = resistant.filter((method) => METHOD_POLICY_ID[method]);
  if (governed.length < resistant.length) return dimension('pass', 'phishing-resistant-method', evidence);
  const policyInventory = inventory.authenticationMethodsPolicy;
  if (!policyInventory || policyInventory.status !== 'covered' || !policyInventory.resources.length) {
    return dimension('unknown', 'method-policy-unavailable', evidence);
  }
  const configurations = policyInventory.resources[0].payload?.authenticationMethodConfigurations;
  if (!Array.isArray(configurations)) return dimension('unknown', 'method-policy-incomplete', evidence);
  let unread = false;
  for (const method of governed) {
    const config = configurations.find((entry) => String(entry?.id ?? '').toLowerCase() === METHOD_POLICY_ID[method]);
    if (!config || typeof config.state !== 'string') { unread = true; continue; }
    if (config.state.toLowerCase() === 'enabled') return dimension('pass', 'phishing-resistant-method', evidence);
  }
  return unread
    ? dimension('unknown', 'method-policy-incomplete', evidence)
    : dimension('fail', 'method-disabled-by-tenant-policy', evidence);
}

function activeRoleTemplates(account, inventory) {
  const assignments = inventory.roleAssignment;
  if (!assignments || assignments.status !== 'covered') return null;
  return new Set(assignments.resources
    .filter((resource) => String(resource.payload?.principalId ?? '').toLowerCase() === account.accountId)
    .map((resource) => String(resource.payload?.roleDefinitionId ?? '').toLowerCase()));
}

function evaluateExclusions(account, inventory, groupMembers) {
  const policies = inventory.conditionalAccessPolicy;
  if (!policies || policies.status !== 'covered') return dimension('unknown', 'policy-inventory-unavailable');
  const roleTemplates = activeRoleTemplates(account, inventory);
  const results = [];
  for (const resource of policies.resources) {
    const state = resource.payload?.state;
    if (state === 'disabled') continue;
    if (state === 'enabledForReportingButNotEnforced') {
      results.push({ policy: resource.naturalKey, treatment: 'report-only', reason: 'not-enforced' });
      continue;
    }
    const treated = state === 'enabled'
      ? policyTreatment(resource.payload, account.accountId, { groupMembers: (group) => groupMembers(group, account.accountId), roleTemplates })
      : { treatment: 'unknown', reason: 'policy-state-unreadable' };
    results.push({ policy: resource.naturalKey, ...treated });
  }
  const applies = results.filter((entry) => entry.treatment === 'applies');
  const unknown = results.filter((entry) => entry.treatment === 'unknown');
  const evidence = { policies: results, observedAt: policies.observedAt };
  if (applies.length) return dimension('fail', 'enforced-policy-applies', evidence);
  if (unknown.length) return dimension('unknown', 'policy-treatment-unknown', evidence);
  return dimension('pass', results.some((entry) => entry.treatment === 'excluded') ? 'excluded-from-every-enforced-policy' : 'no-enforced-policy-applies', evidence);
}

function isGlobalAdministrator(resource) {
  const role = String(resource.payload?.roleDefinitionId ?? '').toLowerCase();
  return role === GLOBAL_ADMINISTRATOR || /GlobalAdministrator|Global Administrator/.test(resource.naturalKey ?? '');
}

function evaluatePrivilegedPath(account, inventory) {
  const assignments = inventory.roleAssignment;
  if (!assignments || assignments.status !== 'covered') return dimension('unknown', 'role-inventory-unavailable');
  const mine = (resource) => String(resource.payload?.principalId ?? '').toLowerCase() === account.accountId;
  const active = assignments.resources.find((resource) => mine(resource) && isGlobalAdministrator(resource)
    && (resource.payload?.directoryScopeId === undefined || resource.payload.directoryScopeId === '/'));
  if (active) return dimension('pass', 'active-global-administrator', { assignment: active.naturalKey });
  const eligibility = inventory.roleEligibilitySchedule;
  if (eligibility?.status === 'covered' && eligibility.resources.some((resource) => mine(resource) && isGlobalAdministrator(resource))) {
    return dimension('fail', 'eligible-only-needs-activation');
  }
  return dimension('fail', 'no-active-global-administrator');
}

function evaluateValidation(account, now) {
  const last = account.lastValidatedAt;
  const intervalMs = account.validationIntervalDays * DAY;
  if (!last) return dimension('due', 'never-validated', { dueSince: iso(account.registeredAt), intervalDays: account.validationIntervalDays });
  const dueAt = ms(last) + intervalMs;
  if (ms(now) >= dueAt) return dimension('due', 'validation-overdue', { lastValidatedAt: iso(last), dueSince: iso(dueAt), intervalDays: account.validationIntervalDays });
  return dimension('pass', 'validated-recently', { lastValidatedAt: iso(last), dueAt: iso(dueAt), intervalDays: account.validationIntervalDays });
}

function reminderFor(kind, last, intervalDays, registeredAt, now) {
  if (!intervalDays) return null;
  const basis = last ?? registeredAt;
  const dueAt = ms(basis) + (last ? intervalDays * DAY : 0);
  return {
    kind, intervalDays, last: iso(last), dueAt: iso(dueAt),
    // Never done is due from registration on.
    status: !last || ms(now) >= dueAt ? 'due' : 'scheduled',
  };
}

/** Pure: one account's five dimensions, its overall verdict and its reminders. */
export function evaluateAccountReadiness({ account, inventory, groupMembers = () => null, now = new Date() }) {
  const dimensions = {
    cloudOnlyIdentity: evaluateIdentity(account, inventory),
    phishingResistantCredential: evaluateCredential(account, inventory),
    policyExclusions: evaluateExclusions(account, inventory, groupMembers),
    privilegedAccessPath: evaluatePrivilegedPath(account, inventory),
    lastValidation: evaluateValidation(account, now),
  };
  const statuses = DIMENSIONS.map((name) => dimensions[name].status);
  // Every dimension counts. The policy exclusion is one of five, never the verdict.
  const overall = statuses.some((status) => status === 'fail' || status === 'due')
    ? 'not-ready'
    : statuses.some((status) => status === 'unknown') ? 'unknown' : 'ready';
  const reminders = [
    reminderFor('validation', account.lastValidatedAt, account.validationIntervalDays, account.registeredAt, now),
    reminderFor('rotation', account.lastRotatedAt, account.rotationIntervalDays, account.registeredAt, now),
  ].filter(Boolean);
  return { overall, dimensions, reminders };
}

/** Pure: which policy surfaces KEEL evaluated, could not, or has no reader for. */
export function evaluateSurfaces(inventory) {
  return SURFACES.map((surface) => {
    if (surface.unsupported) return { surface: surface.id, status: 'unsupported', reason: surface.unsupported };
    const missing = surface.types.filter((type) => inventory[type]?.status !== 'covered');
    if (missing.length) return { surface: surface.id, status: 'unknown', reason: 'evidence-unavailable', missing };
    if (surface.id === 'conditionalAccessRiskConditions') {
      const withRisk = inventory.conditionalAccessPolicy.resources.filter((resource) => {
        const conditions = resource.payload?.conditions ?? {};
        return [conditions.userRiskLevels, conditions.signInRiskLevels, conditions.servicePrincipalRiskLevels, conditions.insiderRiskLevels]
          .some((levels) => Array.isArray(levels) ? levels.length > 0 : Boolean(levels));
      }).length;
      return { surface: surface.id, status: 'evaluated', reason: 'evaluated-as-conditional-access', policies: withRisk };
    }
    return { surface: surface.id, status: 'evaluated', reason: 'collected' };
  });
}

/** Pure: the tenant verdict over its accounts. */
export function tenantReadiness(accounts) {
  if (accounts.length < MINIMUM_ACCOUNTS) return { overall: 'not-ready', reason: 'fewer-than-two-accounts' };
  if (accounts.some((account) => account.overall === 'not-ready')) return { overall: 'not-ready', reason: 'account-not-ready' };
  if (accounts.some((account) => account.overall === 'unknown')) return { overall: 'unknown', reason: 'account-evidence-unknown' };
  return { overall: 'ready', reason: 'every-account-ready' };
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/** The newest covered collection of each inventory type this check reads. */
async function loadInventory(client, tenantRef) {
  const { rows } = await client.query(
    `WITH ${TYPE_COVERAGE_CTES}
     SELECT resource_type, coverage_entry, snapshot_id, completed_at FROM latest_type_coverage
      WHERE resource_type = ANY($2)`,
    [tenantRef, INVENTORY_TYPES],
  );
  const inventory = {};
  for (const type of INVENTORY_TYPES) inventory[type] = { status: 'unavailable', resources: [], observedAt: null };
  for (const row of rows) {
    if (!readCoverageOutcome(row.coverage_entry).covered) continue;
    const { rows: resources } = await client.query(
      `SELECT natural_key AS "naturalKey", payload FROM resource_version
        WHERE snapshot_id = $1 AND resource_type = $2 ORDER BY natural_key`,
      [row.snapshot_id, row.resource_type],
    );
    inventory[row.resource_type] = { status: 'covered', resources, observedAt: iso(row.completed_at), snapshotId: row.snapshot_id };
  }
  return inventory;
}

/** Group membership from the newest complete relationship reads, or null when unread. */
export async function loadGroupMembership(client, tenantRef, inventory) {
  const groups = new Set();
  for (const resource of inventory.conditionalAccessPolicy?.resources ?? []) {
    const users = resource.payload?.conditions?.users ?? {};
    for (const list of [users.excludeGroups, users.includeGroups]) {
      if (Array.isArray(list)) for (const group of list) groups.add(String(group).toLowerCase());
    }
  }
  const membership = new Map();
  if (!groups.size) return () => null;
  const { rows } = await client.query(
    `SELECT DISTINCT ON (lower(s.parent_source_id), s.family) lower(s.parent_source_id) AS group_id, s.family, s.outcome,
            ARRAY(SELECT lower(e.target_source_id) FROM relationship_edge e WHERE e.set_id = s.id AND e.tenant_ref = $1) AS members
       FROM relationship_edge_set s JOIN snapshot sn ON sn.id = s.snapshot_id
      WHERE s.tenant_ref = $1 AND sn.tenant_ref = $1 AND sn.status = 'complete' AND s.parent_type = 'group'
        AND lower(s.parent_source_id) = ANY($2) AND s.family IN ('member','transitiveMember')
      ORDER BY lower(s.parent_source_id), s.family, s.completed_at DESC NULLS LAST, s.id DESC`,
    [tenantRef, [...groups]],
  );
  for (const row of rows) {
    const entry = membership.get(row.group_id) ?? {};
    entry[row.family] = { complete: ['complete', 'complete-empty'].includes(row.outcome), members: new Set(row.members) };
    membership.set(row.group_id, entry);
  }
  return (group, accountId) => {
    const entry = membership.get(group);
    if (!entry) return null;
    if (entry.transitiveMember?.complete) return entry.transitiveMember.members.has(accountId);
    // A direct read proves membership when it lists the account; its absence there
    // does not rule out a nested group.
    if (entry.member?.complete && entry.member.members.has(accountId)) return true;
    return null;
  };
}

async function loadAccounts(client, tenantRef) {
  const { rows } = await client.query(
    `SELECT a.*,
            (SELECT max(occurred_at) FROM breakglass_lifecycle_event e
              WHERE e.tenant_ref = a.tenant_ref AND e.account_id = a.account_id AND e.kind = 'validated') AS last_validated_at,
            (SELECT max(occurred_at) FROM breakglass_lifecycle_event e
              WHERE e.tenant_ref = a.tenant_ref AND e.account_id = a.account_id AND e.kind = 'credential-rotated') AS last_rotated_at,
            (SELECT to_jsonb(m) FROM (
               SELECT kind, occurred_at, recorded_by, detail FROM breakglass_lifecycle_event e
                WHERE e.tenant_ref = a.tenant_ref AND e.account_id = a.account_id AND e.kind IN ('methods-attested','methods-observed')
                ORDER BY occurred_at DESC, id DESC LIMIT 1) m) AS method_event
       FROM breakglass_account a
      WHERE a.tenant_ref = $1 AND a.retired_at IS NULL
      ORDER BY a.label, a.account_id`,
    [tenantRef],
  );
  return rows.map((row) => ({
    accountId: row.account_id,
    label: row.label,
    resourceKey: row.resource_key,
    validationIntervalDays: row.validation_interval_days,
    rotationIntervalDays: row.rotation_interval_days,
    registeredAt: iso(row.registered_at),
    registeredBy: row.registered_by,
    lastValidatedAt: iso(row.last_validated_at),
    lastRotatedAt: iso(row.last_rotated_at),
    methodEvidence: row.method_event ? {
      basis: row.method_event.kind === 'methods-observed' ? 'observed' : 'attested',
      occurredAt: iso(row.method_event.occurred_at),
      recordedBy: row.method_event.recorded_by,
      methods: row.method_event.detail?.methods ?? [],
      synthetic: row.method_event.detail?.synthetic ?? null,
    } : null,
  }));
}

async function signInCoverage(client, tenantRef, now) {
  if (!await tableExists(client, 'audit_ingest_run')) return { status: 'not-configured', reason: 'not-configured', sources: {} };
  const sources = {};
  for (const source of ['sign-in', 'audit']) {
    const { rows: [state] } = await client.query('SELECT * FROM audit_ingest_state WHERE tenant_ref=$1 AND source=$2', [tenantRef, source]);
    const { rows: runs } = await client.query(
      'SELECT evidence FROM audit_ingest_run WHERE tenant_ref=$1 AND source=$2 ORDER BY started_at DESC, id DESC LIMIT 100', [tenantRef, source],
    );
    const completed = runs.filter((run) => ['complete', 'complete-empty'].includes(run.evidence?.status) && run.evidence.window);
    const lastUntil = completed.reduce((latest, run) => Math.max(latest, ms(run.evidence.window.until)), -Infinity);
    if (!runs.length && !state) { sources[source] = { status: 'not-configured', readUntil: null }; continue; }
    if (!Number.isFinite(lastUntil)) { sources[source] = { ...coverageFromRuns({ runs, state: state ?? null }, { from: new Date(ms(now) - CANARY_WATCH_MS), until: new Date(now) }), readUntil: null }; continue; }
    // The canary watches what was read: the day before the newest completed read
    // must be covered, and that read must itself be recent.
    const until = Math.min(lastUntil, ms(now));
    const coverage = coverageFromRuns({ runs, state: state ?? null }, { from: new Date(until - CANARY_WATCH_MS), until: new Date(until) });
    const behind = ms(now) - lastUntil > CANARY_WATCH_MS;
    sources[source] = { status: coverage.status === 'covered' && behind ? 'behind' : coverage.status, readUntil: new Date(lastUntil).toISOString() };
  }
  const signIn = sources['sign-in'];
  const status = signIn.status === 'covered' ? 'watching' : signIn.status === 'not-configured' ? 'not-configured' : 'not-watching';
  return { status, reason: signIn.status, sources };
}

async function activeBreakGlassAlerts(client, tenantRef) {
  const { rows } = await client.query(
    `SELECT id, resource_key, condition, state, severity, condition_active, occurrence, first_opened_at, last_firing_at,
            ack_deadline_at, detail, last_event_id
       FROM alert WHERE tenant_ref = $1 AND control = $2
      ORDER BY condition_active DESC, last_firing_at DESC LIMIT 100`,
    [tenantRef, BREAKGLASS_CONTROL],
  );
  return rows.map((row) => ({
    id: row.id, resourceKey: row.resource_key, condition: row.condition, state: row.state, severity: row.severity,
    active: row.condition_active, occurrence: row.occurrence, firstOpenedAt: iso(row.first_opened_at),
    lastFiringAt: iso(row.last_firing_at), ackDeadlineAt: iso(row.ack_deadline_at), detail: row.detail, lastEventId: row.last_event_id,
  }));
}

/**
 * The readiness report for one tenant. The caller has authorized the reader (the
 * portal page guard, or `read` in the CLI). Legacy installs without the task-94
 * tables read as `not-configured`, never as ready.
 */
/**
 * Roadmap task-149: the raw inputs engine/safety/lockoutGate.mjs evaluates a
 * proposed tenant policy against (registered accounts before evaluation, the
 * newest covered inventory and group membership).
 */
export async function loadLockoutGateInputs(client, { tenantRef, now = new Date() }) {
  if (!await tableExists(client, 'breakglass_account')) return { configured: false, accounts: [], inventory: {}, groupMembers: () => null, now };
  const accounts = await loadAccounts(client, tenantRef);
  const inventory = await loadInventory(client, tenantRef);
  const groupMembers = await loadGroupMembership(client, tenantRef, inventory);
  return { configured: accounts.length > 0, accounts, inventory, groupMembers, now };
}

export async function loadBreakGlassReadiness(client, { tenantRef, now = new Date() }) {
  const generatedAt = new Date(now).toISOString();
  if (!await tableExists(client, 'breakglass_account')) {
    return { generatedAt, configured: false, overall: 'not-configured', reason: 'not-migrated', accounts: [], surfaces: [], canary: { status: 'not-configured', reason: 'not-migrated' }, alerts: [] };
  }
  const accountsRaw = await loadAccounts(client, tenantRef);
  const inventory = await loadInventory(client, tenantRef);
  const groupMembers = await loadGroupMembership(client, tenantRef, inventory);
  const accounts = accountsRaw.map((account) => ({ ...account, ...evaluateAccountReadiness({ account, inventory, groupMembers, now }) }));
  const surfaces = evaluateSurfaces(inventory);
  const verdict = accountsRaw.length ? tenantReadiness(accounts) : { overall: 'not-configured', reason: 'no-accounts-registered' };
  return {
    generatedAt,
    configured: accountsRaw.length > 0,
    overall: verdict.overall,
    reason: verdict.reason,
    accounts,
    surfaces,
    inventory: Object.fromEntries(INVENTORY_TYPES.map((type) => [type, { status: inventory[type].status, observedAt: inventory[type].observedAt }])),
    canary: await signInCoverage(client, tenantRef, now),
    alerts: await activeBreakGlassAlerts(client, tenantRef),
  };
}

// ---------------------------------------------------------------------------
// Usage canary and reminders.
// ---------------------------------------------------------------------------

/**
 * One sweep for one tenant. Every sign-in by a registered account in the lookback
 * window, and every change it made that no such sign-in explains, is a firing
 * observation of that account's usage alert. Event ids derive from the audit event,
 * so re-running is idempotent; a repeat use updates the same alert, a use after the
 * alert was resolved reopens it. The alert detail correlates the sign-in with the
 * changes the account made in the hours after it and with a recorded sign-in test.
 */
export async function runBreakGlassCanary(client, { tenantRef, now = new Date(), notify = null, lookbackDays = CANARY_LOOKBACK_DAYS }) {
  if (!await tableExists(client, 'breakglass_account')) return { status: 'not-configured', usage: [], reminders: [] };
  const accounts = await loadAccounts(client, tenantRef);
  if (!accounts.length) return { status: 'no-accounts', usage: [], reminders: [] };
  const byId = new Map(accounts.map((account) => [account.accountId, account]));
  const since = new Date(ms(now) - lookbackDays * DAY);
  const usage = [];
  const factsReady = await tableExists(client, 'audit_sign_in_fact');
  if (factsReady) {
    const ids = [...byId.keys()];
    const { rows: signIns } = await client.query(
      `SELECT source_event_id, occurred_at, actor_id FROM (
         SELECT source_event_id, occurred_at, actor_id FROM audit_sign_in_fact
          WHERE tenant_ref = $1 AND actor_kind = 'user' AND actor_id = ANY($2) AND occurred_at > $3 AND occurred_at <= $4
          ORDER BY occurred_at DESC, source_event_id DESC LIMIT ${MAX_USAGE_EVENTS}) recent
        ORDER BY occurred_at, source_event_id`,
      [tenantRef, ids, since, new Date(now)],
    );
    const { rows: changes } = await client.query(
      `SELECT source_event_id, occurred_at, actor_id, target_type, target_id, operation, activity FROM (
         SELECT * FROM audit_change_fact
          WHERE tenant_ref = $1 AND actor_kind = 'user' AND actor_id = ANY($2) AND occurred_at > $3 AND occurred_at <= $4
          ORDER BY occurred_at DESC, source_event_id DESC LIMIT ${MAX_USAGE_EVENTS}) recent
        ORDER BY occurred_at, source_event_id`,
      [tenantRef, ids, since, new Date(now)],
    );
    const { rows: tests } = await client.query(
      `SELECT account_id, occurred_at FROM breakglass_lifecycle_event
        WHERE tenant_ref = $1 AND kind = 'validated' AND occurred_at > $2`,
      [tenantRef, new Date(since.getTime() - EXPECTED_TEST_WINDOW_MS)],
    );
    const plannedTest = (accountId, at) => tests.some((test) => test.account_id === accountId
      && Math.abs(ms(test.occurred_at) - ms(at)) <= EXPECTED_TEST_WINDOW_MS);
    const observations = [];
    for (const signIn of signIns) {
      const correlated = changes.filter((change) => change.actor_id === signIn.actor_id
        && ms(change.occurred_at) >= ms(signIn.occurred_at) && ms(change.occurred_at) <= ms(signIn.occurred_at) + CORRELATION_WINDOW_MS);
      observations.push({ kind: 'sign-in', fact: signIn, correlated });
    }
    for (const change of changes) {
      const explained = signIns.some((signIn) => signIn.actor_id === change.actor_id
        && ms(change.occurred_at) >= ms(signIn.occurred_at) && ms(change.occurred_at) <= ms(signIn.occurred_at) + CORRELATION_WINDOW_MS);
      if (!explained) observations.push({ kind: 'change', fact: change, correlated: [change] });
    }
    observations.sort((a, b) => ms(a.fact.occurred_at) - ms(b.fact.occurred_at)
      || a.fact.source_event_id.localeCompare(b.fact.source_event_id));
    for (const observation of observations) {
      const account = byId.get(observation.fact.actor_id);
      const expected = plannedTest(account.accountId, observation.fact.occurred_at);
      const eventId = `breakglass-${observation.kind}:${observation.fact.source_event_id}`;
      const result = await applyConditionEvent(client, {
        tenantRef,
        resourceKey: account.resourceKey,
        control: BREAKGLASS_CONTROL,
        condition: USAGE_CONDITION,
        status: 'firing',
        eventId,
        occurredAt: observation.fact.occurred_at,
        // A use nobody recorded as a test is critical; a recorded test still alerts,
        // so the canary itself is proven by every test.
        severity: expected ? 'warning' : 'critical',
        detail: {
          accountId: account.accountId,
          label: account.label,
          evidence: observation.kind,
          auditEventId: observation.fact.source_event_id,
          occurredAt: iso(observation.fact.occurred_at),
          correlationId: `breakglass:${account.accountId}:${observation.fact.source_event_id}`,
          expectedTest: expected,
          changes: observation.correlated.slice(0, MAX_CORRELATED_CHANGES).map((change) => ({
            auditEventId: change.source_event_id, occurredAt: iso(change.occurred_at), targetType: change.target_type,
            targetId: change.target_id, operation: change.operation, activity: change.activity ?? null,
          })),
          changeCount: observation.correlated.length,
        },
        source: 'breakglass-canary',
        notify,
      });
      usage.push({ accountId: account.accountId, eventId, outcome: result.outcome, duplicate: result.duplicate, alertId: result.alert?.id ?? null });
    }
  }

  const reminders = [];
  for (const account of accounts) {
    const evaluated = [
      { condition: VALIDATION_DUE_CONDITION, reminder: reminderFor('validation', account.lastValidatedAt, account.validationIntervalDays, account.registeredAt, now) },
      { condition: ROTATION_DUE_CONDITION, reminder: reminderFor('rotation', account.lastRotatedAt, account.rotationIntervalDays, account.registeredAt, now) },
    ];
    for (const { condition, reminder } of evaluated) {
      if (!reminder) continue;
      const basis = reminder.last ?? 'never';
      const event = reminder.status === 'due'
        // Observed when KEEL noticed it (the due instant is in the detail), so a reminder
        // after an earlier resolution is never read as a stale observation.
        ? { status: 'firing', eventId: `breakglass-${condition}:${account.accountId}:${basis}`, occurredAt: new Date(now), severity: 'warning' }
        // Only an existing alert can be resolved; the event id is the fact that cleared it.
        : reminder.last ? { status: 'resolved', eventId: `breakglass-${condition}-cleared:${account.accountId}:${basis}`, occurredAt: new Date(now) } : null;
      if (!event) continue;
      const result = await applyConditionEvent(client, {
        tenantRef, resourceKey: account.resourceKey, control: BREAKGLASS_CONTROL, condition,
        status: event.status, eventId: event.eventId, occurredAt: event.occurredAt, severity: event.severity ?? 'warning',
        detail: { accountId: account.accountId, label: account.label, last: reminder.last, dueAt: reminder.dueAt, intervalDays: reminder.intervalDays },
        source: 'breakglass-canary', notify: event.status === 'firing' ? notify : null,
      });
      reminders.push({ accountId: account.accountId, condition, status: event.status, outcome: result.outcome, duplicate: result.duplicate });
    }
  }
  return { status: factsReady ? 'swept' : 'audit-not-configured', usage, reminders };
}

/** Worker seam: one sweep per tenant with active accounts, as the scheduler principal. */
export async function sweepBreakGlassCanaries(client, { now = new Date(), log = console.error } = {}) {
  if (!await tableExists(client, 'breakglass_account')) return null;
  const { rows: [scheduler] } = await client.query(
    "SELECT id FROM principal WHERE system_kind = 'scheduler' AND disabled_at IS NULL",
  );
  if (!scheduler) {
    log('break-glass canary skipped: no enabled scheduler principal to send alerts as');
    return null;
  }
  const { rows: tenants } = await client.query(
    'SELECT DISTINCT tenant_ref FROM breakglass_account WHERE retired_at IS NULL ORDER BY tenant_ref',
  );
  const results = {};
  for (const { tenant_ref: tenantRef } of tenants) {
    results[tenantRef] = await runBreakGlassCanary(client, { tenantRef, now, notify: { requestedBy: scheduler.id } });
  }
  return results;
}
