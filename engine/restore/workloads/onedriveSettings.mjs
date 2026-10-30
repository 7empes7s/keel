/**
 * OneDrive site settings restore: puts one named OneDrive site's sharing settings back
 * as the `onedrive-site-settings` backup had them (engine/collect/workloads/onedrive.mjs),
 * with Set-PnPTenantSite (writeDeclarations.mjs, `onedrive.site-settings.update`).
 *
 * The plan and the promotion are the shared cmdlet workload ones (cmdletSettings.mjs):
 * immutable plan, per-operation qualification, content-effect approval for anything that
 * widens sharing, re-read before each write and read back after it, KEEL-RT- fixtures
 * only on the test tenant. This module only wires the OneDrive read to them:
 *  - the sites to read are the ones the backup holds, each a personal site on one
 *    -my.sharepoint.com host (anything else refuses the plan, nothing is read);
 *  - each site is one object of the `onedriveSite` family.
 * A value the backup shows as the tenant's OneDrive default is never pinned on the site,
 * a locked site is never changed or unlocked, and the owner, quota, sensitivity label and
 * conditional access setting are listed for an administrator.
 */
import { ONEDRIVE_WORKLOAD, OneDriveScopeError, oneDriveSite, readOneDrive } from '../../collect/workloads/onedrive.mjs';
import {
  createWorkloadSettingsArtifact, executeWorkloadSettingsRestore, loadWorkloadSource, planWorkloadSettingsRestore,
} from './cmdletSettings.mjs';
import { ONEDRIVE_WRITE_OPERATION } from './writeDeclarations.mjs';

export const ONEDRIVE_FAMILY = 'onedriveSite';
const KEY_PREFIX = 'onedrive:';
const withKind = (entry) => ({ ...entry, kind: ONEDRIVE_FAMILY });

/** The OneDrive sites a backup or plan names, and their one -my host. Throws when they are not personal sites on one host. */
export function oneDriveScope(urls) {
  const hosts = new Set();
  for (const url of urls) {
    try { hosts.add(new URL(url).hostname.toLowerCase()); } catch { throw new OneDriveScopeError(`${url} is not a OneDrive site address`); }
  }
  if (hosts.size > 1) throw new OneDriveScopeError('the OneDrive sites are not on one host');
  const [myHost = null] = [...hosts];
  // oneDriveSite throws for another host, a path inside a site, a query or a fragment.
  const sites = myHost ? urls.map((url) => oneDriveSite(url, myHost)) : [];
  return { sites, myHost };
}

/** The sites a plan restores, from its resource keys. */
export function planSites(plan) {
  return (plan?.targets ?? []).filter((key) => key.startsWith(KEY_PREFIX)).map((key) => key.slice(KEY_PREFIX.length));
}

/** A read of the named sites, each as one `onedriveSite` object. */
export function oneDriveReader(readImpl = readOneDrive) {
  return async ({ powershell, sites }) => {
    const { sites: named, myHost } = oneDriveScope(sites);
    if (!named.length) return { resources: [], failures: [] };
    const read = await readImpl({ powershell, sites: named, myHost });
    // A named site the read refused is not known now; the planner lists it, never writes it.
    return { ...read, resources: (read.resources ?? []).map(withKind) };
  };
}

/** The recorded backup with each site as one `onedriveSite` object. */
export async function loadOneDriveSource(client, { tenantRef, collectionId }) {
  const source = await loadWorkloadSource(client, { tenantRef, collectionId, workload: ONEDRIVE_WORKLOAD });
  return source ? { ...source, observations: source.observations.map(withKind) } : null;
}

/** The dispatch.mjs entry. */
export function oneDriveSettingsRestore({ readImpl = readOneDrive } = {}) {
  const read = oneDriveReader(readImpl);
  return Object.freeze({
    label: 'OneDrive settings',
    operations: Object.freeze([ONEDRIVE_WRITE_OPERATION]),
    usage: '--collection <id> [--target <key> ...]',
    async plan(client, { tenantRef, tenantId, request, connection }) {
      if (typeof request.collectionId !== 'string' || !request.collectionId) throw new Error('--collection <id> is required for this workload');
      const source = await loadOneDriveSource(client, { tenantRef, collectionId: request.collectionId });
      if (!source) throw new Error(`no recorded OneDrive settings collection ${request.collectionId} for this tenant`);
      const named = new Set((request.targets ?? []).map((key) => String(key).toLowerCase()));
      const sites = source.observations
        .filter((item) => !named.size || named.has(item.resourceKey))
        .map((item) => item.fields.url ?? item.resourceKey.slice(KEY_PREFIX.length));
      const live = await read({ powershell: connection.powershell, sites });
      return planWorkloadSettingsRestore({
        workload: ONEDRIVE_WORKLOAD, source, live, tenantId, tenantRef, targets: request.targets ?? [], allowTenantWide: request.allowTenantWide === true,
      });
    },
    create: createWorkloadSettingsArtifact,
    execute: (client, { tenantRef, artifactId, tenantId, plan, connection, qualifications }) => executeWorkloadSettingsRestore(client, {
      tenantRef, artifactId, tenantId, workload: ONEDRIVE_WORKLOAD, powershell: connection.powershell, qualifications,
      read: ({ powershell }) => read({ powershell, sites: planSites(plan) }),
    }),
  });
}
