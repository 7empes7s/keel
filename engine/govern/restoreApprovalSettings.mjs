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
