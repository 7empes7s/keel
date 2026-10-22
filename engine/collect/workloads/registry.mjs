/**
 * The workload collector registry: every collector `keel-workload-collect run` runs, in
 * run order. Registration is static and explicit, like engine/collect/registry.mjs.
 *
 * To add a collector, add one import and one entry, each in file-name order (the
 * order below), so collectors added in parallel land on different lines. The order
 * only decides the order of the log, never what may run: each workload's activation
 * comes from the task-101 ledger.
 *
 * An entry is { workload, powershellFamily, record, collect }:
 * - powershellFamily names the scope file's powershellConfigs key the workload
 *   connects with, or null for a Graph-only workload.
 * - collect(client, { base, config, scope, transport, powershell, sleep }) runs one
 *   collection; `powershell` is already resolved for the workload's family.
 * - record(client, { tenantRef, result }) stores a run that failed before collect
 *   could record one.
 */
import { collectExchange, recordExchangeRun } from './exchange.mjs';
import { collectExchangeExtended, recordExchangeExtendedRun } from './exchangeExtended.mjs';
import { collectExchangeRoleGroups, recordExchangeRoleGroupsRun } from './exchangeRoleGroups.mjs';
import { collectMailFlow, recordMailFlowRun } from './mailFlow.mjs';
import { collectOneDrive, recordOneDriveRun } from './onedrive.mjs';
import { POWER_PLATFORM_WORKLOAD, collectPowerPlatform, powerPlatformTransportFor, recordPowerPlatformRun } from './powerPlatform.mjs';
import { collectPurview, recordPurviewRun } from './purview.mjs';
import { collectPurviewExtended, recordPurviewExtendedRun } from './purviewExtended.mjs';
import { collectRetentionDlp, recordRetentionDlpRun } from './purviewRetentionDlp.mjs';
import { SHAREPOINT_WORKLOAD, collectSharePointSites, recordSharePointRun } from './sharepoint.mjs';
import { collectTeams, recordTeamsRun } from './teams.mjs';
import { collectTeamsExtended, recordTeamsExtendedRun } from './teamsExtended.mjs';
import { collectTeamsPolicies, recordTeamsPolicyRun } from './teamsPolicies.mjs';

export const WORKLOAD_COLLECTORS = Object.freeze([
  // exchange.mjs
  { workload: 'exchange-mailbox-settings', powershellFamily: 'exchange', record: recordExchangeRun,
    collect: (client, { base, transport, powershell, scope, sleep }) => collectExchange(client, {
      ...base, sleep, transport, powershell, mailboxes: scope.mailboxes ?? [] }) },
  // exchangeExtended.mjs
  { workload: 'exchange-extended', powershellFamily: 'exchange', record: recordExchangeExtendedRun,
    collect: (client, { base, powershell }) => collectExchangeExtended(client, { ...base, powershell }) },
  // exchangeRoleGroups.mjs
  { workload: 'exchange-role-groups', powershellFamily: 'exchange', record: recordExchangeRoleGroupsRun,
    collect: (client, { base, powershell }) => collectExchangeRoleGroups(client, { ...base, powershell }) },
  // mailFlow.mjs
  { workload: 'exchange-mail-flow', powershellFamily: 'exchange', record: recordMailFlowRun,
    collect: (client, { base, powershell }) => collectMailFlow(client, { ...base, powershell }) },
  // onedrive.mjs
  { workload: 'onedrive-site-settings', powershellFamily: 'onedrive', record: recordOneDriveRun,
    collect: (client, { base, powershell, scope }) => collectOneDrive(client, {
      ...base, powershell, sites: scope.onedriveSites ?? [], myHost: scope.onedriveHost }) },
  // powerPlatform.mjs: its own admin API transport, not the Graph one.
  { workload: POWER_PLATFORM_WORKLOAD, powershellFamily: null, record: recordPowerPlatformRun,
    collect: (client, { base, config, sleep }) => collectPowerPlatform(client, { ...base, sleep, transport: powerPlatformTransportFor(config) }) },
  // purview.mjs
  { workload: 'purview-labels', powershellFamily: 'purview', record: recordPurviewRun,
    collect: (client, { base, powershell }) => collectPurview(client, { ...base, powershell }) },
  // purviewExtended.mjs
  { workload: 'purview-governance', powershellFamily: 'purview', record: recordPurviewExtendedRun,
    collect: (client, { base, powershell }) => collectPurviewExtended(client, { ...base, powershell }) },
  // purviewRetentionDlp.mjs
  { workload: 'purview-retention-dlp', powershellFamily: 'purview', record: recordRetentionDlpRun,
    collect: (client, { base, powershell }) => collectRetentionDlp(client, { ...base, powershell }) },
  // sharepoint.mjs
  // Graph reads, plus the per-site sharing read through PnP once that read is qualified.
  { workload: SHAREPOINT_WORKLOAD, powershellFamily: 'sharepoint', record: recordSharePointRun,
    collect: (client, { base, transport, scope, sleep, powershell }) => collectSharePointSites(client, {
      ...base, sleep, transport, tenantHost: scope.sharepointHost,
      // Only its own PnP config can connect; the Graph tenant config has no certificate.
      powershell: scope.powershellConfigs?.sharepoint ? powershell : null }) },
  // teams.mjs
  { workload: 'teams-settings', powershellFamily: null, record: recordTeamsRun,
    collect: (client, { base, transport, config, sleep }) => collectTeams(client, {
      ...base, sleep, transport, tenantId: config.tenantId }) },
  // teamsExtended.mjs
  { workload: 'teams-voice-policies', powershellFamily: 'teams', record: recordTeamsExtendedRun,
    collect: (client, { base, powershell }) => collectTeamsExtended(client, { ...base, powershell }) },
  // teamsPolicies.mjs
  { workload: 'teams-org-policies', powershellFamily: 'teams', record: recordTeamsPolicyRun,
    collect: (client, { base, powershell }) => collectTeamsPolicies(client, { ...base, powershell }) },
]);
