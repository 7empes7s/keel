/**
 * Roadmap task-109: bounded administrative configuration restore qualification.
 *
 * The administrative-configuration batch (engine/coverage/qualification.mjs's
 * EXPANSION_BATCHES) gets its first qualified operations here. There are three
 * explicit operation records, and nothing else in the batch is written:
 *
 *  - administrativeUnit update: displayName and description of an existing
 *    unit. Membership, scoped role members, visibility and the dynamic
 *    membership rule are not written (see UNRECOVERABLE_CONFIGURATION);
 *  - groupSetting update: the values of an existing TENANT-WIDE directory
 *    setting. The setting stays bound to its template: the template id is
 *    never written, a snapshot whose template differs from the live one is
 *    refused, and the value names must be exactly the ones the live setting
 *    (instantiated from that template) defines, so a PATCH never resets a value
 *    the snapshot did not observe;
 *  - groupSetting delete: removes a tenant-wide setting that the snapshot
 *    proves did not exist. Absence is evidence only when the snapshot read the
 *    whole groupSetting collection: a partial, failed, not-requested or
 *    unrecorded observation never authorises a delete.
 *
 * Every write of a governed type also passes these guards, before the
 * capability gate, journal or writer runs:
 *
 *  - global reference templates (directorySettingTemplate,
 *    directoryRoleTemplate) are Microsoft-published and identical in every
 *    tenant. They are never written, whatever is registered for them;
 *  - source authority: an object (or the parent of a group-scoped setting)
 *    whose source of authority is on-premises, hybrid or unknown is refused
 *    here, for every verb, including delete;
 *  - group-scoped settings (/groups/{id}/settings) are unsupported: only
 *    tenant-wide settings from /groupSettings are qualified.
 *
 * The capability registry (capabilities.mjs) holds the claims; this module
 * never raises one.
 *
 * Documentation note: learn.microsoft.com is not reachable from the build
 * container, so the routes and fields below are declarations to confirm
 * against the current Graph v1.0 reference before any live qualification
 * (Global Constraint 8; see docs/roadmap/administrative-fidelity.md).
 */
import { capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import {
  EXPANSION_BATCHES, UNRECOVERABLE_CONFIGURATION, buildExpansionInventory,
} from '../coverage/qualification.mjs';
import { namedValueDrift } from '../reconcile/writableProjection.mjs';
import { refuseIfSynced } from '../safety/syncedObjectGuard.mjs';

export const ADMINISTRATIVE_OPERATIONS_CONTRACT_VERSION = 1;

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';

/** Microsoft-published template catalogues: the same ids in every tenant. */
export const GLOBAL_REFERENCE_TEMPLATE_TYPES = Object.freeze(['directorySettingTemplate', 'directoryRoleTemplate']);

/** Snapshot coverage outcomes that prove the whole collection was read. */
export const COMPLETE_OBSERVATION_OUTCOMES = Object.freeze(['complete', 'complete-empty']);

/** The operation records (at most three, per the task). */
export const ADMINISTRATIVE_OPERATION_RECORDS = Object.freeze([
  Object.freeze({
    resourceType: 'administrativeUnit',
    operation: 'update',
    route: 'PATCH /directory/administrativeUnits/{id}',
    permission: 'AdministrativeUnit.ReadWrite.All',
    docs: `${DOCS}/administrativeunit-update?view=graph-rest-1.0`,
    writableFields: Object.freeze(['description', 'displayName']),
    checks: Object.freeze(['source authority', 'live object present', 'post-state of written fields']),
    proofRef: 'engine/roadmap/administrative-fidelity.test.mjs',
  }),
  Object.freeze({
    resourceType: 'groupSetting',
    operation: 'update',
    route: 'PATCH /groupSettings/{id}',
    permission: 'GroupSettings.ReadWrite.All',
    docs: `${DOCS}/groupsetting-update?view=graph-rest-1.0`,
    writableFields: Object.freeze(['values']),
    checks: Object.freeze([
      'tenant-wide scope', 'source authority', 'template unchanged', 'value names defined by the template',
      'post-state of every value and the template',
    ]),
    proofRef: 'engine/roadmap/administrative-fidelity.test.mjs',
  }),
  Object.freeze({
    resourceType: 'groupSetting',
    operation: 'delete',
    route: 'DELETE /groupSettings/{id}',
    permission: 'GroupSettings.ReadWrite.All',
    docs: `${DOCS}/groupsetting-delete?view=graph-rest-1.0`,
    writableFields: Object.freeze([]),
    checks: Object.freeze([
      'tenant-wide scope', 'source authority', 'complete snapshot observation of the collection', 'absent after delete',
    ]),
    proofRef: 'engine/roadmap/administrative-fidelity.test.mjs',
  }),
]);

const RECORD_TYPES = new Set(ADMINISTRATIVE_OPERATION_RECORDS.map((record) => record.resourceType));

/** True when writes of this type go through this module's guards. */
export function isAdministrativeGoverned(resourceType) {
  return RECORD_TYPES.has(resourceType) || GLOBAL_REFERENCE_TEMPLATE_TYPES.includes(resourceType);
}

export function administrativeRecordFor(resourceType, operation) {
  return ADMINISTRATIVE_OPERATION_RECORDS.find((record) => record.resourceType === resourceType
    && record.operation === operation) ?? null;
}

/**
 * 'tenant' for a setting read from /groupSettings, 'group' for one that names
 * a parent group. Never guessed from a display name.
 */
export function groupSettingScopeOf(resource) {
  return resource?.parent === undefined || resource?.parent === null ? 'tenant' : 'group';
}

function refusal(outcome, reason) {
  return Object.freeze({ outcome, reason });
}

function sourceAuthorityRefusal(resource) {
  const candidates = [
    { ...resource, payload: resource.payload ?? null },
    ...(resource.live?.payload ? [{ ...resource, payload: resource.live.payload }] : []),
    ...(resource.parent ? [{ ...resource.parent, payload: resource.parent.payload ?? null }] : []),
  ];
  for (const candidate of candidates) {
    const check = refuseIfSynced(candidate);
    if (check.refused) return `source authority: administrative write refused — ${check.reason}`;
  }
  return null;
}

function groupSettingUpdateRefusal(resource) {
  const desired = resource.payload ?? {};
  const live = resource.live.payload;
  if (typeof desired.templateId !== 'string' || desired.templateId.length === 0) {
    return 'dependency: the snapshot names no settings template, so the setting cannot be bound to one';
  }
  if (String(live.templateId ?? '').toLowerCase() !== desired.templateId.toLowerCase()) {
    return `dependency: template change refused — the live setting is bound to global reference template ${live.templateId ?? 'none'} and the snapshot to ${desired.templateId}; a template is never rewritten`;
  }
  const drift = namedValueDrift(desired.values, live.values);
  if (drift.duplicates.length > 0) return `dependency: the snapshot repeats value ${drift.duplicates.join(', ')}`;
  if (drift.undefinedNames.length > 0) {
    return `dependency: ${drift.undefinedNames.join(', ')} not defined by the live setting's template`;
  }
  if (drift.unobserved.length > 0) {
    return `dependency: the template now defines ${drift.unobserved.join(', ')}, which the snapshot never observed; writing the setting would reset them`;
  }
  return null;
}

/**
 * The write-time gate applyWave runs for a governed type, before the
 * capability gate, journal or writer. Returns null when the write may
 * proceed, otherwise { outcome, reason }: a global template or a non-cloud
 * source of authority is 'skipped' (nobody may write it from the cloud), every
 * other refusal is 'failed' (the write is unproven).
 *
 * `observedCoverage` maps a type to the source snapshot's coverage entry
 * ({ outcome }); only a delete consults it.
 */
export function administrativeWriteRefusal(resource, verb, { observedCoverage = null } = {}) {
  if (!isAdministrativeGoverned(resource.resourceType)) return null;
  if (GLOBAL_REFERENCE_TEMPLATE_TYPES.includes(resource.resourceType)) {
    return refusal('skipped', `global reference template: ${resource.resourceType} ${resource.naturalKey} is Microsoft-published and identical in every tenant; it is never written`);
  }
  const authority = sourceAuthorityRefusal(resource);
  if (authority) return refusal('skipped', authority);
  if (resource.resourceType === 'groupSetting' && groupSettingScopeOf(resource) !== 'tenant') {
    return refusal('failed', 'unsupported: a group-scoped setting has no qualified operation; only tenant-wide settings are written');
  }

  const record = administrativeRecordFor(resource.resourceType, verb);
  if (!record) return refusal('failed', `no administrative operation record covers ${resource.resourceType} ${verb}`);
  if (!isSupportedClaim(capabilityFor(resource.resourceType, verb).claim)) {
    return refusal('failed', `${resource.resourceType} ${verb} is not a registered write capability`);
  }

  if (verb === 'delete') {
    if (resource.payload !== null && resource.payload !== undefined) {
      return refusal('failed', 'delete refused: the snapshot still contains this object');
    }
    const outcome = observedCoverage?.[resource.resourceType]?.outcome ?? null;
    if (!COMPLETE_OBSERVATION_OUTCOMES.includes(outcome)) {
      return refusal('failed', `partial observation cannot authorise delete: the snapshot's ${resource.resourceType} collection is ${outcome ?? 'not recorded'}, so its absence there is not evidence`);
    }
    return null;
  }

  if (!resource.live?.payload || (resource.live.state !== undefined && resource.live.state !== 'present')) {
    return refusal('failed', `dependency: no live ${resource.resourceType} was observed, so the update cannot be checked against it`);
  }
  if (resource.resourceType === 'groupSetting') {
    const reason = groupSettingUpdateRefusal(resource);
    if (reason) return refusal('failed', reason);
  }
  return null;
}

/**
 * Refuses an update body that carries anything beyond the record's writable
 * fields (a template id above all). writableProjection() already drops
 * immutable and unknown fields; this is the independent check at the writer
 * boundary.
 */
export function administrativePatchRefusal(resourceType, body) {
  const record = administrativeRecordFor(resourceType, 'update');
  if (!record) return `${resourceType}: no administrative update record`;
  const extra = Object.keys(body ?? {}).filter((field) => !record.writableFields.includes(field));
  return extra.length > 0 ? `refusing to PATCH ${resourceType}: ${extra.join(', ')} outside the proven writable fields` : null;
}

/**
 * After an update, the written fields must read back as desired and a setting
 * must still be bound to its template. Returns the reason, or null.
 */
export function administrativePostStateRefusal(resource, live) {
  const record = administrativeRecordFor(resource.resourceType, 'update');
  if (!record) return null;
  const desired = resource.payload ?? {};
  if (resource.resourceType === 'groupSetting') {
    if (String(live?.templateId ?? '').toLowerCase() !== String(desired.templateId ?? '').toLowerCase()) {
      return `post-state: setting read back bound to template ${live?.templateId ?? 'none'}, not ${desired.templateId}`;
    }
    const drift = namedValueDrift(desired.values, live?.values);
    const wrong = [...drift.changed, ...drift.undefinedNames, ...drift.unobserved];
    return wrong.length > 0 ? `post-state: ${wrong.join(', ')} did not read back as written` : null;
  }
  const wrong = record.writableFields.filter((field) => Object.hasOwn(desired, field)
    && JSON.stringify(desired[field] ?? null) !== JSON.stringify(live?.[field] ?? null));
  return wrong.length > 0 ? `post-state: ${wrong.join(', ')} did not read back as written` : null;
}

/**
 * The administrative family ledger: every type in the batch with its status,
 * the qualified operation records, the refusals that hold whatever is
 * registered, and what configuration and relationships cannot be recovered.
 * It deliberately carries no coverage percentage.
 */
export function buildAdministrativeFamilyLedger() {
  const batchId = 'administrative-configuration';
  const batch = buildExpansionInventory().batches.find((candidate) => candidate.id === batchId);
  return Object.freeze({
    contractVersion: ADMINISTRATIVE_OPERATIONS_CONTRACT_VERSION,
    batch: batchId,
    label: EXPANSION_BATCHES.find((candidate) => candidate.id === batchId).label,
    families: Object.freeze(batch.types.map((entry) => Object.freeze({
      resourceType: entry.resourceType,
      status: entry.status,
      restoreScope: entry.restoreScope,
      supportedOperations: entry.supportedOperations,
      operations: Object.freeze(ADMINISTRATIVE_OPERATION_RECORDS
        .filter((record) => record.resourceType === entry.resourceType)
        .map((record) => Object.freeze({
          operation: record.operation,
          route: record.route,
          permission: record.permission,
          writableFields: record.writableFields,
          checks: record.checks,
          claim: capabilityFor(record.resourceType, record.operation).claim,
        }))),
      refusals: Object.freeze(GLOBAL_REFERENCE_TEMPLATE_TYPES.includes(entry.resourceType)
        ? ['global reference template: never written']
        : RECORD_TYPES.has(entry.resourceType)
          ? ['source of authority on-premises, hybrid or unknown: never written from the cloud']
          : []),
      unrecoverable: UNRECOVERABLE_CONFIGURATION[entry.resourceType] ?? Object.freeze([]),
      api: entry.api,
      permission: entry.permission,
      reason: entry.reason,
    }))),
  });
}
