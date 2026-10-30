// engine/govern/restoreApprovalSettings.mjs
//
// Restore approvals as a customer setting. Some restore changes are high impact: they
// shorten retention, release a hold, widen sharing, destroy content, run a script on
// devices or shorten a group's lifetime (safety/contentEffects.mjs and the workload
// effect rules). Whether such a change waits for a second person to approve it is the
// customer's choice, per service. It is on for every service until an admin turns it
// off, and each change is written to the audit record.
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

const WORKLOAD_PATH_PREFIX = 'workload:';

/**
 * The services a restore's dry run writes to, or null when Keel cannot place every
 * object in one (then the restore waits for an approver). Always null for turning a
 * Conditional Access policy on (it can lock people out), a compliance fix, a
 * tenant-wide workload write, and a restore into another tenant.
 */
export async function restoreArtifactServices(client, artifact) {
  if (!artifact || artifact.conditionalAccessEnforcement) return null;
  // A compliance fix writes the value a control asks for, not the backup's: not a restore.
  if (artifact.complianceFix) return null;
  // A tenant-wide workload write goes beyond the KEEL-RT- fixtures: a person approves it (issue #317).
  if (artifact.workloadRestore?.allowTenantWide === true) return null;
  // The setting is the source tenant's; a restore into another tenant waits for a person.
  if (typeof artifact.targetTenantId !== 'string' || artifact.targetTenantId.length === 0
    || tenantRefFor(artifact.targetTenantId) !== artifact.tenantRef) return null;
  const workload = artifact.workloadRestore?.workload
    ?? (String(artifact.collectorConfigPath ?? '').startsWith(WORKLOAD_PATH_PREFIX)
      ? String(artifact.collectorConfigPath).slice(WORKLOAD_PATH_PREFIX.length)
      : null);
  if (workload !== null) {
    const service = Object.hasOwn(WORKLOAD_RESTORE_SERVICES, workload) ? WORKLOAD_RESTORE_SERVICES[workload] : null;
    return service ? [service] : null;
  }
  const keys = [...new Set(artifact.closureKeys ?? [])];
  if (keys.length === 0) return null;
  const types = new Map();
  for (const resource of artifact.reconciliationResources ?? []) {
    if (typeof resource?.naturalKey === 'string' && typeof resource?.resourceType === 'string') {
      types.set(resource.naturalKey, resource.resourceType);
    }
  }
  if (artifact.snapshotId) {
    const { rows } = await client.query(
      'SELECT natural_key, resource_type FROM resource_version WHERE snapshot_id = $1 AND natural_key = ANY($2::text[])',
      [artifact.snapshotId, keys],
    );
    for (const row of rows) if (!types.has(row.natural_key)) types.set(row.natural_key, row.resource_type);
  }
  const services = new Set();
  for (const key of keys) {
    // Only a kind Keel has mapped counts as placed; a service guessed from a name does not.
    const type = types.get(key);
    const service = type !== undefined && typeInfo(type).known ? serviceForResourceType(type) : null;
    if (!service) return null;
    services.add(service);
  }
  return RESTORE_APPROVAL_SERVICES.filter((service) => services.has(service));
}

/**
 * Whether a restore still needs a person to approve it under the tenant's setting.
 * It does unless every service it writes to has restore approvals off. The setting
 * follows the dry run's tenant (its source), as content-effect approvals do.
 * Returns { required, services }.
 */
export async function restoreNeedsApproval(client, { artifact }) {
  const services = await restoreArtifactServices(client, artifact);
  if (!services?.length || typeof artifact.tenantRef !== 'string' || artifact.tenantRef.length === 0) {
    return { required: true, services: services ?? [] };
  }
  const settings = await getRestoreApprovalSettings(client, { tenantRef: artifact.tenantRef });
  const off = new Set(settings.filter((entry) => !entry.approvalRequired).map((entry) => entry.service));
  return { required: services.some((service) => !off.has(service)), services };
}
