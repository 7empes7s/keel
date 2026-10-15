/**
 * Gap register W2: the one table cli/keel-restore.mjs uses to plan and promote a
 * workload restore (SharePoint settings and site app grants, Exchange, Teams, Purview, and from Wave 2 WKLD mail
 * flow, the Exchange settings READ-EXO added, Teams org-wide and voice policies,
 * Purview retention and DLP, and retention labels: cmdletSettings.mjs).
 *
 * A workload artifact has no snapshot and no credential files of its own: its
 * config paths are the marker `workload:<name>`. Its plan is in
 * `artifact.workloadRestore`, and `plan.workload` names the entry below. Each
 * entry only wires the CLI's inputs to the existing workload module; every
 * safety rule (qualification, digest, content-effect approval, re-read before
 * write, read-back) stays in that module's own execute function.
 */
import { PURVIEW_WORKLOAD, loadPurviewCollection, readPurview } from '../../collect/workloads/purview.mjs';
import { SHAREPOINT_WORKLOAD } from '../../collect/workloads/sharepoint.mjs';
import { EXCHANGE_WORKLOAD } from '../../collect/workloads/exchange.mjs';
import { TEAMS_WORKLOAD } from '../../collect/workloads/teams.mjs';
import { EXCHANGE_EXTENDED_WORKLOAD, readExchangeExtended } from '../../collect/workloads/exchangeExtended.mjs';
import { MAIL_FLOW_WORKLOAD, readMailFlow } from '../../collect/workloads/mailFlow.mjs';
import { PURVIEW_EXTENDED_WORKLOAD, readPurviewExtended } from '../../collect/workloads/purviewExtended.mjs';
import { RETENTION_DLP_WORKLOAD, readRetentionDlp } from '../../collect/workloads/purviewRetentionDlp.mjs';
import { TEAMS_EXTENDED_WORKLOAD, readTeamsExtended } from '../../collect/workloads/teamsExtended.mjs';
import { TEAMS_POLICY_WORKLOAD, readTeamsPolicies } from '../../collect/workloads/teamsPolicies.mjs';
import {
  SHAREPOINT_WRITE_OPERATION, createSharePointRestoreArtifact, executeSharePointRestore, loadSharePointSource,
  planSharePointRestore, readLiveSettings,
} from './sharepoint.mjs';
import {
  SITE_GRANTS_RESTORE, SITE_GRANT_WRITE_OPERATIONS, createSiteGrantsRestoreArtifact, executeSiteGrantsRestore,
  planSiteGrantsRestore, readLiveSiteGrants,
} from './sharepointSiteGrants.mjs';
import {
  EXCHANGE_WRITE_OPERATIONS, createExchangeRestoreArtifact, executeExchangeRestore, loadExchangeSource,
  planExchangeRestore, readLiveExchange,
} from './exchange.mjs';
import {
  TEAMS_WRITE_OPERATIONS, createTeamsRestoreArtifact, executeTeamsRestore, loadTeamsSource, planTeamsRestore, readLiveTeam,
} from './teams.mjs';
import { PURVIEW_WRITE_OPERATIONS, createPurviewRestoreArtifact, executePurviewRestore, planPurviewRestore } from './purview.mjs';
import { workloadSettingsRestore } from './cmdletSettings.mjs';

export const WORKLOAD_CONFIG_PREFIX = 'workload:';

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required for this workload`);
  return value;
}

async function source(load, client, { tenantRef, collectionId }, label) {
  const found = await load(client, { tenantRef, collectionId: required(collectionId, '--collection <id>') });
  if (!found) throw new Error(`no recorded ${label} collection ${collectionId} for this tenant`);
  return found;
}

/**
 * plan(client, { tenantRef, tenantId, request, connection, sleep }) reads the source
 * collection and the live state (with the collector connection) and returns the
 * frozen plan. execute(client, { tenantRef, artifactId, tenantId, plan, connection,
 * qualifications, sleep }) promotes it with the restorer connection.
 */
export const WORKLOAD_RESTORES = Object.freeze({
  [SHAREPOINT_WORKLOAD]: Object.freeze({
    label: 'SharePoint',
    operations: Object.freeze([SHAREPOINT_WRITE_OPERATION]),
    usage: '--collection <id> --tenant-host <host>.sharepoint.com',
    async plan(client, { tenantRef, request, connection, sleep }) {
      const tenantHost = required(request.tenantHost, '--tenant-host <host>');
      const recorded = await source(loadSharePointSource, client, { tenantRef, collectionId: request.collectionId }, 'SharePoint');
      const live = await readLiveSettings({ transport: connection.transport, sleep });
      return planSharePointRestore({ source: recorded, live, tenantHost });
    },
    create: createSharePointRestoreArtifact,
    // The plan's host is used because the restorer's tenant was already matched
    // to the artifact's tenant by the caller; Graph scopes the settings to that tenant.
    execute: (client, { tenantRef, artifactId, plan, connection, qualifications, sleep }) => executeSharePointRestore(client, {
      tenantRef, artifactId, tenantHost: plan.tenantHost, transport: connection.transport,
      qualification: qualifications[SHAREPOINT_WRITE_OPERATION], sleep,
    }),
  }),
  // Gap 5: one site's app grants, from the same sharepoint-site-settings collection.
  [SITE_GRANTS_RESTORE]: Object.freeze({
    label: 'SharePoint site app grants',
    operations: SITE_GRANT_WRITE_OPERATIONS,
    usage: '--collection <id> --tenant-host <host>.sharepoint.com --site <site id>',
    async plan(client, { tenantRef, request, connection, sleep }) {
      const tenantHost = required(request.tenantHost, '--tenant-host <host>');
      const siteId = required(request.siteId, '--site <site id>');
      const recorded = await source(loadSharePointSource, client, { tenantRef, collectionId: request.collectionId }, 'SharePoint');
      const live = await readLiveSiteGrants({ transport: connection.transport, siteId, sleep });
      return planSiteGrantsRestore({ source: recorded, live, tenantHost, siteId });
    },
    create: createSiteGrantsRestoreArtifact,
    execute: (client, { tenantRef, artifactId, plan, connection, qualifications, sleep }) => executeSiteGrantsRestore(client, {
      tenantRef, artifactId, tenantHost: plan.tenantHost, transport: connection.transport, qualifications, sleep,
    }),
  }),
  [EXCHANGE_WORKLOAD]: Object.freeze({
    label: 'Exchange',
    operations: EXCHANGE_WRITE_OPERATIONS,
    usage: '--collection <id> --mailbox <user principal name> [--include-organization]',
    async plan(client, { tenantRef, tenantId, request, connection, sleep }) {
      const mailbox = required(request.mailbox, '--mailbox <user principal name>');
      const includeOrganization = request.includeOrganization === true;
      const recorded = await source(loadExchangeSource, client, { tenantRef, collectionId: request.collectionId }, 'Exchange');
      const live = await readLiveExchange({
        transport: connection.transport, powershell: connection.powershell, mailbox, includeOrganization, sleep,
      });
      return planExchangeRestore({ source: recorded, live, tenantId, mailbox, includeOrganization });
    },
    create: createExchangeRestoreArtifact,
    execute: (client, { tenantRef, artifactId, tenantId, connection, qualifications, sleep }) => executeExchangeRestore(client, {
      tenantRef, artifactId, tenantId, transport: connection.transport, powershell: connection.powershell, qualifications, sleep,
    }),
  }),
  [TEAMS_WORKLOAD]: Object.freeze({
    label: 'Teams',
    operations: TEAMS_WRITE_OPERATIONS,
    usage: '--collection <id> --team <team id>',
    async plan(client, { tenantRef, tenantId, request, connection, sleep }) {
      const teamId = required(request.teamId, '--team <team id>');
      const recorded = await source(loadTeamsSource, client, { tenantRef, collectionId: request.collectionId }, 'Teams');
      const live = await readLiveTeam({ transport: connection.transport, teamId, sleep });
      return planTeamsRestore({ source: recorded, live, tenantId, teamId });
    },
    create: createTeamsRestoreArtifact,
    execute: (client, { tenantRef, artifactId, tenantId, connection, qualifications, sleep }) => executeTeamsRestore(client, {
      tenantRef, artifactId, tenantId, transport: connection.transport, qualifications, sleep,
    }),
  }),
  [PURVIEW_WORKLOAD]: Object.freeze({
    label: 'Purview',
    operations: PURVIEW_WRITE_OPERATIONS,
    usage: '--collection <id> --target label:<id> [--target label-policy:<id> ...]',
    async plan(client, { tenantRef, tenantId, request, connection }) {
      const recorded = await source(loadPurviewCollection, client, { tenantRef, collectionId: request.collectionId }, 'Purview');
      const live = await readPurview({ powershell: connection.powershell });
      return planPurviewRestore({ source: recorded, live, tenantId, targets: request.targets ?? [] });
    },
    create: createPurviewRestoreArtifact,
    execute: (client, { tenantRef, artifactId, tenantId, connection, qualifications }) => executePurviewRestore(client, {
      tenantRef, artifactId, tenantId, powershell: connection.powershell, qualifications,
    }),
  }),
  // Wave 2 WKLD: one Set- (or New-) cmdlet per object, re-read with the workload's own collector.
  [MAIL_FLOW_WORKLOAD]: workloadSettingsRestore({ workload: MAIL_FLOW_WORKLOAD, label: 'Mail flow', read: readMailFlow }),
  [EXCHANGE_EXTENDED_WORKLOAD]: workloadSettingsRestore({ workload: EXCHANGE_EXTENDED_WORKLOAD, label: 'Exchange settings', read: readExchangeExtended }),
  [TEAMS_POLICY_WORKLOAD]: workloadSettingsRestore({ workload: TEAMS_POLICY_WORKLOAD, label: 'Teams org-wide policies', read: readTeamsPolicies }),
  [TEAMS_EXTENDED_WORKLOAD]: workloadSettingsRestore({ workload: TEAMS_EXTENDED_WORKLOAD, label: 'Teams voice and live event policies', read: readTeamsExtended }),
  [RETENTION_DLP_WORKLOAD]: workloadSettingsRestore({ workload: RETENTION_DLP_WORKLOAD, label: 'Purview retention and DLP', read: readRetentionDlp }),
  [PURVIEW_EXTENDED_WORKLOAD]: workloadSettingsRestore({ workload: PURVIEW_EXTENDED_WORKLOAD, label: 'Purview retention labels', read: readPurviewExtended }),
});

/** The table entry for a workload name, or a usage error naming the ones that exist. */
export function workloadRestoreFor(workload, restores = WORKLOAD_RESTORES) {
  const entry = Object.hasOwn(restores, workload) ? restores[workload] : null;
  if (!entry) throw new Error(`unknown workload "${workload}"; one of: ${Object.keys(restores).join(', ')}`);
  return entry;
}

/** True for an artifact made by a workload restore (no snapshot, marker config paths). */
export function isWorkloadArtifact(artifact) {
  return Boolean(artifact?.workloadRestore)
    || String(artifact?.collectorConfigPath ?? '').startsWith(WORKLOAD_CONFIG_PREFIX);
}

/** A fetch-backed Graph transport for one bearer token: (url, init?) -> { status, headers, body }. */
export function graphTransport(token, fetchImpl = globalThis.fetch) {
  return async (url, init) => {
    const response = await fetchImpl(url, {
      method: init?.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
  };
}
