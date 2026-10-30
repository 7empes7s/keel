// engine/govern/restoreApprovalSettings.mjs
//
// Restore approvals as a customer setting. Some restore changes are high impact: they
// shorten retention, release a hold, widen sharing, destroy content, run a script on
// devices or shorten a group's lifetime (safety/contentEffects.mjs and the workload
// effect rules). Whether such a change waits for a second person to approve it is the
// customer's choice, per service. It is on for every service until an admin turns it
// off, and each change is written to the audit record. Some kinds of restore have their
// own setting on top (RESTORE_APPROVAL_RULES: content restores, turning a Conditional
// Access policy on, compliance fixes, tenant-wide changes, restores into another tenant,
// objects Keel cannot place in a service), on until an admin turns it off too.
// Changing a setting never needs a second person; a two-person rule a customer set up
// (approvalPolicy.mjs) still holds for every restore it covers.
//
// Off means the change is made as part of the restore, with its disclosure still shown
// in the dry run. It never lifts a technical safety check: the break-glass lockout
// gate, preservation locks and the trust, federation, certificate and sign-in
// endpoint rule stay as they are whatever this setting says.
import { appendEvidence } from './evidence.mjs';
import { SERVICES, typeInfo } from '../insights/taxonomy.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';

export const RESTORE_APPROVAL_SERVICES = SERVICES;
export const RESTORE_APPROVAL_SETTING_EVIDENCE_KIND = 'restore-approval-setting';

export class RestoreApprovalSettingError extends Error {}

/** The service a restored kind belongs to, or null when Keel cannot place it. */
export function serviceForResourceType(resourceType) {
  const service = typeInfo(String(resourceType ?? '')).service;
  return RESTORE_APPROVAL_SERVICES.includes(service) ? service : null;
}

/** Every service, with whether a high-impact restore change in it needs a second approver. On unless set. */
export async function getRestoreApprovalSettings(client, { tenantRef }) {
  const { rows } = await client.query(
    'SELECT service, approval_required, updated_by, updated_at FROM restore_approval_setting WHERE tenant_ref = $1',
    [tenantRef],
  );
  const byService = new Map(rows.map((row) => [row.service, row]));
  return RESTORE_APPROVAL_SERVICES.map((service) => {
    const row = byService.get(service);
    return {
      service,
      approvalRequired: row ? row.approval_required === true : true,
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

/**
 * Turn the approval on or off for one service. The caller checks the actor holds
 * `policies`. Writes the audit record first, so a change is never made without one.
 */
export async function setRestoreApprovalSetting(client, { tenantRef, service, approvalRequired, actor }) {
  if (!RESTORE_APPROVAL_SERVICES.includes(service)) {
    throw new RestoreApprovalSettingError(`unknown service: ${service} (one of ${RESTORE_APPROVAL_SERVICES.join(', ')})`);
  }
  if (typeof approvalRequired !== 'boolean') throw new RestoreApprovalSettingError('approvalRequired must be true or false');
  if (typeof actor !== 'string' || actor.length === 0) throw new RestoreApprovalSettingError('a setting change needs an actor');
  const before = (await getRestoreApprovalSettings(client, { tenantRef })).find((entry) => entry.service === service);
  if (before.approvalRequired === approvalRequired && before.updatedAt) return { changed: false, setting: before };
  await appendEvidence(client, {
    tenantRef,
    kind: RESTORE_APPROVAL_SETTING_EVIDENCE_KIND,
    subject: { service, approvalRequired, previous: before.approvalRequired },
    actor,
  });
  await client.query(
    `INSERT INTO restore_approval_setting (tenant_ref, service, approval_required, updated_by, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (tenant_ref, service)
       DO UPDATE SET approval_required = EXCLUDED.approval_required, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantRef, service, approvalRequired, actor],
  );
  const setting = (await getRestoreApprovalSettings(client, { tenantRef })).find((entry) => entry.service === service);
  return { changed: before.approvalRequired !== approvalRequired, setting };
}

/**
 * Whether these effects need a second approver under the tenant's setting. They do
 * unless every effect's service has the approval turned off. An effect Keel cannot
 * place in a service, or a call with no tenant, always needs it.
 * Returns { required, services, waived } where `waived` lists the services whose
 * setting is off. `settings` (from getRestoreApprovalSettings) saves the read when a
 * caller checks many dry runs.
 */
export async function effectsNeedApproval(client, { tenantRef, effects, settings = null }) {
  const services = [...new Set((effects ?? []).map((effect) => serviceForResourceType(effect?.resourceType)))];
  if (services.length === 0) return { required: false, services: [], waived: [] };
  if (typeof tenantRef !== 'string' || tenantRef.length === 0 || services.includes(null)) {
    return { required: true, services, waived: [] };
  }
  const current = settings ?? await getRestoreApprovalSettings(client, { tenantRef });
  const off = new Set(current.filter((entry) => !entry.approvalRequired).map((entry) => entry.service));
  return { required: services.some((service) => !off.has(service)), services, waived: services.filter((service) => off.has(service)) };
}

// The restore's own approval (approvals.mjs#requestApproval). When every service a
// restore writes to has restore approvals off, the request is approved as it is made,
// under this basis, and nobody has to approve it. The basis is kept on the request
// (standing_policy) and in the approval-decision evidence, next to the services.
export const RESTORE_APPROVALS_OFF_BASIS = 'restore-approvals-off';
// Who the request's decided_by names: Keel itself, never a person, so a person's
// approval is never claimed. Not a principal id (those are UUIDs), so it can never be
// the requester either.
export const RESTORE_APPROVALS_OFF_DECIDER = 'restore-approval-setting';

// The service each workload restore (restore/workloads/dispatch.mjs) writes to. A
// workload missing here waits for an approver; a test keeps the two lists equal.
export const WORKLOAD_RESTORE_SERVICES = Object.freeze({
  'sharepoint-site-settings': 'SharePoint',
  'sharepoint-site-grants': 'SharePoint',
  'sharepoint-site-permissions': 'SharePoint',
  'sharepoint-structure': 'SharePoint',
  // OneDrive is listed under SharePoint everywhere in Keel (insights/taxonomy.mjs).
  'onedrive-site-settings': 'SharePoint',
  'exchange-mailbox-settings': 'Exchange',
  'exchange-mail-flow': 'Exchange',
  'exchange-extended': 'Exchange',
  'exchange-distribution-groups': 'Exchange',
  'exchange-role-definitions': 'Exchange',
  'teams-settings': 'Teams',
  'teams-org-policies': 'Teams',
  'teams-voice-policies': 'Teams',
  'purview-labels': 'Purview',
  'purview-retention-dlp': 'Purview',
  'purview-governance': 'Purview',
});

// Kinds of restore with their own approval setting, next to the per-service one. A
// restore of one of these kinds starts without a person only when its kind and every
// service it writes to have approvals off. On until an admin turns it off. In the
// order the Approvals page lists them.
export const RESTORE_APPROVAL_RULES = Object.freeze([
  'content-restore',
  'turn-on-conditional-access',
  'compliance-fix',
  'tenant-wide',
  'other-tenant',
  'unplaced',
]);
// Plain names, for the reason kept on an approved request.
export const RESTORE_APPROVAL_RULE_NAMES = Object.freeze({
  'content-restore': 'mail, file and Teams content restores',
  'turn-on-conditional-access': 'turning a Conditional Access policy on',
  'compliance-fix': 'compliance fixes',
  'tenant-wide': 'tenant-wide changes',
  'other-tenant': 'restores into another tenant',
  'unplaced': 'objects Keel cannot place in a service',
});

// The service each content restore workload (cli/keel-content-restore*.mjs) writes to.
export const CONTENT_RESTORE_SERVICES = Object.freeze({
  mail: 'Exchange',
  onedrive: 'SharePoint',
  'sharepoint-sites': 'SharePoint',
  'teams-messages': 'Teams',
});

/** Every kind of restore, with whether it needs a person to approve it. On unless set. */
export async function getRestoreApprovalRules(client, { tenantRef }) {
  const { rows } = await client.query(
    'SELECT rule, approval_required, updated_by, updated_at FROM restore_approval_rule WHERE tenant_ref = $1',
    [tenantRef],
  );
  const byRule = new Map(rows.map((row) => [row.rule, row]));
  return RESTORE_APPROVAL_RULES.map((rule) => {
    const row = byRule.get(rule);
    return {
      rule,
      approvalRequired: row ? row.approval_required === true : true,
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

/**
 * Turn the approval on or off for one kind of restore. The caller checks the actor
 * holds `policies`. Writes the audit record first, so a change is never made without one.
 */
export async function setRestoreApprovalRule(client, { tenantRef, rule, approvalRequired, actor }) {
  if (!RESTORE_APPROVAL_RULES.includes(rule)) {
    throw new RestoreApprovalSettingError(`unknown kind of restore: ${rule} (one of ${RESTORE_APPROVAL_RULES.join(', ')})`);
  }
  if (typeof approvalRequired !== 'boolean') throw new RestoreApprovalSettingError('approvalRequired must be true or false');
  if (typeof actor !== 'string' || actor.length === 0) throw new RestoreApprovalSettingError('a setting change needs an actor');
  const before = (await getRestoreApprovalRules(client, { tenantRef })).find((entry) => entry.rule === rule);
  if (before.approvalRequired === approvalRequired && before.updatedAt) return { changed: false, setting: before };
  await appendEvidence(client, {
    tenantRef,
    kind: RESTORE_APPROVAL_SETTING_EVIDENCE_KIND,
    subject: { rule, approvalRequired, previous: before.approvalRequired },
    actor,
  });
  await client.query(
    `INSERT INTO restore_approval_rule (tenant_ref, rule, approval_required, updated_by, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (tenant_ref, rule)
       DO UPDATE SET approval_required = EXCLUDED.approval_required, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantRef, rule, approvalRequired, actor],
  );
  const setting = (await getRestoreApprovalRules(client, { tenantRef })).find((entry) => entry.rule === rule);
  return { changed: before.approvalRequired !== approvalRequired, setting };
}

const WORKLOAD_PATH_PREFIX = 'workload:';

const ordered = (all, picked) => all.filter((entry) => picked.has(entry));

/**
 * What a restore's dry run touches for its approval: { services, rules }. `services`
 * are the services it writes to; `rules` the kinds of restore it is (turning a
 * Conditional Access policy on, a compliance fix, a tenant-wide workload write, a
 * restore into another tenant, objects Keel cannot place in a service). Null when Keel
 * cannot read it (no dry run, no target tenant, nothing in its scope): then it waits
 * for a person.
 */
export async function restoreApprovalScope(client, artifact) {
  if (!artifact) return null;
  if (typeof artifact.targetTenantId !== 'string' || artifact.targetTenantId.length === 0) return null;
  const rules = new Set();
  const services = new Set();
  // Turning a policy on can lock people out: its own setting, on top of Entra's.
  if (artifact.conditionalAccessEnforcement) {
    rules.add('turn-on-conditional-access');
    services.add('Entra');
  }
  // A compliance fix writes the value a control asks for, not the backup's.
  if (artifact.complianceFix) rules.add('compliance-fix');
  // A tenant-wide workload write goes beyond the KEEL-RT- fixtures (issue #317).
  if (artifact.workloadRestore?.allowTenantWide === true) rules.add('tenant-wide');
  // The setting is the source tenant's; writing into another tenant is its own kind.
  if (tenantRefFor(artifact.targetTenantId) !== artifact.tenantRef) rules.add('other-tenant');
  const workload = artifact.workloadRestore?.workload
    ?? (String(artifact.collectorConfigPath ?? '').startsWith(WORKLOAD_PATH_PREFIX)
      ? String(artifact.collectorConfigPath).slice(WORKLOAD_PATH_PREFIX.length)
      : null);
  if (workload !== null) {
    const service = Object.hasOwn(WORKLOAD_RESTORE_SERVICES, workload) ? WORKLOAD_RESTORE_SERVICES[workload] : null;
    if (service) services.add(service);
    else rules.add('unplaced');
    return { services: ordered(RESTORE_APPROVAL_SERVICES, services), rules: ordered(RESTORE_APPROVAL_RULES, rules) };
  }
  const keys = [...new Set(artifact.closureKeys ?? [])];
  // A dry run that names nothing Keel can read waits for a person.
  if (keys.length === 0) return null;
  const types = new Map();
  for (const resource of artifact.reconciliationResources ?? []) {
    if (typeof resource?.naturalKey === 'string' && typeof resource?.resourceType === 'string') {
      types.set(resource.naturalKey, resource.resourceType);
    }
  }
  if (artifact.snapshotId && keys.length > 0) {
    const { rows } = await client.query(
      'SELECT natural_key, resource_type FROM resource_version WHERE snapshot_id = $1 AND natural_key = ANY($2::text[])',
      [artifact.snapshotId, keys],
    );
    for (const row of rows) if (!types.has(row.natural_key)) types.set(row.natural_key, row.resource_type);
  }
  for (const key of keys) {
    // Only a kind Keel has mapped counts as placed; a service guessed from a name does not.
    const type = types.get(key);
    const service = type !== undefined && typeInfo(type).known ? serviceForResourceType(type) : null;
    if (service) {
      services.add(service);
    } else {
      rules.add('unplaced');
      // The service its name suggests must have approvals off too, so turning
      // "unplaced" off never lets an Exchange-like kind past Exchange's setting.
      const guessed = type !== undefined ? serviceForResourceType(type) : null;
      if (guessed) services.add(guessed);
    }
  }
  return { services: ordered(RESTORE_APPROVAL_SERVICES, services), rules: ordered(RESTORE_APPROVAL_RULES, rules) };
}

/**
 * The services a restore's dry run writes to, or null when it is also one of the
 * kinds of restore with their own setting (restoreApprovalScope has both).
 */
export async function restoreArtifactServices(client, artifact) {
  const scope = await restoreApprovalScope(client, artifact);
  return scope && scope.rules.length === 0 ? scope.services : null;
}

// Whether a scope needs a person: it does unless every service and every kind of
// restore it touches has approvals off, and it touches at least one.
async function scopeNeedsApproval(client, { tenantRef, scope }) {
  if (!scope || (scope.services.length === 0 && scope.rules.length === 0)
    || typeof tenantRef !== 'string' || tenantRef.length === 0) {
    return { required: true, services: scope?.services ?? [], rules: scope?.rules ?? [] };
  }
  const offServices = new Set((await getRestoreApprovalSettings(client, { tenantRef }))
    .filter((entry) => !entry.approvalRequired).map((entry) => entry.service));
  const offRules = new Set((await getRestoreApprovalRules(client, { tenantRef }))
    .filter((entry) => !entry.approvalRequired).map((entry) => entry.rule));
  const required = scope.services.some((service) => !offServices.has(service))
    || scope.rules.some((rule) => !offRules.has(rule));
  return { required, services: scope.services, rules: scope.rules };
}

/**
 * Whether a restore still needs a person to approve it under the tenant's settings.
 * It does unless every service it writes to, and every kind of restore it is, has
 * approvals off. The setting follows the dry run's tenant (its source), as
 * content-effect approvals do. Returns { required, services, rules }.
 */
export async function restoreNeedsApproval(client, { artifact }) {
  return scopeNeedsApproval(client, { tenantRef: artifact?.tenantRef, scope: await restoreApprovalScope(client, artifact) });
}

/**
 * Whether a content restore (mail, files, Teams messages) needs a person: it does
 * unless content restores and the workload's service both have approvals off. A
 * workload Keel cannot place always needs one. Returns { required, services, rules }.
 */
export async function contentRestoreNeedsApproval(client, { tenantRef, workload }) {
  const service = Object.hasOwn(CONTENT_RESTORE_SERVICES, String(workload)) ? CONTENT_RESTORE_SERVICES[workload] : null;
  if (!service) return { required: true, services: [], rules: ['content-restore'] };
  return scopeNeedsApproval(client, { tenantRef, scope: { services: [service], rules: ['content-restore'] } });
}

/** The plain reason kept on a request the settings approved. */
export function approvalsOffReason({ services = [], rules = [] }) {
  const names = [...services, ...rules.map((rule) => RESTORE_APPROVAL_RULE_NAMES[rule] ?? rule)];
  return `Restore approvals are off for ${names.join(', ')}`;
}
