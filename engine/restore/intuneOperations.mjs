/**
 * Issue #155: restore of Intune compliance policies, device configuration
 * profiles and settings catalog policies, with their assignments.
 *
 * Before this module every Intune type was collected but nothing could put it
 * back. Three types are now restorable by create and update:
 *
 *  - deviceCompliancePolicy  v1.0  /deviceManagement/deviceCompliancePolicies
 *  - deviceConfiguration     v1.0  /deviceManagement/deviceConfigurations
 *  - configurationPolicy     beta  /deviceManagement/configurationPolicies
 *    (the settings catalog has no v1.0 resource, so it is written through beta)
 *
 * Each is an explicit record naming its Graph version, collection, update
 * method and the fields Intune owns. A body is built from the snapshot payload
 * minus those fields, never sent as the stored object:
 *
 *  - read-only and server-owned fields are stripped (id, createdDateTime,
 *    lastModifiedDateTime, version, status summaries, every @odata annotation
 *    except @odata.type, which Graph needs to create or update a derived type);
 *  - a compliance policy is created with its actions for noncompliance
 *    (scheduledActionsForRule), which Graph requires on create; on update a
 *    changed set of actions is written through the scheduleActionsForRules
 *    action, because PATCH does not change them;
 *  - a settings catalog policy is written whole (its settings included) by
 *    POST on create and PUT on update.
 *
 * Secrets are never written. Graph never returns a password, a Wi-Fi
 * pre-shared key, a certificate or an encrypted custom setting, so a policy
 * that holds one would be restored with a blank in its place. Such a policy is
 * manual: it is skipped with the fields named, and restored by hand. Profile
 * subtypes whose purpose is a credential (Wi-Fi, VPN, certificate and email
 * profiles) are manual for the same reason, whatever the backup shows.
 *
 * Assignments (which groups get a policy) are relationship observations
 * (engine/collect/relationships.mjs, family `assignment`). A restore writes
 * them through the documented `/assign` action, which replaces a policy's
 * whole assignment list, so it runs only when the backup's assignment read
 * was complete. Every group is mapped to its id in the target by natural key
 * (the same resolution references use); a group that does not exist in the
 * target refuses the policy before anything is written. An assignment filter
 * is kept as observed and must exist in the target. Scope tags are written as
 * observed: they are tenant ids ("0" is the built-in default), so a restore
 * into another tenant needs the same tags to exist there.
 *
 * The capability registry (capabilities.mjs) holds the claims; this module
 * never raises one. Routes and fields follow the Graph references as declared
 * and are fixture-tested, not live-qualified (docs/roadmap/intune-restore.md).
 */
import { isDeepStrictEqual } from 'node:util';

import { projectAssignment } from '../collect/relationships.mjs';
import { SERVER_OWNED_ALWAYS } from '../cir/serverOwned.mjs';
import { resolveSymbol } from '../graph/resolver.mjs';
import {
  applyRecordWrite, defineRecord, isNotFound as recordNotFound, outcomeDetail, readUntil, recordLedger, recordObjectPath, sameValue,
} from './recordWriter.mjs';

export const INTUNE_OPERATIONS_CONTRACT_VERSION = 1;

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const v1 = (page) => `${DOCS}/${page}?view=graph-rest-1.0`;
const beta = (page) => `${DOCS}/${page}?view=graph-rest-beta`;

// Navigation properties and reports on every Intune policy: read separately or
// computed by Intune, never part of a write body.
const POLICY_NAVIGATION = Object.freeze([
  'assignments', 'deviceStatuses', 'userStatuses', 'deviceStatusOverview', 'userStatusOverview',
  'deviceSettingStateSummaries', 'groupAssignments',
]);

const record = (fields) => Object.freeze({ ...fields, excluded: Object.freeze([...fields.excluded]) });

/** The operation records, one per restorable type. */
export const INTUNE_RECORDS = Object.freeze({
  deviceCompliancePolicy: record({
    resourceType: 'deviceCompliancePolicy',
    version: 'v1.0',
    collection: '/deviceManagement/deviceCompliancePolicies',
    updateMethod: 'PATCH',
    readQuery: '$expand=scheduledActionsForRule($expand=scheduledActionConfigurations)',
    odataTypeRequired: true,
    scheduledActions: true,
    settings: false,
    assignmentType: '#microsoft.graph.deviceCompliancePolicyAssignment',
    permission: 'DeviceManagementConfiguration.ReadWrite.All',
    docs: Object.freeze({
      create: v1('intune-deviceconfig-devicecompliancepolicy-create'),
      update: v1('intune-deviceconfig-devicecompliancepolicy-update'),
      scheduleActions: v1('intune-deviceconfig-devicecompliancepolicy-scheduleactionsforrules'),
      assign: v1('intune-deviceconfig-devicecompliancepolicy-assign'),
    }),
    excluded: ['version', 'scheduledActionsForRule', ...POLICY_NAVIGATION],
  }),
  deviceConfiguration: record({
    resourceType: 'deviceConfiguration',
    version: 'v1.0',
    collection: '/deviceManagement/deviceConfigurations',
    updateMethod: 'PATCH',
    readQuery: null,
    odataTypeRequired: true,
    scheduledActions: false,
    settings: false,
    assignmentType: '#microsoft.graph.deviceConfigurationAssignment',
    permission: 'DeviceManagementConfiguration.ReadWrite.All',
    docs: Object.freeze({
      create: v1('intune-deviceconfig-deviceconfiguration-create'),
      update: v1('intune-deviceconfig-deviceconfiguration-update'),
      assign: v1('intune-deviceconfig-deviceconfiguration-assign'),
    }),
    excluded: ['version', 'supportsScopeTags', ...POLICY_NAVIGATION],
  }),
  configurationPolicy: record({
    resourceType: 'configurationPolicy',
    version: 'beta',
    collection: '/deviceManagement/configurationPolicies',
    updateMethod: 'PUT',
    readQuery: '$expand=settings',
    odataTypeRequired: false,
    scheduledActions: false,
    settings: true,
    assignmentType: '#microsoft.graph.deviceManagementConfigurationPolicyAssignment',
    permission: 'DeviceManagementConfiguration.ReadWrite.All',
    docs: Object.freeze({
      create: beta('intune-deviceconfigv2-devicemanagementconfigurationpolicy-create'),
      update: beta('intune-deviceconfigv2-devicemanagementconfigurationpolicy-update'),
      assign: beta('intune-deviceconfigv2-devicemanagementconfigurationpolicy-assign'),
    }),
    excluded: ['creationSource', 'isAssigned', 'priorityMetaData', 'settingCount', 'settings', ...POLICY_NAVIGATION],
  }),
});

export const INTUNE_OPERATIONS = Object.freeze(['create', 'update']);

export function isIntuneGoverned(resourceType) {
  return Object.hasOwn(INTUNE_RECORDS, resourceType);
}

export function intuneRecordFor(resourceType) {
  return INTUNE_RECORDS[resourceType] ?? null;
}

const stripGraph = (odata) => (typeof odata === 'string' ? odata.replace(/^#?microsoft\.graph\./, '') : null);
const isAnnotation = (key) => key.includes('@odata.') && key !== '@odata.type';

// ------------------------------------------------------------------ secrets

// Field names whose value Graph never returns in clear (or at all).
const SECRET_NAMES = /^(password|passphrase|presharedkey|sharedsecret|secret|privatekey|pfxblob|productkey|kioskmodeexitcode)$/i;
const SECRET_SUFFIX = /(Password|Passphrase|PreSharedKey|SharedSecret|PrivateKey|Secret|WorkspaceKey|OnboardingBlob|ProductKey)$/;

/**
 * Profile subtypes that exist to carry a credential or certificate. Wi-Fi and
 * VPN profiles hold keys or name certificate profiles; certificate profiles
 * (trusted root, PKCS, SCEP, imported PFX, derived credentials) are
 * certificates; email profiles hold account identity and certificates.
 */
const CREDENTIAL_SUBTYPE = /(wifi|vpn|certificate|pkcs|scep|pfx|derivedcredential|emailprofile|easemail)/i;

/**
 * Where a payload holds something Graph never returns: a secret-named field
 * (whatever its value, since the backup holds a blank or a mask), an
 * encrypted custom (OMA-URI) setting, a secret reference, or a settings
 * catalog secret value. Returns the field paths, empty when there is none.
 */
export function intuneSecretFields(payload) {
  const found = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node.isEncrypted === true) found.push(path || '(policy)');
    if (typeof node.secretReferenceValueId === 'string' && node.secretReferenceValueId.length > 0) found.push(path || '(policy)');
    if (/SecretSettingValue$/i.test(stripGraph(node['@odata.type']) ?? '')) found.push(path || '(policy)');
    for (const [key, value] of Object.entries(node)) {
      const child = path ? `${path}.${key}` : key;
      if (SECRET_NAMES.test(key) || SECRET_SUFFIX.test(key)) {
        found.push(child);
        continue;
      }
      walk(value, child);
    }
  };
  walk(payload, '');
  return [...new Set(found)];
}

/** The credential-bearing profile subtype a payload is, or null. */
export function credentialSubtype(payload) {
  const subtype = stripGraph(payload?.['@odata.type']);
  return subtype && CREDENTIAL_SUBTYPE.test(subtype) ? subtype : null;
}

// ------------------------------------------------------------------- bodies

/** Every @odata annotation except @odata.type, at every depth. */
function withoutAnnotations(value) {
  if (Array.isArray(value)) return value.map(withoutAnnotations);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (isAnnotation(key)) continue;
    out[key] = withoutAnnotations(child);
  }
  return out;
}

/** Actions for noncompliance, without the ids Intune assigns. */
export function scheduledActionsBody(rules) {
  return (rules ?? []).map((rule) => ({
    ruleName: rule?.ruleName ?? null,
    scheduledActionConfigurations: (rule?.scheduledActionConfigurations ?? []).map((action) => ({
      actionType: action?.actionType ?? null,
      gracePeriodHours: action?.gracePeriodHours ?? 0,
      notificationTemplateId: action?.notificationTemplateId ?? null,
      notificationMessageCCList: action?.notificationMessageCCList ?? [],
    })),
  }));
}

/** Settings catalog settings, without the ids Intune assigns. */
export function settingsBody(settings) {
  return (settings ?? []).map((setting) => ({
    '@odata.type': '#microsoft.graph.deviceManagementConfigurationSetting',
    settingInstance: withoutAnnotations(setting?.settingInstance ?? null),
  }));
}

/**
 * The body a create or update sends for one payload. Built field by field from
 * the record: server-owned and navigation fields are never sent, @odata.type
 * is kept only where Graph needs it, a compliance create carries its actions
 * and a settings catalog write carries its settings.
 */
export function intuneWriteBody(resourceType, payload, verb) {
  const entry = intuneRecordFor(resourceType);
  if (!entry) throw new Error(`${resourceType} has no Intune operation record`);
  const body = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (SERVER_OWNED_ALWAYS.has(key)) continue;
    if (key === '@odata.type') {
      if (entry.odataTypeRequired) body[key] = value;
      continue;
    }
    if (isAnnotation(key) || entry.excluded.includes(key)) continue;
    body[key] = withoutAnnotations(value);
  }
  if (entry.settings) body.settings = settingsBody(payload?.settings);
  if (entry.scheduledActions && verb === 'create') body.scheduledActionsForRule = scheduledActionsBody(payload?.scheduledActionsForRule);
  return body;
}

/** Nulls (and empty values Graph leaves out) read the same as an absent field. */
function normalised(value) {
  if (Array.isArray(value)) return value.map(normalised);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const child = normalised(value[key]);
    if (child === null || child === undefined) continue;
    out[key] = child;
  }
  return out;
}

/**
 * The fields of `desired`'s body whose value `live` does not hold, compared as
 * bodies (so server-owned fields and child ids never count). Empty when the
 * live policy already matches.
 */
export function changedIntuneFields(resourceType, desired, live, verb = 'update') {
  const want = intuneWriteBody(resourceType, desired, verb);
  const have = intuneWriteBody(resourceType, live ?? {}, verb);
  return Object.keys(want).filter((key) => !isDeepStrictEqual(normalised(want[key] ?? null), normalised(have[key] ?? null)));
}

/** Whether a compliance policy's actions for noncompliance differ from live. */
export function scheduledActionsDiffer(desired, live) {
  return !isDeepStrictEqual(normalised(scheduledActionsBody(desired?.scheduledActionsForRule)), normalised(scheduledActionsBody(live?.scheduledActionsForRule)));
}

/** The path a policy is read back from, with the expansions its body needs. */
export function intuneReadPath(resourceType, targetId) {
  const entry = intuneRecordFor(resourceType);
  const path = `${entry.collection}/${encodeURIComponent(targetId)}`;
  return entry.readQuery ? `${path}?${entry.readQuery}` : path;
}

// ------------------------------------------------------------------ refusals

/**
 * Refuses a write the records cannot make safely, before any Graph call.
 * Returns null, or { outcome: 'skipped' | 'failed', reason }. `skipped` is a
 * manual-by-design policy (secrets, credential profiles); `failed` is a backup
 * that cannot drive the write.
 */
export function intuneWriteRefusal(resource, verb) {
  if (!isIntuneGoverned(resource?.resourceType)) return null;
  if (verb !== 'create' && verb !== 'update') return null; // the capability gate refuses the rest
  const entry = intuneRecordFor(resource.resourceType);
  const payload = resource.payload;
  if (!payload || typeof payload !== 'object') return { outcome: 'failed', reason: 'the backup holds no policy to write' };

  const subtype = credentialSubtype(payload);
  if (subtype) {
    return {
      outcome: 'skipped',
      reason: `manual: this is a ${subtype} profile, which carries credentials or certificates Graph never returns; restore it by hand so nothing is written as a blank`,
    };
  }
  const secrets = intuneSecretFields(payload);
  if (secrets.length > 0) {
    return {
      outcome: 'skipped',
      reason: `manual: the policy holds values Graph never returns (passwords, keys, certificates or encrypted settings) at ${secrets.join(', ')}; restore it by hand so they are never written as blanks`,
    };
  }
  if (entry.odataTypeRequired && typeof payload['@odata.type'] !== 'string') {
    return { outcome: 'failed', reason: 'the backup does not record which kind of policy this is (@odata.type), and Graph needs it to write one' };
  }
  if (verb === 'update') {
    const liveType = resource.live?.payload?.['@odata.type'];
    if (entry.odataTypeRequired && typeof liveType === 'string' && stripGraph(liveType) !== stripGraph(payload['@odata.type'])) {
      return {
        outcome: 'failed',
        reason: `the live policy is a ${stripGraph(liveType)}, not the ${stripGraph(payload['@odata.type'])} in the backup; a policy cannot change kind, so restore it by hand`,
      };
    }
  }
  if (entry.scheduledActions) {
    // An update from a backup taken before actions were backed up leaves the live
    // actions alone (backupHoldsActions); an explicit empty list is never sent,
    // because Graph needs at least the block action.
    if (Array.isArray(payload.scheduledActionsForRule) && payload.scheduledActionsForRule.length === 0) {
      return {
        outcome: 'failed',
        reason: 'the backup lists no actions for noncompliance for this compliance policy, and Graph needs at least one; restore it by hand',
      };
    }
    if (verb === 'create' && !backupHoldsActions(payload)) {
      return {
        outcome: 'failed',
        reason: 'the backup does not hold this compliance policy\'s actions for noncompliance, and Graph needs them to create it; take a new backup, then restore',
      };
    }
  }
  if (entry.settings) {
    if (!Array.isArray(payload.settings)) {
      return {
        outcome: 'failed',
        reason: 'the backup does not hold this settings catalog policy\'s settings (it was taken before settings were backed up); writing it would empty the policy, so take a new backup first',
      };
    }
    // The whole policy is replaced, so a short settings list would delete settings.
    const count = payload.settingCount;
    if (typeof count === 'number' && payload.settings.length !== count) {
      return {
        outcome: 'failed',
        reason: `the backup holds ${payload.settings.length} of this settings catalog policy's ${count} settings; writing it would delete the rest, so take a new backup first`,
      };
    }
    if (payload.settings.length === 0 && count !== 0) {
      return {
        outcome: 'failed',
        reason: 'the backup holds no settings for this settings catalog policy and does not say it has none; writing it would empty the policy, so take a new backup first',
      };
    }
  }
  return null;
}

/** Whether a compliance backup holds its actions for noncompliance (backups taken before #155 do not). */
export function backupHoldsActions(payload) {
  return Array.isArray(payload?.scheduledActionsForRule) && payload.scheduledActionsForRule.length > 0;
}

// --------------------------------------------------------------- assignments

const isComplete = (outcome) => outcome === 'complete' || outcome === 'complete-empty';
const GROUP_TARGETS = new Set(['groupAssignmentTarget', 'exclusionGroupAssignmentTarget']);
const CONSTANT_TARGETS = Object.freeze({
  allLicensedUsersAssignmentTarget: 'all-licensed-users',
  allDevicesAssignmentTarget: 'all-devices',
});

function filterOf(attributes) {
  const id = typeof attributes?.filterId === 'string' && attributes.filterId.length > 0 ? attributes.filterId.toLowerCase() : null;
  const type = attributes?.filterType && attributes.filterType !== 'none' ? attributes.filterType : null;
  return id && type ? { id, type } : null;
}

const edgeIdentity = (targetType, targetId, filter) => `${targetType}|${targetId}|${filter?.id ?? ''}|${filter?.type ?? 'none'}`;

/**
 * The assignments a restore writes for one policy, from the backup's
 * assignment read (`resource.assignments`: { outcome, targets }) with every
 * group mapped to its target id by `resolve(naturalKey)` (a string, null when
 * missing, or { stale: true } for a group matched only through its lineage,
 * which is refused).
 *
 * Returns { state, ... }:
 *  - 'not-observed': the backup holds no complete assignment read, so the
 *    live assignments are left as they are (absence of evidence is never an
 *    empty list);
 *  - 'refused': a group is missing in the target, or a target kind is not
 *    restorable; nothing about this policy may be written;
 *  - 'ready': `assignments` is the /assign list, `identities` the comparable
 *    set and `filters` the assignment filter ids the target must hold.
 */
export function assignmentPlan(resource, resolve) {
  const desired = resource?.assignments;
  // Only a selection restore attaches assignments (cli/keel-restore.mjs); any
  // other scope never looked, which is not the same as a backup without them.
  if (!desired) return { state: 'not-observed', reason: 'assignments are restored only when policies are picked for a restore; they were not checked, so they are left as they are' };
  if (desired.outcome === 'absent') return { state: 'not-observed', reason: 'the backup holds no assignment read for this policy, so its assignments are left as they are' };
  if (!isComplete(desired.outcome)) {
    return { state: 'not-observed', reason: `the backup's assignment read was ${desired.outcome}, so its assignments are left as they are` };
  }
  const assignments = [];
  const identities = new Set();
  const filters = new Set();
  const problems = [];
  for (const target of desired.targets ?? []) {
    const attributes = target.attributes ?? {};
    const targetType = attributes.targetType ?? null;
    const filter = filterOf(attributes);
    let targetId;
    const body = { '@odata.type': `#microsoft.graph.${targetType}` };
    if (GROUP_TARGETS.has(targetType)) {
      const naturalKey = target.targetNaturalKey ?? null;
      const resolved = naturalKey ? resolve(naturalKey) : null;
      if (resolved && typeof resolved === 'object' && resolved.stale) {
        problems.push(`the group ${naturalKey} was matched only through its history (renamed or recreated), so it is not assigned without a review`);
        continue;
      }
      if (typeof resolved !== 'string' || resolved.length === 0) {
        problems.push(naturalKey
          ? `the group ${naturalKey} does not exist in the target`
          : 'an assigned group is not in the backup, so it cannot be found in the target');
        continue;
      }
      targetId = resolved.toLowerCase();
      body.groupId = resolved;
    } else if (Object.hasOwn(CONSTANT_TARGETS, targetType)) {
      targetId = CONSTANT_TARGETS[targetType];
    } else {
      problems.push(`an assignment to a ${targetType ?? 'target of unknown kind'} is not restorable`);
      continue;
    }
    if (filter) {
      body.deviceAndAppManagementAssignmentFilterId = filter.id;
      body.deviceAndAppManagementAssignmentFilterType = filter.type;
      filters.add(filter.id);
    }
    identities.add(edgeIdentity(targetType, targetId, filter));
    assignments.push({ target: body });
  }
  if (problems.length > 0) {
    return { state: 'refused', reason: `assignments cannot be restored: ${[...new Set(problems)].join('; ')}. Nothing was written for this policy` };
  }
  assignments.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { state: 'ready', assignments, identities, filters: [...filters].sort() };
}

/** The comparable identities of live assignments (Graph's /assignments items or observed edges). */
export function liveAssignmentIdentities(items, { observed = false } = {}) {
  const identities = new Set();
  for (const item of items ?? []) {
    const edge = observed ? item : projectAssignment(item);
    if (!edge) continue;
    const targetType = edge.attributes?.targetType ?? edge.edgeKey?.split('|')[0] ?? null;
    identities.add(edgeIdentity(targetType, String(edge.targetId).toLowerCase(), filterOf(edge.attributes)));
  }
  return identities;
}

export const sameIdentities = (left, right) => left.size === right.size && [...left].every((item) => right.has(item));

/** The /assign request for a policy. */
export function assignRequest(resourceType, targetId, plan) {
  const entry = intuneRecordFor(resourceType);
  return {
    version: entry.version,
    path: `${entry.collection}/${encodeURIComponent(targetId)}/assign`,
    body: { assignments: plan.assignments.map((assignment) => ({ '@odata.type': entry.assignmentType, ...assignment })) },
  };
}

export function assignmentsReadPath(resourceType, targetId) {
  return `${intuneRecordFor(resourceType).collection}/${encodeURIComponent(targetId)}/assignments`;
}

/** Where an assignment filter is read to prove it exists in the target (beta only). */
export const ASSIGNMENT_FILTER_PATH = (filterId) => `/deviceManagement/assignmentFilters/${encodeURIComponent(filterId)}`;

/**
 * Restore planning (selection scope): attaches the backup's assignment reads
 * to the Intune policies a restore covers, and plans an update for a policy
 * whose settings match but whose assignments differ from live (the policy's
 * hash does not include its assignments).
 *
 * - `desired`: loadSnapshotRelationships(..., families ['assignment']) output.
 * - `live`: Map `${naturalKey}|assignment` -> live observation, for policies present live.
 * - `resolve(naturalKey)`: target id of an existing object, or null.
 * - `recoveryFor(resource)`: recomputes the recovery mechanism of a promoted resource.
 */
export function attachIntuneAssignments(resources, { desired, live = new Map(), resolve = () => null, recoveryFor = null }) {
  return resources.map((resource) => {
    if (!isIntuneGoverned(resource.resourceType) || resource.verb === 'delete') return resource;
    const key = `${resource.naturalKey}|assignment`;
    const want = desired?.get(key);
    if (!want) return { ...resource, assignments: { outcome: 'absent', targets: [] } };
    const observed = live.get(key);
    const liveCount = observed && isComplete(observed.outcome) ? liveAssignmentIdentities(observed.targets, { observed: true }).size : null;
    const withAssignments = {
      ...resource,
      assignments: { outcome: want.outcome, targets: want.targets },
      ...(liveCount === null ? {} : { liveAssignmentCount: liveCount }),
    };
    if (resource.verb !== 'noop' || resource.live?.state !== 'present') return withAssignments;
    const plan = assignmentPlan(withAssignments, resolve);
    let reason = null;
    if (plan.state === 'refused') reason = plan.reason;
    else if (plan.state === 'ready' && liveCount !== null
      && !sameIdentities(plan.identities, liveAssignmentIdentities(observed.targets, { observed: true }))) {
      reason = `assignments differ: ${assignmentChange(plan, liveCount)}`;
    }
    if (!reason) return withAssignments;
    const promoted = { ...withAssignments, verb: 'update', verbReason: reason };
    return recoveryFor ? { ...promoted, recovery: recoveryFor(promoted) } : promoted;
  });
}

/**
 * The `resolve` attachIntuneAssignments uses when planning: an object already
 * in the target, or one this same run restores or creates. The wave planner
 * puts such an object before the policies assigned to it, and applyWave then
 * resolves it from the run's own results. A restored object keeps its id; a
 * created one has none yet, so it stands in as "planned" (never written).
 */
export function assignmentTargetResolver(resources, existingTargetIds) {
  const comingBack = new Map((resources ?? [])
    .filter((resource) => resource.verb === 'restore-soft-deleted' || resource.verb === 'create')
    .map((resource) => [resource.naturalKey, (resource.verb === 'restore-soft-deleted'
      ? resource.targetId ?? resource.live?.targetId : null) ?? `planned:${resource.naturalKey}`]));
  return (naturalKey) => existingTargetIds.get(naturalKey) ?? comingBack.get(naturalKey) ?? null;
}

/**
 * Plain words for what /assign does to a policy: `liveCount` is how many
 * assignments it has now (null when unknown, e.g. a create).
 */
export function assignmentChange(plan, liveCount) {
  const planned = plan.assignments.length;
  const items = (n) => `${n} assignment${n === 1 ? '' : 's'}`;
  if (liveCount === null || liveCount === undefined) return planned === 0 ? 'the backup has no assignments for this policy' : `assigns it as in the backup (${items(planned)})`;
  if (planned === 0) return liveCount === 0 ? 'none, as in the backup' : `removes all ${items(liveCount)} the policy has now, because the backup has none`;
  return `replaces the ${items(liveCount)} the policy has now with the ${items(planned)} in the backup`;
}

/**
 * Post-state check after a write: every written field must read back as
 * written (child ids and server-owned fields never count). Returns null when
 * it holds, else the refusal text.
 */
export function intunePostStateRefusal(resourceType, desired, live, { verb, fields }) {
  if (!live || typeof live !== 'object') return 'the policy could not be read back';
  const entry = intuneRecordFor(resourceType);
  if (entry.odataTypeRequired && stripGraph(live['@odata.type']) !== stripGraph(desired['@odata.type'])) {
    return `post-state: the policy reads back as ${stripGraph(live['@odata.type']) ?? 'an unnamed kind'}, not ${stripGraph(desired['@odata.type'])}`;
  }
  const differing = changedIntuneFields(resourceType, desired, live, verb).filter((field) => fields.includes(field));
  if (differing.length > 0) return `post-state: ${differing.join(', ')} did not read back as written`;
  if (entry.scheduledActions && backupHoldsActions(desired) && scheduledActionsDiffer(desired, live)) {
    return 'post-state: the actions for noncompliance did not read back as written';
  }
  return null;
}

/** The Intune family ledger: what each record writes, and with which permission. */
export function buildIntuneLedger() {
  return Object.freeze({
    contractVersion: INTUNE_OPERATIONS_CONTRACT_VERSION,
    operations: Object.freeze(Object.values(INTUNE_RECORDS).flatMap((entry) => INTUNE_OPERATIONS.map((operation) => Object.freeze({
      resourceType: entry.resourceType,
      operation,
      version: entry.version,
      method: operation === 'create' ? 'POST' : entry.updateMethod,
      route: operation === 'create' ? entry.collection : `${entry.collection}/{id}`,
      assign: `POST ${entry.collection}/{id}/assign`,
      permission: entry.permission,
      docs: entry.docs[operation],
    })))),
  });
}

// ======================================================= Wave 2 IDO records
//
// Intune types written through the writer registry (engine/restore/
// recordWriter.mjs), not the built-in applyIntuneWrite branch above:
//
//  - app protection (managedAppPolicy, by subtype: iOS and Android) and app
//    configuration (targetedManagedAppConfiguration for managed apps,
//    mobileAppConfiguration for managed devices): create, update, delete. A
//    protection or managed-app configuration is created only when the backup
//    holds its target apps, which are written through /targetApps; one created
//    without them would protect nothing. A device app configuration names its
//    apps by id, and each must exist in the target before anything is written.
//  - Windows feature, quality and driver update profiles, assignment filters,
//    scope tags (never the built-in Default tag) and notification message
//    templates with their localized messages (wave 1 CAT-INTUNE, PR #254).
//  - policy delete for the three built-in policy types and the types above
//    that have assignments: a policy that is still assigned is never deleted
//    (removing it would unprotect every device it applies to); its assignments
//    must be removed first, by hand.
//
// Assignments are written with the policy through /assign when a restore
// attaches the backup's assignment read (resource.assignments), exactly as for
// the built-in types. Secrets and credential profiles are manual, as above.

const APP_POLICY_SERVER_FIELDS = ['apps', 'assignments', 'deploymentSummary', 'deployedAppCount', 'isAssigned', 'version'];
const UPDATE_PROFILE_SERVER_FIELDS = ['assignments', 'deployableContentDisplayName', 'endOfSupportDate', 'releaseDateDisplayText',
  'deviceReporting', 'newUpdates', 'inventorySyncStatus', 'driverInventories'];

/** App protection subtypes with a write route; anything else in the shared list is manual. */
export const APP_PROTECTION_COLLECTIONS = Object.freeze({
  iosManagedAppProtection: '/deviceAppManagement/iosManagedAppProtections',
  androidManagedAppProtection: '/deviceAppManagement/androidManagedAppProtections',
});

const appIdentity = (app) => JSON.stringify(normalised(withoutAnnotations(app?.mobileAppIdentifier ?? null)));
const appSet = (apps) => new Set((apps ?? []).map(appIdentity));

/** The /targetApps body for a policy's apps. */
export function targetAppsBody(payload) {
  const body = {
    apps: (payload?.apps ?? []).map((app) => ({
      '@odata.type': '#microsoft.graph.managedMobileApp',
      mobileAppIdentifier: withoutAnnotations({ ...(app?.mobileAppIdentifier ?? {}), '@odata.type': app?.mobileAppIdentifier?.['@odata.type'] }),
      ...(app?.version ? { version: app.version } : {}),
    })),
  };
  if (payload?.appGroupType) body.appGroupType = payload.appGroupType;
  return body;
}

function secretRefusal(resource, verb) {
  if (verb === 'delete') return null;
  const payload = resource.payload;
  const subtype = credentialSubtype(payload);
  if (subtype) {
    return { outcome: 'skipped', reason: `manual: this is a ${subtype} profile, which carries credentials or certificates Graph never returns; restore it by hand so nothing is written as a blank` };
  }
  const secrets = intuneSecretFields(payload);
  if (secrets.length > 0) {
    return { outcome: 'skipped', reason: `manual: the policy holds values Graph never returns (passwords, keys, certificates or encrypted settings) at ${secrets.join(', ')}; restore it by hand so they are never written as blanks` };
  }
  return null;
}

/** Managed-app policies (protection, configuration) need their apps to be created. */
function managedAppRefusal(resource, verb) {
  const secret = secretRefusal(resource, verb);
  if (secret) return secret;
  if (verb === 'create' && !Array.isArray(resource.payload?.apps)) {
    return {
      outcome: 'failed',
      reason: 'the backup does not hold this policy\'s target apps, and a policy created without them protects nothing; take a new backup that reads its apps, then restore',
    };
  }
  return null;
}

/** Writes a managed-app policy's apps when they differ (always on create). */
async function targetAppsAfterWrite(io, { payload, verb, targetId, live, resource }) {
  const out = { changes: {} };
  if (Array.isArray(payload?.apps)) {
    const path = `${recordObjectPath(resource.record, payload, targetId)}`;
    const current = verb === 'create' ? new Set() : appSet((await io.retryOperation(() => io.writer.read('v1.0', `${path}?$expand=apps`)))?.body?.apps);
    const want = appSet(payload.apps);
    if (verb === 'create' || current.size !== want.size || [...want].some((app) => !current.has(app))) {
      const result = await io.retryOperation(() => io.writer.write('v1.0', `${path}/targetApps`, { method: 'POST', body: targetAppsBody(payload) }));
      if (!result.ok) return { error: `writing the policy's target apps failed: ${outcomeDetail(result)}` };
      const check = await readUntil(io, 'v1.0', `${path}?$expand=apps`, (r) => recordNotFound(r)
        || (r?.ok === true && !sameApps(appSet(r.body?.apps), want)), io.readOptions);
      if (check?.ok !== true || !sameApps(appSet(check.body?.apps), want)) return { error: 'post-state: the target apps did not read back as written' };
      out.changes.apps = 'written';
    }
  }
  const assigned = await assignmentsAfterWrite(io, { payload, verb, targetId, live, resource });
  if (assigned?.error) return assigned;
  if (assigned?.changes) Object.assign(out.changes, assigned.changes);
  return out;
}

const sameApps = (left, right) => left.size === right.size && [...left].every((app) => right.has(app));

/**
 * Writes a policy's assignments through /assign when the restore attached the
 * backup's assignment read and it differs from live; otherwise leaves them.
 */
async function assignmentsAfterWrite(io, { payload, verb, targetId, resource }) {
  const record = resource.record;
  if (!record.assignmentType) return null;
  const plan = assignmentPlan(resource, (symbol) => {
    const result = resolveSymbol(symbol, resource.referenceContext ?? { targetIndex: new Map(), mappingTable: new Map(), runProvenance: new Map() });
    if (!result.resolved || result.via === 'global-constant') return null;
    return result.stale ? { stale: true } : result.targetId;
  });
  if (plan.state === 'not-observed') return { changes: { assignments: plan.reason } };
  if (plan.state === 'refused') return { error: plan.reason };
  for (const filterId of plan.filters) {
    const found = await io.retryOperation(() => io.writer.read('beta', ASSIGNMENT_FILTER_PATH(filterId)));
    if (found?.ok !== true) return { error: `dependency: an assignment filter this policy uses ${recordNotFound(found) ? 'does not exist in the target' : 'could not be read'}` };
  }
  const base = recordObjectPath(record, payload, targetId);
  let current = new Set();
  if (verb !== 'create') {
    const listed = await io.retryOperation(() => io.writer.read(record.version, `${base}/assignments`));
    if (listed?.ok !== true) return { error: 'the policy\'s live assignments could not be read, so they were not changed' };
    current = liveAssignmentIdentities(listed.body?.value ?? []);
  }
  if (sameIdentities(plan.identities, current)) return { changes: { assignments: 'already as in the backup' } };
  const body = { assignments: plan.assignments.map((assignment) => ({ '@odata.type': record.assignmentType, ...assignment })) };
  const result = await io.retryOperation(() => io.writer.write(record.version, `${base}/assign`, { method: 'POST', body }));
  if (!result.ok) return { error: `assigning the policy failed: ${outcomeDetail(result)}` };
  const check = await readUntil(io, record.version, `${base}/assignments`, (r) => recordNotFound(r)
    || (r?.ok === true && !sameIdentities(plan.identities, liveAssignmentIdentities(r.body?.value ?? []))), io.readOptions);
  if (check?.ok !== true || !sameIdentities(plan.identities, liveAssignmentIdentities(check.body?.value ?? []))) {
    return { error: 'post-state: the assignments did not read back as written' };
  }
  return { changes: { assignments: 'written' } };
}

/** A device app configuration's apps must exist in the target (by id). */
async function mobileAppsExist(io, { payload }) {
  for (const appId of payload?.targetedMobileApps ?? []) {
    const found = await io.retryOperation(() => io.writer.read('v1.0', `/deviceAppManagement/mobileApps/${encodeURIComponent(appId)}?$select=id`));
    if (found?.ok !== true) return `the app ${appId} this configuration targets ${recordNotFound(found) ? 'does not exist in the target' : 'could not be read'}`;
  }
  return null;
}

/** A policy that is still assigned is never deleted. */
async function unassignedDeleteGuard(io, { resource, path }) {
  const listed = await io.retryOperation(() => io.writer.read(resource.record.version, `${path}/assignments`));
  if (listed?.ok !== true) return `manual: the policy's assignments could not be read (${outcomeDetail(listed)}), so it is not deleted`;
  const count = (listed.body?.value ?? []).length;
  if (count > 0) {
    return `manual: the policy is assigned (${count} assignment${count === 1 ? '' : 's'}), and deleting it would unprotect every device it applies to; remove its assignments by hand, then restore again`;
  }
  return null;
}

/** Localized messages of a notification template: added or updated by locale, never removed. */
async function localizedMessagesAfterWrite(io, { payload, verb, targetId, live }) {
  if (!Array.isArray(payload?.localizedNotificationMessages)) return null;
  const base = `/deviceManagement/notificationMessageTemplates/${encodeURIComponent(targetId)}/localizedNotificationMessages`;
  const fieldsOf = (message) => ({ locale: message.locale, subject: message.subject, messageTemplate: message.messageTemplate, isDefault: message.isDefault ?? false });
  const have = new Map((verb === 'create' ? [] : live?.localizedNotificationMessages ?? []).map((message) => [lower(message.locale), message]));
  const written = [];
  for (const message of payload.localizedNotificationMessages) {
    const want = fieldsOf(message);
    const current = have.get(lower(message.locale));
    if (current && sameValue(fieldsOf(current), want)) continue;
    const request = current
      ? { path: `${base}/${encodeURIComponent(current.id)}`, method: 'PATCH', body: { subject: want.subject, messageTemplate: want.messageTemplate, isDefault: want.isDefault } }
      : { path: base, method: 'POST', body: want };
    const result = await io.retryOperation(() => io.writer.write('v1.0', request.path, { method: request.method, body: request.body }));
    if (!result.ok) return { error: `writing the ${message.locale} message failed: ${outcomeDetail(result)}` };
    written.push(message.locale);
  }
  if (written.length === 0) return null;
  const check = await io.retryOperation(() => io.writer.read('v1.0', base));
  const got = new Map((check?.body?.value ?? []).map((message) => [lower(message.locale), fieldsOf(message)]));
  const wrong = payload.localizedNotificationMessages.filter((message) => !sameValue(got.get(lower(message.locale)), fieldsOf(message))).map((message) => message.locale);
  if (check?.ok !== true || wrong.length > 0) return { error: `post-state: the ${wrong.join(', ') || 'localized'} messages did not read back as written` };
  return { changes: { localizedMessages: written } };
}

const lower = (value) => String(value ?? '').toLowerCase();

function builtInScopeTag(resource, verb) {
  const payload = verb === 'delete' ? resource.live?.payload ?? resource.payload : resource.payload;
  if (payload?.isBuiltIn === true || String(payload?.id) === '0') {
    return { outcome: 'skipped', reason: 'built-in: the Default scope tag exists in every tenant and is never written' };
  }
  return null;
}

const DELETE_POLICY = { deleteGuard: unassignedDeleteGuard };

/** The Wave 2 Intune records (resourceType -> record). */
export const INTUNE_EXTENDED_RECORDS = Object.freeze({
  // Delete only: create and update stay on the built-in path above.
  ...Object.fromEntries(Object.values(INTUNE_RECORDS).map((entry) => [entry.resourceType, defineRecord({
    resourceType: entry.resourceType, version: entry.version, collection: entry.collection, operations: ['delete'],
    permission: entry.permission, ...DELETE_POLICY,
  })])),
  managedAppPolicy: defineRecord({
    resourceType: 'managedAppPolicy', version: 'v1.0', odataType: 'required', operations: ['create', 'update', 'delete'],
    collectionFor: (payload) => APP_PROTECTION_COLLECTIONS[stripGraph(payload?.['@odata.type'])] ?? null,
    excluded: APP_POLICY_SERVER_FIELDS, refusal: managedAppRefusal, afterWrite: targetAppsAfterWrite,
    assignmentType: '#microsoft.graph.targetedManagedAppPolicyAssignment', permission: 'DeviceManagementApps.ReadWrite.All', ...DELETE_POLICY,
  }),
  targetedManagedAppConfiguration: defineRecord({
    resourceType: 'targetedManagedAppConfiguration', version: 'v1.0', collection: '/deviceAppManagement/targetedManagedAppConfigurations',
    operations: ['create', 'update', 'delete'], excluded: APP_POLICY_SERVER_FIELDS, refusal: managedAppRefusal, afterWrite: targetAppsAfterWrite,
    assignmentType: '#microsoft.graph.targetedManagedAppPolicyAssignment', permission: 'DeviceManagementApps.ReadWrite.All', ...DELETE_POLICY,
  }),
  mobileAppConfiguration: defineRecord({
    resourceType: 'mobileAppConfiguration', version: 'v1.0', collection: '/deviceAppManagement/mobileAppConfigurations', odataType: 'required',
    operations: ['create', 'update', 'delete'], excluded: ['assignments', 'deviceStatuses', 'userStatuses', 'deviceStatusSummary', 'userStatusSummary', 'version'],
    refusal: secretRefusal, preflight: mobileAppsExist, afterWrite: assignmentsAfterWrite,
    assignmentType: '#microsoft.graph.managedDeviceMobileAppConfigurationAssignment', permission: 'DeviceManagementApps.ReadWrite.All', ...DELETE_POLICY,
  }),
  ...Object.fromEntries(['windowsFeatureUpdateProfile', 'windowsQualityUpdateProfile', 'windowsDriverUpdateProfile'].map((resourceType) => [resourceType, defineRecord({
    resourceType, version: 'beta', collection: `/deviceManagement/${resourceType}s`, operations: ['create', 'update', 'delete'],
    excluded: UPDATE_PROFILE_SERVER_FIELDS, permission: 'DeviceManagementConfiguration.ReadWrite.All', ...DELETE_POLICY,
  })])),
  assignmentFilter: defineRecord({
    resourceType: 'assignmentFilter', version: 'beta', collection: '/deviceManagement/assignmentFilters', operations: ['create', 'update'],
    createOnly: ['platform'], excluded: ['payloads'], permission: 'DeviceManagementConfiguration.ReadWrite.All',
  }),
  roleScopeTag: defineRecord({
    resourceType: 'roleScopeTag', version: 'beta', collection: '/deviceManagement/roleScopeTags', operations: ['create', 'update'],
    excluded: ['isBuiltIn', 'assignments'], refusal: builtInScopeTag, permission: 'DeviceManagementRBAC.ReadWrite.All',
  }),
  notificationMessageTemplate: defineRecord({
    resourceType: 'notificationMessageTemplate', version: 'v1.0', collection: '/deviceManagement/notificationMessageTemplates',
    readQuery: '$expand=localizedNotificationMessages', operations: ['create', 'update'], excluded: ['localizedNotificationMessages'],
    afterWrite: localizedMessagesAfterWrite, permission: 'DeviceManagementServiceConfig.ReadWrite.All',
  }),
});

/** Intune types read in wave 1 that no record can write in full, and why. */
export const INTUNE_BEST_EFFORT = Object.freeze({
  deviceManagementScript: 'the script body is returned only by a per-script read that is not backed up',
  deviceShellScript: 'the script body is returned only by a per-script read that is not backed up',
  deviceHealthScript: 'the detection and remediation script bodies are returned only by a per-script read that is not backed up',
  deviceComplianceScript: 'the detection script body is returned only by a per-script read that is not backed up',
  groupPolicyConfiguration: 'each setting\'s presentation values are on a per-setting route that is not backed up',
  groupPolicyUploadedDefinitionFile: 'the ADMX and ADML file content is returned only per file and is not backed up',
  windowsAutopilotDeviceIdentity: 'the hardware hash is never returned; a device is re-imported from the device itself',
  deviceManagementRoleAssignment: 'it grants Intune admin access to groups by id; remapping them is not qualified',
});

/** One write of a Wave 2 Intune record. */
export async function applyIntuneExtendedWrite(writer, resource, verb, ctx = {}) {
  const record = INTUNE_EXTENDED_RECORDS[resource.resourceType];
  if (!record) return { failed: { naturalKey: resource.naturalKey, error: `${resource.resourceType} has no Intune record` } };
  // Child steps read the record and the reference context from the resource.
  return applyRecordWrite(writer, record, { ...resource, record, referenceContext: ctx.referenceContext }, verb, ctx);
}

/** (resourceType, operation, path) of every Wave 2 Intune record. */
export function intuneExtendedOperations() {
  return Object.freeze(Object.values(INTUNE_EXTENDED_RECORDS).flatMap((record) => record.operations.map((operation) => Object.freeze({
    resourceType: record.resourceType, operation, path: record.collection ?? '/deviceAppManagement/managedAppPolicies',
  }))));
}

export function buildIntuneExtendedLedger() {
  return Object.freeze({ contractVersion: INTUNE_OPERATIONS_CONTRACT_VERSION, operations: recordLedger(Object.values(INTUNE_EXTENDED_RECORDS)) });
}
