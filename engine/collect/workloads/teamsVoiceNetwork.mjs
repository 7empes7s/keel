/**
 * Teams voice network, call flows and devices: the Teams Phone setup an admin builds
 * once and rarely looks at again, so a lost route, site or auto attendant could not be
 * put back from a Keel backup before (gap audit section F, 2026-10-30).
 *
 * Two read-only workloads in the MicrosoftTeams session, so each lands in its own group
 * on the portal's lists (insights/taxonomy.d/teams.mjs):
 *  - `teams-voice-network` ("Calling and meetings"), in three parts:
 *    - voice routing: voice routes, Direct Routing gateways (SBCs), number
 *      translation rules and unassigned number treatments;
 *    - network: network regions, sites, subnets, trusted IP addresses and network
 *      roaming policies (location-based routing and emergency addresses hang off these);
 *    - call flows: auto attendants and call queues (paged, 100 at a time, as Microsoft
 *      serves them), audio conferencing (dial-in) tenant settings, audio conferencing
 *      policies and call hold policies.
 *  - `teams-device-policies` ("Devices and clients"): IP phone, update management,
 *    mobility, VDI, feedback and workload (Teams app on devices) policies.
 *
 * Rules (the same as the other Teams cmdlet workloads):
 *  - Read only. Only the Get cmdlets below run. Only Get-CsAutoAttendant and
 *    Get-CsCallQueue take parameters: -First 100 and -Skip <a multiple of 100>, which
 *    KEEL sets to page through them. No writer exists.
 *  - Declared fields only. Anything else an answer carries is dropped unread: a call
 *    queue's live Statistics and its agents' opt-in state move on their own and are not
 *    settings (the agents an admin set are Users and DistributionLists).
 *  - Identity: policies by `Global` or `Tag:<name>`, auto attendants and call queues by
 *    their Guid, and routes, gateways, rules, regions, sites, subnets and trusted IPs by
 *    the Identity Teams keys them by (their name, FQDN or address: Teams has no other id).
 *  - Errors are structured. A family that fails is `failed` or `denied`, never an empty list.
 *  - Disabled until qualified. Nothing is sent unless the Teams workload is qualified,
 *    and each family runs only once its own read is live-qualified and enabled. The
 *    others are listed as skipped, so one read Microsoft refuses never holds back the rest.
 */
import { registerWorkload } from '../registry.mjs';
import { runCmdlet } from '../../powershell/jobQueue.mjs';
import { structuredFailure } from './exchange.mjs';
import { teamsActivation } from './teams.mjs';
import {
  emptyRead, guidOf, ledgerRows, objectsFrom, policyIdentityOf, recordCmdletRun, recordDisabledRun, summarize,
} from './cmdletFamilies.mjs';

export const TEAMS_VOICE_NETWORK_WORKLOAD = 'teams-voice-network';
export const TEAMS_DEVICE_POLICIES_WORKLOAD = 'teams-device-policies';
export const TEAMS_VOICE_NETWORK_MODULE = 'MicrosoftTeams';
export const DEFAULT_MAX_OBJECTS = 1000;
/** Microsoft serves auto attendants and call queues at most 100 at a time. */
export const PAGE_SIZE = 100;

const policy = (body) => policyIdentityOf(body?.Identity);
const singleton = (body) => (policyIdentityOf(body?.Identity) === 'global' ? 'global' : null);
const byGuid = (body) => guidOf(body?.Identity) ?? guidOf(body?.Id);
// A name, FQDN or address Teams keys an object by (administrator text, bounded).
// eslint-disable-next-line no-control-regex
const NAME = /^[^\u0000-\u001f\u007f]{1,256}$/;
const byName = (body) => {
  const name = typeof body?.Identity === 'string' ? body.Identity.trim() : '';
  return NAME.test(name) ? name.toLowerCase() : null;
};

const family = (spec) => Object.freeze({ ...spec, fields: Object.freeze(spec.fields) });

/**
 * Voice routing, network and call flows. Fields are from Microsoft's cmdlet
 * documentation; the live read check lists any the tenant's answer does not carry.
 * `required` families always answer in a working tenant (each policy list has its
 * Global policy; dial-in settings are a tenant singleton).
 *
 * No PSTN usages family: Get-CsOnlinePstnUsages is not exposed in the app-only
 * MicrosoftTeams session (CommandNotFound in the Q279 live check). The usages are still
 * backed up where they are used: on each voice route (OnlinePstnUsages here) and each
 * voice routing policy (teamsExtended.mjs).
 *
 * Description is not declared where the live answer did not carry it (audio
 * conferencing, VDI and feedback policies, Q279).
 */
export const VOICE_NETWORK_FAMILIES = Object.freeze({
  // Voice routing.
  voiceRoute: family({
    operation: 'teams-voice-network.voice-routes', cmdlet: 'Get-CsOnlineVoiceRoute', prefix: 'voice-route', identity: byName,
    fields: ['Identity', 'Name', 'Description', 'Priority', 'NumberPattern', 'OnlinePstnUsages', 'OnlinePstnGatewayList', 'BridgeSourcePhoneNumber'],
  }),
  pstnGateway: family({
    operation: 'teams-voice-network.pstn-gateways', cmdlet: 'Get-CsOnlinePSTNGateway', prefix: 'pstn-gateway', identity: byName,
    fields: [
      'Identity', 'Fqdn', 'Description', 'Enabled', 'SipSignalingPort', 'MaxConcurrentSessions', 'SendSipOptions', 'FailoverTimeSeconds',
      'FailoverResponseCodes', 'ForwardCallHistory', 'ForwardPai', 'MediaBypass', 'BypassMode', 'ProxySbc', 'MediaRelayRoutingLocationOverride',
      'GatewaySiteId', 'GatewaySiteLbrEnabled', 'GatewayLbrEnabledUserOverride', 'GenerateRingingWhileLocatingUser', 'PidfLoSupported',
      'InboundTeamsNumberTranslationRules', 'InboundPstnNumberTranslationRules', 'OutboundTeamsNumberTranslationRules', 'OutboundPstnNumberTranslationRules',
    ],
  }),
  translationRule: family({
    operation: 'teams-voice-network.translation-rules', cmdlet: 'Get-CsTeamsTranslationRule', prefix: 'translation-rule', identity: byName,
    fields: ['Identity', 'Name', 'Description', 'Pattern', 'Translation'],
  }),
  unassignedNumberTreatment: family({
    operation: 'teams-voice-network.unassigned-number-treatments', cmdlet: 'Get-CsTeamsUnassignedNumberTreatment', prefix: 'unassigned-number-treatment', identity: byName,
    fields: ['Identity', 'TreatmentId', 'Description', 'Pattern', 'Target', 'TargetType', 'TreatmentPriority'],
  }),
  // Network.
  networkRegion: family({
    operation: 'teams-voice-network.network-regions', cmdlet: 'Get-CsTenantNetworkRegion', prefix: 'network-region', identity: byName,
    fields: ['Identity', 'NetworkRegionID', 'Description'],
  }),
  networkSite: family({
    operation: 'teams-voice-network.network-sites', cmdlet: 'Get-CsTenantNetworkSite', prefix: 'network-site', identity: byName,
    fields: [
      'Identity', 'NetworkSiteID', 'Description', 'NetworkRegionID', 'LocationPolicy', 'EnableLocationBasedRouting',
      'EmergencyCallingPolicy', 'EmergencyCallRoutingPolicy', 'NetworkRoamingPolicy', 'SiteAddress',
    ],
  }),
  networkSubnet: family({
    operation: 'teams-voice-network.network-subnets', cmdlet: 'Get-CsTenantNetworkSubnet', prefix: 'network-subnet', identity: byName,
    fields: ['Identity', 'SubnetID', 'MaskBits', 'Description', 'NetworkSiteID'],
  }),
  trustedIpAddress: family({
    operation: 'teams-voice-network.trusted-ip-addresses', cmdlet: 'Get-CsTenantTrustedIPAddress', prefix: 'trusted-ip-address', identity: byName,
    fields: ['Identity', 'IPAddress', 'MaskBits', 'Description'],
  }),
  networkRoamingPolicy: family({
    operation: 'teams-voice-network.network-roaming-policies', cmdlet: 'Get-CsTeamsNetworkRoamingPolicy', prefix: 'network-roaming-policy', identity: policy, required: true,
    fields: ['Identity', 'Description', 'AllowIPVideo', 'MediaBitRateKb'],
  }),
  // Call flows.
  autoAttendant: family({
    operation: 'teams-voice-network.auto-attendants', cmdlet: 'Get-CsAutoAttendant', prefix: 'auto-attendant', identity: byGuid, paged: true,
    fields: [
      'Name', 'LanguageId', 'VoiceId', 'TimeZoneId', 'VoiceResponseEnabled', 'DefaultCallFlow', 'CallFlows', 'Schedules', 'CallHandlingAssociations',
      'Operator', 'DialByNameResourceId', 'DirectoryLookupScope', 'ApplicationInstances', 'AuthorizedUsers', 'HideAuthorizedUsers',
    ],
  }),
  callQueue: family({
    operation: 'teams-voice-network.call-queues', cmdlet: 'Get-CsCallQueue', prefix: 'call-queue', identity: byGuid, paged: true,
    fields: [
      'Name', 'LanguageId', 'RoutingMethod', 'PresenceBasedRouting', 'ConferenceMode', 'AllowOptOut', 'AgentAlertTime', 'Users', 'DistributionLists',
      'ChannelId', 'UseDefaultMusicOnHold', 'MusicOnHoldAudioFileId', 'WelcomeMusicAudioFileId',
      'OverflowThreshold', 'OverflowAction', 'OverflowActionTarget', 'TimeoutThreshold', 'TimeoutAction', 'TimeoutActionTarget',
      'NoAgentAction', 'NoAgentActionTarget', 'NoAgentApplyTo', 'ApplicationInstances', 'OboResourceAccountIds', 'AuthorizedUsers', 'HideAuthorizedUsers',
    ],
  }),
  dialInConferencing: family({
    operation: 'teams-voice-network.dial-in-conferencing', cmdlet: 'Get-CsOnlineDialInConferencingTenantSettings', prefix: 'dial-in-conferencing', identity: singleton, required: true,
    fields: [
      'Identity', 'AllowPSTNOnlyMeetingsByDefault', 'AutomaticallySendEmailsToUsers', 'SendEmailFromOverride', 'SendEmailFromAddress',
      'SendEmailFromDisplayName', 'EnableEntryExitNotifications', 'EntryExitAnnouncementsType', 'EnableNameRecording', 'PinLength',
      'IncludeTollFreeNumberInMeetingInvites', 'MaskPstnNumbersType', 'AllowFederatedUsersToDialOutToSelf', 'AllowFederatedUsersToDialOutToThirdParty',
      'UseUniqueConferenceIds', 'EnableDialOutJoinConfirmation',
    ],
  }),
  audioConferencingPolicy: family({
    operation: 'teams-voice-network.audio-conferencing-policies', cmdlet: 'Get-CsTeamsAudioConferencingPolicy', prefix: 'audio-conferencing-policy', identity: policy, required: true,
    fields: ['Identity', 'AllowTollFreeDialin', 'MeetingInvitePhoneNumbers'],
  }),
  callHoldPolicy: family({
    operation: 'teams-voice-network.call-hold-policies', cmdlet: 'Get-CsTeamsCallHoldPolicy', prefix: 'call-hold-policy', identity: policy, required: true,
    fields: ['Identity', 'Description', 'AudioFileId'],
  }),
});

/** Device and client policies. Each list always has its Global policy. */
export const DEVICE_POLICY_FAMILIES = Object.freeze({
  ipPhonePolicy: family({
    operation: 'teams-device-policies.ip-phone-policies', cmdlet: 'Get-CsTeamsIPPhonePolicy', prefix: 'ip-phone-policy', identity: policy, required: true,
    fields: ['Identity', 'Description', 'SignInMode', 'SearchOnCommonAreaPhoneMode', 'AllowHomeScreen', 'AllowBetterTogether', 'AllowHotDesking', 'HotDeskingIdleTimeoutInMinutes'],
  }),
  updateManagementPolicy: family({
    operation: 'teams-device-policies.update-management-policies', cmdlet: 'Get-CsTeamsUpdateManagementPolicy', prefix: 'update-management-policy', identity: policy, required: true,
    fields: ['Identity', 'Description', 'AllowManagedUpdates', 'AllowPreview', 'AllowPublicPreview', 'UpdateDayOfWeek', 'UpdateTime', 'UpdateTimeOfDay', 'UseNewTeamsClient'],
  }),
  mobilityPolicy: family({
    operation: 'teams-device-policies.mobility-policies', cmdlet: 'Get-CsTeamsMobilityPolicy', prefix: 'mobility-policy', identity: policy, required: true,
    fields: ['Identity', 'Description', 'IPVideoMobileMode', 'IPAudioMobileMode', 'MobileDialerPreference'],
  }),
  vdiPolicy: family({
    operation: 'teams-device-policies.vdi-policies', cmdlet: 'Get-CsTeamsVdiPolicy', prefix: 'vdi-policy', identity: policy, required: true,
    fields: ['Identity', 'DisableCallsAndMeetings', 'DisableAudioVideoInCallsAndMeetings', 'VDI2Optimization'],
  }),
  feedbackPolicy: family({
    operation: 'teams-device-policies.feedback-policies', cmdlet: 'Get-CsTeamsFeedbackPolicy', prefix: 'feedback-policy', identity: policy, required: true,
    fields: [
      'Identity', 'UserInitiatedMode', 'ReceiveSurveysMode', 'AllowScreenshotCollection', 'AllowEmailCollection',
      'AllowLogCollection', 'EnableFeatureSuggestions',
    ],
  }),
  workLoadPolicy: family({
    operation: 'teams-device-policies.workload-policies', cmdlet: 'Get-CsTeamsWorkLoadPolicy', prefix: 'workload-policy', identity: policy, required: true,
    fields: ['Identity', 'Description', 'AllowMeeting', 'AllowMeetingPinned', 'AllowMessaging', 'AllowMessagingPinned', 'AllowCalling', 'AllowCallingPinned'],
  }),
});

export class TeamsVoiceNetworkScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TeamsVoiceNetworkScopeError';
  }
}

// A page offset KEEL sends: a whole number of pages, at most this many objects in.
const MAX_SKIP = 100000;
const PAGE_PARAMETERS = Object.freeze(['First', 'Skip']);

/**
 * One read-only workload over `families`. Returns its descriptor, allowlist, reader,
 * activation, recorder and gated collector.
 */
function teamsWorkload({ workload, type, families, label }) {
  const names = Object.freeze(Object.keys(families));
  const operations = Object.freeze(names.map((name) => families[name].operation));
  // The only cmdlets this workload runs, and the only parameters each may receive.
  // ops/powershell/run-cmdlet.ps1 holds the same lists and checks them again.
  const cmdletParameters = Object.freeze(Object.fromEntries(names.map((name) => [
    families[name].cmdlet, families[name].paged ? PAGE_PARAMETERS : Object.freeze([]),
  ])));
  const cmdlets = new Set(Object.keys(cmdletParameters));

  const descriptor = Object.freeze({ type, workload, adapter: workload, readOnly: true, enabledByDefault: false, operations });

  /** Throws unless the cmdlet is one of the reads above, with only its own parameters and values. */
  function assertCmdlet({ cmdlet, parameters = {} }) {
    const allowed = cmdletParameters[cmdlet];
    if (!allowed) throw new TeamsVoiceNetworkScopeError(`${cmdlet} is not a Teams ${label} read KEEL runs; this workload never writes`);
    for (const [name, value] of Object.entries(parameters)) {
      if (!allowed.includes(name)) throw new TeamsVoiceNetworkScopeError(`${cmdlet} does not take ${name} from KEEL`);
      if (name === 'First' && value !== PAGE_SIZE) throw new TeamsVoiceNetworkScopeError(`First must be ${PAGE_SIZE}`);
      if (name === 'Skip' && !(Number.isInteger(value) && value > 0 && value % PAGE_SIZE === 0 && value <= MAX_SKIP)) {
        throw new TeamsVoiceNetworkScopeError(`Skip must be a whole number of pages of ${PAGE_SIZE}, up to ${MAX_SKIP}`);
      }
    }
    return true;
  }

  async function cmdletCall({ cmdlet, parameters = {} }, powershell = {}) {
    assertCmdlet({ cmdlet, parameters });
    const { tenantConfigPath = null, ...options } = powershell;
    return runCmdlet({ module: TEAMS_VOICE_NETWORK_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: cmdlets });
  }

  /** A whole-tenant family: one call. */
  async function readFamily(name, { powershell, maxObjects }) {
    const spec = families[name];
    let output;
    try {
      ({ output } = await cmdletCall({ cmdlet: spec.cmdlet }, powershell));
    } catch (error) {
      return emptyRead({ failure: { family: name, operation: spec.operation, ...structuredFailure(error) } });
    }
    return { ...emptyRead(), ...objectsFrom(name, spec, output, { maxObjects }) };
  }

  /**
   * A paged family: -First 100, then -Skip 100, 200… until a page comes back short or the
   * object cap is reached. A page that fails fails the family: a partial list would read
   * as deletions.
   */
  async function readPaged(name, { powershell, maxObjects }) {
    const spec = families[name];
    const read = emptyRead();
    const kept = new Map();
    const count = { value: 0 };
    for (let skip = 0; ; skip += PAGE_SIZE) {
      if (count.value >= maxObjects || skip > MAX_SKIP) { read.capped = true; break; }
      const parameters = skip === 0 ? { First: PAGE_SIZE } : { First: PAGE_SIZE, Skip: skip };
      let output;
      try {
        ({ output } = await cmdletCall({ cmdlet: spec.cmdlet, parameters }, powershell));
      } catch (error) {
        return emptyRead({ failure: { family: name, operation: spec.operation, page: skip / PAGE_SIZE + 1, ...structuredFailure(error) } });
      }
      const page = objectsFrom(name, spec, output, { maxObjects, kept, count });
      read.resources.push(...page.resources);
      read.conflicts.push(...page.conflicts);
      read.unidentified += page.unidentified;
      read.capped ||= page.capped;
      // A short page is the last one. A full page that adds nothing new means -Skip was
      // not honoured: stop rather than ask for the same page again.
      if (output.length < PAGE_SIZE || read.capped || (page.resources.length === 0 && page.unidentified === 0)) break;
    }
    return read;
  }

  /** Reads the named families (all by default). Pure apart from the injected PowerShell options. */
  async function read({ powershell = {}, families: wanted = names, skipped = [], maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() } = {}) {
    if (!Array.isArray(wanted)) throw new TypeError(`the Teams ${label} reader needs a list of families`);
    for (const name of wanted) if (!families[name]) throw new TypeError(`unknown Teams ${label} family ${name}`);
    const observedFrom = now().toISOString();
    const reads = {};
    for (const name of wanted) {
      reads[name] = families[name].paged ? await readPaged(name, { powershell, maxObjects }) : await readFamily(name, { powershell, maxObjects });
    }
    return summarize({
      workload, families: wanted, reads, skipped, maxObjects,
      required: wanted.filter((name) => families[name].required),
      observedFrom, observedTo: now().toISOString(),
    });
  }

  /**
   * Whether live collection may run. Teams (team settings and membership) must be
   * qualified first; then each family runs once its own read is live-qualified and
   * enabled, and the others are listed as skipped (the run is partial).
   */
  function activation(ledger) {
    const { rows, describe } = ledgerRows(ledger);
    const teams = teamsActivation(ledger);
    if (!teams.enabled) {
      return {
        enabled: false, families: [], skipped: [],
        reasons: [`Teams is not qualified yet, and Teams ${label} follow it: ${teams.reasons.join('; ')}`],
      };
    }
    const on = names.filter((name) => rows.get(families[name].operation)?.enabled);
    const skipped = names.filter((name) => !on.includes(name))
      .map((name) => ({ family: name, operation: families[name].operation, reason: describe(families[name].operation) }));
    return { enabled: on.length > 0, reasons: on.length ? [] : skipped.map((entry) => entry.reason), families: on, skipped };
  }

  const record = (client, { tenantRef, result }) => recordCmdletRun(client, workload, { tenantRef, result });

  /** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
  async function collect(client, { tenantRef, ledger, powershell, maxObjects, now }) {
    const gate = activation(ledger);
    if (!gate.enabled) {
      const run = await recordDisabledRun(client, workload, { tenantRef, reasons: gate.reasons, now });
      return { run, result: null, activation: gate };
    }
    const result = await read({ powershell, families: gate.families, skipped: gate.skipped, maxObjects, now });
    const run = await record(client, { tenantRef, result });
    return { run, result, activation: gate };
  }

  /** Registry adapter: a direct call is refused until the workload is enabled. */
  const adapter = Object.freeze({
    async collect() {
      throw new Error(`the Teams ${label} workload adapter is disabled until live qualification; use its collector with the ledger`);
    },
  });
  registerWorkload(descriptor, adapter);

  return Object.freeze({
    workload, families, familyNames: names, operations, descriptor, cmdletParameters, assertCmdlet, read, activation, record, collect,
  });
}

export const VOICE_NETWORK = teamsWorkload({
  workload: TEAMS_VOICE_NETWORK_WORKLOAD, type: 'teamsVoiceNetwork', families: VOICE_NETWORK_FAMILIES, label: 'voice network and call flow',
});
export const DEVICE_POLICIES = teamsWorkload({
  workload: TEAMS_DEVICE_POLICIES_WORKLOAD, type: 'teamsDevicePolicies', families: DEVICE_POLICY_FAMILIES, label: 'device policy',
});

export const readTeamsVoiceNetwork = (options) => VOICE_NETWORK.read(options);
export const readTeamsDevicePolicies = (options) => DEVICE_POLICIES.read(options);
export const teamsVoiceNetworkActivation = (ledger) => VOICE_NETWORK.activation(ledger);
export const teamsDevicePoliciesActivation = (ledger) => DEVICE_POLICIES.activation(ledger);
export const recordTeamsVoiceNetworkRun = (client, options) => VOICE_NETWORK.record(client, options);
export const recordTeamsDevicePoliciesRun = (client, options) => DEVICE_POLICIES.record(client, options);
export const collectTeamsVoiceNetwork = (client, options) => VOICE_NETWORK.collect(client, options);
export const collectTeamsDevicePolicies = (client, options) => DEVICE_POLICIES.collect(client, options);
