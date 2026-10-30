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
import { classifyContentEffects } from '../safety/contentEffects.mjs';
import { classifyWriteOutcome } from './rollbackJournal.mjs';
import { SCRIPT_BODY_FIELDS } from '../safety/scriptBodies.mjs';
import { resolveSymbol } from '../graph/resolver.mjs';
import { appGroupOf, appHasPackage, appKindName, appKindWords } from './intuneAppKinds.mjs';
import { trustSettingIds } from './workloads/writeDeclarations.mjs';
import { appleProfileField, appleProfileTrust, groupPolicyTrustSettings, namedTrustSkip, trustOmaUris } from './namedTrustSettings.mjs';
import {
  applyRecordWrite, defineRecord, holdsNestedTrust, isNotFound as recordNotFound, outcomeDetail, readUntil, recordLedger, recordObjectPath, sameValue, trustFieldStep,
  undoesCreate, wholeReplaceTrustRefusal, withoutTrustFields,
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

/**
 * CLAUDE.md restore-writer rule for settings catalog policies, compliance
 * policies and reusable settings groups: a trust, certificate or sign-in
 * setting is named by its settingDefinitionId value, not a key, so the
 * key-based trust check misses it. These are written whole (PUT), so leaving
 * the setting out would delete it from the tenant: the whole write is a manual
 * step when the backup holds one, or (on update) the live policy does.
 * Returns null or the skipped outcome.
 */
export function trustSettingRefusal(resource, verb) {
  const ids = new Set(trustSettingIds(resource?.payload));
  if (verb === 'update') for (const id of trustSettingIds(resource?.live?.payload)) ids.add(id);
  if (ids.size === 0) return null;
  const fields = [...ids].sort();
  const description = `this policy holds trust, certificate or sign-in settings (${fields.join(', ')}); a restore never writes them, and the policy is written whole, so restore it by hand in the Intune admin center`;
  return {
    outcome: 'skipped',
    reason: `manual: ${description}`,
    // The same manual step as a whole-replace refusal, so the person sees which settings to set by hand.
    completion: Object.freeze([Object.freeze({ kind: 'manual-setting', requirement: 'trustFields', fields: Object.freeze(fields), description })]),
  };
}

/**
 * CLAUDE.md restore-writer rule for custom profiles: a trust, certificate or
 * sign-in setting is named by a value, not a key, so the key-based trust check
 * misses it. In an OMA-URI profile it is an omaUri (or a value naming one); in
 * an Apple custom profile it is a payload in the profile file. Both are
 * written as one list or one file, so leaving one out would delete it from the
 * tenant: the whole write is a manual step when the backup holds one, or (on
 * update) the live profile does. A profile file that cannot be read is manual
 * too, since nothing shows it holds none. Returns null or the skipped outcome.
 */
export function omaTrustRefusal(resource, verb) {
  const payloads = [resource?.payload, ...(verb === 'update' ? [resource?.live?.payload] : [])];
  const names = new Set();
  const unreadable = new Set();
  for (const payload of payloads) {
    for (const uri of trustOmaUris(payload)) names.add(uri);
    const apple = appleProfileTrust(payload);
    for (const name of apple.trust) names.add(name);
    for (const field of apple.unreadable) unreadable.add(field);
  }
  // Without the live profile nothing shows its custom settings hold no trust setting the list would remove.
  const writesWhole = Array.isArray(resource?.payload?.omaSettings) || appleProfileField(resource?.payload) !== null;
  // A live profile read without its file or its custom settings list cannot show the backup's removes no trust setting.
  const liveFileMissing = appleProfileField(resource?.payload) !== null && appleProfileField(resource?.live?.payload) === null;
  const liveListMissing = Array.isArray(resource?.payload?.omaSettings) && !Array.isArray(resource?.live?.payload?.omaSettings);
  if (names.size === 0 && unreadable.size === 0 && verb === 'update' && writesWhole && (!resource?.live?.payload || liveFileMissing || liveListMissing)) {
    return namedTrustSkip([], () => 'the live profile was not read, so nothing shows its custom settings hold no trust, certificate or sign-in setting the restore would remove; restore the profile by hand in the Intune admin center');
  }
  if (names.size === 0 && unreadable.size > 0) {
    return namedTrustSkip(unreadable, (fields) => `the profile file (${fields}) could not be read, so nothing shows it holds no trust, certificate or sign-in setting; restore the profile by hand in the Intune admin center`);
  }
  if (names.size === 0) return null;
  return namedTrustSkip(names, (list) => `this profile holds custom settings for trust, certificates or sign-in (${list}); a restore never writes them, and the custom settings are written as one list or file, so restore the profile by hand in the Intune admin center`);
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
  // A trust, certificate or sign-in field is never sent (intuneTrustFieldStep lists it for a person).
  return withoutTrustFields(resourceType, body, verb);
}

/**
 * The refusal of a policy update written whole (PUT) when the backup or the
 * live policy holds a trust, certificate or sign-in setting, or null
 * (recordWriter.mjs wholeReplaceTrustRefusal).
 */
export function intuneReplaceTrustRefusal(resourceType, desired, live) {
  const entry = intuneRecordFor(resourceType);
  if (entry?.updateMethod !== 'PUT') return null;
  return wholeReplaceTrustRefusal(resourceType, {
    // The create body names every field a write can send; an update leaves out one holding a nested trust field.
    payload: desired, live, body: intuneWriteBody(resourceType, desired, 'create'), excluded: entry.excluded,
  });
}

/** The manual step for a policy's trust, certificate or sign-in fields the write leaves out, or null. */
export function intuneTrustFieldStep(resourceType, desired, live, verb) {
  return trustFieldStep(resourceType, desired, live, verb, { excluded: intuneRecordFor(resourceType)?.excluded ?? [] });
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
  return Object.keys(want).filter((key) => !isDeepStrictEqual(normalised(want[key] ?? null), normalised(have[key] ?? null)))
    // A field whose live value holds a nested trust field is never sent on update (see changedRecordFields).
    .filter((key) => verb === 'create' || !holdsNestedTrust(resourceType, live?.[key]));
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
  const trust = trustSettingRefusal(resource, verb);
  if (trust) return trust;
  const oma = omaTrustRefusal(resource, verb);
  if (oma) return oma;
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

const edgeIdentity = (targetType, targetId, filter, extras = '') => `${targetType}|${targetId}|${filter?.id ?? ''}|${filter?.type ?? 'none'}${extras}`;

/**
 * The per-assignment settings a type's /assign body carries besides its target
 * (a remediation's schedule and whether its fix runs), in the comparable form.
 */
function extrasIdentity(attributes, extras) {
  if (!extras || extras.length === 0) return '';
  return extras.map((field) => `|${JSON.stringify(normalised(attributes?.[field] ?? null) ?? null)}`).join('');
}

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
export function assignmentPlan(resource, resolve, { extras = [] } = {}) {
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
    identities.add(edgeIdentity(targetType, targetId, filter, extrasIdentity(attributes, extras)));
    const item = { target: body };
    for (const field of extras) {
      if (attributes[field] !== undefined && attributes[field] !== null) item[field] = withoutAnnotations(attributes[field]);
    }
    assignments.push(item);
  }
  if (problems.length > 0) {
    return { state: 'refused', reason: `assignments cannot be restored: ${[...new Set(problems)].join('; ')}. Nothing was written for this policy` };
  }
  assignments.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { state: 'ready', assignments, identities, filters: [...filters].sort() };
}

const UNREAD_ASSIGNMENTS = Object.freeze({
  absent: 'the backup did not read who it is assigned to',
  failed: 'the backup could not read who it is assigned to',
  partial: 'the backup read only some of its assignments',
  unsupported: 'the backup cannot read the assignments of this kind',
});

/**
 * Issue #546: a policy whose backup holds no complete read of its assignments
 * keeps whatever assignments it has live, so a restore can leave it on the
 * wrong groups. That is a step for a person on that object, in the dry run and
 * in the restore result, never a silent "applied". Null when the assignments
 * were read in full, when the restore did not look at them (not a selection
 * restore), and for a kind with no assignments.
 */
export function unreadAssignmentsStep(resource) {
  if (!writesIntuneAssignments(resource?.resourceType) || resource.verb === 'delete') return null;
  // Batch 18: app assignments a restore holds back, shown in the dry run too.
  const held = resource.resourceType === 'mobileApp' && (resource.verb === 'create' || resource.verb === 'update') ? appAssignmentHold(resource, resource.verb, resource.live?.payload) : null;
  if (held) return held.step;
  const desired = resource.assignments;
  if (!desired || isComplete(desired.outcome)) return null;
  // The default Company Portal branding applies to every user and has none.
  if (resource.resourceType === 'intuneBrandingProfile' && isDefaultBranding(resource.payload)) return null;
  const why = UNREAD_ASSIGNMENTS[desired.outcome] ?? `the backup's read of its assignments was ${desired.outcome ?? 'not recorded'}`;
  return Object.freeze({
    kind: 'integration',
    requirement: 'assignments',
    description: `Assignments not restored: ${why}, so ${resource.verb === 'create' ? 'it is not assigned to anyone yet' : 'the groups it applies to were left as they are'}. Check its assignments in the Intune admin center and set them by hand`,
  });
}

/** The comparable identities of live assignments (Graph's /assignments items or observed edges). */
export function liveAssignmentIdentities(items, { observed = false, extras = [] } = {}) {
  const identities = new Set();
  for (const item of items ?? []) {
    const edge = observed ? item : projectAssignment(item);
    if (!edge) continue;
    const targetType = edge.attributes?.targetType ?? edge.edgeKey?.split('|')[0] ?? null;
    identities.add(edgeIdentity(targetType, String(edge.targetId).toLowerCase(), filterOf(edge.attributes), extrasIdentity(edge.attributes, extras)));
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
 * How a type's assignments are written through /assign, or null when they are
 * not: the built-in policy types, and the Wave 2 records that name an
 * `assignmentType`. `bodyKey` is the /assign body's list (scripts use their
 * own name for it); `extras` are the per-assignment fields sent besides the target.
 */
export function assignmentWriteFor(resourceType) {
  const entry = INTUNE_RECORDS[resourceType]
    ?? (INTUNE_EXTENDED_RECORDS[resourceType]?.assignmentType ? INTUNE_EXTENDED_RECORDS[resourceType] : null);
  if (!entry?.assignmentType) return null;
  return { assignmentType: entry.assignmentType, bodyKey: entry.assignmentBodyKey ?? 'assignments', extras: entry.assignmentExtras ?? [] };
}

/** Whether a restore attaches and writes a type's assignments. */
export const writesIntuneAssignments = (resourceType) => assignmentWriteFor(resourceType) !== null;

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
    if (!writesIntuneAssignments(resource.resourceType) || resource.verb === 'delete') return resource;
    const { extras } = assignmentWriteFor(resource.resourceType);
    const key = `${resource.naturalKey}|assignment`;
    const want = desired?.get(key);
    if (!want) return { ...resource, assignments: { outcome: 'absent', targets: [] } };
    const observed = live.get(key);
    const liveCount = observed && isComplete(observed.outcome) ? liveAssignmentIdentities(observed.targets, { observed: true, extras }).size : null;
    const attached = { ...resource, assignments: { outcome: want.outcome, targets: want.targets } };
    // Batch 18: app assignments the restore holds back are never written, so they reach no one.
    const held = resource.resourceType === 'mobileApp' && appAssignmentHold(attached, resource.verb === 'noop' ? 'update' : resource.verb, resource.live?.payload);
    const reach = held ? [] : newAssignmentReach(attached, observed, resolve, extras);
    const withAssignments = {
      ...attached,
      ...(liveCount === null ? {} : { liveAssignmentCount: liveCount }),
      // Nothing is written when the plan is not ready, so it reaches no one new.
      newAssignments: reach ?? [],
    };
    if (resource.verb !== 'noop' || resource.live?.state !== 'present') return withAssignments;
    const plan = assignmentPlan(withAssignments, resolve, { extras });
    let reason = null;
    if (plan.state === 'refused') reason = plan.reason;
    else if (plan.state === 'ready' && liveCount !== null
      && !sameIdentities(plan.identities, liveAssignmentIdentities(observed.targets, { observed: true, extras }))) {
      reason = `assignments differ: ${assignmentChange(plan, liveCount)}`;
    }
    if (!reason) return withAssignments;
    const promoted = { ...withAssignments, verb: 'update', verbReason: reason };
    return recoveryFor ? { ...promoted, recovery: recoveryFor(promoted) } : promoted;
  });
}

const EXCLUSION = 'exclusionGroupAssignmentTarget';
const targetTypeOf = (identity) => identity.split('|')[0];

/** A target in plain words for the people who review the restore: the group's key, or the kind of target. */
function targetLabel(targetType, key, attributes, extras) {
  const base = GROUP_TARGETS.has(targetType) ? (key ?? 'a group not in the backup') : ({
    allLicensedUsersAssignmentTarget: 'all users', allDevicesAssignmentTarget: 'all devices',
  }[targetType] ?? targetType ?? 'a target of unknown kind');
  const filter = filterOf(attributes);
  const details = [
    ...(filter ? [`with an assignment filter (${filter.type})`] : []),
    ...extras.filter((field) => attributes?.[field] !== undefined && attributes?.[field] !== null)
      .map((field) => `${field}: ${JSON.stringify(withoutAnnotations(attributes[field]))}`),
  ];
  return details.length ? `${base}, ${details.join(', ')}` : base;
}

/**
 * Issue #461: who a restore's assignment write reaches that the object does not
 * reach now, in plain words, sorted; null when no assignments are written. A new
 * include target (or the same one with its remediation fix turned on; a schedule,
 * or a fix turned off, alone never counts) counts, and so does a live exclusion the backup does not have.
 * An added exclusion only narrows, so it never counts. When the live assignments
 * were not read (a create, or a read that did not complete), every include target
 * counts: the safe direction. The content-effect review (engine/safety/
 * contentEffects.mjs) judges an object that reaches new devices as if it were new.
 */
export function newAssignmentReach(resource, observed, resolve, assignmentExtras = []) {
  // When a script runs is not who it reaches: a schedule alone never counts,
  // nor do an app assignment's notification and delivery settings (batch 18).
  const extras = assignmentExtras.filter((field) => field !== 'runSchedule' && field !== 'settings');
  const plan = assignmentPlan(resource, resolve, { extras });
  if (plan.state !== 'ready') return null;
  const liveEdges = resource.live?.state === 'present' && observed && isComplete(observed.outcome) ? (observed.targets ?? []) : null;
  const liveIdentities = liveEdges === null ? new Set() : liveAssignmentIdentities(liveEdges, { observed: true, extras });
  // The same targets without their settings: a fix turned off reaches no one new.
  const liveTargets = liveEdges === null ? new Set() : liveAssignmentIdentities(liveEdges, { observed: true });
  const reach = new Set();
  for (const target of resource.assignments.targets ?? []) {
    const single = { assignments: { outcome: resource.assignments.outcome, targets: [target] } };
    const [identity] = assignmentPlan(single, resolve, { extras }).identities ?? [];
    if (!identity || targetTypeOf(identity) === EXCLUSION || liveIdentities.has(identity)) continue;
    const attributes = target.attributes ?? {};
    const [bare] = assignmentPlan(single, resolve).identities ?? [];
    if (attributes.runRemediationScript !== true && liveTargets.has(bare)) continue;
    reach.add(targetLabel(attributes.targetType ?? null, target.targetNaturalKey ?? null, attributes, extras));
  }
  for (const edge of liveEdges ?? []) {
    const [identity] = liveAssignmentIdentities([edge], { observed: true, extras });
    if (!identity || targetTypeOf(identity) !== EXCLUSION || plan.identities.has(identity)) continue;
    reach.add(`no longer excluded: ${targetLabel(EXCLUSION, edge.targetNaturalKey ?? edge.targetId ?? null, edge.attributes, [])}`);
  }
  return [...reach].sort();
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
    // Windows app protection (batch 12) lives on beta only; the others on v1.0.
    const version = resource.record.version ?? 'v1.0';
    const current = verb === 'create' ? new Set() : appSet((await io.retryOperation(() => io.writer.read(version, `${path}?$expand=apps`)))?.body?.apps);
    const want = appSet(payload.apps);
    if (verb === 'create' || current.size !== want.size || [...want].some((app) => !current.has(app))) {
      const result = await io.retryOperation(() => io.writer.write(version, `${path}/targetApps`, { method: 'POST', body: targetAppsBody(payload) }));
      if (!result.ok) return { error: `writing the policy's target apps failed: ${outcomeDetail(result)}` };
      const check = await readUntil(io, version, `${path}?$expand=apps`, (r) => recordNotFound(r)
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

/**
 * Where a policy's live assignments are read, and the items of that read
 * (null when the read holds no list). Custom attribute scripts have no
 * /assignments route (issue #546), so the script is read with them expanded.
 */
const assignmentsListPath = (record, base) => (record.assignmentsRead === 'expand' ? `${base}?$expand=assignments` : `${base}/assignments`);
function liveAssignmentItems(record, read) {
  if (record.assignmentsRead === 'expand' && read?.body?.['assignments@odata.nextLink']) return null; // a paged list is not all of it
  const items = record.assignmentsRead === 'expand' ? read?.body?.assignments : (read?.body?.value ?? []);
  return Array.isArray(items) ? items : null;
}

const sameApps = (left, right) => left.size === right.size && [...left].every((app) => right.has(app));

/**
 * Writes a policy's assignments through /assign when the restore attached the
 * backup's assignment read and it differs from live; otherwise leaves them.
 */
async function assignmentsAfterWrite(io, { payload, verb, targetId, resource }) {
  const record = resource.record;
  if (!record.assignmentType) return null;
  const extras = record.assignmentExtras ?? [];
  const plan = assignmentPlan(resource, (symbol) => {
    const result = resolveSymbol(symbol, resource.referenceContext ?? { targetIndex: new Map(), mappingTable: new Map(), runProvenance: new Map() });
    if (!result.resolved || result.via === 'global-constant') return null;
    return result.stale ? { stale: true } : result.targetId;
  }, { extras });
  if (plan.state === 'not-observed') return { changes: { assignments: plan.reason } };
  if (plan.state === 'refused') return { error: plan.reason };
  for (const filterId of plan.filters) {
    const found = await io.retryOperation(() => io.writer.read('beta', ASSIGNMENT_FILTER_PATH(filterId)));
    if (found?.ok !== true) return { error: `dependency: an assignment filter this policy uses ${recordNotFound(found) ? 'does not exist in the target' : 'could not be read'}` };
  }
  const base = recordObjectPath(record, payload, targetId);
  if (record.assignmentWrite === 'per-item') return perItemAssignments(io, { record, base, verb, plan, extras });
  let current = new Set();
  if (verb !== 'create') {
    const listed = await io.retryOperation(() => io.writer.read(record.version, assignmentsListPath(record, base)));
    const items = liveAssignmentItems(record, listed);
    if (listed?.ok !== true || !items) return { error: 'the policy\'s live assignments could not be read, so they were not changed' };
    current = liveAssignmentIdentities(items, { extras });
  }
  if (sameIdentities(plan.identities, current)) return { changes: { assignments: 'already as in the backup' } };
  // Most kinds take /assign; a policy set takes its assignments through its
  // update action (batch 16), with empty item lists so its items stay.
  const body = {
    ...(record.assignmentBodyBase ?? {}),
    [record.assignmentBodyKey ?? 'assignments']: plan.assignments.map((assignment) => ({ '@odata.type': record.assignmentType, ...assignment })),
  };
  const result = await io.retryOperation(() => io.writer.write(record.version, `${base}/${record.assignmentAction ?? 'assign'}`, { method: 'POST', body }));
  if (!result.ok) return { error: `assigning the policy failed: ${outcomeDetail(result)}` };
  const readBack = (r) => liveAssignmentIdentities(liveAssignmentItems(record, r) ?? [], { extras });
  const check = await readUntil(io, record.version, assignmentsListPath(record, base), (r) => recordNotFound(r)
    || (r?.ok === true && !sameIdentities(plan.identities, readBack(r))), io.readOptions);
  if (check?.ok !== true || !liveAssignmentItems(record, check) || !sameIdentities(plan.identities, readBack(check))) {
    return { error: 'post-state: the assignments did not read back as written' };
  }
  return { changes: { assignments: 'written' } };
}

/**
 * Assignments written one by one (Autopilot profiles, restore gaps batch 15):
 * Graph has no /assign action for them, so each missing assignment is POSTed
 * to .../assignments and each one not in the backup is deleted by its id,
 * then the list is read back.
 */
async function perItemAssignments(io, { record, base, verb, plan, extras }) {
  const wanted = new Map(plan.assignments.map((assignment, index) => [
    [...liveAssignmentIdentities([assignment], { extras })][0] ?? `unknown-${index}`, assignment,
  ]));
  let liveItems = [];
  if (verb !== 'create') {
    const listed = await io.retryOperation(() => io.writer.read(record.version, `${base}/assignments`));
    if (listed?.ok !== true) return { error: 'the profile\'s live assignments could not be read, so they were not changed' };
    liveItems = listed.body?.value ?? [];
  }
  const current = liveAssignmentIdentities(liveItems, { extras });
  if (sameIdentities(plan.identities, current)) return { changes: { assignments: 'already as in the backup' } };
  const extra = liveItems.filter((item) => {
    const identity = [...liveAssignmentIdentities([item], { extras })][0];
    return identity === undefined || !plan.identities.has(identity);
  });
  for (const item of extra) {
    if (typeof item?.id !== 'string' || item.id.length === 0) return { error: 'a live assignment has no id, so it could not be removed' };
    const removed = await io.retryOperation(() => io.writer.write(record.version, `${base}/assignments/${encodeURIComponent(item.id)}`, { method: 'DELETE' }));
    if (!removed.ok && !recordNotFound(removed)) return { error: `removing an assignment that is not in the backup failed: ${outcomeDetail(removed)}` };
  }
  for (const [identity, assignment] of wanted) {
    if (current.has(identity)) continue;
    const added = await io.retryOperation(() => io.writer.write(record.version, `${base}/assignments`, {
      method: 'POST', body: { '@odata.type': record.assignmentType, ...assignment },
    }));
    if (!added.ok) return { error: `assigning the profile failed: ${outcomeDetail(added)}` };
  }
  const check = await readUntil(io, record.version, `${base}/assignments`, (r) => recordNotFound(r)
    || (r?.ok === true && !sameIdentities(plan.identities, liveAssignmentIdentities(r.body?.value ?? [], { extras }))), io.readOptions);
  if (check?.ok !== true || !sameIdentities(plan.identities, liveAssignmentIdentities(check.body?.value ?? [], { extras }))) {
    return { error: 'post-state: the assignments did not read back as written' };
  }
  return { changes: { assignments: { removed: extra.length, added: [...wanted.keys()].filter((identity) => !current.has(identity)).length } } };
}

/** A device app configuration's apps must exist in the target (by id). */
async function mobileAppsExist(io, { payload }) {
  for (const appId of payload?.targetedMobileApps ?? []) {
    const found = await io.retryOperation(() => io.writer.read('v1.0', `/deviceAppManagement/mobileApps/${encodeURIComponent(appId)}?$select=id`));
    if (found?.ok !== true) return `the app ${appId} this configuration targets ${recordNotFound(found) ? 'does not exist in the target' : 'could not be read'}`;
  }
  return null;
}

/**
 * A policy that is still assigned is never deleted, with one exception: the
 * undo of a restore that created it, when the person planning the undo chose
 * to delete it with its assignments (compensation.mjs applyUndoChoices). Then
 * the live assignments must still be exactly the ones that choice named;
 * removeChosenAssignments takes them off just before the delete.
 */
async function unassignedDeleteGuard(io, { resource, path }) {
  const listed = await io.retryOperation(() => io.writer.read(resource.record.version, `${path}/assignments`));
  if (listed?.ok !== true) return `manual: the policy's assignments could not be read (${outcomeDetail(listed)}), so it is not deleted`;
  const items = listed.body?.value ?? [];
  const count = items.length;
  if (count === 0) return null;
  const chosen = chosenAssignmentIds(resource);
  if (chosen) {
    if (listed.body?.['@odata.nextLink']) return 'manual: the policy has more assignments than one read returns, so it is not deleted; remove them by hand';
    // The full assignments are journaled with the delete, so they can be put back by hand.
    if (sameIdList(items.map((item) => item?.id), chosen)) return { prior: { assignments: items } };
    return `manual: the policy's assignments changed after you chose to delete it with its ${chosen.length} assignment${chosen.length === 1 ? '' : 's'} (it has ${count} now), so it is not deleted; plan the undo again`;
  }
  return `manual: the policy is assigned (${count} assignment${count === 1 ? '' : 's'}), and deleting it would unprotect every device it applies to; remove its assignments by hand, then restore again`;
}

/** The assignment ids an undo was chosen to remove, or null when none was chosen. */
function chosenAssignmentIds(resource) {
  const ids = resource?.removeAssignments?.ids;
  return undoesCreate(resource) && Array.isArray(ids) && ids.length > 0 ? ids : null;
}

const sameIdList = (left, right) => {
  const a = left.map(String).sort();
  const b = right.map(String).sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
};

/**
 * The undo chose to delete an assigned policy: its assignments are taken off
 * through /assign with an empty list (every type with this guard takes it),
 * and read back as none before the policy is deleted.
 */
async function removeChosenAssignments(io, { resource, path }) {
  const chosen = chosenAssignmentIds(resource);
  if (!chosen) return null;
  const { version } = resource.record;
  const result = await io.retryOperation(() => io.writer.write(version, `${path}/assign`, { method: 'POST', body: { assignments: [] } }));
  if (!result.ok) {
    const outcome = classifyWriteOutcome(result);
    const maybe = outcome === 'uncertain' ? ' (Graph gave no clear answer, so they may be removed)' : '';
    return { outcome, changed: outcome === 'uncertain', error: `removing the policy's assignments failed${maybe}, so it was not deleted: ${outcomeDetail(result)}` };
  }
  const check = await readUntil(io, version, `${path}/assignments`, (r) => r?.ok === true && (r.body?.value ?? []).length > 0, io.readOptions);
  if (check?.ok !== true || (check.body?.value ?? []).length > 0) {
    return { outcome: 'uncertain', changed: true, error: 'post-state: Graph accepted removing the policy\'s assignments, but they did not read back as removed, so it was not deleted' };
  }
  return { changes: { assignmentsRemoved: chosen.length } };
}

/**
 * Where the undo of a created policy reads its live assignments, for the types
 * that are never deleted while assigned; null for any other type.
 */
export function undoAssignmentsPath(resourceType, payload, targetId) {
  const record = INTUNE_EXTENDED_RECORDS[resourceType];
  if (record?.deleteGuard !== unassignedDeleteGuard || typeof targetId !== 'string' || targetId.length === 0) return null;
  const path = recordObjectPath(record, payload, targetId);
  return path ? { version: record.version, path: `${path}/assignments` } : null;
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

const DELETE_POLICY = { deleteGuard: unassignedDeleteGuard, beforeDelete: removeChosenAssignments };

// Run results, assignments and Intune's own version bookkeeping: never part of a write body.
const SCRIPT_SERVER_FIELDS = Object.freeze([
  'assignments', 'groupAssignments', 'runSummary', 'deviceRunStates', 'userRunStates', 'isGlobalScript', 'highestAvailableVersion',
]);

/**
 * A script is written only from a backup that holds its body (backups taken
 * before the per-script read hold only its settings), and a remediation
 * Microsoft publishes is never written: it is not tenant configuration.
 */
function scriptRefusal([body]) {
  return (resource, verb, ctx = {}) => {
    const payload = resource.payload ?? {};
    if (payload.isGlobalScript === true || resource.live?.payload?.isGlobalScript === true) {
      return { outcome: 'skipped', reason: 'built-in: Microsoft publishes this remediation in every tenant, so it is never written' };
    }
    if (verb !== 'delete' && (typeof payload[body] !== 'string' || payload[body].length === 0)) {
      return {
        outcome: 'skipped',
        reason: 'manual: this backup holds the script\'s settings but not the script itself (backups before the script read was added), so it is not written; take a new backup, or recreate the script by hand from your own copy',
      };
    }
    return scriptTextUnapproved(resource, verb, ctx);
  };
}

/**
 * PR #435 follow-up: putting back a script's text runs it on every device the script
 * is assigned to, so an update that changes the text, a recreated script the
 * restore assigns, and a script the restore assigns to more devices (issue #461)
 * are written only when the restore's promotion checked a separate approval of
 * exactly that text and those targets (the 'runs-on-devices' content effect). A
 * dry run cannot carry that approval yet, so it simulates the write and lists the
 * effect for review.
 */
function scriptTextUnapproved(resource, verb, { mode, approvedContentEffects = [] } = {}) {
  if (verb === 'delete' || mode === 'dry-run') return null;
  const { effects } = classifyContentEffects([{ ...resource, verb }]);
  const approved = (effect) => (approvedContentEffects ?? []).some((entry) => entry?.effect === effect.effect
    && entry.naturalKey === effect.naturalKey && entry.field === effect.field && entry.before === effect.before && entry.after === effect.after
    && JSON.stringify(entry.newAssignments ?? null) === JSON.stringify(effect.newAssignments ?? null));
  if (effects.every(approved)) return null;
  return {
    outcome: 'skipped',
    reason: 'manual: this puts back the script\'s text, which then runs on every device the script is assigned to, so a second person approves the script first: '
      + 'run the restore as a dry run, have someone other than you approve "Runs on devices" in Approvals, then run it again',
  };
}

// ------------------------------------------ administrative templates (batch 5)

const GROUP_POLICY_DEFINITIONS = 'https://graph.microsoft.com/beta/deviceManagement/groupPolicyDefinitions';
const groupPolicyPath = (targetId) => `/deviceManagement/groupPolicyConfigurations/${encodeURIComponent(targetId)}`;
const definitionIdOf = (setting) => setting?.definition?.id ?? null;
const presentationIdOf = (value) => value?.presentation?.id ?? null;

/** One setting as restore compares it: which setting, on or off, and each value entered. */
export function settingShape(setting) {
  return {
    definition: lower(definitionIdOf(setting)),
    enabled: setting?.enabled === true,
    values: (setting?.presentationValues ?? [])
      .map((value) => ({ presentation: lower(presentationIdOf(value)), kind: stripGraph(value?.['@odata.type']), value: value?.value ?? null, values: withoutAnnotations(value?.values ?? null) }))
      .sort((left, right) => left.presentation.localeCompare(right.presentation)),
  };
}

/** The updateDefinitionValues entry that adds one setting with its values. */
export function addedSetting(setting) {
  const definitionId = definitionIdOf(setting);
  return {
    enabled: setting.enabled === true,
    'definition@odata.bind': `${GROUP_POLICY_DEFINITIONS}('${definitionId}')`,
    presentationValues: (setting.presentationValues ?? []).map((value) => ({
      '@odata.type': value['@odata.type'],
      ...(value.value !== undefined && value.value !== null ? { value: value.value } : {}),
      ...(Array.isArray(value.values) ? { values: withoutAnnotations(value.values) } : {}),
      'presentation@odata.bind': `${GROUP_POLICY_DEFINITIONS}('${definitionId}')/presentations('${presentationIdOf(value)}')`,
    })),
  };
}

/**
 * An administrative template is written only from a backup that holds every
 * setting with the values entered for it (backups before batch 5 hold the
 * settings without their values; backups before issue #472 hold no settings).
 */
function groupPolicyRefusal(resource, verb) {
  if (verb === 'delete') return null;
  const settings = resource.payload?.definitionValues;
  const manual = (why) => ({ outcome: 'skipped', reason: `manual: ${why}, so it is not written; take a new backup, or recreate the template by hand from the backup` });
  if (!Array.isArray(settings)) return manual('this backup does not hold the template\'s settings');
  // Issue #472: a backup whose settings came through $expand=definitionValues
  // holds none, whatever the template had (Graph returns no settings that
  // way), so writing it would remove every setting. Graph marks an expanded
  // list with its own @odata.context; settings read from their own
  // collection carry none.
  if (resource.payload['definitionValues@odata.context'] !== undefined) {
    return manual('this backup was taken before the template\'s settings were read on their own, and may be missing every setting');
  }
  for (const setting of settings) {
    if (!definitionIdOf(setting)) return manual('a setting in this backup does not say which setting it is');
    if (!Array.isArray(setting.presentationValues)) {
      return manual('this backup holds the template\'s settings but not the values entered for them (backups before setting values were read)');
    }
    if (setting.presentationValues.some((value) => !presentationIdOf(value) || typeof value['@odata.type'] !== 'string')) {
      return manual('a value in this backup does not say which field of its setting it fills');
    }
  }
  const backup = groupPolicyTrustSettings(settings);
  if (backup.unknown.length > 0) {
    return manual(`this backup does not say what ${backup.unknown.length === 1 ? 'the setting' : 'the settings'} ${backup.unknown.join(', ')} ${backup.unknown.length === 1 ? 'is' : 'are'}, so ${backup.unknown.length === 1 ? 'it' : 'they'} cannot be checked for trust, certificate or sign-in settings`);
  }
  const live = verb === 'update' ? groupPolicyTrustSettings(resource.live?.payload?.definitionValues).trust : [];
  return groupPolicyTrustRefusal([...backup.trust, ...live]);
}

/**
 * CLAUDE.md restore-writer rule for administrative templates: a setting is
 * named by a GUID definition id, so only its display name and category say it
 * is a trust, certificate or sign-in setting. A restore puts the template's
 * settings back as a set (a live setting not in the backup is removed), so the
 * whole template is a manual step when the backup or the live template holds one.
 */
function groupPolicyTrustRefusal(names) {
  if (names.length === 0) return null;
  return namedTrustSkip(names, (list) => `this template holds trust, certificate or sign-in settings (${list}); a restore never writes them, and the template's settings are written as one set, so restore it by hand in the Intune admin center`);
}

/** On update, the live template's own settings are read: one that is a trust setting makes the write manual. */
async function groupPolicyLiveTrust(io, { verb, targetId }) {
  if (verb !== 'update' || !targetId) return null;
  const read = await readGroupPolicySettings(io, targetId);
  if (read.error) return `${read.error}, so they could not be checked for trust, certificate or sign-in settings`;
  const refusal = groupPolicyTrustRefusal(groupPolicyTrustSettings(read.settings).trust);
  return refusal ? { skipped: refusal.reason, completion: refusal.completion } : null;
}

/** The template's preflights, one after another; the first that finds something stops them. */
async function groupPolicyPreflight(io, step) {
  return (await groupPolicyDefinitionsExist(io, step)) ?? groupPolicyLiveTrust(io, step);
}

/** Every setting a template uses must exist in the target (an imported ADMX file is put back first). */
async function groupPolicyDefinitionsExist(io, { payload }) {
  for (const definitionId of new Set((payload?.definitionValues ?? []).map(definitionIdOf))) {
    const found = await io.retryOperation(() => io.writer.read('beta', `/deviceManagement/groupPolicyDefinitions/${encodeURIComponent(definitionId)}?$select=id`));
    if (found?.ok !== true) {
      return `the setting ${definitionId} this template uses ${recordNotFound(found) ? 'does not exist in the target (it may come from an imported template file that is not there)' : 'could not be read'}`;
    }
  }
  return null;
}

/** A template's live settings, each with its values. */
async function readGroupPolicySettings(io, targetId) {
  const base = `${groupPolicyPath(targetId)}/definitionValues`;
  const listed = await io.retryOperation(() => io.writer.read('beta', `${base}?$expand=definition`));
  if (listed?.ok !== true) return { error: `the template's settings could not be read (${outcomeDetail(listed)})` };
  const settings = [];
  for (const setting of listed.body?.value ?? []) {
    const values = await io.retryOperation(() => io.writer.read('beta', `${base}/${encodeURIComponent(setting.id)}/presentationValues?$expand=presentation`));
    if (values?.ok !== true) return { error: `the values of a setting could not be read (${outcomeDetail(values)})` };
    settings.push({ ...setting, presentationValues: values.body?.value ?? [] });
  }
  return { settings };
}

const settingSet = (settings) => settings.map(settingShape).sort((left, right) => left.definition.localeCompare(right.definition));

/**
 * Puts a template's settings back: a live setting that is not in the backup,
 * or differs from it, is removed, then each backup setting live lacks is
 * added with its values. Two calls, so a setting is never removed and added
 * in the same request.
 */
async function groupPolicySettingsAfterWrite(io, { payload, verb, targetId }) {
  const want = payload.definitionValues;
  let have = [];
  if (verb !== 'create') {
    const read = await readGroupPolicySettings(io, targetId);
    if (read.error) return { error: `${read.error}, so they were not changed` };
    have = read.settings;
  }
  const wantBy = new Map(want.map((setting) => [settingShape(setting).definition, settingShape(setting)]));
  const haveBy = new Map(have.map((setting) => [settingShape(setting).definition, settingShape(setting)]));
  const removed = have.filter((setting) => !sameValue(wantBy.get(settingShape(setting).definition), settingShape(setting)));
  const added = want.filter((setting) => !sameValue(haveBy.get(settingShape(setting).definition), settingShape(setting)));
  if (removed.length === 0 && added.length === 0) return verb === 'create' ? null : { changes: { settings: 'already as in the backup' } };
  const path = `${groupPolicyPath(targetId)}/updateDefinitionValues`;
  for (const body of [
    removed.length > 0 ? { added: [], updated: [], deletedIds: removed.map((setting) => setting.id) } : null,
    added.length > 0 ? { added: added.map(addedSetting), updated: [], deletedIds: [] } : null,
  ].filter(Boolean)) {
    const result = await io.retryOperation(() => io.writer.write('beta', path, { method: 'POST', body }));
    if (!result.ok) return { error: `writing the template's settings failed: ${outcomeDetail(result)}` };
  }
  const check = await readGroupPolicySettings(io, targetId);
  if (check.error || !sameValue(settingSet(check.settings), settingSet(want))) return { error: 'post-state: the template\'s settings did not read back as written' };
  return { changes: { settings: { removed: removed.length, added: added.length } } };
}

/**
 * Script and remediation /assign bodies (beta). Scripts name their list
 * deviceManagementScriptAssignments, remediations and compliance scripts
 * deviceHealthScriptAssignments. Custom attribute scripts (batch 15) use the
 * script list too.
 */
// Graph refuses every script kind (PowerShell, shell, remediation, compliance and
// custom attribute scripts) without this permission; the device configuration
// permission does not cover them (issue #471).
export const SCRIPT_WRITE_PERMISSION = 'DeviceManagementScripts.ReadWrite.All';

const SCRIPT_ASSIGNMENTS = Object.freeze({
  deviceManagementScript: { assignmentType: '#microsoft.graph.deviceManagementScriptAssignment', assignmentBodyKey: 'deviceManagementScriptAssignments' },
  deviceShellScript: { assignmentType: '#microsoft.graph.deviceManagementScriptAssignment', assignmentBodyKey: 'deviceManagementScriptAssignments' },
  deviceHealthScript: {
    assignmentType: '#microsoft.graph.deviceHealthScriptAssignment', assignmentBodyKey: 'deviceHealthScriptAssignments',
    assignmentExtras: ['runRemediationScript', 'runSchedule'],
  },
  deviceComplianceScript: { assignmentType: '#microsoft.graph.deviceHealthScriptAssignment', assignmentBodyKey: 'deviceHealthScriptAssignments' },
  // Batch 15: custom attribute scripts take the same list as other scripts.
  // Issue #546: they have no /assignments route, so they are read expanded.
  deviceCustomAttributeShellScript: {
    assignmentType: '#microsoft.graph.deviceManagementScriptAssignment', assignmentBodyKey: 'deviceManagementScriptAssignments',
    assignmentsRead: 'expand',
  },
});

/**
 * Child writes one after another; the first error stops them, and their
 * changes merge. A step that read the object back passes it on as `live`.
 */
function inOrder(...steps) {
  return async (io, step) => {
    const changes = {};
    let live = null;
    for (const run of steps) {
      const out = await run(io, live ? { ...step, live } : step);
      if (out?.error) return out;
      if (out?.changes) Object.assign(changes, out.changes);
      if (out?.live) live = out.live;
    }
    if (Object.keys(changes).length === 0 && !live) return null;
    return { ...(Object.keys(changes).length > 0 ? { changes } : {}), ...(live ? { live } : {}) };
  };
}

/** The Wave 2 Intune records (resourceType -> record). */
// ------------------------------------------- restore gaps, batch 7

const COMPLIANCE_POLICIES = '/deviceManagement/compliancePolicies';
const COMPLIANCE_EXPAND = '$expand=settings';
// Issue #473: expanded next to the settings, Graph returns the actions for
// noncompliance as an empty list, so they are read from their own collection.
const COMPLIANCE_ACTIONS = 'scheduledActionsForRule?$expand=scheduledActionConfigurations';

/**
 * Whether a backup holds a policy's actions for noncompliance. Graph needs at
 * least the block action, so an empty list means they were not read (backups
 * taken before #473), never that the policy has none.
 */
const holdsComplianceActions = (payload) => Array.isArray(payload?.scheduledActionsForRule) && payload.scheduledActionsForRule.length > 0;

/** The whole policy with its settings; a create also carries its actions for noncompliance. */
function complianceBody(body, { verb, payload }) {
  const out = { ...body, settings: settingsBody(payload?.settings) };
  if (verb === 'create') out.scheduledActionsForRule = scheduledActionsBody(payload?.scheduledActionsForRule);
  return out;
}

/** Settings and actions compare without the ids and annotations Intune adds. */
function sameComplianceField(field, left, right) {
  if (field === 'settings') return sameValue(settingsBody(left), settingsBody(right));
  if (field === 'scheduledActionsForRule') return sameValue(scheduledActionsBody(left), scheduledActionsBody(right));
  return null;
}

/**
 * A compliance policy is written only from a backup that holds all of its
 * settings (the write replaces the whole policy, so a short list deletes
 * settings), and created only with its actions for noncompliance, which Graph
 * needs (at least the block action). Secret settings are never written.
 */
function compliancePolicyRefusal(resource, verb) {
  const payload = resource.payload ?? {};
  const secrets = intuneSecretFields(payload);
  if (secrets.length > 0) {
    return { outcome: 'skipped', reason: `manual: the policy holds values Graph never returns at ${secrets.join(', ')}; restore it by hand so they are never written as blanks` };
  }
  const trust = trustSettingRefusal(resource, verb);
  if (trust) return trust;
  const newBackup = 'take a new backup, then restore';
  if (!Array.isArray(payload.settings)) return { outcome: 'failed', reason: `the backup does not hold this compliance policy's settings; writing it would empty the policy, so ${newBackup}` };
  const count = payload.settingCount;
  if (typeof count === 'number' && payload.settings.length !== count) {
    return { outcome: 'failed', reason: `the backup holds ${payload.settings.length} of this compliance policy's ${count} settings; writing it would delete the rest, so ${newBackup}` };
  }
  const actions = payload.scheduledActionsForRule;
  if (holdsComplianceActions(payload) && !actions.some((rule) => (rule?.scheduledActionConfigurations ?? []).some((action) => action?.actionType === 'block'))) {
    return { outcome: 'failed', reason: 'the backup lists no block action for noncompliance for this compliance policy, and Graph needs one; restore it by hand' };
  }
  if (verb === 'create' && !holdsComplianceActions(payload)) {
    return { outcome: 'failed', reason: `the backup does not hold this compliance policy's actions for noncompliance (backups before they were read), and Graph needs them to create it; ${newBackup}` };
  }
  return null;
}

/**
 * Puts a policy's actions for noncompliance back. A create sent them with the
 * policy, so they are only checked. An update from a backup without them leaves
 * the live actions as they are; otherwise changed actions are replaced through
 * setScheduledActions and read back. The live actions are always read from
 * their own collection (#473).
 */
async function complianceActionsAfterWrite(io, { payload, verb, targetId, live }) {
  if (verb === 'update' && !holdsComplianceActions(payload)) {
    return { changes: { scheduledActions: 'left as they are: the backup was taken before actions for noncompliance were backed up' } };
  }
  const want = scheduledActionsBody(payload.scheduledActionsForRule);
  const path = `${COMPLIANCE_POLICIES}/${encodeURIComponent(targetId)}`;
  const differ = (actions) => !sameValue(want, scheduledActionsBody(actions));
  const actionsOf = (r) => (r?.ok === true && Array.isArray(r.body?.value) ? r.body.value : null);
  const readActions = (isStale) => readUntil(io, 'beta', `${path}/${COMPLIANCE_ACTIONS}`, isStale, io.readOptions);
  const withActions = (actions) => ({ ...live, scheduledActionsForRule: actions });
  // A create waits for its actions to show; an update reads them once.
  const current = await readActions((r) => verb === 'create' && (recordNotFound(r) || (actionsOf(r) !== null && differ(actionsOf(r)))));
  const found = actionsOf(current);
  if (found === null) return { error: `reading the live actions for noncompliance failed: ${outcomeDetail(current)}` };
  if (!differ(found)) return verb === 'create' ? { live: withActions(found) } : { live: withActions(found), changes: { scheduledActions: 'already as in the backup' } };
  if (verb === 'create') return { error: 'post-state: the actions for noncompliance did not read back as written' };
  const result = await io.retryOperation(() => io.writer.write('beta', `${path}/setScheduledActions`, { method: 'POST', body: { scheduledActions: want } }));
  if (!result.ok) return { error: `writing the actions for noncompliance failed: ${outcomeDetail(result)}` };
  const check = await readActions((r) => recordNotFound(r) || (actionsOf(r) !== null && differ(actionsOf(r))));
  const written = actionsOf(check);
  if (written === null || differ(written)) return { error: 'post-state: the actions for noncompliance did not read back as written' };
  return { live: withActions(written), changes: { scheduledActions: 'written' } };
}

// Batch 9: the image fields of a branding profile. The list read returns no
// image bytes, so a backup never holds them.
const BRANDING_PROFILE_IMAGES = Object.freeze(['themeColorLogo', 'lightBackgroundLogo', 'landingPageCustomizedImage']);

const isDefaultBranding = (payload) => payload?.isDefaultProfile === true;

/**
 * The default branding profile reaches every user. Restore gaps batch 17 (the
 * user's OK for tenant-wide settings, 2026-10-22): it is updated in place when
 * the backup and the live profile are both the default. It is never created,
 * and a custom profile never takes the default's place (or the reverse).
 */
function defaultBrandingProfile(resource, verb) {
  const backup = isDefaultBranding(resource.payload);
  const live = isDefaultBranding(resource.live?.payload);
  if (!backup && !live) return null;
  if (verb === 'update' && backup && live) return null;
  if (verb === 'create' && backup) {
    return { outcome: 'skipped', reason: 'manual: the default Company Portal branding is made by Intune and is never created; update the default profile in place from the backup' };
  }
  return { outcome: 'skipped', reason: 'manual: the backup and the live profile disagree on which one is the default Company Portal branding, so neither is written; check it by hand' };
}

/** The default profile applies to every user and has no assignments to write. */
async function brandingAfterWrite(io, step) {
  if (isDefaultBranding(step.payload)) return { changes: { assignments: 'the default profile applies to every user' } };
  return assignmentsAfterWrite(io, step);
}

// Batch 10: an Endpoint analytics baseline Microsoft provides in every tenant.
function builtInBaseline(resource) {
  if (resource.payload?.isBuiltIn === true || resource.live?.payload?.isBuiltIn === true) {
    return { outcome: 'skipped', reason: 'built-in: Microsoft provides this Endpoint analytics baseline in every tenant, so it is never written' };
  }
  return null;
}

// Batch 10: the Wi-Fi password of an Android Enterprise enrollment profile is
// never read, so a profile that joins a secured network is written only when
// the live profile already joins that same network (its password is kept).
const ANDROID_WIFI_FIELDS = Object.freeze(['wifiSsid', 'wifiSecurityType']);
const securedWifi = (payload) => payload?.configureWifi === true && lower(payload?.wifiSecurityType || 'none') !== 'none';

function androidWifiPassword(resource, verb) {
  const want = resource.payload;
  if (!securedWifi(want)) return null;
  const now = resource.live?.payload;
  const sameNetwork = verb === 'update' && securedWifi(now) && ANDROID_WIFI_FIELDS.every((field) => sameValue(want[field], now[field]));
  if (sameNetwork) return null;
  return {
    outcome: 'skipped',
    reason: `manual: the profile joins the secured Wi-Fi network ${want.wifiSsid ?? ''}, and its password is not backed up; ${verb === 'create' ? 'recreate it' : 'change the network'} by hand and type the password again`,
  };
}

// Batch 11: an imported ADMX file. The backup reads each file on its own, so
// it holds the ADMX content and each ADML language file; a backup without
// them (all before batch 11) is refused. Only the name, language and content
// of a language file are sent; Graph adds its id and dates.
const ADMX_LANGUAGE_FIELDS = Object.freeze(['fileName', 'languageCode', 'content']);
const admxLanguageFiles = (files) => (Array.isArray(files) ? files : [])
  .map((file) => Object.fromEntries(ADMX_LANGUAGE_FIELDS.filter((field) => file?.[field] !== undefined && file?.[field] !== null)
    .map((field) => [field, file[field]])))
  .sort((left, right) => lower(left.languageCode).localeCompare(lower(right.languageCode)));
const hasText = (value) => typeof value === 'string' && value.length > 0;

function admxFileRefusal(resource) {
  const payload = resource.payload ?? {};
  const files = Array.isArray(payload.groupPolicyUploadedLanguageFiles) ? payload.groupPolicyUploadedLanguageFiles : [];
  if (!hasText(payload.content) || files.length === 0 || files.some((file) => !hasText(file?.content))) {
    return {
      outcome: 'skipped',
      reason: 'manual: this backup lists the imported ADMX file but does not hold its ADMX and ADML file content (backups before the file read was added), so it is not uploaded; take a new backup, or import the files again by hand from your own copy',
    };
  }
  return null;
}

/**
 * Batch 12: a file is keyed by its id, and a re-imported file gets a new one,
 * so a second restore from the same backup would plan another upload. Intune
 * holds one file per file name: one already imported under the backup's file
 * name is left as it is (a newer version is uploaded by hand).
 */
async function admxNotImported(io, { payload, verb }) {
  if (verb !== 'create') return null;
  const listed = await io.retryOperation(() => io.writer.read('beta', '/deviceManagement/groupPolicyUploadedDefinitionFiles?$select=id,fileName,status'));
  if (listed?.ok !== true) return `the imported ADMX files could not be listed (${outcomeDetail(listed)})`;
  const same = (listed.body?.value ?? []).find((file) => hasText(file?.fileName) && lower(file.fileName) === lower(payload?.fileName));
  if (!same) return null;
  return {
    skipped: `already imported: Intune holds an ADMX file named ${same.fileName} (status ${same.status ?? 'unknown'}), so it is not uploaded again; if the backup holds a different version, upload it by hand in the Intune admin center, under Devices, Configuration, Import ADMX`,
  };
}

/** Waits for Intune to finish reading an uploaded ADMX file; a failed upload fails the restore. */
async function admxUploadAfterWrite(io, { targetId, live }) {
  const path = `/deviceManagement/groupPolicyUploadedDefinitionFiles/${encodeURIComponent(targetId)}`;
  let now = live;
  if (now?.status === 'uploadInProgress') {
    const result = await readUntil(io, 'beta', path, (r) => r?.ok === true && r.body?.status === 'uploadInProgress', io.readOptions);
    if (result?.ok === true) now = result.body;
  }
  if (now?.status === 'uploadFailed') return { error: 'Intune could not read the uploaded ADMX file (status uploadFailed); check it in the Intune admin center, under Devices, Configuration, Import ADMX' };
  const completion = now?.status === 'uploadInProgress'
    ? [{ kind: 'manual-setting', requirement: 'admxUploadProcessing', fields: ['status'], description: 'Intune was still reading the uploaded ADMX file when the restore finished: check that it shows as Available in the Intune admin center, under Devices, Configuration, Import ADMX, before restoring templates that use it.' }]
    : [];
  return { live: now, completion, changes: { status: now?.status ?? 'unknown' } };
}

// Batch 11: a BIOS configuration is updated in place. Its settings file is
// not backed up (it can hold the BIOS password), so a deleted one is imported
// again by hand. A restore never turns per-device BIOS passwords off.
function biosPasswordRefusal(resource, verb) {
  if (verb !== 'update') return null;
  if (resource.payload?.perDevicePasswordDisabled === true && resource.live?.payload?.perDevicePasswordDisabled === false) {
    return {
      outcome: 'skipped',
      reason: 'manual: the backup turns off the per-device BIOS password, which is on now; a restore never weakens BIOS passwords, so change it by hand in the Intune admin center if that is wanted',
    };
  }
  return null;
}

// Batch 12: an iOS app provisioning profile is the .mobileprovision file
// Apple issued (no private key), read per profile. A backup without the file
// is never written as a blank, an expired file is never uploaded, and a live
// profile is never replaced with one that expires sooner.
const expiresAt = (payload) => {
  const at = Date.parse(payload?.expirationDateTime ?? '');
  return Number.isFinite(at) ? at : null;
};

function provisioningProfileRefusal(resource, verb) {
  const payload = resource.payload ?? {};
  const live = resource.live?.payload ?? null;
  if (verb === 'create' && !hasText(payload.payload)) {
    return {
      outcome: 'skipped',
      reason: 'manual: this backup does not hold the profile file from Apple (backups before the profile read was added), so it is not uploaded; take a new backup, or upload the file again by hand from your own copy',
    };
  }
  if (!hasText(payload.payload) || (verb === 'update' && payload.payload === live?.payload)) return null;
  const until = expiresAt(payload);
  if (until !== null && until <= Date.now()) {
    return {
      outcome: 'skipped',
      reason: `manual: the profile file in the backup expired on ${payload.expirationDateTime}, and an expired profile stops the apps it signs from opening; renew it with Apple, then upload the new file in the Intune admin center, under Apps, iOS/iPadOS, App provisioning profiles`,
    };
  }
  const liveUntil = expiresAt(live);
  if (verb === 'update' && until !== null && liveUntil !== null && until < liveUntil) {
    return {
      outcome: 'skipped',
      reason: `manual: the profile file in the backup expires on ${payload.expirationDateTime}, before the one in Intune now (${live.expirationDateTime}); a restore never replaces a profile with an older one, so change it by hand if that is wanted`,
    };
  }
  return null;
}

/**
 * The fields of a reusable settings group the backup reads and a write
 * re-reads. Graph leaves settingInstance out of a read unless it is selected
 * ($expand is refused), issue #470.
 */
export const REUSABLE_SETTING_SELECT = 'id,displayName,description,settingDefinitionId,settingInstance,lastModifiedDateTime';

/**
 * Issue #477: Graph gives the key child of a dynamic keyword item (the
 * simple setting `..._{id}_id`, a guid) a new value on every write, much
 * like a server id. It never counts when a group's values are compared;
 * every other value still does.
 */
const REGENERATED_KEY_CHILD = /_\{id\}_id$/;

export function withoutRegeneratedKeys(value) {
  if (Array.isArray(value)) return value.map(withoutRegeneratedKeys);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = key === 'children' && Array.isArray(child)
      ? child.filter((item) => !(REGENERATED_KEY_CHILD.test(item?.settingDefinitionId ?? '') && 'simpleSettingValue' in (item ?? {}))).map(withoutRegeneratedKeys)
      : withoutRegeneratedKeys(child);
  }
  return out;
}

const sameReusableField = (field, left, right) => (field === 'settingInstance'
  ? sameValue(withoutRegeneratedKeys(left), withoutRegeneratedKeys(right)) : null);

// Restore gaps, batch 18: Intune apps. What Intune keeps about an app's
// package, its links to other apps and how many devices use it: never sent.
const MOBILE_APP_SERVER_FIELDS = Object.freeze([
  'assignments', 'categories', 'relationships', 'contentVersions', 'uploadState', 'publishingState', 'isAssigned',
  'dependentAppCount', 'supersedingAppCount', 'supersededAppCount', 'committedContentVersion', 'size', 'manifestHash',
  'usedLicenseCount', 'totalLicenseCount',
]);

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
  // Restore gaps, batch 14: who each profile is assigned to is written through /assign.
  ...Object.fromEntries(['windowsFeatureUpdateProfile', 'windowsQualityUpdateProfile', 'windowsDriverUpdateProfile'].map((resourceType) => [resourceType, defineRecord({
    resourceType, version: 'beta', collection: `/deviceManagement/${resourceType}s`, operations: ['create', 'update', 'delete'],
    excluded: UPDATE_PROFILE_SERVER_FIELDS, afterWrite: assignmentsAfterWrite,
    assignmentType: `#microsoft.graph.${resourceType}Assignment`, permission: 'DeviceManagementConfiguration.ReadWrite.All', ...DELETE_POLICY,
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
  // Restore gaps, batch 1: Intune tenant settings whose backup is complete.
  // A reusable settings group is referenced by id from settings catalog
  // policies, so it is rebuilt before them; its setting definition never changes.
  // Issue #470: Graph returns a group's values (settingInstance) only when
  // they are selected, and routes no PATCH, so the group is read with
  // REUSABLE_SETTING_SELECT and written whole with PUT. A backup without the
  // values is refused.
  deviceManagementReusablePolicySetting: defineRecord({
    resourceType: 'deviceManagementReusablePolicySetting', version: 'beta', collection: '/deviceManagement/reusablePolicySettings',
    operations: ['create', 'update'], updateMethod: 'PUT', readQuery: `$select=${REUSABLE_SETTING_SELECT}`,
    excluded: ['version', 'referencingConfigurationPolicyCount', 'referencingConfigurationPolicies'],
    refusal: reusableSettingRefusal, sameField: sameReusableField, permission: 'DeviceManagementConfiguration.ReadWrite.All',
  }),
  windowsQualityUpdatePolicy: defineRecord({
    resourceType: 'windowsQualityUpdatePolicy', version: 'beta', collection: '/deviceManagement/windowsQualityUpdatePolicies',
    operations: ['create', 'update'], excluded: ['assignments'], permission: 'DeviceManagementConfiguration.ReadWrite.All',
  }),
  // A category is only a name: which devices were in it is set at enrollment and is not restored.
  deviceCategory: defineRecord({
    resourceType: 'deviceCategory', version: 'v1.0', collection: '/deviceManagement/deviceCategories',
    operations: ['create', 'update'], permission: 'DeviceManagementManagedDevices.ReadWrite.All',
  }),
  // A cleanup rule retires devices that stopped checking in. A restore only
  // ever makes a rule wait as long or longer than it does now, never retires
  // sooner; a deleted rule is recreated by hand.
  managedDeviceCleanupRule: defineRecord({
    resourceType: 'managedDeviceCleanupRule', version: 'beta', collection: '/deviceManagement/managedDeviceCleanupRules',
    operations: ['update'], createOnly: ['deviceCleanupRulePlatformType'], refusal: cleanupRuleRefusal,
    permission: 'DeviceManagementManagedDevices.ReadWrite.All',
  }),
  // Restore gaps, batch 4: scripts and remediations. The backup reads each
  // script on its own, so it holds the script body; a backup without it is
  // refused. Batch 14: who a script runs on is written through /assign, whose
  // body names its list per kind (SCRIPT_ASSIGNMENTS); a remediation also
  // carries its schedule and whether its fix runs.
  ...Object.fromEntries(Object.entries(SCRIPT_BODY_FIELDS).map(([resourceType, bodies]) => [resourceType, defineRecord({
    resourceType, version: 'beta', collection: `/deviceManagement/${resourceType}s`, operations: ['create', 'update'],
    excluded: SCRIPT_SERVER_FIELDS, refusal: scriptRefusal(bodies), permission: SCRIPT_WRITE_PERMISSION,
    ...(SCRIPT_ASSIGNMENTS[resourceType] ? { afterWrite: assignmentsAfterWrite, ...SCRIPT_ASSIGNMENTS[resourceType] } : {}),
  })])),
  // Restore gaps, batch 5: administrative templates. The backup reads the
  // values of each setting, so the template, its settings and their values
  // come back; every setting it uses must exist in the target first. Batch 14:
  // then who it is assigned to, through /assign.
  groupPolicyConfiguration: defineRecord({
    resourceType: 'groupPolicyConfiguration', version: 'beta', collection: '/deviceManagement/groupPolicyConfigurations', operations: ['create', 'update'],
    excluded: ['definitionValues', 'assignments', 'policyConfigurationIngestionType'],
    refusal: groupPolicyRefusal, preflight: groupPolicyPreflight, afterWrite: inOrder(groupPolicySettingsAfterWrite, assignmentsAfterWrite),
    assignmentType: '#microsoft.graph.groupPolicyConfigurationAssignment', permission: 'DeviceManagementConfiguration.ReadWrite.All',
  }),
  // Restore gaps, batch 6. An app category is only a name; Microsoft's
  // built-in categories are in every tenant and are never written.
  mobileAppCategory: defineRecord({
    resourceType: 'mobileAppCategory', version: 'v1.0', collection: '/deviceAppManagement/mobileAppCategories',
    operations: ['create', 'update'], refusal: builtInAppCategory, permission: 'DeviceManagementApps.ReadWrite.All',
  }),
  // An Autopilot profile is written with its kind (Entra joined or hybrid
  // joined), which never changes. The devices it applies to are not written.
  // Batch 15: who it is assigned to is written one assignment at a time
  // (Autopilot profiles have no /assign action).
  windowsAutopilotDeploymentProfile: defineRecord({
    resourceType: 'windowsAutopilotDeploymentProfile', version: 'beta', collection: '/deviceManagement/windowsAutopilotDeploymentProfiles',
    odataType: 'required', operations: ['create', 'update'], excluded: ['assignedDevices', 'assignments'],
    refusal: sameAutopilotKind, afterWrite: assignmentsAfterWrite,
    assignmentType: '#microsoft.graph.windowsAutopilotDeploymentProfileAssignment', assignmentWrite: 'per-item',
    permission: 'DeviceManagementServiceConfig.ReadWrite.All',
  }),
  // A policy set is written, then its items (the apps and policies in it)
  // are synced through the set's update action. Every app and policy it holds
  // must exist in the target with the same id. Batch 16: then who it is
  // assigned to, through the same update action (a set has no /assign).
  policySet: defineRecord({
    resourceType: 'policySet', version: 'beta', collection: '/deviceAppManagement/policySets', operations: ['create', 'update'],
    excluded: ['items', 'assignments', 'status', 'errorCode'],
    refusal: policySetRefusal, preflight: policySetItemsExist, afterWrite: inOrder(policySetItemsAfterWrite, assignmentsAfterWrite),
    assignmentType: '#microsoft.graph.policySetAssignment', assignmentAction: 'update',
    assignmentBodyBase: Object.freeze({ addedPolicySetItems: [], updatedPolicySetItems: [], deletedPolicySetItemIds: [] }),
    permission: 'DeviceManagementApps.ReadWrite.All',
  }),
  // Restore gaps, batch 7: settings catalog compliance policies. The backup
  // reads each policy with its settings, then its actions for noncompliance. The
  // policy is written whole (PUT, like a settings catalog policy); a create
  // carries its actions, and on update changed actions go through the
  // policy's setScheduledActions action. Batch 15: then who it is assigned
  // to, through /assign (read per policy from batch 15).
  deviceManagementCompliancePolicy: defineRecord({
    resourceType: 'deviceManagementCompliancePolicy', version: 'beta', collection: COMPLIANCE_POLICIES, operations: ['create', 'update'],
    updateMethod: 'PUT', readQuery: COMPLIANCE_EXPAND,
    excluded: ['creationSource', 'isAssigned', 'settingCount', 'settings', 'scheduledActionsForRule', ...POLICY_NAVIGATION],
    transform: complianceBody, sameField: sameComplianceField, refusal: compliancePolicyRefusal,
    // Issue #513: the policy read leaves the actions out; complianceActionsAfterWrite
    // reads them from their own collection and checks them.
    checkedAfterWrite: ['scheduledActionsForRule'],
    afterWrite: inOrder(complianceActionsAfterWrite, assignmentsAfterWrite),
    assignmentType: '#microsoft.graph.deviceManagementConfigurationPolicyAssignment', permission: 'DeviceManagementConfiguration.ReadWrite.All',
  }),
  // Restore gaps, batch 8. An e-book category is only a name.
  managedEBookCategory: defineRecord({
    resourceType: 'managedEBookCategory', version: 'beta', collection: '/deviceAppManagement/managedEBookCategories',
    operations: ['create', 'update'], permission: 'DeviceManagementApps.ReadWrite.All',
  }),
  // A Microsoft Tunnel server configuration (address range, DNS, routes, port).
  // Sites and servers point to it by id and are not written. The older route
  // fields hold the same routes as routeIncludes and routeExcludes, so only the
  // current ones are sent.
  microsoftTunnelConfiguration: defineRecord({
    resourceType: 'microsoftTunnelConfiguration', version: 'beta', collection: '/deviceManagement/microsoftTunnelConfigurations',
    operations: ['create', 'update'], excluded: ['lastUpdateDateTime', 'routesInclude', 'routesExclude'],
    permission: 'DeviceManagementConfiguration.ReadWrite.All',
  }),
  // An Apple user enrollment profile (which enrollment types users may pick).
  // Its platform is set on create only. Its place in the priority order and
  // who it is assigned to are not written.
  appleUserInitiatedEnrollmentProfile: defineRecord({
    resourceType: 'appleUserInitiatedEnrollmentProfile', version: 'beta', collection: '/deviceManagement/appleUserInitiatedEnrollmentProfiles',
    operations: ['create', 'update'], excluded: ['priority', 'assignments'], createOnly: ['platform'],
    permission: 'DeviceManagementServiceConfig.ReadWrite.All',
  }),
  // Restore gaps, batch 9. A Company Portal branding profile for some groups.
  // Batch 17: the default profile, which every user sees, is updated in place
  // (never created). Logo images are not backed up, so they are never sent: an update
  // keeps the live logos and a recreated profile has none. Who a profile is
  // assigned to is not written.
  intuneBrandingProfile: defineRecord({
    resourceType: 'intuneBrandingProfile', version: 'beta', collection: '/deviceManagement/intuneBrandingProfiles',
    operations: ['create', 'update'], excluded: ['isDefaultProfile', 'assignments', ...BRANDING_PROFILE_IMAGES],
    refusal: defaultBrandingProfile, afterWrite: brandingAfterWrite, assignmentType: '#microsoft.graph.intuneBrandingProfileAssignment',
    permission: 'DeviceManagementServiceConfig.ReadWrite.All',
  }),
  // Restore gaps, batch 10. A custom Endpoint analytics baseline is only a
  // name: Graph takes the scores to compare against when it is created, so a
  // recreated baseline holds today's scores. Built-in baselines are never written.
  userExperienceAnalyticsBaseline: defineRecord({
    resourceType: 'userExperienceAnalyticsBaseline', version: 'beta', collection: '/deviceManagement/userExperienceAnalyticsBaselines',
    operations: ['create', 'update'], writable: ['displayName'], refusal: builtInBaseline,
    permission: 'DeviceManagementConfiguration.ReadWrite.All',
  }),
  // Which device carts go to which classes (Intune for Education). The device
  // and class ids are written as backed up: devices and classes are not
  // restored by KEEL, so they must still exist.
  cartToClassAssociation: defineRecord({
    resourceType: 'cartToClassAssociation', version: 'beta', collection: '/deviceManagement/cartToClassAssociations',
    operations: ['create', 'update'], writable: ['displayName', 'description', 'deviceIds', 'classroomIds'],
    permission: 'DeviceManagementConfiguration.ReadWrite.All',
  }),
  // A legacy Android work profile enrollment profile: name and description.
  // The enrollment token and QR code are never read; a recreated profile has
  // no token until one is made in the admin center.
  androidForWorkEnrollmentProfile: defineRecord({
    resourceType: 'androidForWorkEnrollmentProfile', version: 'beta', collection: '/deviceManagement/androidForWorkEnrollmentProfiles',
    operations: ['create', 'update'], writable: ['displayName', 'description'],
    permission: 'DeviceManagementServiceConfig.ReadWrite.All',
  }),
  // An Android Enterprise corporate-owned enrollment profile. Its enrollment
  // mode, token type and Teams flag are set on create only. The token, QR code
  // and Wi-Fi password are never read: a profile joining a secured network is
  // refused unless the live profile already joins it.
  androidDeviceOwnerEnrollmentProfile: defineRecord({
    resourceType: 'androidDeviceOwnerEnrollmentProfile', version: 'beta', collection: '/deviceManagement/androidDeviceOwnerEnrollmentProfiles',
    operations: ['create', 'update'],
    writable: ['displayName', 'description', 'deviceNameTemplate', 'configureWifi', 'wifiSsid', 'wifiHidden', 'wifiSecurityType', 'roleScopeTagIds'],
    createOnly: ['enrollmentMode', 'enrollmentTokenType', 'isTeamsDeviceProfile'],
    refusal: androidWifiPassword, permission: 'DeviceManagementServiceConfig.ReadWrite.All',
  }),
  // Restore gaps, batch 11. An imported ADMX file is uploaded again with its
  // ADML language files; Intune gives the settings in it new ids, so the
  // templates that used them are set up again. It is never updated in place
  // (a new version is a separate upload action).
  groupPolicyUploadedDefinitionFile: defineRecord({
    resourceType: 'groupPolicyUploadedDefinitionFile', version: 'beta', collection: '/deviceManagement/groupPolicyUploadedDefinitionFiles',
    operations: ['create'], writable: ['fileName', 'content', 'defaultLanguageCode', 'groupPolicyUploadedLanguageFiles'],
    transform: (body) => ('groupPolicyUploadedLanguageFiles' in body
      ? { ...body, groupPolicyUploadedLanguageFiles: admxLanguageFiles(body.groupPolicyUploadedLanguageFiles) } : body),
    sameField: (field, left, right) => (field === 'groupPolicyUploadedLanguageFiles' ? sameValue(admxLanguageFiles(left), admxLanguageFiles(right)) : null),
    refusal: admxFileRefusal, preflight: admxNotImported, afterWrite: admxUploadAfterWrite, permission: 'DeviceManagementConfiguration.ReadWrite.All',
  }),
  // A BIOS configuration: its name, description, scope tags and whether each
  // device gets its own BIOS password, updated in place only.
  hardwareConfiguration: defineRecord({
    resourceType: 'hardwareConfiguration', version: 'beta', collection: '/deviceManagement/hardwareConfigurations',
    operations: ['update'], writable: ['displayName', 'description', 'perDevicePasswordDisabled', 'roleScopeTagIds'],
    refusal: biosPasswordRefusal, permission: 'DeviceManagementConfiguration.ReadWrite.All',
  }),
  // Restore gaps, batch 12. Windows app protection (Edge on unmanaged Windows
  // devices): the backup reads each policy with its apps, which are written
  // through /targetApps like iOS and Android policies. Batch 15: who it is
  // assigned to is read per policy and written through /assign.
  windowsManagedAppProtection: defineRecord({
    resourceType: 'windowsManagedAppProtection', version: 'beta', collection: '/deviceAppManagement/windowsManagedAppProtections',
    operations: ['create', 'update'], excluded: APP_POLICY_SERVER_FIELDS, refusal: managedAppRefusal, afterWrite: targetAppsAfterWrite,
    assignmentType: '#microsoft.graph.targetedManagedAppPolicyAssignment', permission: 'DeviceManagementApps.ReadWrite.All',
  }),
  // An iOS app provisioning profile: its name, description, scope tags and the
  // profile file. Batch 16: who it is assigned to is read per profile and
  // written through /assign, in the body's iOSLobAppProvisioningConfigAssignments
  // list (the older group assignments list is not sent).
  iosLobAppProvisioningConfiguration: defineRecord({
    resourceType: 'iosLobAppProvisioningConfiguration', version: 'beta', collection: '/deviceAppManagement/iosLobAppProvisioningConfigurations',
    operations: ['create', 'update'], writable: ['displayName', 'description', 'payloadFileName', 'payload', 'expirationDateTime', 'roleScopeTagIds'],
    // The file name and expiry belong to the file: never sent without it.
    transform: (body) => {
      if (hasText(body.payload)) return body;
      const { payload: _file, payloadFileName: _name, expirationDateTime: _expiry, ...rest } = body;
      return rest;
    },
    refusal: provisioningProfileRefusal, afterWrite: assignmentsAfterWrite,
    assignmentType: '#microsoft.graph.iosLobAppProvisioningConfigurationAssignment', assignmentBodyKey: 'iOSLobAppProvisioningConfigAssignments',
    permission: 'DeviceManagementApps.ReadWrite.All',
  }),
  // Restore gaps, batch 13. Which app depends on or replaces which: the two
  // apps and the direction are set on create; an update changes only how
  // (install automatically or detect; update or replace). Batch 19: the two
  // apps are named by the ids they have in the target, so a link between apps
  // this run recreated (or that exist under the same name) points at them.
  // Issue #642: Graph has no POST or PATCH on the tenant's link list, so a
  // link is written through its app's updateRelationships, and read back from
  // the app's links. Its delete is only the undo of a link a restore created,
  // through the same route, with the link left out.
  mobileAppRelationship: defineRecord({
    resourceType: 'mobileAppRelationship', version: 'beta', collection: '/deviceAppManagement/mobileAppRelationships',
    odataType: 'required', operations: ['create', 'update', 'delete'], remapsReferences: true,
    writable: ['dependencyType', 'supersedenceType'], createOnly: ['sourceId', 'targetId', 'targetType'],
    refusal: appRelationshipRefusal, preflight: appRelationshipPreflight,
    writeVia: appRelationshipWrite, readVia: appRelationshipRead, deleteVia: appRelationshipDelete,
    writeRoute: '/deviceAppManagement/mobileApps/{appId}/updateRelationships',
    permission: 'DeviceManagementApps.ReadWrite.All',
  }),
  // Restore gaps, batch 18. An app is written from its settings (store and
  // web links, Microsoft 365 Apps, Edge, WinGet), or as a shell waiting for its
  // package (Win32 and line-of-business apps: engine/restore/intuneAppKinds.mjs).
  // Who it is assigned to is written through /assign, with each assignment's
  // intent and settings; a shell is assigned only once its package is uploaded.
  mobileApp: defineRecord({
    resourceType: 'mobileApp', version: 'v1.0', collection: '/deviceAppManagement/mobileApps', odataType: 'required',
    operations: ['create', 'update'], excluded: MOBILE_APP_SERVER_FIELDS, createOnly: ['packageIdentifier', 'fileName'],
    transform: mobileAppBody, refusal: mobileAppRefusal, updateGuard: appWithoutPackageGuard, afterWrite: appAfterWrite, planChanges: appPlannedChanges,
    assignmentType: '#microsoft.graph.mobileAppAssignment', assignmentBodyKey: 'mobileAppAssignments', assignmentExtras: Object.freeze(['intent', 'settings']),
    permission: 'DeviceManagementApps.ReadWrite.All',
  }),
  // Restore gaps, batch 17: Intune tenant-wide settings, approved by the user
  // on 2026-10-22. Each is updated in place only.
  // The Intune tenant settings: the compliance settings (settings). Graph
  // sends a read naming fields of more than one backend to a backend that
  // cannot answer it (issue #447), so the read back reads each field on its
  // own, as the backup does. The device cleanup window is the cleanup rules
  // (managedDeviceCleanupRule), and the Company Portal brand on this object is
  // the default branding profile; each is written there.
  deviceManagementSettings: defineRecord({
    resourceType: 'deviceManagementSettings', version: 'beta', collection: '/deviceManagement', singleton: true,
    readEach: ['settings'], operations: ['update'],
    writable: ['settings'], refusal: deviceManagementSettingsRefusal,
    permission: 'DeviceManagementConfiguration.ReadWrite.All',
  }),
  // The Microsoft Tunnel health limits: only the two limits are written; the
  // defaults beside them are Microsoft's.
  microsoftTunnelHealthThreshold: defineRecord({
    resourceType: 'microsoftTunnelHealthThreshold', version: 'beta', collection: '/deviceManagement/microsoftTunnelHealthThresholds',
    operations: ['update'], writable: ['healthyThreshold', 'unhealthyThreshold'],
    permission: 'DeviceManagementConfiguration.ReadWrite.All',
  }),
  // Exchange on-premises access for managed devices. A restore never turns it
  // on: that could block mail on every device that is not managed.
  onPremisesConditionalAccessSettings: defineRecord({
    resourceType: 'onPremisesConditionalAccessSettings', version: 'v1.0', collection: '/deviceManagement/conditionalAccessSettings', singleton: true,
    operations: ['update'], writable: ['enabled', 'includedGroups', 'excludedGroups', 'overrideDefaultRule'],
    refusal: onPremisesAccessRefusal, permission: 'DeviceManagementConfiguration.ReadWrite.All',
  }),
});

// ------------------------------------- batch 17: Intune tenant-wide settings

const INTUNE_PORTAL = 'Intune admin center';

/**
 * The Intune tenant settings are never restored to a looser state than live:
 * devices with no compliance policy are never turned compliant (Conditional
 * Access reads it). Device cleanup has its own guard (cleanupRuleRefusal).
 */
export function deviceManagementSettingsRefusal(resource, verb) {
  if (verb !== 'update') return null;
  const want = resource.payload ?? {};
  const now = resource.live?.payload ?? {};
  if (want.settings?.secureByDefault === false && now.settings?.secureByDefault === true) {
    return {
      outcome: 'skipped',
      reason: `manual: the backup marks devices with no compliance policy as compliant, which they are not now; Conditional Access reads that, so a restore never loosens it; change it by hand in the ${INTUNE_PORTAL}, under Endpoint security, Device compliance, Compliance settings`,
    };
  }
  return null;
}

/** Exchange on-premises access is never turned on by a restore. */
export function onPremisesAccessRefusal(resource, verb) {
  if (verb !== 'update') return null;
  if (resource.payload?.enabled === true && resource.live?.payload?.enabled !== true) {
    return {
      outcome: 'skipped',
      reason: `manual: the backup turns on Exchange on-premises access control, which is off now; that could block mail on devices that are not managed, so a restore never turns it on; turn it on by hand in the ${INTUNE_PORTAL}, under Tenant administration, Connectors and tokens, Exchange on-premises access`,
    };
  }
  return null;
}

// Restore gaps batch 13: a dependency or supersedence between two Intune
// apps. Both must be in Intune: with the ids the backup names, or (batch 19)
// with the ids the record writer remapped them to, when this run recreated an
// app or the target has it under the same name. A re-run after a recreate
// looks for the link between the same two apps first.
const RELATIONSHIP_KINDS = new Set(['mobileAppDependency', 'mobileAppSupersedence']);
const appPath = (id) => `/deviceAppManagement/mobileApps/${encodeURIComponent(id)}`;

function appRelationshipRefusal(resource, verb) {
  if (verb === 'delete' && !undoesCreate(resource)) {
    return {
      outcome: 'skipped',
      reason: `manual: a restore takes out only a link it added itself (when that restore is undone); remove this link by hand in ${APP_PORTAL}: the app, Dependencies or Supersedence`,
    };
  }
  const payload = (verb === 'delete' ? resource.live?.payload : resource.payload) ?? {};
  if (!RELATIONSHIP_KINDS.has(stripGraph(payload['@odata.type']))) {
    return { outcome: 'failed', reason: `the backup does not say whether this link is a dependency or a supersedence (${stripGraph(payload['@odata.type']) ?? 'no kind'}), so it is not written` };
  }
  if (!hasText(payload.sourceId) || !hasText(payload.targetId)) {
    return { outcome: 'failed', reason: 'the backup does not name both apps of this link, so it is not written' };
  }
  if (verb === 'update') {
    const live = resource.live?.payload ?? {};
    const sameEnds = lower(live.sourceId) === lower(payload.sourceId) && lower(live.targetId) === lower(payload.targetId)
      && stripGraph(live['@odata.type']) === stripGraph(payload['@odata.type']);
    if (!sameEnds) {
      return {
        outcome: 'skipped',
        reason: 'manual: this link now joins other apps or is of another kind than in the backup; a link is never changed into another one, so set it by hand in the Intune admin center, under Apps, All apps, the app, Dependencies or Supersedence',
      };
    }
  }
  return null;
}

/** Both apps must be in Intune; on create, a link already set between them is not added again. */
async function appRelationshipPreflight(io, { payload, verb }) {
  const ends = [['the app that has the link', payload.sourceId, payload.sourceDisplayName], ['the app it points to', payload.targetId, payload.targetDisplayName]];
  for (const [end, id, name] of ends) {
    const found = await io.retryOperation(() => io.writer.read('beta', `${appPath(id)}?$select=id,displayName`));
    if (recordNotFound(found)) return `${end} (${name ?? id}) is not in Intune; add the app again first, then restore`;
    if (found?.ok !== true) return `${end} could not be read (${outcomeDetail(found)})`;
  }
  // The links the app that holds this one has now are sent again with it, so
  // they must be readable in full before anything is written.
  const { holder } = linkEnds(payload);
  const held = await io.retryOperation(() => io.writer.read('beta', `${appPath(holder)}/relationships`));
  if (held?.ok !== true) return `the app's current links could not be read (${outcomeDetail(held)})`;
  if (held.body?.['@odata.nextLink']) return 'the app has more links than one page holds, so its links are not changed';
  if (verb !== 'create') return null;
  const listed = await io.retryOperation(() => io.writer.read('beta', `${appPath(payload.sourceId)}/relationships`));
  if (listed?.ok !== true) return `the app's current links could not be read (${outcomeDetail(listed)})`;
  const same = (listed.body?.value ?? []).find((link) => lower(link?.targetId) === lower(payload.targetId));
  if (!same) return null;
  return {
    skipped: `already set: ${payload.sourceDisplayName ?? payload.sourceId} already has a ${stripGraph(same['@odata.type']) === 'mobileAppSupersedence' ? 'supersedence' : 'dependency'} link to ${payload.targetDisplayName ?? payload.targetId}, so it is not added again; check it in the Intune admin center if the backup holds another kind of link`,
  };
}

/**
 * Issue #642: the app that holds a link (the one that depends on or replaces
 * the other) and the app it points to. A link read from the app it points to
 * names the holder as its target (targetType 'parent').
 */
const linkEnds = (payload) => (lower(payload?.targetType) === 'parent'
  ? { holder: payload.targetId, other: payload.sourceId }
  : { holder: payload.sourceId, other: payload.targetId });

/** One link as updateRelationships takes it: its kind, the app it points to and how. */
function relationshipEntry(link, targetId) {
  const kind = stripGraph(link?.['@odata.type']);
  return {
    '@odata.type': `#microsoft.graph.${kind}`, targetId,
    ...(kind === 'mobileAppSupersedence' ? { supersedenceType: link.supersedenceType } : { dependencyType: link.dependencyType }),
  };
}

// Intune's answers when a link joins an app that is not a Win32 app (seen
// live in Q191), and when an app's package is not uploaded yet (seen live on
// PATCH in Q185; assumed the same for its links until proven).
const NOT_WIN32 = /is not a Win32LobApp/i;
const NOT_PUBLISHED = /PublishingState is not 'Published'/i;

/**
 * Issue #642: Graph has no write route on the tenant's link list (POST answers
 * "No method match route template"). An app's links are set through
 * POST .../mobileApps/{id}/updateRelationships, which replaces all the links
 * that app holds, so the ones it holds now are sent again with this one. A
 * link Intune refuses because an app is not a Win32 app is a plain step.
 */
async function appRelationshipWrite(io, { payload }) {
  const { holder, other } = linkEnds(payload);
  const listed = await io.retryOperation(() => io.writer.read('beta', `${appPath(holder)}/relationships`));
  if (listed?.ok !== true) return listed ?? { ok: false, status: 400, error: 'the app\'s links could not be read; nothing was written' };
  if (listed.body?.['@odata.nextLink']) return { ok: false, status: 400, error: 'the app has more links than one page holds; nothing was written' };
  const kept = (listed.body?.value ?? [])
    .filter((link) => lower(link?.targetType) !== 'parent' && lower(link?.targetId) !== lower(other))
    .map((link) => relationshipEntry(link, link.targetId));
  const result = await io.retryOperation(() => io.writer.write('beta', `${appPath(holder)}/updateRelationships`, {
    method: 'POST', body: { relationships: [...kept, relationshipEntry(payload, other)] },
  }));
  return linkWriteAnswer(result, payload, 'restore the link again');
}

/** Intune's refusals of an updateRelationships call, as plain steps for a person. */
function linkWriteAnswer(result, payload, then) {
  const answer = result?.ok !== true && result?.status === 400 ? JSON.stringify(result?.body ?? '') : '';
  const apps = `${payload.sourceDisplayName ?? payload.sourceId} or ${payload.targetDisplayName ?? payload.targetId}`;
  if (NOT_WIN32.test(answer)) {
    return {
      ...result,
      skipped: `manual: Intune sets dependencies and supersedence only between Win32 apps, and ${apps} is not one now; nothing was written. Check both apps in ${APP_PORTAL}, then set the link by hand under the app, Dependencies or Supersedence`,
    };
  }
  if (NOT_PUBLISHED.test(answer)) {
    return {
      ...result,
      skipped: `manual: Intune does not let ${apps} be changed until its package is uploaded, so the link was not written; upload the package in ${APP_PORTAL}, then ${then}`,
    };
  }
  return result;
}

/**
 * The undo of a link a restore created: the app that holds it is sent the
 * links it holds now, with this one left out (updateRelationships replaces
 * them all; the tenant's link list has no DELETE route Intune accepts).
 */
async function appRelationshipDelete(io, { payload }) {
  const { holder, other } = linkEnds(payload);
  const listed = await io.retryOperation(() => io.writer.read('beta', `${appPath(holder)}/relationships`));
  if (listed?.ok !== true) return listed ?? { ok: false, status: 400, error: 'the app\'s links could not be read; nothing was written' };
  if (listed.body?.['@odata.nextLink']) return { ok: false, status: 400, error: 'the app has more links than one page holds; nothing was written' };
  const held = (listed.body?.value ?? []).filter((link) => lower(link?.targetType) !== 'parent');
  // Already gone: nothing to send; the read after it confirms.
  if (!held.some((link) => lower(link?.targetId) === lower(other))) return { ok: true, status: 204, body: null };
  const kept = held.filter((link) => lower(link?.targetId) !== lower(other)).map((link) => relationshipEntry(link, link.targetId));
  const result = await io.retryOperation(() => io.writer.write('beta', `${appPath(holder)}/updateRelationships`, {
    method: 'POST', body: { relationships: kept },
  }));
  return linkWriteAnswer(result, payload, 'undo the restore again');
}

/** The link as the backup names it, found among its source app's links (404 when it is not there). */
async function appRelationshipRead(io, { payload }) {
  const listed = await io.retryOperation(() => io.writer.read('beta', `${appPath(payload.sourceId)}/relationships`));
  if (listed?.ok !== true) return listed;
  const kind = stripGraph(payload['@odata.type']);
  const side = lower(payload.targetType ?? 'child');
  const found = (listed.body?.value ?? []).find((link) => lower(link?.targetId) === lower(payload.targetId)
    && stripGraph(link?.['@odata.type']) === kind && lower(link?.targetType ?? 'child') === side);
  if (!found) return { ok: false, status: 404, body: { error: { code: 'ResourceNotFound', message: 'the link is not among the app\'s links' } } };
  // Listed under its source app, so that is its source, when Graph leaves it out.
  return { ok: true, status: 200, body: { sourceId: payload.sourceId, ...found } };
}

// ---------------------------------------------- restore gaps, batch 18: apps

const APP_PORTAL = 'the Intune admin center, under Apps, All apps';
const SYNCED_SOURCES = Object.freeze([
  [/vpp/i, 'Apple Business Manager, through your volume purchase token'],
  [/^androidManagedStore/i, 'managed Google Play'],
  [/^managed(IOS|Android)/i, 'Microsoft (a built-in app for app protection)'],
  [/storeforbusiness|^windowsStoreApp$/i, 'the retired Microsoft Store for Business; add it again as a Microsoft Store app (new)'],
]);
const syncedSource = (payload) => SYNCED_SOURCES.find(([pattern]) => pattern.test(appKindName(payload) ?? ''))?.[1] ?? 'the store it came from';

/**
 * What a write sends for an app. A synced app's settings belong to the store
 * it came from, so only who it is assigned to is written. A Win32 app's older
 * rule lists (detectionRules, requirementRules) hold the same rules as
 * `rules`, so only `rules` is sent when the backup has it.
 */
function mobileAppBody(body, { payload }) {
  if (appGroupOf(payload) === 'synced') return typeof body['@odata.type'] === 'string' ? { '@odata.type': body['@odata.type'] } : {};
  if (Array.isArray(body.rules) && body.rules.length > 0) {
    const { detectionRules: _detection, requirementRules: _requirement, ...rest } = body;
    return rest;
  }
  return body;
}

/** Kinds KEEL never writes, synced apps on create, and an app whose kind changed. */
function mobileAppRefusal(resource, verb) {
  const payload = resource.payload ?? {};
  const group = appGroupOf(payload);
  if (!group) {
    return { outcome: 'skipped', reason: `manual: KEEL does not write this kind of app (${appKindWords(payload)}); add it again by hand in ${APP_PORTAL}, using the backed-up settings` };
  }
  if (group === 'synced' && verb === 'create') {
    return {
      outcome: 'skipped',
      reason: `manual: this ${appKindWords(payload)} is added by ${syncedSource(payload)}, not by KEEL; sync it again there, then restore again to put back who it is assigned to`,
    };
  }
  if (verb === 'update') {
    const live = resource.live?.payload;
    if (live && lower(appKindName(live)) !== lower(appKindName(payload))) {
      return {
        outcome: 'skipped',
        reason: `manual: the app with this name in Intune is now a ${appKindWords(live)}, not a ${appKindWords(payload)} as in the backup; an app never changes kind, so fix it by hand in ${APP_PORTAL}`,
      };
    }
  }
  return null;
}

/** Who an app was assigned to, in plain words: "group:Sales (required)". */
function appTargetWords(targets) {
  return (targets ?? []).map((target) => {
    const attributes = target.attributes ?? {};
    const who = targetLabel(attributes.targetType ?? null, target.targetNaturalKey ?? null, attributes, []);
    return attributes.intent ? `${who} (${attributes.intent})` : who;
  }).join('; ');
}

const appAssignmentStep = (description) => Object.freeze({ kind: 'integration', requirement: 'assignments', description });

/**
 * An app's assignments, written through /assign with each one's intent and
 * settings, except when that would do harm or lose data. Each such case is a
 * step for a person, with the backed-up assignments:
 *  - an app without its package (a recreated Win32 or line-of-business app):
 *    assigned, it would fail to install on every device it reaches;
 *  - an uninstall assignment: it removes the app and its data from devices;
 *  - a backup that holds only a fingerprint of the assignment settings (taken
 *    before batch 18): writing them would drop notifications, delivery and
 *    restart options.
 */
export function appAssignmentHold(resource, verb, livePayload) {
  const desired = resource?.assignments;
  if (!desired || !isComplete(desired.outcome)) return null;
  const payload = resource.payload ?? {};
  const targets = desired.targets ?? [];
  const included = targets.filter((target) => target?.attributes?.targetType !== EXCLUSION);
  if (included.length === 0) return null;
  const listed = appTargetWords(targets);
  const hold = (changes, description) => ({ changes: { assignments: changes }, step: appAssignmentStep(description) });
  const hasPackage = verb === 'create' ? appGroupOf(payload) !== 'packaged' : appHasPackage(livePayload ?? {});
  if (!hasPackage) {
    return hold('not written: the app has no package yet', `Not assigned yet: Intune has no package for this app, and an assigned app without one fails to install on every device it reaches. Upload the package in ${APP_PORTAL}, then assign it as in the backup: ${listed}`);
  }
  const uninstall = included.filter((target) => lower(target.attributes?.intent) === 'uninstall');
  if (uninstall.length > 0) {
    return hold('not written: the backup uninstalls it from some devices', `Assignments not restored: the backup uninstalls this app for ${appTargetWords(uninstall)}, which removes it and its data from those devices, so KEEL never writes it. Check them and assign it by hand in ${APP_PORTAL}, as in the backup: ${listed}`);
  }
  if (targets.some((target) => target?.attributes?.settingsDigest && target.attributes.settings === undefined)) {
    return hold('not written: the backup holds only a fingerprint of the assignment settings', `Assignments not restored: this backup was taken before KEEL read the assignment settings (notifications, delivery and restart options) in full. Take a new backup and restore again, or assign it by hand in ${APP_PORTAL}, as in the backup: ${listed}`);
  }
  return null;
}

async function appAssignmentsAfterWrite(io, step) {
  const { verb, live, resource } = step;
  // Judged again on the object as it reads back now (its package may have
  // changed since the plan); the plan's own step is already on the result.
  const held = appAssignmentHold(resource, verb, live ?? resource.live?.payload);
  if (held) {
    const planned = appAssignmentHold(resource, verb, resource.live?.payload);
    return { changes: held.changes, ...(planned ? {} : { completion: [held.step] }) };
  }
  return assignmentsAfterWrite(io, step);
}

// ------------------------------------------- restore gaps, batch 19: app categories

const APP_CATEGORIES = '/deviceAppManagement/mobileAppCategories';
const APP_CATEGORY_URL = 'https://graph.microsoft.com/beta/deviceAppManagement/mobileAppCategories';
const sameName = (left, right) => lower(String(left ?? '').trim()) === lower(String(right ?? '').trim());
const idSet = (list) => [...new Set(list.map((item) => lower(item?.id)))].sort();

/**
 * The category in the target that a backed-up one is: the category this run
 * recreated from it, the same category (same id), or the only one with its
 * name (a built-in category, or one recreated by hand). null when none is.
 */
function targetCategory(category, known, runProvenance) {
  const byId = (id) => (typeof id === 'string' && id.length > 0 ? known.find((item) => lower(item?.id) === lower(id)) ?? null : null);
  const recreated = typeof runProvenance?.get === 'function' ? runProvenance.get(`mobileAppCategory:${category?.id}`) : null;
  const named = known.filter((item) => sameName(item?.displayName, category?.displayName));
  return byId(recreated) ?? byId(category?.id) ?? (named.length === 1 ? named[0] : null);
}

const readAppCategories = async (io, targetId) => {
  const read = await io.retryOperation(() => io.writer.read('beta', `${appPath(targetId)}/categories?$select=id,displayName`));
  if (read?.ok !== true) return { error: outcomeDetail(read) };
  if (read.body?.['@odata.nextLink']) return { error: 'the list has more than one page' };
  return { categories: read.body?.value ?? [] };
};

/**
 * Restore gaps batch 19: puts an app back in the categories the backup lists
 * (each matched in the target by targetCategory), and takes it out of the
 * others, through the app's categories/$ref. A category that is not in the
 * target is a step for a person, and a current category with its name is
 * kept. No `categories` (a backup taken before they were read, or an app in
 * no category, whose empty list the backup leaves out) changes nothing.
 * Lists of more than one page are not guessed from: the app is left as it is.
 */
async function appCategoriesAfterWrite(io, { payload, targetId, ctx }) {
  const want = payload?.categories;
  if (!Array.isArray(want)) return null;
  const listed = await io.retryOperation(() => io.writer.read('beta', `${APP_CATEGORIES}?$select=id,displayName`));
  if (listed?.ok !== true || listed.body?.['@odata.nextLink']) {
    return { error: `the app categories could not be read (${listed?.ok === true ? 'the list has more than one page' : outcomeDetail(listed)}), so the app's categories were not changed` };
  }
  const known = listed.body?.value ?? [];
  const wanted = new Map();
  const missing = [];
  for (const category of want) {
    const found = targetCategory(category, known, ctx?.referenceContext?.runProvenance);
    if (found) wanted.set(lower(found.id), found);
    else missing.push(category?.displayName ?? category?.id ?? 'a category with no name');
  }
  // A category the backup names but that could not be told apart (two with
  // its name) is never taken away from the app.
  const unsure = (item) => missing.some((name) => sameName(name, item?.displayName));
  const current = await readAppCategories(io, targetId);
  if (current.error) return { error: `the app's categories could not be read (${current.error}), so they were not changed` };
  const have = new Set(current.categories.map((item) => lower(item?.id)));
  const kept = current.categories.filter((item) => !wanted.has(lower(item?.id)) && unsure(item));
  const removed = current.categories.filter((item) => !wanted.has(lower(item?.id)) && !unsure(item));
  const added = [...wanted.values()].filter((item) => !have.has(lower(item.id)));
  const base = appPath(targetId);
  for (const item of removed) {
    const result = await io.retryOperation(() => io.writer.write('beta', `${base}/categories/${encodeURIComponent(item.id)}/$ref`, { method: 'DELETE' }));
    if (!result?.ok) return { error: `taking the app out of the category ${item.displayName ?? item.id} failed: ${outcomeDetail(result)}` };
  }
  for (const item of added) {
    const result = await io.retryOperation(() => io.writer.write('beta', `${base}/categories/$ref`, {
      method: 'POST', body: { '@odata.id': `${APP_CATEGORY_URL}/${encodeURIComponent(item.id)}` },
    }));
    if (!result?.ok) return { error: `adding the app to the category ${item.displayName ?? item.id} failed: ${outcomeDetail(result)}` };
  }
  if (removed.length > 0 || added.length > 0) {
    const check = await readAppCategories(io, targetId);
    if (check.error || !sameValue(idSet(check.categories), idSet([...wanted.values(), ...kept]))) {
      return { error: 'post-state: the app\'s categories did not read back as written' };
    }
  }
  const changes = { categories: removed.length > 0 || added.length > 0 ? { added: added.length, removed: removed.length } : 'already as in the backup' };
  if (missing.length === 0) return { changes };
  return {
    changes,
    completion: [Object.freeze({
      kind: 'integration', requirement: 'categories',
      description: `Categories not all restored: the app category ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in Intune. Restore or add ${missing.length === 1 ? 'it' : 'them'} first, then add the app to ${missing.length === 1 ? 'it' : 'them'} in ${APP_PORTAL}, the app, Properties, App information, Category`,
    })],
  };
}

/**
 * Issue #642: in a dry run, which categories the app would be added to or
 * taken out of, compared by name with the app's categories now (a recreated
 * app is in none). Shown in the plan beside the changed fields.
 */
async function appPlannedChanges(io, { payload, verb, targetId, ctx }) {
  const want = payload?.categories;
  if (!Array.isArray(want)) return null;
  const listed = await io.retryOperation(() => io.writer.read('beta', `${APP_CATEGORIES}?$select=id,displayName`));
  if (listed?.ok !== true || listed.body?.['@odata.nextLink']) {
    return { categories: `not read: ${listed?.ok === true ? 'the list has more than one page' : outcomeDetail(listed)}` };
  }
  let current = [];
  if (verb !== 'create' && targetId) {
    const read = await readAppCategories(io, targetId);
    if (read.error) return { categories: `not read: ${read.error}` };
    current = read.categories;
  }
  // Matched as the write matches them (targetCategory). A category not in
  // Intune yet (one this run is about to add again, or missing) is counted
  // apart: the run adds the app to one it recreates, and lists a step otherwise.
  const known = listed.body?.value ?? [];
  const wanted = new Map();
  const missing = [];
  for (const category of want) {
    const found = targetCategory(category, known, ctx?.referenceContext?.runProvenance);
    if (found) wanted.set(lower(found.id), found);
    else missing.push(category?.displayName ?? category?.id);
  }
  const have = new Set(current.map((item) => lower(item?.id)));
  const unsure = (item) => missing.some((name) => sameName(name, item?.displayName));
  const added = [...wanted.keys()].filter((id) => !have.has(id)).length;
  const removed = current.filter((item) => !wanted.has(lower(item?.id)) && !unsure(item)).length;
  if (added === 0 && removed === 0 && missing.length === 0) return { categories: 'already as in the backup' };
  return { categories: { added, removed, ...(missing.length > 0 ? { notInIntuneYet: missing.length } : {}) } };
}

/**
 * Issue #642: Intune refuses any change to a Win32 or line-of-business app
 * whose package is not uploaded yet (400 "app's PublishingState is not
 * 'Published'"), so such an update is a step for a person, in the plan too.
 */
function appWithoutPackageGuard(_io, { before, payload }) {
  const live = before ?? {};
  if (appGroupOf(live) !== 'packaged' || appHasPackage(live)) return null;
  return {
    reason: `manual: Intune does not let ${payload?.displayName ?? live.displayName ?? 'this app'} be changed until its package is uploaded, so nothing was written; upload the package in ${APP_PORTAL}, then restore again`,
  };
}

/** An app's assignments, then its categories; the steps of both are kept. */
async function appAfterWrite(io, step) {
  const assigned = await appAssignmentsAfterWrite(io, step);
  if (assigned?.error) return assigned;
  const placed = await appCategoriesAfterWrite(io, assigned?.live ? { ...step, live: assigned.live } : step);
  if (placed?.error) return placed;
  if (!assigned && !placed) return null;
  const changes = { ...(assigned?.changes ?? {}), ...(placed?.changes ?? {}) };
  const completion = [...(assigned?.completion ?? []), ...(placed?.completion ?? [])];
  return {
    ...(Object.keys(changes).length > 0 ? { changes } : {}),
    ...(assigned?.live ? { live: assigned.live } : {}),
    ...(completion.length > 0 ? { completion } : {}),
  };
}

/**
 * A reusable settings group is written whole, so a backup taken before the
 * group's values were read (issue #470) is never written: Intune refuses a
 * group without them. Its setting definition is never changed on update.
 */
export function reusableSettingRefusal(resource, verb) {
  if (verb === 'delete') return null;
  const trust = trustSettingRefusal(resource, verb);
  if (trust) return trust;
  const payload = resource.payload ?? {};
  const instance = payload.settingInstance;
  if (!instance || typeof instance !== 'object' || Array.isArray(instance)) {
    return {
      outcome: 'skipped',
      reason: 'manual: this backup holds the group\'s name but not its values (backups before the values were read), so it is not written; take a new backup, or set the values by hand in the Intune admin center',
    };
  }
  const live = resource.live?.payload?.settingDefinitionId;
  if (verb === 'update' && typeof live === 'string' && live !== payload.settingDefinitionId) {
    return {
      outcome: 'skipped',
      reason: `manual: the backup's group is for setting ${payload.settingDefinitionId}, but the group in the tenant is for ${live}; a group's setting never changes, so recreate it by hand`,
    };
  }
  return null;
}

/** A cleanup rule is never made to retire devices sooner than it does now. */
export function cleanupRuleRefusal(resource, verb) {
  if (verb !== 'update') return null;
  const want = Number(resource.payload?.deviceInactivityBeforeRetirementInDays);
  const now = Number(resource.live?.payload?.deviceInactivityBeforeRetirementInDays);
  if (Number.isFinite(want) && Number.isFinite(now) && want < now) {
    return {
      outcome: 'skipped',
      reason: `manual: the backup retires devices after ${want} days without check-in, sooner than the ${now} days set now; a shorter wait could retire devices at once, so a person changes it`,
    };
  }
  return null;
}

// ------------------------------------------------- batch 6: app categories

// Microsoft's built-in app categories, in every tenant (matched by name).
const BUILT_IN_APP_CATEGORIES = new Set([
  'other apps', 'books & reference', 'data management', 'productivity', 'business',
  'development & design', 'photos & media', 'collaboration & social', 'computer management',
]);

function builtInAppCategory(resource) {
  const names = [resource.payload?.displayName, resource.live?.payload?.displayName].map(lower);
  if (names.some((name) => BUILT_IN_APP_CATEGORIES.has(name.trim()))) {
    return { outcome: 'skipped', reason: 'built-in: Microsoft provides this app category in every tenant, so it is never written' };
  }
  return null;
}

/** An Autopilot profile never changes kind (Entra joined or hybrid joined): that is a new profile. */
function sameAutopilotKind(resource, verb) {
  if (verb !== 'update') return null;
  const want = stripGraph(resource.payload?.['@odata.type']);
  const now = stripGraph(resource.live?.payload?.['@odata.type']);
  if (want && now && want !== now) {
    return { outcome: 'skipped', reason: `manual: the live profile is a ${now}, not the ${want} in the backup; a profile cannot change kind, so recreate it by hand` };
  }
  return null;
}

// ---------------------------------------------------- batch 6: policy sets

const POLICY_SETS = '/deviceAppManagement/policySets';
const policySetPath = (targetId) => `${POLICY_SETS}/${encodeURIComponent(targetId)}`;

// Where the app or policy each kind of item points at lives (declared from the
// Graph beta policySetItem subtypes; unmeasured live).
export const POLICY_SET_ITEM_TARGETS = Object.freeze({
  mobileAppPolicySetItem: '/deviceAppManagement/mobileApps',
  managedAppProtectionPolicySetItem: '/deviceAppManagement/managedAppPolicies',
  targetedManagedAppConfigurationPolicySetItem: '/deviceAppManagement/targetedManagedAppConfigurations',
  managedDeviceMobileAppConfigurationPolicySetItem: '/deviceAppManagement/mobileAppConfigurations',
  iosLobAppProvisioningConfigurationPolicySetItem: '/deviceAppManagement/iosLobAppProvisioningConfigurations',
  mdmWindowsInformationProtectionPolicyPolicySetItem: '/deviceAppManagement/mdmWindowsInformationProtectionPolicies',
  deviceConfigurationPolicySetItem: '/deviceManagement/deviceConfigurations',
  deviceCompliancePolicyPolicySetItem: '/deviceManagement/deviceCompliancePolicies',
  deviceManagementConfigurationPolicyPolicySetItem: '/deviceManagement/configurationPolicies',
  deviceManagementScriptPolicySetItem: '/deviceManagement/deviceManagementScripts',
  enrollmentRestrictionsConfigurationPolicySetItem: '/deviceManagement/deviceEnrollmentConfigurations',
  windows10EnrollmentCompletionPageConfigurationPolicySetItem: '/deviceManagement/deviceEnrollmentConfigurations',
  windowsAutopilotDeploymentProfilePolicySetItem: '/deviceManagement/windowsAutopilotDeploymentProfiles',
});

// Fields Intune fills in on an item: never sent, never compared.
const POLICY_SET_ITEM_SERVER_FIELDS = new Set(['id', 'createdDateTime', 'lastModifiedDateTime', 'displayName', 'status', 'errorCode', 'itemType']);

/** The body that adds one item: its kind, what it points at and its own settings. */
export function policySetItemBody(item) {
  const body = {};
  for (const [key, value] of Object.entries(item ?? {})) {
    if (POLICY_SET_ITEM_SERVER_FIELDS.has(key) || (key.includes('@odata.') && key !== '@odata.type')) continue;
    body[key] = withoutAnnotations(value);
  }
  return body;
}

const itemKey = (item) => `${stripGraph(item?.['@odata.type'])}:${lower(item?.payloadId)}`;
const itemShape = (item) => normalisedItem(policySetItemBody(item));
const normalisedItem = (body) => ({ ...body, '@odata.type': stripGraph(body['@odata.type']), payloadId: lower(body.payloadId) });

/** A set is written only from a backup that holds its items, each saying what it points at. */
function policySetRefusal(resource, verb) {
  if (verb === 'delete') return null;
  const items = resource.payload?.items;
  const manual = (why) => ({ outcome: 'skipped', reason: `manual: ${why}, so it is not written; take a new backup, or recreate the set by hand from the backup` });
  if (!Array.isArray(items)) return manual('this backup holds the set but not the apps and policies in it (backups before the items were read)');
  for (const item of items) {
    const kind = stripGraph(item?.['@odata.type']);
    if (!kind || typeof item.payloadId !== 'string' || item.payloadId.length === 0) return manual('an item in this backup does not say which app or policy it is');
    if (!POLICY_SET_ITEM_TARGETS[kind]) return manual(`an item in this backup is a ${kind}, a kind of item KEEL does not write`);
  }
  return null;
}

/** Every app and policy in the set must exist in the target with the id the backup holds. */
async function policySetItemsExist(io, { payload }) {
  for (const item of payload?.items ?? []) {
    const collection = POLICY_SET_ITEM_TARGETS[stripGraph(item['@odata.type'])];
    const found = await io.retryOperation(() => io.writer.read('beta', `${collection}/${encodeURIComponent(item.payloadId)}?$select=id`));
    if (found?.ok !== true) {
      return `the ${item.displayName ? `item ${item.displayName}` : `item ${item.payloadId}`} in this set ${recordNotFound(found) ? 'does not exist in the target with the same id (restore it first, then the set)' : 'could not be read'}`;
    }
  }
  return null;
}

async function readPolicySetItems(io, targetId) {
  const read = await io.retryOperation(() => io.writer.read('beta', `${policySetPath(targetId)}?$expand=items`));
  if (read?.ok !== true) return { error: `the set's items could not be read (${outcomeDetail(read)})` };
  return { items: read.body?.items ?? [] };
}

const itemSet = (items) => items.map(itemShape).sort((left, right) => itemKey(left).localeCompare(itemKey(right)));

/**
 * Puts a set's items back through its update action: a live item that is not
 * in the backup, or differs from it, is removed, then each backup item live
 * lacks is added. Two calls, so an item is never removed and added in the
 * same request. Assignments are never sent.
 */
async function policySetItemsAfterWrite(io, { payload, verb, targetId }) {
  const want = payload.items;
  let have = [];
  if (verb !== 'create') {
    const read = await readPolicySetItems(io, targetId);
    if (read.error) return { error: `${read.error}, so they were not changed` };
    have = read.items;
  }
  const wantBy = new Map(want.map((item) => [itemKey(item), itemShape(item)]));
  const haveBy = new Map(have.map((item) => [itemKey(item), itemShape(item)]));
  const removed = have.filter((item) => !sameValue(wantBy.get(itemKey(item)), itemShape(item)));
  const added = want.filter((item) => !sameValue(haveBy.get(itemKey(item)), itemShape(item)));
  if (removed.length === 0 && added.length === 0) return verb === 'create' ? null : { changes: { items: 'already as in the backup' } };
  const path = `${policySetPath(targetId)}/update`;
  for (const body of [
    removed.length > 0 ? { addedPolicySetItems: [], updatedPolicySetItems: [], deletedPolicySetItemIds: removed.map((item) => item.id) } : null,
    added.length > 0 ? { addedPolicySetItems: added.map(policySetItemBody), updatedPolicySetItems: [], deletedPolicySetItemIds: [] } : null,
  ].filter(Boolean)) {
    const result = await io.retryOperation(() => io.writer.write('beta', path, { method: 'POST', body }));
    if (!result.ok) return { error: `writing the set's items failed: ${outcomeDetail(result)}` };
  }
  const check = await readPolicySetItems(io, targetId);
  if (check.error || !sameValue(itemSet(check.items), itemSet(want))) return { error: 'post-state: the set\'s items did not read back as written' };
  return { changes: { items: { removed: removed.length, added: added.length } } };
}

/** Intune types read in wave 1 that no record can write in full, and why. */
export const INTUNE_BEST_EFFORT = Object.freeze({
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
