/**
 * Teams collaboration policies and meeting settings that Keel did not back up before
 * (gap audit 2026-10-30, section D): per-user external access, private and shared
 * channel creation, file storage, templates, Shifts, the Skype for Business upgrade,
 * Azure Communication Services federation, the tenant meeting configuration,
 * end-to-end encryption and compliance recording.
 *
 * Two read-only workloads in the MicrosoftTeams session, so each lands in its own group
 * on the portal's lists:
 *  - `teams-collaboration-policies` ("Organization policies"): external access, channels,
 *    files, team template, Shifts and upgrade policies, then the upgrade and ACS
 *    federation tenant configurations;
 *  - `teams-meeting-settings` ("Calling and meetings"): encryption, compliance recording
 *    and meeting template policies, then the tenant meeting configuration.
 * Each family is its own task-101 operation and one Get cmdlet run with no parameters.
 *
 * Rules (the same as teamsPolicies.mjs and teamsExtended.mjs, which this does not change):
 *  - Read only. Only the Get cmdlets in each workload's CMDLET_PARAMETERS run, with no
 *    parameters. No write capability exists for these workloads.
 *  - Declared fields only (cmdletFamilies.mjs). Anything else an answer carries is
 *    dropped unread. No declared field holds a secret; a credential-shaped value is
 *    still redacted.
 *  - Policies are keyed by Identity (`Global` or `Tag:<name>`), configurations by
 *    `Global` only. Nothing is keyed by a name a user can change.
 *  - Errors are structured. A family that fails is `failed` or `denied`, never an empty list.
 *  - Disabled until qualified. Nothing is sent unless the Teams workload is qualified AND
 *    every read of the workload is live-qualified and enabled.
 *
 * Fields were declared from Microsoft's cmdlet documentation (Set-/New- pages, 2026-10-30)
 * and have not been checked against the live module yet; the live read check names any
 * declared field an answer lacks (unknownFields) so the list can be corrected.
 * Org-wide app settings (/teamwork/teamsAppSettings) are not here: Graph offers them to
 * delegated callers only.
 */
import { registerWorkload } from '../registry.mjs';
import { runCmdlet } from '../../powershell/jobQueue.mjs';
import { structuredFailure } from './exchange.mjs';
import { teamsActivation } from './teams.mjs';
import {
  emptyRead, ledgerRows, objectsFrom, policyIdentityOf, recordCmdletRun, recordDisabledRun, summarize,
} from './cmdletFamilies.mjs';

export const TEAMS_COLLABORATION_WORKLOAD = 'teams-collaboration-policies';
export const TEAMS_MEETING_SETTINGS_WORKLOAD = 'teams-meeting-settings';
export const TEAMS_COLLABORATION_MODULE = 'MicrosoftTeams';
export const DEFAULT_MAX_OBJECTS = 1000;

const policy = (body) => policyIdentityOf(body?.Identity);
const singleton = (body) => (policyIdentityOf(body?.Identity) === 'global' ? 'global' : null);

/**
 * `required` families always answer in a working tenant (each has its Global policy or
 * configuration), so an empty answer is a gap. A compliance recording policy exists
 * only once an admin creates one.
 */
export const COLLABORATION_FAMILIES = Object.freeze({
  externalAccessPolicy: Object.freeze({
    operation: 'teams.external-access-policies', cmdlet: 'Get-CsExternalAccessPolicy', prefix: 'external-access-policy', identity: policy, required: true,
    fields: Object.freeze([
      'Identity', 'Description', 'EnableFederationAccess', 'CommunicationWithExternalOrgs', 'AllowedExternalDomains', 'BlockedExternalDomains',
      'EnableTeamsConsumerAccess', 'EnableTeamsConsumerInbound', 'RestrictTeamsConsumerAccessToExternalUserProfiles', 'EnableAcsFederationAccess',
      'EnablePublicCloudAudioVideoAccess', 'EnableOutsideAccess', 'FederatedBilateralChats',
    ]),
  }),
  channelsPolicy: Object.freeze({
    operation: 'teams.channels-policies', cmdlet: 'Get-CsTeamsChannelsPolicy', prefix: 'channels-policy', identity: policy, required: true,
    fields: Object.freeze([
      'Identity', 'Description', 'AllowOrgWideTeamCreation', 'EnablePrivateTeamDiscovery', 'AllowPrivateChannelCreation',
      'AllowSharedChannelCreation', 'AllowChannelSharingToExternalUser', 'AllowUserToParticipateInExternalSharedChannel',
    ]),
  }),
  filesPolicy: Object.freeze({
    operation: 'teams.files-policies', cmdlet: 'Get-CsTeamsFilesPolicy', prefix: 'files-policy', identity: policy, required: true,
    fields: Object.freeze(['Identity', 'NativeFileEntryPoints', 'SPChannelFilesTab']),
  }),
  templatePermissionPolicy: Object.freeze({
    operation: 'teams.template-permission-policies', cmdlet: 'Get-CsTeamsTemplatePermissionPolicy', prefix: 'template-permission-policy', identity: policy, required: true,
    fields: Object.freeze(['Identity', 'Description', 'HiddenTemplates']),
  }),
  shiftsPolicy: Object.freeze({
    operation: 'teams.shifts-policies', cmdlet: 'Get-CsTeamsShiftsPolicy', prefix: 'shifts-policy', identity: policy, required: true,
    fields: Object.freeze([
      'Identity', 'ShiftNoticeFrequency', 'ShiftNoticeMessageType', 'ShiftNoticeMessageCustom', 'AccessType', 'AccessGracePeriodMinutes',
    ]),
  }),
  upgradePolicy: Object.freeze({
    operation: 'teams.upgrade-policies', cmdlet: 'Get-CsTeamsUpgradePolicy', prefix: 'upgrade-policy', identity: policy, required: true,
    fields: Object.freeze(['Identity', 'Description', 'Mode', 'NotifySfbUsers']),
  }),
  upgradeConfiguration: Object.freeze({
    operation: 'teams.upgrade-configuration', cmdlet: 'Get-CsTeamsUpgradeConfiguration', prefix: 'upgrade-configuration', identity: singleton, required: true,
    fields: Object.freeze(['Identity', 'DownloadTeams', 'SfBMeetingJoinUx']),
  }),
  acsFederationConfiguration: Object.freeze({
    operation: 'teams.acs-federation-configuration', cmdlet: 'Get-CsTeamsAcsFederationConfiguration', prefix: 'acs-federation-configuration', identity: singleton, required: true,
    fields: Object.freeze(['Identity', 'EnableAcsUsers', 'AllowedAcsResources']),
  }),
});

export const MEETING_SETTINGS_FAMILIES = Object.freeze({
  enhancedEncryptionPolicy: Object.freeze({
    operation: 'teams.enhanced-encryption-policies', cmdlet: 'Get-CsTeamsEnhancedEncryptionPolicy', prefix: 'enhanced-encryption-policy', identity: policy, required: true,
    fields: Object.freeze(['Identity', 'Description', 'CallingEndtoEndEncryptionEnabledType', 'MeetingEndToEndEncryption']),
  }),
  complianceRecordingPolicy: Object.freeze({
    operation: 'teams.compliance-recording-policies', cmdlet: 'Get-CsTeamsComplianceRecordingPolicy', prefix: 'compliance-recording-policy', identity: policy, required: false,
    fields: Object.freeze([
      'Identity', 'Description', 'Enabled', 'WarnUserOnRemoval', 'DisableComplianceRecordingAudioNotificationForCalls', 'ComplianceRecordingApplications',
    ]),
  }),
  meetingTemplatePermissionPolicy: Object.freeze({
    operation: 'teams.meeting-template-permission-policies', cmdlet: 'Get-CsTeamsMeetingTemplatePermissionPolicy', prefix: 'meeting-template-permission-policy', identity: policy, required: true,
    fields: Object.freeze(['Identity', 'Description', 'HiddenMeetingTemplates']),
  }),
  meetingConfiguration: Object.freeze({
    operation: 'teams.meeting-configuration', cmdlet: 'Get-CsTeamsMeetingConfiguration', prefix: 'meeting-configuration', identity: singleton, required: true,
    fields: Object.freeze([
      'Identity', 'DisableAnonymousJoin', 'DisableAppInteractionForAnonymousUsers', 'FeedbackSurveyForAnonymousUsers', 'LimitPresenterRolePermissions',
      'LogoURL', 'LegalURL', 'HelpURL', 'CustomFooterText', 'EnableQoS', 'ClientMediaPortRangeEnabled', 'ClientAudioPort', 'ClientAudioPortRange',
      'ClientVideoPort', 'ClientVideoPortRange', 'ClientAppSharingPort', 'ClientAppSharingPortRange',
    ]),
  }),
});

export class TeamsCollaborationScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TeamsCollaborationScopeError';
  }
}

/**
 * One read-only workload over `families`: its descriptor, allowlist, reader,
 * activation, recorder and gated collector.
 */
function teamsReadWorkload({ workload, type, families, label }) {
  const names = Object.freeze(Object.keys(families));
  const operations = Object.freeze(names.map((name) => families[name].operation));
  // The only cmdlets this workload runs, and the only parameters each may receive (none).
  // ops/powershell/run-cmdlet.ps1 ($AllowedTeamsCollaboration) holds both workloads' cmdlets.
  const parameters = Object.freeze(Object.fromEntries(names.map((name) => [families[name].cmdlet, Object.freeze([])])));
  const cmdlets = new Set(Object.keys(parameters));
  const descriptor = Object.freeze({ type, workload, adapter: workload, readOnly: true, enabledByDefault: false, operations });

  /** Throws unless the cmdlet is one of the reads above and is given no parameters. */
  function assertCmdlet({ cmdlet, parameters: given = {} }) {
    if (!parameters[cmdlet]) throw new TeamsCollaborationScopeError(`${cmdlet} is not a Teams ${label} read KEEL runs; this workload never writes, assigns policies or reads users`);
    for (const name of Object.keys(given)) throw new TeamsCollaborationScopeError(`${cmdlet} does not take ${name} from KEEL`);
    return true;
  }

  async function cmdletCall({ cmdlet, parameters: given = {} }, powershell = {}) {
    assertCmdlet({ cmdlet, parameters: given });
    const { tenantConfigPath = null, ...options } = powershell;
    return runCmdlet({ module: TEAMS_COLLABORATION_MODULE, cmdlet, parameters: given, tenantConfigPath }, { ...options, allowedCmdlets: cmdlets });
  }

  async function readFamily(family, { powershell, maxObjects }) {
    const spec = families[family];
    let output;
    try {
      ({ output } = await cmdletCall({ cmdlet: spec.cmdlet }, powershell));
    } catch (error) {
      return emptyRead({ failure: { family, operation: spec.operation, ...structuredFailure(error) } });
    }
    return { ...emptyRead(), ...objectsFrom(family, spec, output, { maxObjects }) };
  }

  /** Reads the named families (all by default). No database, no gate. */
  async function read({ powershell = {}, families: chosen = names, maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() } = {}) {
    if (!Array.isArray(chosen) || chosen.length === 0) throw new TypeError(`the ${workload} read needs at least one family`);
    for (const family of chosen) if (!families[family]) throw new TypeError(`unknown ${workload} family ${family}`);
    const observedFrom = now().toISOString();
    const reads = {};
    for (const family of chosen) reads[family] = await readFamily(family, { powershell, maxObjects });
    return summarize({
      workload, families: chosen, reads, maxObjects,
      required: chosen.filter((family) => families[family].required),
      observedFrom, observedTo: now().toISOString(),
    });
  }

  /** Teams (team settings and membership) must be qualified first, then every read here. */
  function activation(ledger) {
    const { rows, describe } = ledgerRows(ledger);
    const reasons = [];
    const teams = teamsActivation(ledger);
    if (!teams.enabled) reasons.push(`Teams is not qualified yet, and Teams ${label} follow it: ${teams.reasons.join('; ')}`);
    for (const id of operations) if (!rows.get(id)?.enabled) reasons.push(describe(id));
    return { enabled: reasons.length === 0, reasons };
  }

  const record = (client, { tenantRef, result }) => recordCmdletRun(client, workload, { tenantRef, result });

  /** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
  async function collect(client, { tenantRef, ledger, powershell, maxObjects, now }) {
    const gate = activation(ledger);
    if (!gate.enabled) {
      const run = await recordDisabledRun(client, workload, { tenantRef, reasons: gate.reasons, now });
      return { run, result: null, activation: gate };
    }
    const result = await read({ powershell, maxObjects, now });
    const run = await record(client, { tenantRef, result });
    return { run, result, activation: gate };
  }

  /** Registry adapter: a direct call is refused until the workload is enabled. */
  const adapter = Object.freeze({
    async collect() {
      throw new Error(`the ${workload} workload adapter is disabled until live qualification; use its gated collector with the ledger`);
    },
  });
  registerWorkload(descriptor, adapter);

  return Object.freeze({ names, operations, parameters, descriptor, assertCmdlet, read, activation, record, collect });
}

const collaboration = teamsReadWorkload({
  workload: TEAMS_COLLABORATION_WORKLOAD, type: 'teamsCollaborationPolicy', families: COLLABORATION_FAMILIES, label: 'collaboration policies',
});
const meetings = teamsReadWorkload({
  workload: TEAMS_MEETING_SETTINGS_WORKLOAD, type: 'teamsMeetingSetting', families: MEETING_SETTINGS_FAMILIES, label: 'meeting settings',
});

export const TEAMS_COLLABORATION_OPERATIONS = collaboration.operations;
export const TEAMS_COLLABORATION_DESCRIPTOR = collaboration.descriptor;
export const TEAMS_COLLABORATION_CMDLET_PARAMETERS = collaboration.parameters;
export const assertTeamsCollaborationCmdlet = collaboration.assertCmdlet;
export const readTeamsCollaboration = collaboration.read;
export const teamsCollaborationActivation = collaboration.activation;
export const recordTeamsCollaborationRun = collaboration.record;
export const collectTeamsCollaboration = collaboration.collect;

export const TEAMS_MEETING_SETTINGS_OPERATIONS = meetings.operations;
export const TEAMS_MEETING_SETTINGS_DESCRIPTOR = meetings.descriptor;
export const TEAMS_MEETING_SETTINGS_CMDLET_PARAMETERS = meetings.parameters;
export const assertTeamsMeetingSettingsCmdlet = meetings.assertCmdlet;
export const readTeamsMeetingSettings = meetings.read;
export const teamsMeetingSettingsActivation = meetings.activation;
export const recordTeamsMeetingSettingsRun = meetings.record;
export const collectTeamsMeetingSettings = meetings.collect;
