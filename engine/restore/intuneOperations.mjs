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
