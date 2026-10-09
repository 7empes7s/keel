/**
 * Issue #154: the Teams organization's org-wide policies and tenant configuration.
 *
 * Nine families, each its own task-101 operation and one Get cmdlet run with no
 * parameters in the MicrosoftTeams session:
 *  - meeting, messaging, app setup and app permission policies (lists);
 *  - external access (federation) configuration;
 *  - client configuration (which includes the guest access switch);
 *  - guest meeting, guest messaging and guest calling configuration.
 * Every object becomes one observation, keyed by its Identity (see FAMILIES).
 *
 * Rules:
 *  - Read only. Only the Get cmdlets in TEAMS_POLICY_CMDLET_PARAMETERS run, with no
 *    parameters. No write capability exists for this workload; restore is a separate
 *    task once these reads are live-qualified.
 *  - Declared fields only. Anything an answer carries beyond a family's fields is
 *    dropped unread, including properties the module adds later. No declared field
 *    holds a secret; a credential-shaped value is still redacted.
 *  - Errors are structured. A family that fails is `failed` or `denied` with the
 *    structured error, never an empty list.
 *  - Disabled until qualified. collectTeamsPolicies() sends nothing unless the Teams
 *    workload is qualified (these follow it, as mail flow follows Exchange) AND every
 *    read here is live-qualified and enabled.
 */
import { registerWorkload } from '../registry.mjs';
import { runCmdlet } from '../../powershell/jobQueue.mjs';
import { redactPayload } from '../../telemetry/events.mjs';
import { structuredFailure } from './exchange.mjs';
import { teamsActivation } from './teams.mjs';

export const TEAMS_POLICY_WORKLOAD = 'teams-org-policies';
export const TEAMS_POLICY_MODULE = 'MicrosoftTeams';
export const DEFAULT_MAX_OBJECTS = 1000;

/**
 * The families. `key` is how an observation is identified:
 *  - `policy`: a policy list. Each policy's Identity is `Global` (the org-wide
 *    default) or `Tag:<name>` (a named policy, including Microsoft's built-in ones).
 *    A policy cannot be renamed, so the Identity is stable. It is stored lower-cased
 *    in the key (Teams compares identities without case) and as answered in the
 *    `Identity` field;
 *  - `singleton`: a tenant configuration. There is exactly one, `Global`; anything
 *    else in the answer is not trusted and is counted as unidentified.
 * Fields were declared from Microsoft's cmdlet documentation, not measured live.
 */
export const FAMILIES = Object.freeze({
  meetingPolicy: Object.freeze({
    operation: 'teams.meeting-policies', cmdlet: 'Get-CsTeamsMeetingPolicy', prefix: 'meeting-policy', key: 'policy',
    fields: Object.freeze([
      'Identity', 'Description', 'AllowChannelMeetingScheduling', 'AllowMeetNow', 'AllowPrivateMeetNow', 'AllowPrivateMeetingScheduling',
      'MeetingChatEnabledType', 'LiveCaptionsEnabledType', 'AllowIPAudio', 'AllowIPVideo', 'IPAudioMode', 'IPVideoMode',
      'ScreenSharingMode', 'AllowPowerPointSharing', 'AllowWhiteboard', 'AllowSharedNotes', 'AllowParticipantGiveRequestControl',
      'AllowExternalParticipantGiveRequestControl', 'AllowTranscription', 'AllowCloudRecording', 'AllowRecordingStorageOutsideRegion',
      'NewMeetingRecordingExpirationDays', 'AllowAnonymousUsersToJoinMeeting', 'AllowAnonymousUsersToStartMeeting', 'AutoAdmittedUsers',
      'AllowPSTNUsersToBypassLobby', 'AllowExternalNonTrustedMeetingChat', 'DesignatedPresenterRoleMode', 'AllowBreakoutRooms',
      'AllowMeetingReactions', 'AllowMeetingRegistration', 'WhoCanRegister', 'AllowEngagementReport', 'AllowOutlookAddIn',
      'AllowUserToJoinExternalMeeting', 'StreamingAttendeeMode', 'MediaBitRateKb', 'VideoFiltersMode',
      'AllowWatermarkForScreenSharing', 'AllowWatermarkForCameraVideo', 'ExplicitRecordingConsent',
    ]),
  }),
  messagingPolicy: Object.freeze({
    operation: 'teams.messaging-policies', cmdlet: 'Get-CsTeamsMessagingPolicy', prefix: 'messaging-policy', key: 'policy',
    fields: Object.freeze([
      'Identity', 'Description', 'AllowUrlPreviews', 'AllowOwnerDeleteMessage', 'AllowUserEditMessage', 'AllowUserDeleteMessage',
      'AllowUserDeleteChat', 'AllowUserChat', 'AllowRemoveUser', 'AllowGiphy', 'GiphyRatingType', 'AllowGiphyDisplay',
      'AllowPasteInternetImage', 'AllowMemes', 'AllowImmersiveReader', 'AllowStickers', 'AllowUserTranslation',
      'ReadReceiptsEnabledType', 'AllowPriorityMessages', 'AllowSmartReply', 'AllowSmartCompose', 'ChannelsInChatListEnabledType',
      'AudioMessageEnabledType', 'ChatPermissionRole', 'AllowFullChatPermissionUserToDeleteAnyMessage', 'AllowVideoMessages',
      'AllowCommunicationComplianceEndUserReporting', 'AllowSecurityEndUserReporting', 'AllowGroupChatJoinLinks',
    ]),
  }),
  appSetupPolicy: Object.freeze({
    operation: 'teams.app-setup-policies', cmdlet: 'Get-CsTeamsAppSetupPolicy', prefix: 'app-setup-policy', key: 'policy',
    fields: Object.freeze(['Identity', 'Description', 'AppPresetList', 'AppPresetMeetingList', 'PinnedAppBarApps', 'PinnedMessageBarApps', 'AllowUserPinning', 'AllowSideLoading']),
  }),
  appPermissionPolicy: Object.freeze({
    operation: 'teams.app-permission-policies', cmdlet: 'Get-CsTeamsAppPermissionPolicy', prefix: 'app-permission-policy', key: 'policy',
    fields: Object.freeze([
      'Identity', 'Description', 'DefaultCatalogAppsType', 'DefaultCatalogApps', 'GlobalCatalogAppsType', 'GlobalCatalogApps',
      'PrivateCatalogAppsType', 'PrivateCatalogApps',
    ]),
  }),
  federationConfiguration: Object.freeze({
    operation: 'teams.federation-configuration', cmdlet: 'Get-CsTenantFederationConfiguration', prefix: 'federation-configuration', key: 'singleton',
    fields: Object.freeze([
      'Identity', 'AllowFederatedUsers', 'AllowedDomains', 'BlockedDomains', 'BlockAllSubdomains', 'AllowTeamsConsumer',
      'AllowTeamsConsumerInbound', 'RestrictTeamsConsumerToExternalUserProfiles', 'AllowPublicUsers', 'TreatDiscoveredPartnersAsUnverified',
      'SharedSipAddressSpace', 'ExternalAccessWithTrialTenants', 'AllowedTrialTenantDomains',
    ]),
  }),
  clientConfiguration: Object.freeze({
    operation: 'teams.client-configuration', cmdlet: 'Get-CsTeamsClientConfiguration', prefix: 'client-configuration', key: 'singleton',
    fields: Object.freeze([
      'Identity', 'AllowGuestUser', 'AllowEmailIntoChannel', 'RestrictedSenderList', 'AllowDropBox', 'AllowBox', 'AllowGoogleDrive',
      'AllowShareFile', 'AllowEgnyte', 'AllowOrganizationTab', 'AllowSkypeBusinessInterop', 'ContentPin', 'AllowResourceAccountSendMessage',
      'ResourceAccountContentAccess', 'AllowScopedPeopleSearchandAccess', 'AllowRoleBasedChatPermissions',
    ]),
  }),
  guestMeetingConfiguration: Object.freeze({
    operation: 'teams.guest-meeting-configuration', cmdlet: 'Get-CsTeamsGuestMeetingConfiguration', prefix: 'guest-meeting-configuration', key: 'singleton',
    fields: Object.freeze(['Identity', 'AllowIPVideo', 'ScreenSharingMode', 'AllowMeetNow', 'LiveCaptionsEnabledType', 'AllowTranscription']),
  }),
  guestMessagingConfiguration: Object.freeze({
    operation: 'teams.guest-messaging-configuration', cmdlet: 'Get-CsTeamsGuestMessagingConfiguration', prefix: 'guest-messaging-configuration', key: 'singleton',
    fields: Object.freeze([
      'Identity', 'AllowUserEditMessage', 'AllowUserDeleteMessage', 'AllowUserDeleteChat', 'AllowUserChat', 'AllowGiphy', 'GiphyRatingType',
      'AllowMemes', 'AllowImmersiveReader', 'AllowStickers',
    ]),
  }),
  guestCallingConfiguration: Object.freeze({
    operation: 'teams.guest-calling-configuration', cmdlet: 'Get-CsTeamsGuestCallingConfiguration', prefix: 'guest-calling-configuration', key: 'singleton',
    fields: Object.freeze(['Identity', 'AllowPrivateCalling']),
  }),
});
export const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));
export const TEAMS_POLICY_OPERATIONS = Object.freeze(FAMILY_NAMES.map((name) => FAMILIES[name].operation));

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const TEAMS_POLICY_DESCRIPTOR = Object.freeze({
  type: 'teamsOrgPolicy',
  workload: TEAMS_POLICY_WORKLOAD,
  adapter: 'teams-org-policies',
  readOnly: true,
  enabledByDefault: false,
  operations: TEAMS_POLICY_OPERATIONS,
});

// The only cmdlets this workload runs, and the only parameters each may receive (none).
// ops/powershell/run-cmdlet.ps1 ($AllowedTeamsPolicy) holds the same list and checks it again.
export const TEAMS_POLICY_CMDLET_PARAMETERS = Object.freeze(Object.fromEntries(FAMILY_NAMES.map((name) => [FAMILIES[name].cmdlet, Object.freeze([])])));
export const TEAMS_POLICY_CMDLETS = new Set(Object.keys(TEAMS_POLICY_CMDLET_PARAMETERS));

export class TeamsPolicyScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TeamsPolicyScopeError';
  }
}

/** Throws unless the cmdlet is one of the reads above and is given no parameters. */
export function assertTeamsPolicyCmdlet({ cmdlet, parameters = {} }) {
  const allowed = TEAMS_POLICY_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new TeamsPolicyScopeError(`${cmdlet} is not a Teams policy read KEEL runs; this workload never writes, assigns policies or reads users`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.includes(name)) throw new TeamsPolicyScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  return true;
}

/** Runs one Teams policy cmdlet through the bounded job transport. */
export async function teamsPolicyCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertTeamsPolicyCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: TEAMS_POLICY_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: TEAMS_POLICY_CMDLETS });
}

// `Tag:` names are administrator text: any printable characters, bounded.
// eslint-disable-next-line no-control-regex
const POLICY_IDENTITY = /^(global|tag:[^\u0000-\u001f\u007f]{1,256})$/;

/** The stable identity of one answer in a family; null when it has none KEEL trusts. */
export function objectIdentity(family, body) {
  const identity = typeof body?.Identity === 'string' ? body.Identity.trim().toLowerCase() : '';
  if (FAMILIES[family].key === 'singleton') return identity === 'global' ? 'global' : null;
  return POLICY_IDENTITY.test(identity) ? identity : null;
}
export const teamsPolicyKey = (family, identity) => `${FAMILIES[family].prefix}:${identity}`;

function observeObject(family, body) {
  const { fields, operation } = FAMILIES[family];
  const entry = { fields: {}, fieldCoverage: {} };
  for (const field of fields) {
    const value = body[field];
    if (value === undefined) {
      entry.fieldCoverage[field] = { status: 'unknown', operation };
      continue;
    }
    // Defence in depth: a credential-shaped value (typed into a description, say) is
    // redacted by the shared telemetry redactor and marked as such.
    const redaction = { redactedFields: 0, seen: new WeakSet() };
    const clean = redactPayload(value, redaction);
    if (redaction.redactedFields > 0) {
      entry.fields[field] = clean;
      entry.fieldCoverage[field] = { status: 'redacted', operation, reason: 'the value looked like a credential and was not stored' };
      continue;
    }
    entry.fields[field] = value;
    entry.fieldCoverage[field] = { status: 'observed', operation };
  }
  return entry;
}

/** Reads one family. Returns its resources and, when the read did not succeed, why. */
async function readFamily(family, { powershell, maxObjects }) {
  const { cmdlet, operation } = FAMILIES[family];
  let output;
  try {
    ({ output } = await teamsPolicyCmdlet({ cmdlet }, powershell));
  } catch (error) {
    return { resources: [], failure: { family, operation, ...structuredFailure(error) }, capped: false, unidentified: 0 };
  }
  const resources = [];
  const seen = new Set();
  let unidentified = 0;
  let capped = false;
  for (const body of output) {
    const identity = body && typeof body === 'object' ? objectIdentity(family, body) : null;
    if (!identity) { unidentified += 1; continue; }
    if (seen.has(identity)) continue;
    if (resources.length >= maxObjects) { capped = true; continue; }
    seen.add(identity);
    resources.push({ resourceKey: teamsPolicyKey(family, identity), kind: family, identity, ...observeObject(family, body) });
  }
  return { resources, failure: null, capped, unidentified };
}

/**
 * Reads the named families (all by default). Pure apart from the injected
 * PowerShell options: no database, no gate. Callers outside tests use
 * collectTeamsPolicies.
 */
export async function readTeamsPolicies({ powershell = {}, families = FAMILY_NAMES, maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() }) {
  for (const family of families) if (!FAMILIES[family]) throw new TypeError(`unknown Teams policy family ${family}`);
  const observedFrom = now().toISOString();
  const reads = [];
  for (const family of families) reads.push(await readFamily(family, { powershell, maxObjects }));
  const resources = reads.flatMap((read) => read.resources);
  const failures = reads.map((read) => read.failure).filter(Boolean);
  const capped = reads.some((read) => read.capped);
  const unidentified = reads.reduce((sum, read) => sum + read.unidentified, 0);
  const statuses = resources.flatMap((entry) => Object.values(entry.fieldCoverage).map((coverage) => coverage.status));
  const fieldCounts = statuses.reduce((counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {});
  const perFamily = Object.fromEntries(families.map((family, index) => {
    const read = reads[index];
    return [family, { status: read.failure ? read.failure.status : 'read', objects: read.resources.length }];
  }));
  // A tenant always has its Global policies and configurations, so a family that
  // answered nothing is a gap, not an empty tenant.
  const empty = families.filter((family, index) => !reads[index].failure && reads[index].resources.length === 0);
  let outcome;
  if (families.length > 0 && failures.length === families.length) outcome = 'failed';
  else if (failures.length || empty.length || capped || unidentified || statuses.some((status) => status !== 'observed')) outcome = 'partial';
  else if (resources.length === 0) outcome = 'complete-empty';
  else outcome = 'complete';
  return {
    workload: TEAMS_POLICY_WORKLOAD,
    outcome,
    observedFrom,
    observedTo: now().toISOString(),
    discovery: { families: perFamily, objects: resources.length, capped, unidentified, empty, maxObjects },
    resources,
    failures,
    fieldCounts,
  };
}

/**
 * Whether live collection may run. The Teams workload (team settings and membership)
 * must be qualified first, and every read here must be live-qualified and enabled.
 */
export function teamsPolicyActivation(ledger) {
  const rows = new Map((ledger?.rows ?? []).map((row) => [row.id, row]));
  const reasons = [];
  const teams = teamsActivation(ledger);
  if (!teams.enabled) reasons.push(`Teams is not qualified yet, and Teams org-wide policies follow it: ${teams.reasons.join('; ')}`);
  for (const id of TEAMS_POLICY_OPERATIONS) {
    const row = rows.get(id);
    if (!row?.enabled) reasons.push(`${id} is ${row?.state ?? 'not in the ledger'}${row?.prerequisite ? `: ${row.prerequisite.message}` : ''}`);
  }
  return { enabled: reasons.length === 0, reasons };
}

/** Persists one run in one transaction; one row per object. */
export async function recordTeamsPolicyRun(client, { tenantRef, result }) {
  await client.query('BEGIN');
  try {
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantRef, TEAMS_POLICY_WORKLOAD, result.outcome, result.observedFrom, result.observedTo, {
        discovery: result.discovery ?? null,
        fieldCounts: result.fieldCounts ?? {},
        failures: result.failures ?? [],
        reasons: result.reasons ?? [],
      }],
    );
    for (const resource of result.resources ?? []) {
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields, field_coverage)
         VALUES ($1,$2,$3,$4) ON CONFLICT (collection_id, resource_key) DO NOTHING`,
        [run.id, resource.resourceKey, { identity: resource.identity, kind: resource.kind, ...resource.fields }, resource.fieldCoverage],
      );
    }
    await client.query('COMMIT');
    return run;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
export async function collectTeamsPolicies(client, { tenantRef, ledger, powershell, maxObjects, now }) {
  const activation = teamsPolicyActivation(ledger);
  if (!activation.enabled) {
    const at = (now?.() ?? new Date()).toISOString();
    const run = await recordTeamsPolicyRun(client, { tenantRef, result: { outcome: 'disabled', observedFrom: at, observedTo: at, reasons: activation.reasons } });
    return { run, result: null, activation };
  }
  const result = await readTeamsPolicies({ powershell, maxObjects, now });
  const run = await recordTeamsPolicyRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const teamsPolicyAdapter = Object.freeze({
  async collect() {
    throw new Error('the Teams org-wide policy workload adapter is disabled until live qualification; use collectTeamsPolicies with the ledger');
  },
});

registerWorkload(TEAMS_POLICY_DESCRIPTOR, teamsPolicyAdapter);
