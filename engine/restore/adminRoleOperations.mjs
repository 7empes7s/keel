/**
 * Roadmap task-151: restore of the admin role model beyond active role
 * assignments.
 *
 *  - Custom directory roles (roleDefinition): create and update. A built-in
 *    role is Microsoft-owned and immutable: every write to it is skipped
 *    before the journal or the writer runs. A role whose isBuiltIn flag is
 *    missing is refused, never guessed. Delete is not registered.
 *  - PIM eligible assignments (roleEligibilitySchedule): create only, through
 *    a schedule request with action 'adminAssign' and a justification. The
 *    snapshot's expiry is kept (an "after duration" expiry becomes the same
 *    end date), a future start is kept, an expired schedule is never restored,
 *    and only directory-wide (scope "/") eligibility is written. An eligibility a
 *    principal holds through a group is not written; the group's own
 *    eligibility is. Removal and update are not registered.
 *  - PIM role settings (unifiedRoleManagementPolicy): update of the reviewed
 *    rules only, one PATCH per changed rule: expiration, enablement (MFA,
 *    justification, ticket on activation) and approval. A change that would
 *    weaken protection (approval stages are compared one by one) is withheld,
 *    never written, and reported as not remediable; an approval rule is
 *    written only when every stage names an approver and every approver it
 *    names still exists. A rule is sent with the live rule's target.
 *    Notification and authentication-context rules are reported, not written.
 *
 * Each operation is an explicit record with its route, method, permission and
 * writable fields; a body is built from those fields, never from the snapshot
 * as a whole. Every write is read back and every written field must match.
 * Only the references inside what is written are rewritten (a server field
 * such as lastModifiedBy is never resolved or sent).
 *
 * Natural keys are unchanged for the two existing types: a custom role keeps
 * its templateId key (sent on create so the key survives a recreate), and an
 * eligibility keeps its id key. Because a recreated eligibility gets a new id,
 * the target is matched at restore time by principal, role and scope: an
 * eligibility that already exists there is never requested again.
 *
 * The capability registry (capabilities.mjs) holds the claims; this module
 * never raises one.
 *
 * Documentation note: learn.microsoft.com is not reachable from the build
 * container, so the routes, permissions, rule ids and fields below are
 * declarations to confirm against the current Graph v1.0 reference before any
 * live qualification (see docs/roadmap/admin-role-fidelity.md).
 */
import { isDeepStrictEqual } from 'node:util';

import { capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { comparable } from './tenantPolicyOperations.mjs';

export const ADMIN_ROLE_OPERATIONS_CONTRACT_VERSION = 1;

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const ROLE_DEFINITIONS = '/roleManagement/directory/roleDefinitions';
const ELIGIBILITY_REQUESTS = '/roleManagement/directory/roleEligibilityScheduleRequests';
const ELIGIBILITY_SCHEDULES = '/roleManagement/directory/roleEligibilitySchedules';
const ROLE_POLICIES = '/policies/roleManagementPolicies';

const record = (fields) => Object.freeze({ ...fields, writableFields: Object.freeze(fields.writableFields) });

/** The operation records. */
export const ADMIN_ROLE_RECORDS = Object.freeze([
  record({
    resourceType: 'roleDefinition',
    operation: 'create',
    subtype: 'custom',
    route: ROLE_DEFINITIONS,
    method: 'POST',
    permission: 'RoleManagement.ReadWrite.Directory',
    docs: `${DOCS}/rbacapplication-post-roledefinitions?view=graph-rest-1.0`,
    // templateId is sent so a recreated role keeps its natural key.
    writableFields: ['description', 'displayName', 'isEnabled', 'rolePermissions', 'templateId'],
  }),
  record({
    resourceType: 'roleDefinition',
    operation: 'update',
    subtype: 'custom',
    route: `${ROLE_DEFINITIONS}/{id}`,
    method: 'PATCH',
    permission: 'RoleManagement.ReadWrite.Directory',
    docs: `${DOCS}/unifiedroledefinition-update?view=graph-rest-1.0`,
    writableFields: ['description', 'displayName', 'isEnabled', 'rolePermissions'],
  }),
  record({
    resourceType: 'roleEligibilitySchedule',
    operation: 'create',
    subtype: null,
    route: ELIGIBILITY_REQUESTS,
    method: 'POST',
    permission: 'RoleEligibilitySchedule.ReadWrite.Directory',
    docs: `${DOCS}/rbacapplication-post-roleeligibilityschedulerequests?view=graph-rest-1.0`,
    // The request body: action and justification are set by KEEL, the rest
    // comes from the snapshot.
    writableFields: ['action', 'justification', 'principalId', 'roleDefinitionId', 'directoryScopeId', 'scheduleInfo'],
  }),
  record({
    resourceType: 'unifiedRoleManagementPolicy',
    operation: 'update',
    subtype: null,
    route: `${ROLE_POLICIES}/{id}/rules/{ruleId}`,
    method: 'PATCH',
    permission: 'RoleManagementPolicy.ReadWrite.Directory',
    docs: `${DOCS}/unifiedrolemanagementpolicyrule-update?view=graph-rest-1.0`,
    // Per rule: '@odata.type', id and target, plus its kind's fields (PIM_RULE_KINDS).
    writableFields: ['rules'],
  }),
]);

const GOVERNED_TYPES = new Set(ADMIN_ROLE_RECORDS.map((entry) => entry.resourceType));

/** The registry write path of each governed type (capabilities.mjs registers these). */
export const ADMIN_ROLE_PATHS = Object.freeze({
  roleDefinition: ROLE_DEFINITIONS,
  roleEligibilitySchedule: ELIGIBILITY_REQUESTS,
  unifiedRoleManagementPolicy: ROLE_POLICIES,
});

/** The rule kinds a PIM settings restore may write, with the fields each carries. */
export const PIM_RULE_KINDS = Object.freeze({
  expiration: Object.freeze({ odataType: '#microsoft.graph.unifiedRoleManagementPolicyExpirationRule', fields: Object.freeze(['isExpirationRequired', 'maximumDuration']) }),
  enablement: Object.freeze({ odataType: '#microsoft.graph.unifiedRoleManagementPolicyEnablementRule', fields: Object.freeze(['enabledRules']) }),
  approval: Object.freeze({ odataType: '#microsoft.graph.unifiedRoleManagementPolicyApprovalRule', fields: Object.freeze(['setting']) }),
});

/** The reviewed rules, by the fixed id Entra gives each one in every role policy. */
export const PIM_REVIEWED_RULES = Object.freeze({
  Expiration_Admin_Eligibility: 'expiration',
  Expiration_Admin_Assignment: 'expiration',
  Expiration_EndUser_Assignment: 'expiration',
  Enablement_Admin_Eligibility: 'enablement',
  Enablement_Admin_Assignment: 'enablement',
  Enablement_EndUser_Assignment: 'enablement',
  Approval_EndUser_Assignment: 'approval',
});

/** The justification every eligibility request carries. */
export const ELIGIBILITY_JUSTIFICATION = 'Restored by KEEL from a backup snapshot';

/** Request states that mean the eligibility was not (or not yet) granted. */
const UNGRANTED_REQUEST_STATES = new Set(['Canceled', 'Denied', 'Failed', 'PendingApproval', 'PendingAdminDecision', 'Revoked']);

export function isAdminRoleGoverned(resourceType) {
  return GOVERNED_TYPES.has(resourceType);
}

export function adminRoleRecordFor(resourceType, operation) {
  return ADMIN_ROLE_RECORDS.find((entry) => entry.resourceType === resourceType && entry.operation === operation) ?? null;
}

function refusal(outcome, reason) {
  return Object.freeze({ outcome, reason });
}

/** 'builtIn', 'custom' or 'unknown' — from isBuiltIn only, never from a name. */
export function roleSubtypeOf(payload) {
  if (payload?.isBuiltIn === true) return 'builtIn';
  if (payload?.isBuiltIn === false) return 'custom';
  return 'unknown';
}

const DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Seconds in an ISO 8601 duration of weeks, days, hours, minutes and seconds
 * (the forms PIM uses). Null for anything else, including years and months,
 * whose length depends on the calendar.
 */
export function durationSeconds(value) {
  if (typeof value !== 'string' || value === 'P' || value.endsWith('T')) return null;
  const match = DURATION.exec(value);
  if (!match) return null;
  const [, weeks, days, hours, minutes, seconds] = match.map((part) => Number(part ?? 0));
  return weeks * 604800 + days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * When a schedule ends: { type, end } with end a Date, null for no
 * expiration, or `error` when the schedule cannot be read.
 */
export function scheduleEnd(scheduleInfo) {
  const expiration = scheduleInfo?.expiration ?? null;
  const type = expiration?.type ?? null;
  if (type === 'noExpiration') return { type, end: null };
  if (type === 'afterDateTime') {
    const end = Date.parse(expiration.endDateTime ?? '');
    return Number.isNaN(end) ? { type, error: 'its end date cannot be read' } : { type, end: new Date(end) };
  }
  if (type === 'afterDuration') {
    const start = Date.parse(scheduleInfo?.startDateTime ?? '');
    const seconds = durationSeconds(expiration.duration);
    if (Number.isNaN(start) || seconds === null) return { type, error: 'its start or duration cannot be read' };
    return { type, end: new Date(start + seconds * 1000) };
  }
  return { type, error: `expiration type ${type ?? 'missing'} is not known` };
}

function sameId(left, right) {
  return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
}

/**
 * The write-time gate applyWave runs for a governed type, before the journal
 * or the writer. Returns null when the write may proceed, otherwise
 * { outcome, reason }: an object nobody may write (a built-in role, an
 * eligibility held through a group, an expired schedule) is 'skipped'; every
 * other refusal is 'failed'.
 */
export function adminRoleWriteRefusal(resource, verb, { now = new Date() } = {}) {
  if (!isAdminRoleGoverned(resource.resourceType)) return null;
  const entry = adminRoleRecordFor(resource.resourceType, verb);
  if (!entry) return refusal('failed', `no admin role operation record covers ${resource.resourceType} ${verb}`);
  const capability = capabilityFor(resource.resourceType, verb);
  if (!isSupportedClaim(capability.claim) || capability.subtype !== entry.subtype) {
    return refusal('failed', `${resource.resourceType} ${verb} is not a registered write capability`);
  }
  const desired = resource.payload;
  if (!desired || typeof desired !== 'object') {
    return refusal('failed', `${resource.resourceType} ${verb}: the snapshot holds nothing to restore`);
  }
  const live = resource.live?.state === undefined || resource.live?.state === 'present' ? resource.live?.payload ?? null : null;
  if (verb === 'update' && !live) {
    return refusal('failed', `dependency: no live ${resource.resourceType} was observed, so the update cannot be checked against it`);
  }

  if (resource.resourceType === 'roleDefinition') {
    if (roleSubtypeOf(desired) === 'builtIn' || roleSubtypeOf(live) === 'builtIn') {
      return refusal('skipped', `immutable built-in role: ${resource.naturalKey} is Microsoft-owned and is never written`);
    }
    if (roleSubtypeOf(desired) !== 'custom' || (live && roleSubtypeOf(live) !== 'custom')) {
      return refusal('failed', 'the role does not say whether it is built in (isBuiltIn), so it is not written');
    }
    if (!Array.isArray(desired.rolePermissions) || desired.rolePermissions.length === 0) {
      return refusal('failed', 'the custom role holds no permissions to restore');
    }
    return null;
  }

  if (resource.resourceType === 'roleEligibilitySchedule') {
    if (desired.memberType && desired.memberType !== 'Direct') {
      return refusal('skipped', `eligibility held through a group (memberType ${desired.memberType}): the group's own eligibility is restored, never a copy for each member`);
    }
    if (typeof desired.principalId !== 'string' || typeof desired.roleDefinitionId !== 'string') {
      return refusal('failed', 'the eligibility names no principal or no role');
    }
    if (desired.appScopeId && desired.appScopeId !== '/') {
      return refusal('failed', 'unsupported: an eligibility scoped to an application (appScopeId) is not restored');
    }
    if ((desired.directoryScopeId ?? '/') !== '/') {
      return refusal('failed', `unsupported: an eligibility scoped to ${desired.directoryScopeId} is not restored; only directory-wide (scope "/") eligibility is qualified, and a scope id is never rewritten`);
    }
    const end = scheduleEnd(desired.scheduleInfo);
    if (end.error) return refusal('failed', `the eligibility schedule cannot be kept: ${end.error}`);
    if (end.end && end.end.getTime() <= now.getTime()) {
      return refusal('skipped', `expired: the eligibility ended on ${end.end.toISOString()}, so it is not restored`);
    }
    return null;
  }

  // unifiedRoleManagementPolicy
  for (const [side, policy] of [['snapshot', desired], ['live', live]]) {
    if (policy.scopeId !== '/' || policy.scopeType !== 'DirectoryRole') {
      return refusal('failed', `the ${side} policy is not a directory role policy (scope ${policy.scopeType ?? '?'} ${policy.scopeId ?? '?'})`);
    }
  }
  if (!Array.isArray(desired.rules) || !Array.isArray(live.rules)) {
    return refusal('failed', 'the policy was read without its rules, so they cannot be compared');
  }
  return null;
}

/** The writable fields the snapshot holds, from an allowlist, without annotations. */
function allowlisted(fields, desired) {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(desired ?? {}, field))
    .map((field) => [field, withoutAnnotations(desired[field])]));
}

function withoutAnnotations(value) {
  if (Array.isArray(value)) return value.map(withoutAnnotations);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !key.includes('@odata.'))
      .map(([key, item]) => [key, withoutAnnotations(item)]));
  }
  return value;
}

function sameValue(left, right) {
  return isDeepStrictEqual(comparable(left ?? null) ?? null, comparable(right ?? null) ?? null);
}

function changedFields(fields, desired, live) {
  return fields.filter((field) => Object.hasOwn(desired ?? {}, field) && !sameValue(desired[field], live?.[field]));
}

const actions = (role) => new Set((role?.rolePermissions ?? []).flatMap((permission) => permission?.allowedResourceActions ?? []));

/** The resource actions a role write adds and removes, for the dry run. */
export function roleActionChanges(desired, live) {
  const want = actions(desired);
  const have = actions(live);
  return {
    addedActions: [...want].filter((action) => !have.has(action)).sort(),
    removedActions: [...have].filter((action) => !want.has(action)).sort(),
  };
}

/**
 * A role create or update: { method, path, body, fields }, or null when an
 * update has nothing to change. A create sends every writable field the
 * snapshot holds; an update only those that differ from live.
 */
export function roleDefinitionWrite(verb, desired, { live = null, targetId = null } = {}) {
  const entry = adminRoleRecordFor('roleDefinition', verb);
  if (verb === 'create') {
    const body = allowlisted(entry.writableFields, desired);
    return { method: 'POST', path: ROLE_DEFINITIONS, body, fields: Object.keys(body) };
  }
  const fields = changedFields(entry.writableFields, desired, live);
  if (fields.length === 0) return null;
  return {
    method: 'PATCH', path: `${ROLE_DEFINITIONS}/${encodeURIComponent(targetId)}`, body: allowlisted(fields, desired), fields,
  };
}

export function roleDefinitionReadPath(targetId) {
  return `${ROLE_DEFINITIONS}/${encodeURIComponent(targetId)}`;
}

/** After a role write: still custom, and every written field reads back. */
export function roleDefinitionPostStateRefusal(desired, live, fields) {
  if (roleSubtypeOf(live) === 'builtIn') return 'post-state: the role read back as built in';
  const wrong = fields.filter((field) => !sameValue(desired[field], live?.[field]));
  return wrong.length > 0 ? `post-state: ${wrong.join(', ')} did not read back as written` : null;
}

/** The schedule a request asks for: the snapshot's end date. */
function requestedExpiration(scheduleInfo) {
  const end = scheduleEnd(scheduleInfo);
  if (end.error) throw new Error(`the eligibility schedule cannot be kept: ${end.error}`);
  return end.end ? { type: 'afterDateTime', endDateTime: end.end.toISOString() } : { type: 'noExpiration' };
}

/**
 * When a restored eligibility starts: now, or the snapshot's own start when
 * that is still in the future, so a future-dated eligibility is never granted
 * early.
 */
function requestedStart(scheduleInfo, now) {
  const start = Date.parse(scheduleInfo?.startDateTime ?? '');
  return Number.isNaN(start) || start <= now.getTime() ? now : new Date(start);
}

/** The roleEligibilityScheduleRequests body for one snapshot eligibility. */
export function eligibilityRequestBody(desired, { now = new Date() } = {}) {
  return {
    action: 'adminAssign',
    justification: ELIGIBILITY_JUSTIFICATION,
    principalId: desired.principalId,
    roleDefinitionId: desired.roleDefinitionId,
    directoryScopeId: desired.directoryScopeId ?? '/',
    scheduleInfo: { startDateTime: requestedStart(desired.scheduleInfo, now).toISOString(), expiration: requestedExpiration(desired.scheduleInfo) },
  };
}

const odataString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** The read that finds the target's eligibilities for one principal and role. */
export function eligibilityLookupPath(body) {
  return `${ELIGIBILITY_SCHEDULES}?$filter=principalId eq ${odataString(body.principalId)} and roleDefinitionId eq ${odataString(body.roleDefinitionId)}`;
}

/**
 * The target's direct eligibility for the same principal, role and scope, or
 * null. An eligibility held through a group never counts as this one.
 */
export function matchingEligibility(schedules, body) {
  return (schedules ?? []).find((schedule) => sameId(schedule?.principalId, body.principalId)
    && sameId(schedule?.roleDefinitionId, body.roleDefinitionId)
    && (schedule?.directoryScopeId ?? '/') === body.directoryScopeId
    && (!schedule?.memberType || schedule.memberType === 'Direct')) ?? null;
}

/** Whether a request response means the eligibility was not granted. */
export function ungrantedRequest(response) {
  return UNGRANTED_REQUEST_STATES.has(response?.status) ? response.status : null;
}

/** After the request: the schedule exists with the requested end. */
export function eligibilityPostStateRefusal(body, schedule) {
  if (!schedule) return 'post-state: the eligibility did not read back after the request';
  const want = body.scheduleInfo.expiration;
  const got = schedule.scheduleInfo?.expiration ?? null;
  if (want.type === 'noExpiration') {
    return got?.type === 'noExpiration' ? null : `post-state: the eligibility reads back with expiration ${got?.type ?? 'missing'}, not noExpiration`;
  }
  const end = scheduleEnd(schedule.scheduleInfo);
  return end.end && end.end.getTime() === Date.parse(want.endDateTime) ? null
    : `post-state: the eligibility reads back ending ${end.end?.toISOString() ?? 'never or unknown'}, not ${want.endDateTime}`;
}

function ruleKind(rule) {
  return PIM_REVIEWED_RULES[rule?.id] ?? null;
}

function ruleFields(kind, rule) {
  return Object.fromEntries(PIM_RULE_KINDS[kind].fields.filter((field) => Object.hasOwn(rule ?? {}, field))
    .map((field) => [field, withoutAnnotations(rule[field])]));
}

/**
 * Why writing `want` over `have` would weaken protection, or null. Unknown
 * comparisons count as weakening: they are withheld, never guessed.
 */
export function ruleWeakening(kind, want, have) {
  if (kind === 'expiration') {
    if (have?.isExpirationRequired === true && want?.isExpirationRequired !== true) return 'it would stop requiring an end date';
    if (want?.isExpirationRequired === true && have?.isExpirationRequired === true && want.maximumDuration !== have.maximumDuration) {
      const wanted = durationSeconds(want.maximumDuration);
      const had = durationSeconds(have.maximumDuration);
      if (wanted === null || had === null) return `the maximum durations ${have.maximumDuration} and ${want.maximumDuration} cannot be compared`;
      if (wanted > had) return `it would raise the maximum duration from ${have.maximumDuration} to ${want.maximumDuration}`;
    }
    return null;
  }
  if (kind === 'enablement') {
    const wanted = new Set(want?.enabledRules ?? []);
    const dropped = (have?.enabledRules ?? []).filter((name) => !wanted.has(name));
    return dropped.length > 0 ? `it would stop requiring ${dropped.join(', ')}` : null;
  }
  const ws = want?.setting ?? {};
  const hs = have?.setting ?? {};
  for (const flag of ['isApprovalRequired', 'isApprovalRequiredForExtension', 'isRequestorJustificationRequired']) {
    if (hs[flag] === true && ws[flag] !== true) return `it would turn off ${flag}`;
  }
  // Stages only protect anything while approval is required on the live side.
  if (hs.isApprovalRequired !== true) return null;
  const wantStages = ws.approvalStages ?? [];
  const haveStages = hs.approvalStages ?? [];
  if (wantStages.length < haveStages.length) return 'it would remove an approval stage';
  // Adding stages is stronger; any other mode change is not known to be.
  if (wantStages.length === haveStages.length && ws.approvalMode !== hs.approvalMode && hs.approvalMode !== 'NoApproval') {
    return `it would change the approval mode from ${hs.approvalMode ?? 'unset'} to ${ws.approvalMode ?? 'unset'}`;
  }
  for (const [index, had] of haveStages.entries()) {
    const wanted = wantStages[index] ?? {};
    const stage = `approval stage ${index + 1}`;
    for (const flag of ['isApproverJustificationRequired', 'isEscalationEnabled']) {
      if (had?.[flag] === true && wanted?.[flag] !== true) return `it would turn off ${flag} in ${stage}`;
    }
    for (const list of ['primaryApprovers', 'escalationApprovers']) {
      const kept = new Set((wanted?.[list] ?? []).map(approverKey));
      const removed = (had?.[list] ?? []).map(approverKey).filter((key) => !kept.has(key));
      if (removed.length > 0) return `it would remove ${list} ${removed.join(', ')} from ${stage}`;
    }
  }
  return null;
}

/** One approver, by its kind and id (a user, a group, a manager level). */
function approverKey(approver) {
  const id = approver?.userId ?? approver?.groupId ?? approver?.managerLevel ?? approver?.id ?? '';
  return `${approver?.['@odata.type'] ?? 'approver'}:${String(id).toLowerCase()}`;
}

/** The users and groups an approval rule names: [{ collection, id }]. */
export function ruleApprovers(rule) {
  const found = new Map();
  for (const stage of rule?.setting?.approvalStages ?? []) {
    for (const approver of [...(stage?.primaryApprovers ?? []), ...(stage?.escalationApprovers ?? [])]) {
      if (typeof approver?.userId === 'string') found.set(`users/${approver.userId.toLowerCase()}`, { collection: 'users', id: approver.userId });
      if (typeof approver?.groupId === 'string') found.set(`groups/${approver.groupId.toLowerCase()}`, { collection: 'groups', id: approver.groupId });
    }
  }
  return [...found.values()];
}

function approvalWithoutApprovers(rule) {
  const setting = rule?.setting ?? {};
  if (setting.isApprovalRequired !== true) return false;
  const stages = setting.approvalStages ?? [];
  return stages.length === 0 || !stages.every((stage) => (stage?.primaryApprovers ?? []).length > 0);
}

/**
 * The rule writes one policy restore needs:
 *  - writes:   [{ ruleId, kind, path, body, fields }] — reviewed rules that differ
 *  - withheld: [{ ruleId, reason }] — reviewed rules whose change would weaken protection
 *  - manual:   [ruleId] — other rules that differ, or a rule the live policy lacks
 * Throws when an approval rule would require approval with a stage that has no
 * approver. A rule is sent with the live rule's target: a rule id's target is
 * fixed by Entra, so the snapshot's copy is never written over it.
 */
export function policyRuleWrites(policyId, desired, live) {
  const liveRules = new Map((live?.rules ?? []).map((rule) => [rule?.id, rule]));
  const writes = [];
  const withheld = [];
  const manual = [];
  for (const rule of desired?.rules ?? []) {
    const current = liveRules.get(rule?.id);
    const kind = ruleKind(rule);
    if (!kind) {
      if (!current || !sameValue(rule, current)) manual.push(rule?.id ?? '(no id)');
      continue;
    }
    if (!current) { manual.push(rule.id); continue; }
    const fields = changedFields(PIM_RULE_KINDS[kind].fields, rule, current);
    if (fields.length === 0) continue;
    const weakening = ruleWeakening(kind, rule, current);
    if (weakening) { withheld.push({ ruleId: rule.id, reason: weakening }); continue; }
    if (kind === 'approval' && approvalWithoutApprovers(rule)) {
      throw new Error(`${rule.id}: approval would be required with no approver, which blocks every activation`);
    }
    writes.push({
      ruleId: rule.id,
      kind,
      path: `${ROLE_POLICIES}/${encodeURIComponent(policyId)}/rules/${encodeURIComponent(rule.id)}`,
      body: {
        '@odata.type': PIM_RULE_KINDS[kind].odataType,
        id: rule.id,
        ...(current.target ? { target: withoutAnnotations(current.target) } : {}),
        ...ruleFields(kind, rule),
      },
      fields: PIM_RULE_KINDS[kind].fields.filter((field) => Object.hasOwn(rule, field)),
    });
  }
  return { writes, withheld, manual };
}

export function policyReadPath(policyId) {
  return `${ROLE_POLICIES}/${encodeURIComponent(policyId)}?$expand=rules`;
}

/** After the rule writes: every written rule reads back with its written fields. */
export function policyPostStateRefusal(desired, live, writes) {
  const liveRules = new Map((live?.rules ?? []).map((rule) => [rule?.id, rule]));
  const wrong = [];
  for (const write of writes) {
    const want = (desired.rules ?? []).find((rule) => rule.id === write.ruleId);
    const got = liveRules.get(write.ruleId);
    if (!got || write.fields.some((field) => !sameValue(want[field], got[field]))) wrong.push(write.ruleId);
  }
  return wrong.length > 0 ? `post-state: rule ${wrong.join(', ')} did not read back as written` : null;
}

/**
 * Only the references inside what a write sends are rewritten: the role and
 * principal of an eligibility, and the reviewed rules of a policy. A server
 * field elsewhere in the payload (lastModifiedBy) is never resolved or sent.
 */
export function writtenReferences(resource) {
  const references = resource.references ?? [];
  if (resource.resourceType === 'roleEligibilitySchedule') {
    return references.filter((ref) => ref.field === 'principalId' || ref.field === 'roleDefinitionId');
  }
  if (resource.resourceType === 'unifiedRoleManagementPolicy') {
    const reviewed = new Set((resource.payload?.rules ?? []).map((rule, index) => (ruleKind(rule) ? index : null)).filter((index) => index !== null));
    return references.filter((ref) => {
      // The live target is sent, never the snapshot's, so its references are not.
      const match = /^rules\[(\d+)\]\.(?!target(?:[.[]|$))/.exec(ref.field);
      return match !== null && reviewed.has(Number(match[1]));
    });
  }
  const fields = new Set(adminRoleRecordFor('roleDefinition', 'create').writableFields);
  return references.filter((ref) => fields.has(String(ref.field).split(/[.[]/)[0]));
}

/** The family ledger: every record with its claim. No coverage percentage. */
export function buildAdminRoleLedger() {
  return Object.freeze({
    contractVersion: ADMIN_ROLE_OPERATIONS_CONTRACT_VERSION,
    operations: Object.freeze(ADMIN_ROLE_RECORDS.map((entry) => Object.freeze({
      resourceType: entry.resourceType,
      operation: entry.operation,
      subtype: entry.subtype,
      route: `${entry.method} ${entry.route}`,
      permission: entry.permission,
      writableFields: entry.writableFields,
      claim: capabilityFor(entry.resourceType, entry.operation).claim,
    }))),
    refused: Object.freeze([
      'built-in roles (isBuiltIn: true) are never written',
      'role delete, eligibility removal and eligibility update are not registered',
      'an eligibility held through a group is restored on the group, not per member',
      'an expired eligibility is not restored',
      'an eligibility scoped below the directory (directoryScopeId other than "/") is not restored',
      'a PIM rule change that weakens protection is reported, never written',
      'notification and authentication-context rules are reported, never written',
    ]),
  });
}
