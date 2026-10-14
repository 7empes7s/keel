/**
 * Wave 1 READ-TEAMS-PV: Teams calling, voice and live event policies, and the policies
 * assigned to each user and group.
 *
 * A workload of its own (`teams-voice-policies`), beside the issue #154 org-wide
 * policies (teamsPolicies.mjs), which it does not change. Thirteen families, each its
 * own task-101 operation and one Get cmdlet in the MicrosoftTeams session:
 *  - calling, voice routing, emergency calling and call routing, call park, caller ID
 *    and voicemail policies, and tenant dial plans;
 *  - live event (meeting broadcast) policies, town hall and webinar (events) policies,
 *    and the live event tenant configuration;
 *  - the policies assigned to each user (Get-CsOnlineUser, bounded by -ResultSize) and
 *    to each group (Get-CsGroupPolicyAssignment).
 *
 * Rules:
 *  - Read only. Only the Get cmdlets in TEAMS_EXTENDED_CMDLET_PARAMETERS run, and only
 *    Get-CsOnlineUser takes a parameter (-ResultSize). No write capability exists.
 *  - Declared fields only (cmdletFamilies.mjs). The live event configuration's
 *    `SdnApiToken` is a secret and is never declared: the backup is incomplete for it
 *    (TEAMS_EXTENDED_MISSING).
 *  - Policies are keyed by Identity (`Global` or `Tag:<name>`), users by object id and
 *    group assignments by group id and policy type. Nothing is keyed by a name a user
 *    can change.
 *  - Disabled until qualified. collectTeamsExtended() sends nothing unless the Teams
 *    workload is qualified (as for the org-wide policies) AND every read here is
 *    live-qualified and enabled.
 */
import { registerWorkload } from '../registry.mjs';
import { runCmdlet } from '../../powershell/jobQueue.mjs';
import { structuredFailure } from './exchange.mjs';
import { teamsActivation } from './teams.mjs';
import {
  emptyRead, guidOf, ledgerRows, objectsFrom, policyIdentityOf, recordCmdletRun, recordDisabledRun, summarize,
} from './cmdletFamilies.mjs';

export const TEAMS_EXTENDED_WORKLOAD = 'teams-voice-policies';
export const TEAMS_EXTENDED_MODULE = 'MicrosoftTeams';
export const DEFAULT_MAX_OBJECTS = 1000;
export const DEFAULT_MAX_USERS = 5000;

const policy = (body) => policyIdentityOf(body?.Identity);
const singleton = (body) => (policyIdentityOf(body?.Identity) === 'global' ? 'global' : null);
const user = (body) => guidOf(body?.Identity);
// A group holds at most one assignment per policy type.
const POLICY_TYPE = /^[A-Za-z]{1,128}$/;
const groupAssignment = (body) => {
  const group = guidOf(body?.GroupId);
  const type = typeof body?.PolicyType === 'string' && POLICY_TYPE.test(body.PolicyType) ? body.PolicyType.toLowerCase() : null;
  return group && type ? `${group}/${type}` : null;
};

/**
 * The families. Fields were declared from Microsoft's cmdlet documentation, not
 * measured live. `required` families always answer in a working tenant (every policy
 * list has its Global policy, and a tenant has users), so an empty answer is a gap.
 */
export const FAMILIES = Object.freeze({
  callingPolicy: Object.freeze({
    operation: 'teams.calling-policies', cmdlet: 'Get-CsTeamsCallingPolicy', prefix: 'calling-policy', identity: policy, required: true,
    fields: Object.freeze([
      'Identity', 'Description', 'AllowPrivateCalling', 'AllowWebPSTNCalling', 'AllowSIPDevicesCalling', 'AllowVoicemail', 'AllowCallGroups',
      'AllowDelegation', 'AllowCallForwardingToUser', 'AllowCallForwardingToPhone', 'AllowCallRedirect', 'PreventTollBypass',
      'BusyOnBusyEnabledType', 'MusicOnHoldEnabledType', 'AllowCloudRecordingForCalls', 'AllowTranscriptionForCalling',
      'LiveCaptionsEnabledTypeForCalling', 'AutoAnswerEnabledType', 'SpamFilteringEnabledType', 'CallRecordingExpirationDays',
      'InboundPstnCallRoutingTreatment', 'InboundFederatedCallRoutingTreatment', 'PopoutForIncomingPstnCalls', 'PopoutAppPathForIncomingPstnCalls',
    ]),
  }),
  voiceRoutingPolicy: Object.freeze({
    operation: 'teams.voice-routing-policies', cmdlet: 'Get-CsOnlineVoiceRoutingPolicy', prefix: 'voice-routing-policy', identity: policy, required: true,
    fields: Object.freeze(['Identity', 'Description', 'OnlinePstnUsages', 'RouteType']),
  }),
  dialPlan: Object.freeze({
    operation: 'teams.dial-plans', cmdlet: 'Get-CsTenantDialPlan', prefix: 'dial-plan', identity: policy, required: true,
    fields: Object.freeze(['Identity', 'Description', 'SimpleName', 'NormalizationRules', 'OptimizeDeviceDialing', 'ExternalAccessPrefix']),
  }),
  emergencyCallingPolicy: Object.freeze({
    operation: 'teams.emergency-calling-policies', cmdlet: 'Get-CsTeamsEmergencyCallingPolicy', prefix: 'emergency-calling-policy', identity: policy, required: true,
    fields: Object.freeze([
      'Identity', 'Description', 'NotificationGroup', 'NotificationDialOutNumber', 'NotificationMode', 'ExternalLocationLookupMode',
      'EnhancedEmergencyServiceDisclaimer', 'ExtendedNotifications',
    ]),
  }),
  emergencyCallRoutingPolicy: Object.freeze({
    operation: 'teams.emergency-call-routing-policies', cmdlet: 'Get-CsTeamsEmergencyCallRoutingPolicy', prefix: 'emergency-call-routing-policy', identity: policy, required: true,
    fields: Object.freeze(['Identity', 'Description', 'EmergencyNumbers', 'AllowEnhancedEmergencyServices']),
  }),
  callParkPolicy: Object.freeze({
    operation: 'teams.call-park-policies', cmdlet: 'Get-CsTeamsCallParkPolicy', prefix: 'call-park-policy', identity: policy, required: true,
    fields: Object.freeze(['Identity', 'Description', 'AllowCallPark', 'ParkTimeoutSeconds', 'PickupRangeStart', 'PickupRangeEnd']),
  }),
  callerIdPolicy: Object.freeze({
    operation: 'teams.caller-id-policies', cmdlet: 'Get-CsCallingLineIdentity', prefix: 'caller-id-policy', identity: policy, required: true,
    fields: Object.freeze([
      'Identity', 'Description', 'CallingIDSubstitute', 'ServiceNumber', 'ResourceAccount', 'CompanyName', 'EnableUserOverride', 'BlockIncomingPstnCallerID',
    ]),
  }),
  voicemailPolicy: Object.freeze({
    operation: 'teams.voicemail-policies', cmdlet: 'Get-CsOnlineVoicemailPolicy', prefix: 'voicemail-policy', identity: policy, required: true,
    fields: Object.freeze([
      'Identity', 'Description', 'EnableTranscription', 'EnableTranscriptionProfanityMasking', 'EnableTranscriptionTranslation', 'ShareData',
      'EnableEditingCallAnswerRulesSetting', 'MaximumRecordingLength', 'PrimarySystemPromptLanguage', 'SecondarySystemPromptLanguage',
    ]),
  }),
  liveEventsPolicy: Object.freeze({
    operation: 'teams.live-events-policies', cmdlet: 'Get-CsTeamsMeetingBroadcastPolicy', prefix: 'live-events-policy', identity: policy, required: true,
    fields: Object.freeze(['Identity', 'Description', 'AllowBroadcastScheduling', 'AllowBroadcastTranscription', 'BroadcastAttendeeVisibilityMode', 'BroadcastRecordingMode']),
  }),
  eventsPolicy: Object.freeze({
    operation: 'teams.events-policies', cmdlet: 'Get-CsTeamsEventsPolicy', prefix: 'events-policy', identity: policy, required: true,
    fields: Object.freeze([
      'Identity', 'Description', 'AllowWebinars', 'AllowTownhalls', 'AllowEmailEditing', 'EventAccessType', 'TownhallEventAttendeeAccess',
      'UseMicrosoftECDN', 'TownhallChatExperience', 'RecordingForTownhall', 'RecordingForWebinar', 'TranscriptionForTownhall',
      'TranscriptionForWebinar', 'AllowedQuestionTypesInRegistrationForm', 'AllowedTownhallTypesForRecordingPublish',
      'AllowedWebinarTypesForRecordingPublish', 'BroadcastPremiumApps', 'ImmersiveEvents',
    ]),
  }),
  liveEventsConfiguration: Object.freeze({
    operation: 'teams.live-events-configuration', cmdlet: 'Get-CsTeamsMeetingBroadcastConfiguration', prefix: 'live-events-configuration', identity: singleton, required: true,
    // SdnApiToken is a secret: never declared, so never read into a backup.
    fields: Object.freeze(['Identity', 'SupportURL', 'AllowSdnProviderForBroadcastMeeting', 'SdnName', 'SdnProviderName', 'SdnLicenseId', 'SdnApiTemplateUrl']),
  }),
  userPolicyAssignment: Object.freeze({
    operation: 'teams.user-policy-assignments', cmdlet: 'Get-CsOnlineUser', prefix: 'user-policy-assignment', identity: user, required: true,
    fields: Object.freeze([
      'Identity', 'UserPrincipalName', 'EnterpriseVoiceEnabled', 'LineURI',
      'TeamsCallingPolicy', 'OnlineVoiceRoutingPolicy', 'TenantDialPlan', 'TeamsEmergencyCallingPolicy', 'TeamsEmergencyCallRoutingPolicy',
      'TeamsCallParkPolicy', 'CallingLineIdentity', 'OnlineVoicemailPolicy', 'TeamsMeetingBroadcastPolicy', 'TeamsEventsPolicy',
      'TeamsMeetingPolicy', 'TeamsMessagingPolicy', 'TeamsAppSetupPolicy', 'TeamsAppPermissionPolicy', 'TeamsChannelsPolicy',
      'TeamsUpdateManagementPolicy', 'TeamsFeedbackPolicy',
    ]),
  }),
  groupPolicyAssignment: Object.freeze({
    operation: 'teams.group-policy-assignments', cmdlet: 'Get-CsGroupPolicyAssignment', prefix: 'group-policy-assignment', identity: groupAssignment, required: false,
    fields: Object.freeze(['GroupId', 'PolicyType', 'PolicyName', 'Priority']),
  }),
});
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
export const TEAMS_EXTENDED_OPERATIONS = Object.freeze(FAMILY_NAMES.map((name) => FAMILIES[name].operation));

/**
 * What a backup of this workload cannot hold, for the completeness records
 * (package INCOMPLETE): a secret Microsoft never returns.
 */
export const TEAMS_EXTENDED_MISSING = Object.freeze([
  Object.freeze({ family: 'liveEventsConfiguration', field: 'SdnApiToken', reason: 'secret', note: 'The API token of a third-party video distribution (eCDN) provider. Set it again in the Teams admin center after a restore.' }),
]);

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const TEAMS_EXTENDED_DESCRIPTOR = Object.freeze({
  type: 'teamsVoicePolicy',
  workload: TEAMS_EXTENDED_WORKLOAD,
  adapter: 'teams-voice-policies',
  readOnly: true,
  enabledByDefault: false,
  operations: TEAMS_EXTENDED_OPERATIONS,
});

// The only cmdlets this workload runs, and the only parameters each may receive.
// ops/powershell/run-cmdlet.ps1 ($AllowedTeamsExtended) holds the same list and checks it again.
export const TEAMS_EXTENDED_CMDLET_PARAMETERS = Object.freeze(Object.fromEntries(FAMILY_NAMES.map((name) => [
  FAMILIES[name].cmdlet, Object.freeze(FAMILIES[name].cmdlet === 'Get-CsOnlineUser' ? ['ResultSize'] : []),
])));
export const TEAMS_EXTENDED_CMDLETS = new Set(Object.keys(TEAMS_EXTENDED_CMDLET_PARAMETERS));

export class TeamsExtendedScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TeamsExtendedScopeError';
  }
}

/** Throws unless the cmdlet is one of the reads above, with only its own parameters. */
export function assertTeamsExtendedCmdlet({ cmdlet, parameters = {} }) {
  const allowed = TEAMS_EXTENDED_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new TeamsExtendedScopeError(`${cmdlet} is not a Teams voice or assignment read KEEL runs; this workload never writes or grants policies`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.includes(name)) throw new TeamsExtendedScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  if ('ResultSize' in parameters && !(Number.isInteger(parameters.ResultSize) && parameters.ResultSize > 0)) {
    throw new TeamsExtendedScopeError('ResultSize must be a positive whole number');
  }
  return true;
}

/** Runs one cmdlet through the bounded job transport. */
export async function teamsExtendedCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertTeamsExtendedCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: TEAMS_EXTENDED_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: TEAMS_EXTENDED_CMDLETS });
}

async function readFamily(family, { powershell, maxObjects, maxUsers }) {
  const spec = FAMILIES[family];
  const users = spec.cmdlet === 'Get-CsOnlineUser';
  // One more than the bound, so an answer at the bound is seen to be capped.
  const parameters = users ? { ResultSize: maxUsers + 1 } : {};
  let output;
  try {
    ({ output } = await teamsExtendedCmdlet({ cmdlet: spec.cmdlet, parameters }, powershell));
  } catch (error) {
    return emptyRead({ failure: { family, operation: spec.operation, ...structuredFailure(error) } });
  }
  return { ...emptyRead(), ...objectsFrom(family, spec, output, { maxObjects: users ? maxUsers : maxObjects }) };
}

/**
 * Reads the named families (all by default). Pure apart from the injected PowerShell
 * options: no database, no gate. Callers outside tests use collectTeamsExtended.
 */
export async function readTeamsExtended({
  powershell = {}, families = FAMILY_NAMES, maxObjects = DEFAULT_MAX_OBJECTS, maxUsers = DEFAULT_MAX_USERS, now = () => new Date(),
}) {
  if (!Array.isArray(families) || families.length === 0) throw new TypeError('readTeamsExtended needs at least one family');
  for (const family of families) if (!FAMILIES[family]) throw new TypeError(`unknown Teams voice family ${family}`);
  const observedFrom = now().toISOString();
  const reads = {};
  for (const family of families) reads[family] = await readFamily(family, { powershell, maxObjects, maxUsers });
  return summarize({
    workload: TEAMS_EXTENDED_WORKLOAD, families, reads, maxObjects,
    required: families.filter((family) => FAMILIES[family].required),
    observedFrom, observedTo: now().toISOString(),
  });
}

/**
 * Whether live collection may run. The Teams workload (team settings and membership)
 * must be qualified first, and every read here must be live-qualified and enabled.
 */
export function teamsExtendedActivation(ledger) {
  const { rows, describe } = ledgerRows(ledger);
  const reasons = [];
  const teams = teamsActivation(ledger);
  if (!teams.enabled) reasons.push(`Teams is not qualified yet, and Teams voice policies follow it: ${teams.reasons.join('; ')}`);
  for (const id of TEAMS_EXTENDED_OPERATIONS) if (!rows.get(id)?.enabled) reasons.push(describe(id));
  return { enabled: reasons.length === 0, reasons };
}

export const recordTeamsExtendedRun = (client, { tenantRef, result }) => recordCmdletRun(client, TEAMS_EXTENDED_WORKLOAD, { tenantRef, result });

/** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
export async function collectTeamsExtended(client, { tenantRef, ledger, powershell, maxObjects, maxUsers, now }) {
  const activation = teamsExtendedActivation(ledger);
  if (!activation.enabled) {
    const run = await recordDisabledRun(client, TEAMS_EXTENDED_WORKLOAD, { tenantRef, reasons: activation.reasons, now });
    return { run, result: null, activation };
  }
  const result = await readTeamsExtended({ powershell, maxObjects, maxUsers, now });
  const run = await recordTeamsExtendedRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const teamsExtendedAdapter = Object.freeze({
  async collect() {
    throw new Error('the Teams voice policy workload adapter is disabled until live qualification; use collectTeamsExtended with the ledger');
  },
});

registerWorkload(TEAMS_EXTENDED_DESCRIPTOR, teamsExtendedAdapter);
