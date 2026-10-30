// Teams collaboration policies and meeting settings (gap audit section D), read-only.
//
// Acceptance:
//  - each read is declared in workloadContract.mjs, passes the scope validator, is run
//    by the read-only probe in the Teams session, and ships disabled;
//  - the Node and container allowlists hold Get cmdlets only, take no parameters and
//    are identical;
//  - a fixture read of every family is keyed by Identity, with declared fields only;
//  - gaps are partial, never complete: a failed or empty required family, an
//    unidentified or conflicting answer;
//  - without qualification nothing is sent and a disabled run is recorded;
//  - each workload sits in its own Teams group, in the list order.
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays ops/powershell/run-cmdlet.ps1 through the real jobQueue spawn path.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  COLLABORATION_FAMILIES, MEETING_SETTINGS_FAMILIES, TEAMS_COLLABORATION_CMDLET_PARAMETERS, TEAMS_COLLABORATION_DESCRIPTOR,
  TEAMS_COLLABORATION_OPERATIONS, TEAMS_COLLABORATION_WORKLOAD, TEAMS_MEETING_SETTINGS_CMDLET_PARAMETERS, TEAMS_MEETING_SETTINGS_DESCRIPTOR,
  TEAMS_MEETING_SETTINGS_OPERATIONS, TEAMS_MEETING_SETTINGS_WORKLOAD, TeamsCollaborationScopeError, assertTeamsCollaborationCmdlet,
  assertTeamsMeetingSettingsCmdlet, collectTeamsCollaboration, collectTeamsMeetingSettings, readTeamsCollaboration, readTeamsMeetingSettings,
  teamsCollaborationActivation, teamsMeetingSettingsActivation,
} from './teamsCollaboration.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../workloadContract.mjs';
import { listWorkloads } from '../registry.mjs';
import { WORKLOAD_COLLECTORS } from './registry.mjs';
import { TAXONOMY } from '../../insights/taxonomy.mjs';
import { runFixtureHarness } from '../../../tools/qualification/workloads.mjs';
import { createIsolatedTestDatabase } from '../../test/dbTestHelper.mjs';
import { ALL_READS, GRANTS, RUNTIME, containerAllowlist, fakeCmdletContainer, ledgerWith } from '../../test/fakeCmdletContainer.mjs';
import { schemaSql } from '../../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(schemaSql());
    schemaReady = true;
  }
  return client;
}

const NOW = new Date('2026-10-30T12:00:00Z');
const ALLOWED = containerAllowlist('AllowedTeamsCollaboration');
const pair = (name, extra = {}) => [{ Identity: 'Global', Description: '', ...extra }, { Identity: `Tag:KEEL-RT-${name}`, Description: 'fixture', ...extra }];
const global = (extra) => [{ Identity: 'Global', ...extra }];

// What the Teams session answers, with the extra properties a careless reader would keep.
const SAMPLE = Object.freeze({
  'Get-CsExternalAccessPolicy': pair('external', { EnableFederationAccess: true, CommunicationWithExternalOrgs: 'OrganizationDefault', AllowedExternalDomains: [], BlockedExternalDomains: ['blocked.test'], EnableTeamsConsumerAccess: false, Key: '[{urn:schema:Microsoft.Rtc.Management.Policy.ExternalAccess}ExternalAccessPolicy]', XsAnyElements: null }),
  'Get-CsTeamsChannelsPolicy': pair('channels', { AllowPrivateChannelCreation: false, AllowSharedChannelCreation: true, AllowChannelSharingToExternalUser: false }),
  'Get-CsTeamsFilesPolicy': pair('files', { NativeFileEntryPoints: 'Enabled', SPChannelFilesTab: 'Enabled' }),
  'Get-CsTeamsTemplatePermissionPolicy': pair('templates', { HiddenTemplates: [{ Id: 'com.microsoft.teams.template.ManageAProject' }] }),
  'Get-CsTeamsShiftsPolicy': pair('shifts', { ShiftNoticeFrequency: 'Always', AccessType: 'UnrestrictedAccess_TeamsApp', AccessGracePeriodMinutes: 15 }),
  'Get-CsTeamsUpgradePolicy': [{ Identity: 'Global', Description: '', Mode: 'TeamsOnly', NotifySfbUsers: false }, { Identity: 'Tag:Islands', Description: 'built-in', Mode: 'Islands', NotifySfbUsers: false }],
  'Get-CsTeamsUpgradeConfiguration': global({ DownloadTeams: true, SfBMeetingJoinUx: 'NativeLimitedClient' }),
  'Get-CsTeamsAcsFederationConfiguration': global({ EnableAcsUsers: false, AllowedAcsResources: [] }),
  'Get-CsTeamsEnhancedEncryptionPolicy': pair('e2ee', { CallingEndtoEndEncryptionEnabledType: 'DisabledUserOverride', MeetingEndToEndEncryption: 'Disabled' }),
  'Get-CsTeamsComplianceRecordingPolicy': [{ Identity: 'Tag:KEEL-RT-recording', Description: 'fixture', Enabled: false, WarnUserOnRemoval: true, ComplianceRecordingApplications: [{ Id: '00000000-0000-4000-8000-00000000c0de', Priority: 1 }] }],
  'Get-CsTeamsMeetingTemplatePermissionPolicy': pair('meeting-templates', { HiddenMeetingTemplates: [] }),
  'Get-CsTeamsMeetingConfiguration': global({ DisableAnonymousJoin: false, EnableQoS: true, ClientAudioPort: 50000, ClientAudioPortRange: 20, LogoURL: null, LegalURL: 'https://contoso.test/legal' }),
});
const answer = (overrides = {}) => (cmdlet) => (cmdlet in overrides ? overrides[cmdlet] : SAMPLE[cmdlet]);
const container = (overrides) => fakeCmdletContainer({ module: 'MicrosoftTeams', allowlist: ALLOWED, answer: answer(overrides) });
// Both answer every declared field.
const full = (families) => Object.fromEntries(Object.values(families).map(({ cmdlet, fields }) => [
  cmdlet, SAMPLE[cmdlet].map((body) => ({ ...Object.fromEntries(fields.map((field) => [field, null])), ...body })),
]));
const OWN = [...TEAMS_COLLABORATION_OPERATIONS, ...TEAMS_MEETING_SETTINGS_OPERATIONS];
// These follow Teams, which follows SharePoint.
const TEAMS_GATE = ALL_READS.filter((id) => (id.startsWith('sharepoint.') || id.startsWith('teams.')) && !OWN.includes(id));

const WORKLOADS = [
  [TEAMS_COLLABORATION_WORKLOAD, COLLABORATION_FAMILIES, TEAMS_COLLABORATION_OPERATIONS, TEAMS_COLLABORATION_DESCRIPTOR, TEAMS_COLLABORATION_CMDLET_PARAMETERS],
  [TEAMS_MEETING_SETTINGS_WORKLOAD, MEETING_SETTINGS_FAMILIES, TEAMS_MEETING_SETTINGS_OPERATIONS, TEAMS_MEETING_SETTINGS_DESCRIPTOR, TEAMS_MEETING_SETTINGS_CMDLET_PARAMETERS],
];

test('each read is declared, in scope, probed, read-only and ships disabled', async () => {
  const probe = readFileSync(new URL('../../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const teamsProbe = /# --- Teams([\s\S]*?)# --- SharePoint/.exec(probe)[1];
  const union = {};
  for (const [workload, families, operations, descriptor, parameters] of WORKLOADS) {
    const declared = WORKLOAD_DESCRIPTORS.filter((entry) => entry.workload === workload);
    assert.deepEqual(declared.map((entry) => entry.id), [...operations]);
    assert.deepEqual(declared.map((entry) => entry.operation.cmdlet), Object.values(families).map((spec) => spec.cmdlet));
    for (const entry of declared) {
      assert.deepEqual(descriptorProblems(entry), [], entry.id);
      assert.equal(entry.operation.module, 'MicrosoftTeams');
      assert.deepEqual(entry.operation.parameters, []);
      assert.deepEqual(entry.rbac.roles, ['Teams Administrator']);
      assert.match(teamsProbe, new RegExp(`-Workload 'teams' -Name '${entry.operation.probeName}'`), entry.id);
    }

    // Fixture proof never enables a read.
    const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
    assert.ok(results.every((result) => result.ok), JSON.stringify(results));
    const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
    assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

    assert.equal(descriptor.enabledByDefault, false);
    assert.equal(descriptor.readOnly, true);
    assert.ok(listWorkloads().some((entry) => entry.workload === workload && entry.enabledByDefault === false));
    assert.ok(WORKLOAD_COLLECTORS.some((entry) => entry.workload === workload && entry.powershellFamily === 'teams'));
    assert.ok(Object.keys(parameters).every((cmdlet) => cmdlet.startsWith('Get-')));
    Object.assign(union, Object.fromEntries(Object.entries(parameters).map(([name, list]) => [name, [...list]])));
  }
  // The container holds exactly both workloads' cmdlets, with no parameters.
  assert.ok(Object.keys(ALLOWED).every((cmdlet) => cmdlet.startsWith('Get-')));
  assert.deepEqual(union, ALLOWED);

  for (const cmdlet of ['Set-CsExternalAccessPolicy', 'Grant-CsTeamsChannelsPolicy', 'New-CsTeamsComplianceRecordingPolicy', 'Get-CsOnlineUser', 'Get-CsTeamsMeetingConfiguration']) {
    assert.throws(() => assertTeamsCollaborationCmdlet({ cmdlet }), TeamsCollaborationScopeError, cmdlet);
  }
  assert.throws(() => assertTeamsMeetingSettingsCmdlet({ cmdlet: 'Get-CsExternalAccessPolicy' }), TeamsCollaborationScopeError);
  assert.throws(() => assertTeamsCollaborationCmdlet({ cmdlet: 'Get-CsExternalAccessPolicy', parameters: { Identity: 'Global' } }), /does not take Identity/);
  assert.ok(assertTeamsMeetingSettingsCmdlet({ cmdlet: 'Get-CsTeamsMeetingConfiguration' }));
});

test('a fixture read of every family is keyed by identity, with declared fields only', async () => {
  const fake = container();
  const result = await readTeamsCollaboration({ powershell: fake.powershell, now: () => NOW });
  assert.equal(result.outcome, 'partial', 'sample answers omit some declared fields');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(fake.calls.map((call) => call.cmdlet), Object.values(COLLABORATION_FAMILIES).map((spec) => spec.cmdlet));
  assert.ok(fake.calls.every((call) => Object.keys(call.parameters).length === 0));
  const keys = result.resources.map((resource) => resource.resourceKey);
  for (const key of ['external-access-policy:global', 'external-access-policy:tag:keel-rt-external', 'channels-policy:tag:keel-rt-channels',
    'upgrade-policy:tag:islands', 'upgrade-configuration:global', 'acs-federation-configuration:global']) assert.ok(keys.includes(key), key);
  const external = result.resources.find((resource) => resource.resourceKey === 'external-access-policy:global');
  assert.deepEqual(external.fields.BlockedExternalDomains, ['blocked.test']);
  assert.ok(!('Key' in external.fields) && !('XsAnyElements' in external.fields), 'undeclared fields are dropped');

  const meetings = await readTeamsMeetingSettings({ powershell: container().powershell, now: () => NOW });
  const config = meetings.resources.find((resource) => resource.resourceKey === 'meeting-configuration:global');
  assert.equal(config.fields.DisableAnonymousJoin, false);
  assert.equal(config.fields.LogoURL, null);
  assert.equal(config.fieldCoverage.LogoURL.status, 'observed', 'null is a value, not a gap');
  const recording = meetings.resources.find((resource) => resource.kind === 'complianceRecordingPolicy');
  assert.deepEqual(recording.fields.ComplianceRecordingApplications, [{ Id: '00000000-0000-4000-8000-00000000c0de', Priority: 1 }]);

  // Every declared field answered: complete, for both workloads.
  assert.equal((await readTeamsCollaboration({ powershell: container(full(COLLABORATION_FAMILIES)).powershell, now: () => NOW })).outcome, 'complete');
  const complete = await readTeamsMeetingSettings({ powershell: container(full(MEETING_SETTINGS_FAMILIES)).powershell, now: () => NOW });
  assert.equal(complete.outcome, 'complete');
  assert.deepEqual(complete.unknownFields, {});
  // No compliance recording policy is an empty tenant, not a gap; no meeting configuration is a gap.
  const noRecording = await readTeamsMeetingSettings({
    powershell: container({ ...full(MEETING_SETTINGS_FAMILIES), 'Get-CsTeamsComplianceRecordingPolicy': [] }).powershell, now: () => NOW,
  });
  assert.equal(noRecording.outcome, 'complete');
  const noConfig = await readTeamsMeetingSettings({
    powershell: container({ ...full(MEETING_SETTINGS_FAMILIES), 'Get-CsTeamsMeetingConfiguration': [] }).powershell, now: () => NOW,
  });
  assert.equal(noConfig.outcome, 'partial');
  assert.deepEqual(noConfig.discovery.empty, ['meetingConfiguration']);
  // A declared field an answer lacks is named, per family, with its object count.
  const filesFull = full(COLLABORATION_FAMILIES);
  const lacking = await readTeamsCollaboration({
    powershell: container({ ...filesFull, 'Get-CsTeamsFilesPolicy': filesFull['Get-CsTeamsFilesPolicy'].map(({ SPChannelFilesTab, ...body }) => body) }).powershell,
    now: () => NOW,
  });
  assert.deepEqual(lacking.unknownFields, { filesPolicy: { SPChannelFilesTab: 2 } });
});

test('gaps make the run partial or failed, never complete', async () => {
  const denied = { error: { message: 'Access denied: the caller does not have permission', category: 'PermissionDenied', errorId: 'Forbidden' } };
  const answers = full(COLLABORATION_FAMILIES);
  const partial = await readTeamsCollaboration({
    powershell: container({
      ...answers,
      'Get-CsTeamsShiftsPolicy': denied,
      'Get-CsTeamsFilesPolicy': [],
      'Get-CsTeamsAcsFederationConfiguration': [...answers['Get-CsTeamsAcsFederationConfiguration'], { Identity: 'Tag:not-a-configuration' }],
      'Get-CsTeamsChannelsPolicy': [...answers['Get-CsTeamsChannelsPolicy'], { ...answers['Get-CsTeamsChannelsPolicy'][0], AllowPrivateChannelCreation: true }],
      'Get-CsExternalAccessPolicy': answers['Get-CsExternalAccessPolicy'].map((body, index) => (index === 1 ? { ...body, Description: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' } : body)),
    }).powershell,
    now: () => NOW,
  });
  assert.equal(partial.outcome, 'partial');
  assert.equal(partial.discovery.families.shiftsPolicy.status, 'denied');
  assert.deepEqual(partial.failures.map((failure) => failure.family), ['shiftsPolicy']);
  assert.deepEqual(partial.discovery.empty, ['filesPolicy']);
  assert.equal(partial.discovery.unidentified, 1, 'a configuration other than Global is not trusted');
  assert.deepEqual(partial.discovery.conflicts, [{ resourceKey: 'channels-policy:global', fields: ['AllowPrivateChannelCreation'] }]);
  const tagged = partial.resources.find((resource) => resource.resourceKey === 'external-access-policy:tag:keel-rt-external');
  assert.equal(tagged.fieldCoverage.Description.status, 'redacted');
  assert.ok(!JSON.stringify(partial.resources).includes('abcdefghijklmnopqrstuvwxyz0123456789'));

  const crashed = await readTeamsMeetingSettings({
    powershell: fakeCmdletContainer({ module: 'MicrosoftTeams', allowlist: ALLOWED, answer: () => 'crash' }).powershell, now: () => NOW,
  });
  assert.equal(crashed.outcome, 'failed');
  assert.equal(crashed.failures.length, Object.keys(MEETING_SETTINGS_FAMILIES).length);
});

test('without qualification nothing is sent; once qualified the run and its objects are stored', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = 'sha256:teams-collaboration';
  const fake = container();
  for (const collect of [collectTeamsCollaboration, collectTeamsMeetingSettings]) {
    const bare = await collect(client, { tenantRef, ledger: buildWorkloadLedger({ now: NOW }), powershell: fake.powershell, now: () => NOW });
    assert.equal(bare.run.outcome, 'disabled');
    assert.ok(bare.run.digest.reasons.some((reason) => reason.startsWith('Teams is not qualified yet')));
  }
  assert.equal(fake.calls.length, 0);

  // Teams qualified but one read here is not: still off.
  const short = teamsCollaborationActivation(ledgerWith(tenantRef, [...TEAMS_GATE, ...OWN.slice(1)], { now: NOW }));
  assert.equal(short.enabled, false);
  assert.deepEqual(short.reasons, [`${OWN[0]} is fixture-tested`]);
  // Each workload waits only for its own reads.
  const meetingsOnly = ledgerWith(tenantRef, [...TEAMS_GATE, ...TEAMS_MEETING_SETTINGS_OPERATIONS], { now: NOW });
  assert.equal(teamsMeetingSettingsActivation(meetingsOnly).enabled, true);
  assert.equal(teamsCollaborationActivation(meetingsOnly).enabled, false);

  const ledger = ledgerWith(tenantRef, [...TEAMS_GATE, ...OWN], { now: NOW });
  const live = await collectTeamsCollaboration(client, { tenantRef, ledger, powershell: fake.powershell, now: () => NOW });
  assert.equal(live.run.outcome, 'partial');
  const { rows } = await client.query('SELECT resource_key, fields FROM workload_observation WHERE collection_id = $1', [live.run.id]);
  assert.equal(rows.length, live.result.resources.length);
  assert.equal(rows.find((row) => row.resource_key === 'upgrade-policy:global').fields.kind, 'upgradePolicy');
  const { rows: [stored] } = await client.query('SELECT workload FROM workload_collection WHERE id = $1', [live.run.id]);
  assert.equal(stored.workload, TEAMS_COLLABORATION_WORKLOAD);
});

test('each workload sits in its own Teams group, in the portal\'s order', () => {
  assert.equal(TAXONOMY[TEAMS_COLLABORATION_WORKLOAD].service, 'Teams');
  assert.equal(TAXONOMY[TEAMS_COLLABORATION_WORKLOAD].category, 'org');
  assert.equal(TAXONOMY[TEAMS_MEETING_SETTINGS_WORKLOAD].category, 'calling');
  assert.ok(TAXONOMY[TEAMS_COLLABORATION_WORKLOAD].typeRank > TAXONOMY['teams-org-policies'].typeRank);
  // Meeting settings apply to every meeting, so they open Calling and meetings, before the calling policies.
  assert.ok(TAXONOMY[TEAMS_MEETING_SETTINGS_WORKLOAD].typeRank < TAXONOMY['teams-voice-policies'].typeRank);
  assert.ok(TAXONOMY[TEAMS_COLLABORATION_WORKLOAD].categoryRank < TAXONOMY[TEAMS_MEETING_SETTINGS_WORKLOAD].categoryRank);
  const portal = readFileSync(new URL('../../../portal/lib/restore-workloads-view.ts', import.meta.url), 'utf8');
  assert.match(portal, /"teams-org-policies", "teams-collaboration-policies", "teams-meeting-settings", "teams-voice-policies"/);
});
