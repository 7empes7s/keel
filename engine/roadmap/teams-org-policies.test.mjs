// Issue #154: Teams org-wide policies and tenant configuration, read-only.
//
// Acceptance:
//  - meeting, messaging, app setup and app permission policies, federation (external
//    access), client and guest configuration are each declared in workloadContract.mjs,
//    pass the scope validator, are run by the read-only probe, and ship disabled
//    (fixture proof never enables them);
//  - the meeting policy read is the one task-101 declared (same id), moved, not copied;
//  - no write capability exists for the workload;
//  - each policy is one observation keyed by its Identity (`Global`, `Tag:<name>`), each
//    configuration one singleton (`Global`), with declared fields only and nothing
//    credential-shaped stored.
// Mutation checks:
//  - accept a singleton whose Identity is not Global (the identity test fails);
//  - treat a family that answered nothing as complete (the outcome test fails);
//  - drop the Teams prerequisite from activation (the activation test fails).
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays the ops/powershell/run-cmdlet.ps1 contract through the real
// engine/powershell/jobQueue.mjs spawn path. No tenant is touched.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  FAMILIES, FAMILY_NAMES, TEAMS_POLICY_CMDLET_PARAMETERS, TEAMS_POLICY_DESCRIPTOR, TEAMS_POLICY_OPERATIONS, TEAMS_POLICY_WORKLOAD,
  TeamsPolicyScopeError, assertTeamsPolicyCmdlet, collectTeamsPolicies, objectIdentity, readTeamsPolicies, teamsPolicyActivation,
} from '../collect/workloads/teamsPolicies.mjs';
import { TEAMS_OPERATIONS } from '../collect/workloads/teams.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { planDeletionWaves, planWaves } from '../restore/wavePlanner.mjs';
import { redactPayload } from '../telemetry/events.mjs';
import { runFixtureHarness } from '../../tools/qualification/workloads.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    schemaReady = true;
  }
  return client;
}

const NOW = new Date('2026-10-09T12:00:00Z');
const TEAMS_VERSION = '7.9.0';
const MODULE_VERSIONS = Object.freeze({ ExchangeOnlineManagement: '3.5.0', 'PnP.PowerShell': '3.4.1', MicrosoftTeams: TEAMS_VERSION });
let tenantSeq = 0;
const nextTenant = () => `sha256:issue-154-${tenantSeq += 1}`;

// Objects as the MicrosoftTeams module answers them, with the extra properties a
// careless reader would keep.
const SAMPLE = Object.freeze({
  'Get-CsTeamsMeetingPolicy': [
    {
      Identity: 'Global', Description: null, AllowChannelMeetingScheduling: true, AllowMeetNow: true, AllowPrivateMeetNow: true, AllowPrivateMeetingScheduling: true,
      MeetingChatEnabledType: 'Enabled', LiveCaptionsEnabledType: 'DisabledUserOverride', AllowIPAudio: true, AllowIPVideo: true, IPAudioMode: 'EnabledOutgoingIncoming', IPVideoMode: 'EnabledOutgoingIncoming',
      ScreenSharingMode: 'EntireScreen', AllowPowerPointSharing: true, AllowWhiteboard: true, AllowSharedNotes: true, AllowParticipantGiveRequestControl: true,
      AllowExternalParticipantGiveRequestControl: false, AllowTranscription: false, AllowCloudRecording: true, AllowRecordingStorageOutsideRegion: false,
      NewMeetingRecordingExpirationDays: 120, AllowAnonymousUsersToJoinMeeting: true, AllowAnonymousUsersToStartMeeting: false, AutoAdmittedUsers: 'EveryoneInCompanyExcludingGuests',
      AllowPSTNUsersToBypassLobby: false, AllowExternalNonTrustedMeetingChat: true, DesignatedPresenterRoleMode: 'EveryoneUserOverride', AllowBreakoutRooms: true,
      AllowMeetingReactions: true, AllowMeetingRegistration: true, WhoCanRegister: 'Everyone', AllowEngagementReport: 'Enabled', AllowOutlookAddIn: true,
      AllowUserToJoinExternalMeeting: 'Disabled', StreamingAttendeeMode: 'Enabled', MediaBitRateKb: 50000, VideoFiltersMode: 'AllFilters',
      AllowWatermarkForScreenSharing: false, AllowWatermarkForCameraVideo: false, ExplicitRecordingConsent: 'Disabled',
      Key: '[{urn:schema:Microsoft.Rtc.Management.Policy.Meeting:2015}TeamsMeetingPolicy,Tenant{00000000-0000-4000-8000-000000000154},Global]', XsAnyElements: null,
    },
    { Identity: 'Tag:AllOn', Description: 'Built-in', AllowMeetNow: true, AllowCloudRecording: true },
  ],
  'Get-CsTeamsMessagingPolicy': [
    {
      Identity: 'Global', Description: null, AllowUrlPreviews: true, AllowOwnerDeleteMessage: false, AllowUserEditMessage: true, AllowUserDeleteMessage: true,
      AllowUserDeleteChat: true, AllowUserChat: true, AllowRemoveUser: true, AllowGiphy: true, GiphyRatingType: 'Moderate', AllowGiphyDisplay: true,
      AllowPasteInternetImage: true, AllowMemes: true, AllowImmersiveReader: true, AllowStickers: true, AllowUserTranslation: true,
      ReadReceiptsEnabledType: 'UserPreference', AllowPriorityMessages: true, AllowSmartReply: true, AllowSmartCompose: true, ChannelsInChatListEnabledType: 'DisabledUserOverride',
      AudioMessageEnabledType: 'ChatsAndChannels', ChatPermissionRole: 'Restricted', AllowFullChatPermissionUserToDeleteAnyMessage: false, AllowVideoMessages: true,
      AllowCommunicationComplianceEndUserReporting: true, AllowSecurityEndUserReporting: true, AllowGroupChatJoinLinks: false,
    },
    {
      Identity: 'Tag:Students', Description: 'No memes in class', AllowUrlPreviews: true, AllowOwnerDeleteMessage: false, AllowUserEditMessage: false, AllowUserDeleteMessage: false,
      AllowUserDeleteChat: false, AllowUserChat: true, AllowRemoveUser: false, AllowGiphy: false, GiphyRatingType: 'Strict', AllowGiphyDisplay: false,
      AllowPasteInternetImage: false, AllowMemes: false, AllowImmersiveReader: true, AllowStickers: false, AllowUserTranslation: true,
      ReadReceiptsEnabledType: 'UserPreference', AllowPriorityMessages: false, AllowSmartReply: true, AllowSmartCompose: true, ChannelsInChatListEnabledType: 'DisabledUserOverride',
      AudioMessageEnabledType: 'Disabled', ChatPermissionRole: 'Restricted', AllowFullChatPermissionUserToDeleteAnyMessage: false, AllowVideoMessages: false,
      AllowCommunicationComplianceEndUserReporting: true, AllowSecurityEndUserReporting: true, AllowGroupChatJoinLinks: false,
    },
  ],
  'Get-CsTeamsAppSetupPolicy': [
    { Identity: 'Global', Description: null, AppPresetList: [{ Id: '14d6962d-6eeb-4f48-8890-de55454bb136' }], AppPresetMeetingList: [], PinnedAppBarApps: [{ Id: '14d6962d-6eeb-4f48-8890-de55454bb136', Order: 1 }], PinnedMessageBarApps: [], AllowUserPinning: true, AllowSideLoading: false },
  ],
  'Get-CsTeamsAppPermissionPolicy': [
    { Identity: 'Global', Description: null, DefaultCatalogAppsType: 'BlockedAppList', DefaultCatalogApps: [], GlobalCatalogAppsType: 'BlockedAppList', GlobalCatalogApps: [], PrivateCatalogAppsType: 'BlockedAppList', PrivateCatalogApps: [] },
  ],
  'Get-CsTenantFederationConfiguration': [
    {
      Identity: 'Global', AllowFederatedUsers: true, AllowedDomains: { AllowedDomain: [{ Domain: 'partner.test' }] }, BlockedDomains: [{ Domain: 'blocked.test' }], BlockAllSubdomains: false,
      AllowTeamsConsumer: false, AllowTeamsConsumerInbound: false, RestrictTeamsConsumerToExternalUserProfiles: false, AllowPublicUsers: false,
      TreatDiscoveredPartnersAsUnverified: false, SharedSipAddressSpace: false, ExternalAccessWithTrialTenants: 'Blocked', AllowedTrialTenantDomains: [],
    },
  ],
  'Get-CsTeamsClientConfiguration': [
    {
      Identity: 'Global', AllowGuestUser: true, AllowEmailIntoChannel: true, RestrictedSenderList: 'contoso.test;partner.test', AllowDropBox: true, AllowBox: true, AllowGoogleDrive: true,
      AllowShareFile: true, AllowEgnyte: true, AllowOrganizationTab: true, AllowSkypeBusinessInterop: true, ContentPin: 'RequiredOutsideScheduleMeeting', AllowResourceAccountSendMessage: true,
      ResourceAccountContentAccess: 'NoAccess', AllowScopedPeopleSearchandAccess: false, AllowRoleBasedChatPermissions: false,
    },
  ],
  'Get-CsTeamsGuestMeetingConfiguration': [
    { Identity: 'Global', AllowIPVideo: true, ScreenSharingMode: 'EntireScreen', AllowMeetNow: true, LiveCaptionsEnabledType: 'Disabled', AllowTranscription: false },
  ],
  'Get-CsTeamsGuestMessagingConfiguration': [
    { Identity: 'Global', AllowUserEditMessage: true, AllowUserDeleteMessage: true, AllowUserDeleteChat: true, AllowUserChat: true, AllowGiphy: true, GiphyRatingType: 'Moderate', AllowMemes: true, AllowImmersiveReader: true, AllowStickers: true },
  ],
  'Get-CsTeamsGuestCallingConfiguration': [
    { Identity: 'Global', AllowPrivateCalling: true },
  ],
});
// The SAMPLE built-in Tag:AllOn meeting policy answers only some fields; the full set.
const COMPLETE = Object.freeze({
  ...SAMPLE,
  'Get-CsTeamsMeetingPolicy': [SAMPLE['Get-CsTeamsMeetingPolicy'][0], { ...SAMPLE['Get-CsTeamsMeetingPolicy'][0], Identity: 'Tag:AllOn', Description: 'Built-in' }],
});

// The allowlist the container enforces, parsed from the script it ships.
function containerAllowlist(variable) {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const TEAMS_POLICY_ALLOWED = containerAllowlist('AllowedTeamsPolicy');

/**
 * A fake Microsoft Teams session behind the real jobQueue spawn path. It plays
 * run-cmdlet.ps1 for the Teams policy session. `answers[cmdlet]` overrides the
 * sample: a list is the output, `{ error }` an error envelope, 'crash' a non-zero
 * exit with no envelope.
 */
function fakeTeams({ answers = {}, base = SAMPLE } = {}) {
  const calls = [];
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });
  function run(job) {
    const keys = Object.keys(job).filter((key) => key !== 'jobId').sort();
    if (job.mode !== 'cmdlet' || keys.some((key) => !['adapter', 'cmdlet', 'mode', 'module', 'parameters', 'tenantConfigPath'].includes(key))) {
      return { stdout: '', stderr: `run-job.sh: refused descriptor with ${keys.join(',')}`, exitCode: 2 };
    }
    if (job.module !== 'MicrosoftTeams' || !TEAMS_POLICY_ALLOWED[job.cmdlet]) {
      return envelope({ ok: false, error: { message: `cmdlet ${job.cmdlet} is not allowed`, category: null, errorId: 'CmdletNotAllowed' } }, 1);
    }
    for (const name of Object.keys(job.parameters ?? {})) {
      if (!TEAMS_POLICY_ALLOWED[job.cmdlet].includes(name)) return envelope({ ok: false, error: { message: `parameter ${name} is not allowed`, category: null, errorId: 'ParameterNotAllowed' } }, 1);
    }
    calls.push({ cmdlet: job.cmdlet, parameters: job.parameters ?? {} });
    const answer = answers[job.cmdlet] ?? base[job.cmdlet];
    if (answer === 'crash') return { stdout: '', stderr: 'pwsh: segmentation fault', exitCode: 139 };
    if (answer?.error) return envelope({ ok: false, error: answer.error }, 1);
    return envelope({ ok: true, output: structuredClone(answer) });
  }
  function spawnFn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let input = '';
    child.stdin = {
      write(chunk) { input += chunk; },
      end() {
        queueMicrotask(() => {
          const result = run(JSON.parse(input));
          if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
          if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
          child.emit('close', result.exitCode);
        });
      },
    };
    return child;
  }
  return { calls, powershell: { spawnFn, timeoutMs: 200, tenantConfigPath: '/etc/keel/tenant.json' } };
}

// ---------------------------------------------------------------- ledgers

const liveCapture = (operationId, tenantRef) => {
  const descriptor = WORKLOAD_DESCRIPTORS.find((item) => item.id === operationId);
  const version = descriptor.operation.kind === 'graph' ? descriptor.operation.version : MODULE_VERSIONS[descriptor.operation.module];
  return { operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-08T00:00:00Z', version, ok: true, proofRef: `${operationId}@sha256:x` };
};
const fixtureRun = (operationId) => ({ operationId, kind: 'fixture', synthetic: true, ok: true, proofRef: `${operationId}.fixture` });
const GRANTS = Object.freeze({
  permissions: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.permissions))],
  roles: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.roles))],
});
const RUNTIME = Object.freeze({ modules: MODULE_VERSIONS });
function ledgerWith(tenantRef, live) {
  const evidence = WORKLOAD_DESCRIPTORS.map((descriptor) => (live.includes(descriptor.id) ? liveCapture(descriptor.id, tenantRef) : fixtureRun(descriptor.id)));
  return buildWorkloadLedger({ evidence, grants: GRANTS, runtime: RUNTIME, tenantRef, now: NOW });
}
const ALL_READS = Object.freeze(WORKLOAD_DESCRIPTORS.map((descriptor) => descriptor.id));
const OTHER_READS = Object.freeze(ALL_READS.filter((id) => !TEAMS_POLICY_OPERATIONS.includes(id)));

// ---------------------------------------------------------------- tests

test('each Teams org-wide policy read is declared, in scope, probed, read-only and ships disabled', async () => {
  const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === TEAMS_POLICY_WORKLOAD);
  assert.deepEqual(declared.map((descriptor) => descriptor.operation.cmdlet), [
    'Get-CsTeamsMeetingPolicy', 'Get-CsTeamsMessagingPolicy', 'Get-CsTeamsAppSetupPolicy', 'Get-CsTeamsAppPermissionPolicy',
    'Get-CsTenantFederationConfiguration', 'Get-CsTeamsClientConfiguration', 'Get-CsTeamsGuestMeetingConfiguration',
    'Get-CsTeamsGuestMessagingConfiguration', 'Get-CsTeamsGuestCallingConfiguration',
  ]);
  assert.deepEqual(declared.map((descriptor) => descriptor.id), [...TEAMS_POLICY_OPERATIONS]);
  // The task-101 meeting policy read moved here; it is declared once, under its old id.
  assert.deepEqual(WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.operation.cmdlet === 'Get-CsTeamsMeetingPolicy').map((descriptor) => descriptor.id), ['teams.meeting-policies']);
  assert.ok(!WORKLOAD_DESCRIPTORS.some((descriptor) => descriptor.workload === 'teams-settings' && descriptor.operation.kind === 'cmdlet'));
  for (const descriptor of declared) {
    assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
    assert.equal(descriptor.operation.module, 'MicrosoftTeams');
    assert.deepEqual(descriptor.operation.parameters, []);
    assert.deepEqual(descriptor.rbac, { permissions: [], roles: ['Teams Administrator'] });
    assert.match(descriptor.source.url, /^https:\/\/learn\.microsoft\.com\/en-us\/powershell\/module\/teams\/get-cs/);
  }

  // The read-only probe runs each one in the Teams session.
  const probe = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const teams = /# --- Teams([\s\S]*?)# --- SharePoint/.exec(probe)[1];
  for (const descriptor of declared) assert.match(teams, new RegExp(`-Workload 'teams' -Name '${descriptor.operation.probeName}'`), descriptor.id);

  // No proof: disabled. Fixture proof: fixture-tested, still disabled.
  const bare = buildWorkloadLedger({ grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  for (const id of TEAMS_POLICY_OPERATIONS) {
    const row = bare.rows.find((item) => item.id === id);
    assert.equal(row.state, 'disabled', id);
    assert.equal(row.enabled, false, id);
  }
  const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

  // Registered disabled; read-only; no write of any kind.
  assert.equal(TEAMS_POLICY_DESCRIPTOR.enabledByDefault, false);
  assert.equal(TEAMS_POLICY_DESCRIPTOR.readOnly, true);
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === TEAMS_POLICY_WORKLOAD && descriptor.enabledByDefault === false));
  assert.deepEqual(Object.values(WORKLOAD_WRITE_OPERATIONS).filter((operation) => operation.workload === TEAMS_POLICY_WORKLOAD), []);
  assert.ok(Object.keys(TEAMS_POLICY_CMDLET_PARAMETERS).every((cmdlet) => cmdlet.startsWith('Get-')));
  assert.deepEqual(Object.fromEntries(Object.entries(TEAMS_POLICY_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), TEAMS_POLICY_ALLOWED,
    'the Node and container allowlists are identical');
  for (const cmdlet of ['Set-CsTeamsMeetingPolicy', 'New-CsTeamsMessagingPolicy', 'Grant-CsTeamsAppSetupPolicy', 'Remove-CsTeamsAppPermissionPolicy', 'Set-CsTenantFederationConfiguration', 'Get-CsOnlineUser', 'Get-Team']) {
    assert.throws(() => assertTeamsPolicyCmdlet({ cmdlet }), TeamsPolicyScopeError, cmdlet);
  }
  assert.throws(() => assertTeamsPolicyCmdlet({ cmdlet: 'Get-CsTeamsMeetingPolicy', parameters: { Identity: 'Global' } }), /does not take Identity/);
});

test('every policy and configuration is one observation under its Identity, with declared fields only', async () => {
  const session = fakeTeams({
    answers: {
      // Identity is compared without case; a duplicate is stored once; a credential typed
      // into a description is redacted; a policy with no usable Identity is not guessed at.
      'Get-CsTeamsMessagingPolicy': [
        ...SAMPLE['Get-CsTeamsMessagingPolicy'],
        { ...SAMPLE['Get-CsTeamsMessagingPolicy'][1], Identity: 'tag:students' },
        { ...SAMPLE['Get-CsTeamsMessagingPolicy'][1], Identity: 'Tag:Contractors', Description: 'Bearer abcdefghijklmnopqrstuvwxyz' },
        { ...SAMPLE['Get-CsTeamsMessagingPolicy'][1], Identity: 'Site:Redmond' },
        { ...SAMPLE['Get-CsTeamsMessagingPolicy'][1], Identity: null },
      ],
    },
  });
  const result = await readTeamsPolicies({ powershell: session.powershell, now: () => NOW });

  // One call per family, no parameters, nothing else.
  assert.deepEqual(session.calls.map((call) => call.cmdlet), FAMILY_NAMES.map((name) => FAMILIES[name].cmdlet));
  assert.ok(session.calls.every((call) => Object.keys(call.parameters).length === 0));

  assert.deepEqual(result.resources.map((resource) => resource.resourceKey), [
    'meeting-policy:global', 'meeting-policy:tag:allon',
    'messaging-policy:global', 'messaging-policy:tag:students', 'messaging-policy:tag:contractors',
    'app-setup-policy:global', 'app-permission-policy:global',
    'federation-configuration:global', 'client-configuration:global', 'guest-meeting-configuration:global',
    'guest-messaging-configuration:global', 'guest-calling-configuration:global',
  ]);
  const students = result.resources.find((resource) => resource.resourceKey === 'messaging-policy:tag:students');
  assert.equal(students.fields.Identity, 'Tag:Students', 'the Identity is kept as Teams answered it; only the key is lower-cased');
  assert.equal(result.discovery.unidentified, 2);

  // Declared fields only: extras (the internal Key, XsAnyElements) are dropped.
  for (const resource of result.resources) {
    const declared = FAMILIES[resource.kind].fields;
    assert.deepEqual(Object.keys(resource.fieldCoverage).sort(), [...declared].sort(), resource.resourceKey);
    assert.ok(Object.keys(resource.fields).every((field) => declared.includes(field)), resource.resourceKey);
  }
  const stored = JSON.stringify(result.resources);
  for (const dropped of ['XsAnyElements', 'urn:schema:Microsoft.Rtc']) assert.ok(!stored.includes(dropped), dropped);

  // A built-in policy that does not answer a declared field is an unknown, not a false.
  const allOn = result.resources.find((resource) => resource.resourceKey === 'meeting-policy:tag:allon');
  assert.equal(allOn.fieldCoverage.AllowTranscription.status, 'unknown');
  assert.equal(allOn.fields.AllowTranscription, undefined);

  const contractors = result.resources.find((resource) => resource.resourceKey === 'messaging-policy:tag:contractors');
  assert.equal(contractors.fieldCoverage.Description.status, 'redacted');
  assert.ok(!stored.includes('abcdefghijklmnopqrstuvwxyz'));
  const redaction = { redactedFields: 0, seen: new WeakSet() };
  redactPayload(result.resources.map((resource) => resource.fields), redaction);
  assert.equal(redaction.redactedFields, 0, 'nothing left that the shared redactor would catch');

  // Federation keeps its domain lists as Teams answered them.
  const federation = result.resources.find((resource) => resource.resourceKey === 'federation-configuration:global');
  assert.deepEqual(federation.fields.AllowedDomains, { AllowedDomain: [{ Domain: 'partner.test' }] });
  assert.equal(federation.fields.ExternalAccessWithTrialTenants, 'Blocked');
  const client = result.resources.find((resource) => resource.resourceKey === 'client-configuration:global');
  assert.equal(client.fields.AllowGuestUser, true);

  // Identities: policies are Global or Tag:<name>; configurations are Global only.
  assert.equal(objectIdentity('meetingPolicy', { Identity: 'Global' }), 'global');
  assert.equal(objectIdentity('meetingPolicy', { Identity: 'Tag:RestrictedAnonymousAccess' }), 'tag:restrictedanonymousaccess');
  assert.equal(objectIdentity('meetingPolicy', { Identity: 'Tag:' }), null);
  assert.equal(objectIdentity('meetingPolicy', { Identity: 'Tag:a\nb' }), null);
  assert.equal(objectIdentity('meetingPolicy', { Name: 'Global' }), null);
  assert.equal(objectIdentity('federationConfiguration', { Identity: 'Global' }), 'global');
  assert.equal(objectIdentity('federationConfiguration', { Identity: 'Tag:Other' }), null);
  assert.equal(objectIdentity('guestCallingConfiguration', {}), null);
  assert.equal(result.outcome, 'partial', 'unidentified objects, an unknown field and a redacted value are gaps');

  const clean = await readTeamsPolicies({ powershell: fakeTeams({ base: COMPLETE }).powershell, now: () => NOW });
  assert.equal(clean.outcome, 'complete');
  assert.equal(clean.resources.length, 11);
  assert.ok(Object.values(clean.discovery.families).every((family) => family.status === 'read'));
});

test('failures are structured gaps, and a family with no Global answer is never complete', async () => {
  const mixed = await readTeamsPolicies({
    powershell: fakeTeams({
      base: COMPLETE,
      answers: {
        'Get-CsTeamsAppPermissionPolicy': { error: { message: 'Access Denied. User is not authorized to perform this operation.', category: 'PermissionDenied', errorId: 'AccessDenied' } },
        'Get-CsTeamsGuestCallingConfiguration': 'crash',
        'Get-CsTeamsGuestMeetingConfiguration': [],
      },
    }).powershell,
  });
  assert.equal(mixed.outcome, 'partial');
  assert.deepEqual(mixed.failures.map((failure) => [failure.family, failure.status, failure.error.code]), [
    ['appPermissionPolicy', 'denied', 'CMDLET_ERROR'], ['guestCallingConfiguration', 'failed', 'NONZERO_EXIT'],
  ]);
  assert.deepEqual(mixed.discovery.families.guestMeetingConfiguration, { status: 'read', objects: 0 });
  assert.deepEqual(mixed.discovery.empty, ['guestMeetingConfiguration']);

  // Only the empty family wrong: still partial, because every tenant has a Global one.
  const onlyEmpty = await readTeamsPolicies({ powershell: fakeTeams({ base: COMPLETE, answers: { 'Get-CsTeamsGuestMeetingConfiguration': [] } }).powershell });
  assert.equal(onlyEmpty.outcome, 'partial');
  assert.deepEqual(onlyEmpty.failures, []);

  await assert.rejects(readTeamsPolicies({ powershell: fakeTeams().powershell, families: [] }), TypeError);

  const everything = Object.fromEntries(FAMILY_NAMES.map((name) => [FAMILIES[name].cmdlet, 'crash']));
  assert.equal((await readTeamsPolicies({ powershell: fakeTeams({ answers: everything }).powershell })).outcome, 'failed');
});

test('collection stays off until Teams and every policy read are qualified', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const session = fakeTeams({ base: COMPLETE });

  // Fixture proof only, or every policy read live but Teams not: disabled, nothing sent.
  const withoutTeams = ALL_READS.filter((id) => !TEAMS_OPERATIONS.includes(id));
  for (const ledger of [ledgerWith(tenantRef, OTHER_READS), ledgerWith(tenantRef, withoutTeams)]) {
    const disabled = await collectTeamsPolicies(client, { tenantRef, ledger, powershell: session.powershell, now: () => NOW });
    assert.equal(disabled.run.outcome, 'disabled');
    assert.equal(disabled.result, null);
  }
  assert.deepEqual(session.calls, [], 'nothing is sent while disabled');
  assert.match(teamsPolicyActivation(ledgerWith(tenantRef, OTHER_READS)).reasons.join('; '), /teams\.federation-configuration is fixture-tested/);
  assert.match(teamsPolicyActivation(ledgerWith(tenantRef, withoutTeams)).reasons[0], /Teams is not qualified yet/);
  // One read missing keeps the whole workload off.
  assert.equal(teamsPolicyActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => id !== 'teams.guest-calling-configuration'))).enabled, false);
  // A live capture under another MicrosoftTeams version no longer counts.
  const drifted = buildWorkloadLedger({
    evidence: ALL_READS.map((id) => liveCapture(id, tenantRef)), grants: GRANTS, tenantRef, now: NOW,
    runtime: { modules: { ...MODULE_VERSIONS, MicrosoftTeams: '8.0.0' } },
  });
  assert.equal(teamsPolicyActivation(drifted).enabled, false);

  // Everything live: complete, one stored observation per object.
  const full = await collectTeamsPolicies(client, { tenantRef, ledger: ledgerWith(tenantRef, ALL_READS), powershell: session.powershell, now: () => NOW });
  assert.equal(full.run.outcome, 'complete');
  assert.equal(session.calls.length, FAMILY_NAMES.length);
  const { rows } = await client.query(`SELECT resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key`, [full.run.id]);
  assert.equal(rows.length, 11);
  const federation = rows.find((row) => row.resource_key === 'federation-configuration:global');
  assert.equal(federation.fields.identity, 'global');
  assert.equal(federation.fields.kind, 'federationConfiguration');
  assert.equal(federation.fields.AllowFederatedUsers, true);
  assert.equal(federation.field_coverage.AllowedDomains.status, 'observed');

  // Coverage lists the workload; its type never enters an Entra wave.
  const report = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [], now: NOW });
  const entry = report.workloads.find((item) => item.workload === TEAMS_POLICY_WORKLOAD);
  assert.equal(entry.status, 'complete');
  assert.throws(() => planWaves([{ naturalKey: 'x', resourceType: 'teamsOrgPolicy', verb: 'update', payload: {} }]), /workload restore path/);
  assert.throws(() => planDeletionWaves([{ naturalKey: 'x', resourceType: 'teamsOrgPolicy', verb: 'delete', payload: {} }]), /workload restore path/);
});
