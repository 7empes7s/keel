// Wave 1 READ-TEAMS-PV: Teams calling, voice and live event policies and policy
// assignments, read-only.
//
// Acceptance:
//  - each read is declared in workloadContract.mjs, passes the scope validator, is run
//    by the read-only probe in the Teams session, and ships disabled;
//  - the Node and container allowlists hold Get cmdlets only and are identical;
//  - a fixture read of every family is complete, keyed by Identity (users by object id,
//    group assignments by group and policy type), with declared fields only and no
//    secret stored;
//  - gaps are partial, never complete: a failed or empty family, a capped user read,
//    an unidentified or conflicting answer;
//  - without qualification nothing is sent and a disabled run is recorded.
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays ops/powershell/run-cmdlet.ps1 through the real jobQueue spawn path.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  FAMILIES, FAMILY_NAMES, TEAMS_EXTENDED_CMDLET_PARAMETERS, TEAMS_EXTENDED_DESCRIPTOR, TEAMS_EXTENDED_MISSING, TEAMS_EXTENDED_OPERATIONS,
  TEAMS_EXTENDED_WORKLOAD, TeamsExtendedScopeError, assertTeamsExtendedCmdlet, collectTeamsExtended, readTeamsExtended, teamsExtendedActivation,
} from './teamsExtended.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../workloadContract.mjs';
import { listWorkloads } from '../registry.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../coverage/qualification.mjs';
import { WKLD_WRITE_OPERATIONS } from '../../restore/workloads/writeDeclarations.mjs';
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

const NOW = new Date('2026-10-14T12:00:00Z');
const ALLOWED = containerAllowlist('AllowedTeamsExtended');
const oid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-00000000c0de`;
const pair = (name) => [{ Identity: 'Global', Description: '' }, { Identity: `Tag:KEEL-RT-${name}`, Description: 'fixture' }];

// What the Teams session answers, with the extra properties a careless reader would keep.
const SAMPLE = Object.freeze({
  'Get-CsTeamsCallingPolicy': pair('calling').map((body) => ({ ...body, AllowPrivateCalling: true, AllowVoicemail: 'UserOverride', AllowCallGroups: true, AllowDelegation: true, AllowCallForwardingToUser: true, AllowCallForwardingToPhone: true, PreventTollBypass: false, BusyOnBusyEnabledType: 'Disabled', AllowCloudRecordingForCalls: false, AllowTranscriptionForCalling: false, Key: '[{urn:schema:Microsoft.Teams.Policy}TeamsCallingPolicy]', XsAnyElements: null })),
  'Get-CsOnlineVoiceRoutingPolicy': pair('routing').map((body) => ({ ...body, OnlinePstnUsages: ['KEEL-RT-usage'], RouteType: 'BYOT' })),
  'Get-CsTenantDialPlan': pair('dialplan').map((body) => ({ ...body, SimpleName: body.Identity, NormalizationRules: [{ Pattern: '^(\\d{4})$', Translation: '+1425555$1' }], OptimizeDeviceDialing: false, ExternalAccessPrefix: null })),
  'Get-CsTeamsEmergencyCallingPolicy': pair('emergency').map((body) => ({ ...body, NotificationGroup: 'security@contoso.test', NotificationMode: 'NotificationOnly', ExternalLocationLookupMode: 'Disabled' })),
  'Get-CsTeamsEmergencyCallRoutingPolicy': pair('ecrp').map((body) => ({ ...body, EmergencyNumbers: [{ EmergencyDialString: '911', OnlinePSTNUsage: 'KEEL-RT-usage' }], AllowEnhancedEmergencyServices: true })),
  'Get-CsTeamsCallParkPolicy': pair('park').map((body) => ({ ...body, AllowCallPark: false, ParkTimeoutSeconds: 300, PickupRangeStart: 10, PickupRangeEnd: 99 })),
  'Get-CsCallingLineIdentity': pair('callerid').map((body) => ({ ...body, CallingIDSubstitute: 'Anonymous', EnableUserOverride: false, BlockIncomingPstnCallerID: false })),
  'Get-CsOnlineVoicemailPolicy': pair('voicemail').map((body) => ({ ...body, EnableTranscription: true, ShareData: 'Defer', MaximumRecordingLength: '00:05:00' })),
  'Get-CsTeamsMeetingBroadcastPolicy': pair('live').map((body) => ({ ...body, AllowBroadcastScheduling: true, AllowBroadcastTranscription: false, BroadcastAttendeeVisibilityMode: 'EveryoneInCompany', BroadcastRecordingMode: 'AlwaysEnabled' })),
  'Get-CsTeamsEventsPolicy': pair('events').map((body) => ({ ...body, AllowWebinars: 'Enabled', AllowTownhalls: 'Enabled', EventAccessType: 'Everyone' })),
  'Get-CsTeamsMeetingBroadcastConfiguration': [{ Identity: 'Global', SupportURL: 'https://support.contoso.test', AllowSdnProviderForBroadcastMeeting: true, SdnApiToken: 'never-store-this-token' }],
  'Get-CsOnlineUser': [
    { Identity: oid(1), UserPrincipalName: 'keel-rt-alice@contoso.test', DisplayName: 'KEEL-RT Alice', EnterpriseVoiceEnabled: true, LineUri: 'tel:+14255550101', TeamsCallingPolicy: { Name: 'KEEL-RT-calling', Authority: 'Tenant' }, OnlineVoiceRoutingPolicy: null, TenantDialPlan: null, TeamsMeetingBroadcastPolicy: null, Department: 'Finance', MobilePhone: '+1 425 555 0199' },
    { Identity: oid(2), UserPrincipalName: 'keel-rt-bob@contoso.test', EnterpriseVoiceEnabled: false, LineUri: null, TeamsCallingPolicy: null },
  ],
  'Get-CsGroupPolicyAssignment': [{ GroupId: oid(3), PolicyType: 'TeamsCallingPolicy', PolicyName: 'KEEL-RT-calling', Priority: 1, CreatedBy: 'admin' }],
});
const sample = (overrides = {}) => (cmdlet) => (cmdlet in overrides ? overrides[cmdlet] : SAMPLE[cmdlet]);
const container = (overrides) => fakeCmdletContainer({ module: 'MicrosoftTeams', allowlist: ALLOWED, answer: sample(overrides) });
// Teams voice follows Teams, which follows SharePoint.
const TEAMS_GATE = ALL_READS.filter((id) => (id.startsWith('sharepoint.') || id.startsWith('teams.')) && !TEAMS_EXTENDED_OPERATIONS.includes(id));

test('each Teams voice read is declared, in scope, probed, read-only and ships disabled', async () => {
  const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === TEAMS_EXTENDED_WORKLOAD);
  assert.deepEqual(declared.map((descriptor) => descriptor.id), [...TEAMS_EXTENDED_OPERATIONS]);
  assert.deepEqual(declared.map((descriptor) => descriptor.operation.cmdlet), FAMILY_NAMES.map((name) => FAMILIES[name].cmdlet));
  for (const descriptor of declared) {
    assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
    assert.equal(descriptor.operation.module, 'MicrosoftTeams');
    assert.deepEqual(descriptor.rbac.roles, ['Teams Administrator']);
  }

  // The read-only probe runs each one in the Teams session.
  const probe = readFileSync(new URL('../../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const teams = /# --- Teams([\s\S]*?)# --- SharePoint/.exec(probe)[1];
  for (const descriptor of declared) assert.match(teams, new RegExp(`-Workload 'teams' -Name '${descriptor.operation.probeName}'`), descriptor.id);

  // Fixture proof never enables a read.
  const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

  // Registered disabled; Get cmdlets only; the container holds the same allowlist.
  assert.equal(TEAMS_EXTENDED_DESCRIPTOR.enabledByDefault, false);
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === TEAMS_EXTENDED_WORKLOAD && descriptor.enabledByDefault === false));
  // Wave 2 WKLD: the only writes for this workload are its declared cmdlet writes, and
  // each needs observed grants and a live write capture before it runs.
  const writes = Object.entries(WORKLOAD_WRITE_OPERATIONS).filter(([, operation]) => operation.workload === TEAMS_EXTENDED_WORKLOAD);
  assert.ok(writes.length > 0);
  for (const [id, operation] of writes) {
    assert.equal(operation, WKLD_WRITE_OPERATIONS[id], id);
    assert.equal(operation.kind, 'cmdlet', id);
    assert.equal(operation.grantsRequired, true, id);
  }
  assert.ok(Object.keys(TEAMS_EXTENDED_CMDLET_PARAMETERS).every((cmdlet) => cmdlet.startsWith('Get-')));
  assert.ok(Object.keys(ALLOWED).every((cmdlet) => cmdlet.startsWith('Get-')));
  assert.deepEqual(Object.fromEntries(Object.entries(TEAMS_EXTENDED_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), ALLOWED);
  for (const cmdlet of ['Grant-CsTeamsCallingPolicy', 'Set-CsTeamsCallingPolicy', 'New-CsGroupPolicyAssignment', 'Remove-CsTenantDialPlan', 'Get-CsTeamsMeetingPolicy']) {
    assert.throws(() => assertTeamsExtendedCmdlet({ cmdlet }), TeamsExtendedScopeError, cmdlet);
  }
  assert.throws(() => assertTeamsExtendedCmdlet({ cmdlet: 'Get-CsOnlineUser', parameters: { Identity: 'x' } }), /does not take Identity/);
  assert.throws(() => assertTeamsExtendedCmdlet({ cmdlet: 'Get-CsOnlineUser', parameters: { ResultSize: 'Unlimited' } }), /positive whole number/);
  assert.throws(() => assertTeamsExtendedCmdlet({ cmdlet: 'Get-CsTeamsCallingPolicy', parameters: { ResultSize: 5 } }), /does not take ResultSize/);
  // What the backup never holds is listed for the completeness records: the secret, and
  // the provider fields Teams does not return to a read (Q155).
  assert.deepEqual(TEAMS_EXTENDED_MISSING.map((entry) => [entry.family, entry.field, entry.reason]), [
    ['liveEventsConfiguration', 'SdnApiToken', 'secret'],
    ['liveEventsConfiguration', 'SdnName, SdnProviderName, SdnLicenseId, SdnApiTemplateUrl', 'not-read'],
  ]);
  for (const field of ['SdnApiToken', 'SdnName', 'SdnProviderName', 'SdnLicenseId', 'SdnApiTemplateUrl']) {
    assert.ok(!FAMILIES.liveEventsConfiguration.fields.includes(field), field);
  }
});

test('a fixture read of every family is complete, keyed by identity, with declared fields only', async () => {
  const fake = container();
  const result = await readTeamsExtended({ powershell: fake.powershell, maxUsers: 50, now: () => NOW });
  assert.equal(result.outcome, 'partial', 'sample answers omit some declared fields');
  assert.deepEqual(result.failures, []);
  assert.equal(result.discovery.objects, 2 * 10 + 1 + 2 + 1);
  assert.deepEqual(fake.calls.map((call) => call.cmdlet), FAMILY_NAMES.map((name) => FAMILIES[name].cmdlet));
  assert.deepEqual(fake.calls.find((call) => call.cmdlet === 'Get-CsOnlineUser').parameters, { ResultSize: 51 });
  assert.ok(fake.calls.filter((call) => call.cmdlet !== 'Get-CsOnlineUser').every((call) => Object.keys(call.parameters).length === 0));

  const keys = result.resources.map((resource) => resource.resourceKey);
  assert.ok(keys.includes('calling-policy:global'));
  assert.ok(keys.includes('calling-policy:tag:keel-rt-calling'));
  assert.ok(keys.includes('live-events-configuration:global'));
  assert.ok(keys.includes(`user-policy-assignment:${oid(1)}`));
  assert.ok(keys.includes(`group-policy-assignment:${oid(3)}/teamscallingpolicy`));

  const config = result.resources.find((resource) => resource.kind === 'liveEventsConfiguration');
  assert.equal(config.fields.SupportURL, 'https://support.contoso.test');
  // Shaped like the live answer (Q155): no Sdn* provider fields, so none is declared or unknown.
  assert.deepEqual(Object.keys(config.fieldCoverage).sort(), ['AllowSdnProviderForBroadcastMeeting', 'Identity', 'SupportURL']);
  assert.ok(!JSON.stringify(result).includes('never-store-this-token'), 'the eCDN API token is never read into the result');
  const alice = result.resources.find((resource) => resource.identity === oid(1));
  assert.equal(alice.fields.LineUri, 'tel:+14255550101');
  assert.deepEqual(alice.fields.TeamsCallingPolicy, { Name: 'KEEL-RT-calling', Authority: 'Tenant' });
  assert.equal(alice.fields.OnlineVoiceRoutingPolicy, null, 'null means the Global default and is kept as observed');
  assert.equal(alice.fieldCoverage.OnlineVoiceRoutingPolicy.status, 'observed');
  assert.ok(!('Department' in alice.fields) && !('MobilePhone' in alice.fields) && !('DisplayName' in alice.fields), 'undeclared user fields are dropped');
  const calling = result.resources.find((resource) => resource.resourceKey === 'calling-policy:global');
  assert.ok(!('Key' in calling.fields) && !('XsAnyElements' in calling.fields));

  // Every declared field answered: complete.
  const full = Object.fromEntries(FAMILY_NAMES.map((name) => {
    const { cmdlet, fields } = FAMILIES[name];
    return [cmdlet, SAMPLE[cmdlet].map((body) => ({ ...Object.fromEntries(fields.map((field) => [field, null])), ...body }))];
  }));
  const complete = await readTeamsExtended({ powershell: container(full).powershell, now: () => NOW });
  assert.equal(complete.outcome, 'complete');
  assert.deepEqual(Object.keys(complete.fieldCounts), ['observed']);
  assert.deepEqual(complete.unknownFields, {});
  // A declared field an answer lacks is named in the run, per family, with its object count.
  const lacking = await readTeamsExtended({
    powershell: container({ ...full, 'Get-CsTeamsCallParkPolicy': full['Get-CsTeamsCallParkPolicy'].map(({ PickupRangeEnd, ...body }) => body) }).powershell,
    now: () => NOW,
  });
  assert.equal(lacking.outcome, 'partial');
  assert.deepEqual(lacking.unknownFields, { callParkPolicy: { PickupRangeEnd: full['Get-CsTeamsCallParkPolicy'].length } });
  // A policy list with no Global policy is a gap on its own; no group assignments is not.
  const noVoicemail = await readTeamsExtended({ powershell: container({ ...full, 'Get-CsOnlineVoicemailPolicy': [] }).powershell, now: () => NOW });
  assert.equal(noVoicemail.outcome, 'partial');
  const noGroups = await readTeamsExtended({ powershell: container({ ...full, 'Get-CsGroupPolicyAssignment': [] }).powershell, now: () => NOW });
  assert.equal(noGroups.outcome, 'complete');
});

test('gaps make the run partial or failed, never complete', async () => {
  const deniedError = { error: { message: 'Access denied: the caller does not have permission', category: 'PermissionDenied', errorId: 'Forbidden' } };
  const partial = await readTeamsExtended({
    powershell: container({
      'Get-CsTeamsCallParkPolicy': deniedError,
      'Get-CsOnlineVoicemailPolicy': [],
      'Get-CsTeamsEventsPolicy': [...SAMPLE['Get-CsTeamsEventsPolicy'], { Identity: 'not a policy' }],
      'Get-CsTenantDialPlan': [...SAMPLE['Get-CsTenantDialPlan'], { ...SAMPLE['Get-CsTenantDialPlan'][0], Description: 'changed' }],
      'Get-CsTeamsCallingPolicy': SAMPLE['Get-CsTeamsCallingPolicy'].map((body, index) => (index === 1 ? { ...body, Description: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' } : body)),
      'Get-CsGroupPolicyAssignment': [],
    }).powershell,
    maxUsers: 1,
    now: () => NOW,
  });
  assert.equal(partial.outcome, 'partial');
  assert.equal(partial.discovery.families.callParkPolicy.status, 'denied');
  assert.deepEqual(partial.failures.map((failure) => failure.family), ['callParkPolicy']);
  assert.deepEqual(partial.discovery.empty, ['voicemailPolicy'], 'an empty policy list is a gap; no group assignments is not');
  assert.equal(partial.discovery.unidentified, 1);
  assert.deepEqual(partial.discovery.conflicts, [{ resourceKey: 'dial-plan:global', fields: ['Description'] }]);
  assert.equal(partial.discovery.capped, true, 'two users answered a bound of one');
  assert.equal(partial.resources.filter((resource) => resource.kind === 'userPolicyAssignment').length, 1);
  const tagged = partial.resources.find((resource) => resource.resourceKey === 'calling-policy:tag:keel-rt-calling');
  assert.equal(tagged.fieldCoverage.Description.status, 'redacted');
  assert.ok(!JSON.stringify(partial.resources).includes('abcdefghijklmnopqrstuvwxyz0123456789'));

  const crashed = await readTeamsExtended({
    powershell: fakeCmdletContainer({ module: 'MicrosoftTeams', allowlist: ALLOWED, answer: () => 'crash' }).powershell, now: () => NOW,
  });
  assert.equal(crashed.outcome, 'failed');
  assert.equal(crashed.failures.length, FAMILY_NAMES.length);
});

test('without qualification nothing is sent; once qualified the run and its objects are stored', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = 'sha256:read-teams-pv-teams';
  const fake = container();
  const bare = await collectTeamsExtended(client, { tenantRef, ledger: buildWorkloadLedger({ now: NOW }), powershell: fake.powershell, now: () => NOW });
  assert.equal(bare.run.outcome, 'disabled');
  assert.equal(fake.calls.length, 0);
  assert.ok(bare.run.digest.reasons.some((reason) => reason.startsWith('Teams is not qualified yet')));

  // Teams qualified but one read here is not: still nothing is sent.
  const oneShort = ledgerWith(tenantRef, [...TEAMS_GATE, ...TEAMS_EXTENDED_OPERATIONS.slice(1)], { now: NOW });
  const short = teamsExtendedActivation(oneShort);
  assert.equal(short.enabled, false);
  assert.deepEqual(short.reasons, [`${TEAMS_EXTENDED_OPERATIONS[0]} is fixture-tested`]);

  const ledger = ledgerWith(tenantRef, [...TEAMS_GATE, ...TEAMS_EXTENDED_OPERATIONS], { now: NOW });
  assert.equal(teamsExtendedActivation(ledger).enabled, true);
  const live = await collectTeamsExtended(client, { tenantRef, ledger, powershell: fake.powershell, maxUsers: 50, now: () => NOW });
  assert.equal(live.run.outcome, 'partial');
  assert.deepEqual(live.run.digest.unknownFields, live.result.unknownFields, 'the stored run names its unknown fields');
  const { rows } = await client.query('SELECT resource_key, fields FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [live.run.id]);
  assert.equal(rows.length, live.result.resources.length);
  const alice = rows.find((row) => row.resource_key === `user-policy-assignment:${oid(1)}`);
  assert.equal(alice.fields.kind, 'userPolicyAssignment');
  assert.equal(alice.fields.UserPrincipalName, 'keel-rt-alice@contoso.test');
  const { rows: [stored] } = await client.query('SELECT workload FROM workload_collection WHERE id = $1', [live.run.id]);
  assert.equal(stored.workload, TEAMS_EXTENDED_WORKLOAD);
});
