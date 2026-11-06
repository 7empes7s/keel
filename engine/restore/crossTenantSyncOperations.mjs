/**
 * Issue #1015: each partner tenant's user sync settings
 * (crossTenantIdentitySyncPolicyPartner).
 *
 *  - create and update are one PUT of displayName and userSyncInbound to the
 *    partner's own identitySynchronization, keyed by its tenantId
 *    (crossTenantAccessPolicyConfigurationPartner-put-identitySynchronization).
 *    Nothing else is sent: the object holds no trust or sign-in field.
 *  - Graph refuses sync settings for a tenant that is not a partner, so the
 *    partner's cross-tenant access settings are read first; a partner that is
 *    not there, or a read that fails, writes nothing.
 *  - turning sync on lets the partner's sync job create accounts here, and
 *    those accounts stay when sync is turned off again. It is written only once
 *    its "changes admin access" and "can't be undone" effects are approved
 *    (safety/permanentEffects.mjs, approvalHeld.mjs permanentWriteRefusal).
 *    Turning it off, or a write that keeps it as it is, needs only the
 *    restore's own approval.
 *  - delete is not registered.
 *
 * The route follows the Graph v1.0 reference and is fixture-tested, not
 * live-qualified.
 */
import { permanentWriteRefusal } from './approvalHeld.mjs';
import { defineRecord, isNotFound, outcomeDetail } from './recordWriter.mjs';

const TYPE = 'crossTenantIdentitySyncPolicyPartner';
const PARTNERS = '/policies/crossTenantAccessPolicy/partners';
const PORTAL = 'Entra admin center > External Identities > Cross-tenant access settings';
const partnerPath = (tenantId) => `${PARTNERS}/${encodeURIComponent(tenantId)}`;
const syncPath = (tenantId) => `${partnerPath(tenantId)}/identitySynchronization`;

/** The partner's tenant id, from the backup. */
function partnerTenantId(resource) {
  const id = resource.payload?.tenantId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function syncRefusal(resource, verb, ctx) {
  if (!partnerTenantId(resource)) return { outcome: 'failed', reason: `${TYPE}: the backup does not say which partner tenant the sync settings belong to (tenantId)` };
  return permanentWriteRefusal(resource, verb, ctx);
}

/** Graph refuses sync settings for a tenant that is not a partner: its access settings must be there. */
async function partnerExists(io, { payload }) {
  const read = await io.retryOperation(() => io.writer.read('v1.0', partnerPath(payload.tenantId)));
  if (read?.ok === true) return null;
  if (isNotFound(read)) {
    return `the partner organization "${payload.displayName ?? 'from the backup'}" has no cross-tenant access settings in the target, and Graph takes sync settings only for a partner: `
      + `restore its cross-tenant access settings first, or add the organization in ${PORTAL}`;
  }
  return `the partner's cross-tenant access settings could not be read (${outcomeDetail(read)})`;
}

export const IDENTITY_SYNC_RECORD = defineRecord({
  resourceType: TYPE, version: 'v1.0', collection: PARTNERS,
  operations: ['create', 'update'], writable: ['displayName', 'userSyncInbound'], updateMethod: 'PUT',
  refusal: syncRefusal,
  preflight: partnerExists,
  writeVia: (io, { payload, sent }) => io.retryOperation(() => io.writer.write('v1.0', syncPath(payload.tenantId), { method: 'PUT', body: sent })),
  // The object has no id of its own: it is the partner's, by tenant id.
  readVia: async (io, { payload }) => {
    const read = await io.retryOperation(() => io.writer.read('v1.0', syncPath(payload.tenantId)));
    return read?.ok === true ? { ...read, body: { ...read.body, id: payload.tenantId } } : read;
  },
  writeRoute: `PUT ${PARTNERS}/{tenantId}/identitySynchronization`,
  permission: 'Policy.ReadWrite.CrossTenantAccess',
  docs: 'https://learn.microsoft.com/en-us/graph/api/crosstenantaccesspolicyconfigurationpartner-put-identitysynchronization?view=graph-rest-1.0',
});

/** The write of this module: the sync settings, at the partner's tenant id. */
export function identitySyncDispatch(resource) {
  if (resource.resourceType !== TYPE) return null;
  const tenantId = partnerTenantId(resource);
  // The live object is the partner's, by tenant id (it has no id of its own).
  return { record: IDENTITY_SYNC_RECORD, resource: tenantId ? { ...resource, targetId: resource.targetId ?? tenantId } : resource };
}
