// Teams voice network, call flows and device policies (gap audit section F), read-only.
//
// Acceptance:
//  - every read is declared in workloadContract.mjs, passes the scope validator, is run
//    by the read-only probe, and ships disabled (fixture proof never enables it);
//  - only Get- cmdlets run, the Node and container allowlists match, and only the auto
//    attendant and call queue reads take parameters (-First 100, -Skip whole pages);
//  - each object is one observation under its policy identity, Guid or Teams key, with
//    declared fields only (a call queue's live statistics are dropped);
//  - auto attendants and call queues are read page by page, past Microsoft's 100 limit,
//    up to the object cap; a page that fails fails the family, never a short list;
//  - collection stays off until Teams is qualified, then each read switches on with its
//    own live proof; the others are listed as skipped;
//  - the kinds sit in Teams' "Calling and meetings" and "Devices and clients" groups, in
//    the portal's order.
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays the ops/powershell/run-cmdlet.ps1 contract through the real
// engine/powershell/jobQueue.mjs spawn path. No tenant is touched.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  DEVICE_POLICIES, DEVICE_POLICY_FAMILIES, PAGE_SIZE, TEAMS_DEVICE_POLICIES_WORKLOAD, TEAMS_VOICE_NETWORK_WORKLOAD, TeamsVoiceNetworkScopeError,
  VOICE_NETWORK, VOICE_NETWORK_FAMILIES, collectTeamsDevicePolicies, collectTeamsVoiceNetwork, readTeamsDevicePolicies, readTeamsVoiceNetwork,
  teamsDevicePoliciesActivation, teamsVoiceNetworkActivation,
} from '../collect/workloads/teamsVoiceNetwork.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOADS, WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { compareInService, typeInfo } from '../insights/taxonomy.mjs';
import { readModule, workloadReads } from '../../tools/qualification/workloadReadsAcceptance.mjs';
import { ALL_READS, GRANTS, RUNTIME, containerAllowlist, fakeCmdletContainer, ledgerWith } from '../test/fakeCmdletContainer.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

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
const now = () => NOW;
let tenantSeq = 0;
const nextTenant = () => `sha256:teams-voice-network-${tenantSeq += 1}`;
const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-00000000b0b0`;

const ALLOWED = containerAllowlist('AllowedTeamsVoiceNetwork');
const WORKLOADS_UNDER_TEST = [VOICE_NETWORK, DEVICE_POLICIES];
const OWN_READS = new Set(WORKLOADS_UNDER_TEST.flatMap((workload) => workload.operations));
const OTHER_READS = ALL_READS.filter((id) => !OWN_READS.has(id));

/** An answer carrying every declared field of `spec`, plus properties KEEL must drop. */
function answerFor(spec, n = 1, over = {}) {
  const body = { Statistics: 'Current queue size = 3', Agents: [{ ObjectId: guid(90), OptIn: true }], XsAnyElements: 'internal' };
  for (const field of spec.fields) body[field] = `${field}-${n}`;
  if (spec.identity.name === 'policy') body.Identity = n === 1 ? 'Global' : `Tag:KEEL-RT-${n}`;
  if (spec.identity.name === 'singleton') body.Identity = 'Global';
  if (spec.identity.name === 'byName') body.Identity = `KEEL-RT-${n}`;
  if (spec.identity.name === 'byGuid') body.Identity = guid(n);
  return { ...body, ...over };
}
const many = (spec, count) => Array.from({ length: count }, (_, index) => answerFor(spec, index + 1));

/** A tenant that answers each cmdlet with one object, or `answers[cmdlet](parameters)`. */
function fakeTeams(answers = {}) {
  const byCmdlet = Object.fromEntries([...Object.values(VOICE_NETWORK_FAMILIES), ...Object.values(DEVICE_POLICY_FAMILIES)].map((spec) => [spec.cmdlet, spec]));
  return fakeCmdletContainer({
    module: 'MicrosoftTeams',
    allowlist: ALLOWED,
    answer: (cmdlet, parameters) => (answers[cmdlet] ? answers[cmdlet](parameters) : [answerFor(byCmdlet[cmdlet])]),
  });
}

test('every read is declared, in scope, probed, Get-only and ships disabled', () => {
  const probe = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const teams = /# --- Teams([\s\S]*?)# --- SharePoint/.exec(probe)[1];
  const bare = buildWorkloadLedger({ grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  for (const workload of WORKLOADS_UNDER_TEST) {
    assert.ok(WORKLOADS.includes(workload.workload));
    assert.equal(workload.descriptor.readOnly, true);
    assert.equal(workload.descriptor.enabledByDefault, false);
    assert.ok(listWorkloads().some((entry) => entry.workload === workload.workload));
    assert.ok(WORKLOAD_COLLECTORS.some((entry) => entry.workload === workload.workload && entry.powershellFamily === 'teams'));
    const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === workload.workload);
    assert.deepEqual(declared.map((descriptor) => descriptor.id), [...workload.operations]);
    for (const descriptor of declared) {
      assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
      assert.equal(descriptor.operation.module, 'MicrosoftTeams');
      assert.match(descriptor.operation.cmdlet, /^Get-Cs/);
      assert.ok(teams.includes(`-Workload 'teams' -Name '${descriptor.operation.probeName}'`), `${descriptor.id} is probed`);
      assert.equal(bare.rows.find((row) => row.id === descriptor.id).enabled, false);
    }
    // The read capture tool can qualify it, in the Teams module.
    assert.equal(readModule(workload.workload), 'MicrosoftTeams');
    assert.deepEqual(workloadReads(workload.workload).map((read) => read.operationId), [...workload.operations]);
  }
});

test('the Node and container allowlists match, and only paging parameters are accepted', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(ALLOWED).sort()),
    Object.fromEntries(Object.entries({ ...VOICE_NETWORK.cmdletParameters, ...DEVICE_POLICIES.cmdletParameters }).map(([name, list]) => [name, [...list]]).sort()),
  );
  assert.ok(Object.keys(ALLOWED).every((name) => name.startsWith('Get-')));
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  assert.match(script, /elseif \(\$AllowedTeamsVoiceNetwork\.ContainsKey\(\$name\) -and \$module -eq 'MicrosoftTeams'\)/);

  const check = (call) => VOICE_NETWORK.assertCmdlet(call);
  assert.equal(check({ cmdlet: 'Get-CsCallQueue', parameters: { First: 100 } }), true);
  assert.equal(check({ cmdlet: 'Get-CsAutoAttendant', parameters: { First: 100, Skip: 300 } }), true);
  assert.throws(() => check({ cmdlet: 'Set-CsCallQueue' }), TeamsVoiceNetworkScopeError);
  assert.throws(() => check({ cmdlet: 'Get-CsCallQueue', parameters: { First: 50 } }), /First must be 100/);
  assert.throws(() => check({ cmdlet: 'Get-CsCallQueue', parameters: { First: 100, Skip: 150 } }), /whole number of pages/);
  assert.throws(() => check({ cmdlet: 'Get-CsCallQueue', parameters: { NameFilter: 'x' } }), /does not take NameFilter/);
  assert.throws(() => check({ cmdlet: 'Get-CsOnlineVoiceRoute', parameters: { Identity: 'x' } }), /does not take Identity/);
  assert.throws(() => DEVICE_POLICIES.assertCmdlet({ cmdlet: 'Get-CsCallQueue' }), TeamsVoiceNetworkScopeError);
});

test('each object is kept once under its identity, with declared fields only', async () => {
  const live = fakeTeams();
  const result = await readTeamsVoiceNetwork({ powershell: live.powershell, now });
  assert.equal(result.outcome, 'complete');
  assert.ok(live.calls.every((call) => call.cmdlet.startsWith('Get-')));
  const byKind = Object.fromEntries(result.resources.map((resource) => [resource.kind, resource]));
  assert.deepEqual(Object.keys(byKind), Object.keys(VOICE_NETWORK_FAMILIES));
  assert.equal(byKind.pstnUsage.resourceKey, 'pstn-usages:global');
  assert.equal(byKind.networkRoamingPolicy.resourceKey, 'network-roaming-policy:global');
  assert.equal(byKind.voiceRoute.resourceKey, 'voice-route:keel-rt-1');
  assert.equal(byKind.callQueue.resourceKey, `call-queue:${guid(1)}`);
  for (const resource of result.resources) {
    assert.deepEqual(Object.keys(resource.fields).sort(), [...VOICE_NETWORK_FAMILIES[resource.kind].fields].sort());
    assert.ok(!('Statistics' in resource.fields) && !('Agents' in resource.fields) && !('XsAnyElements' in resource.fields));
  }

  const devices = await readTeamsDevicePolicies({ powershell: fakeTeams().powershell, now });
  assert.equal(devices.outcome, 'complete');
  assert.deepEqual(devices.resources.map((resource) => resource.kind), Object.keys(DEVICE_POLICY_FAMILIES));
});

test('an empty answer is a gap only where Teams always has an object', async () => {
  const empty = () => [];
  const live = fakeTeams({ 'Get-CsOnlineVoiceRoute': empty, 'Get-CsAutoAttendant': empty, 'Get-CsTeamsCallHoldPolicy': empty });
  const result = await readTeamsVoiceNetwork({ powershell: live.powershell, now });
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.discovery.empty, ['callHoldPolicy']);
});

test('auto attendants and call queues are paged past 100, up to the object cap', async () => {
  const queues = many(VOICE_NETWORK_FAMILIES.callQueue, 250);
  const live = fakeTeams({ 'Get-CsCallQueue': ({ First, Skip = 0 }) => queues.slice(Skip, Skip + First) });
  const result = await readTeamsVoiceNetwork({ powershell: live.powershell, families: ['callQueue'], now });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.resources.length, 250);
  assert.deepEqual(live.calls.map((call) => call.parameters), [{ First: PAGE_SIZE }, { First: PAGE_SIZE, Skip: 100 }, { First: PAGE_SIZE, Skip: 200 }]);

  // Exactly one full page: a second call confirms there is nothing more.
  const hundred = many(VOICE_NETWORK_FAMILIES.autoAttendant, 100);
  const full = fakeTeams({ 'Get-CsAutoAttendant': ({ First, Skip = 0 }) => hundred.slice(Skip, Skip + First) });
  const once = await readTeamsVoiceNetwork({ powershell: full.powershell, families: ['autoAttendant'], now });
  assert.equal(once.resources.length, 100);
  assert.equal(full.calls.length, 2);
  assert.equal(once.discovery.capped, false);

  // The object cap stops paging and marks the run partial.
  const capped = fakeTeams({ 'Get-CsCallQueue': ({ First, Skip = 0 }) => queues.slice(Skip, Skip + First) });
  const limited = await readTeamsVoiceNetwork({ powershell: capped.powershell, families: ['callQueue'], maxObjects: 150, now });
  assert.equal(limited.resources.length, 150);
  assert.equal(limited.discovery.capped, true);
  assert.equal(limited.outcome, 'partial');
  assert.equal(capped.calls.length, 2);
});

test('a page that fails fails the whole family, never a short list', async () => {
  const queues = many(VOICE_NETWORK_FAMILIES.callQueue, 150);
  const live = fakeTeams({
    'Get-CsCallQueue': ({ Skip = 0 }) => (Skip === 0 ? queues.slice(0, 100) : { error: { message: 'throttled', category: 'LimitsExceeded', errorId: 'Throttled' } }),
  });
  const result = await readTeamsVoiceNetwork({ powershell: live.powershell, families: ['callQueue', 'pstnUsage'], now });
  assert.equal(result.outcome, 'partial');
  assert.equal(result.discovery.families.callQueue.status, 'failed');
  assert.equal(result.discovery.families.callQueue.objects, 0);
  assert.equal(result.failures[0].page, 2);
  assert.equal(result.discovery.families.pstnUsage.status, 'read');
});

test('collection stays off until Teams is qualified, then each read switches on with its own proof', async (t) => {
  const client = await schemaClient(t);
  // Nothing qualified: a disabled run, nothing sent.
  const tenantRef = nextTenant();
  const off = fakeTeams();
  const disabled = await collectTeamsVoiceNetwork(client, { tenantRef, ledger: ledgerWith(tenantRef, [], { now: NOW }), powershell: off.powershell, now });
  assert.equal(disabled.run.outcome, 'disabled');
  assert.equal(off.calls.length, 0);
  assert.match(disabled.activation.reasons.join(' '), /Teams is not qualified yet/);

  // Teams and every other read qualified, but none of these: still off.
  assert.equal(teamsVoiceNetworkActivation(ledgerWith(tenantRef, OTHER_READS, { now: NOW })).enabled, false);
  assert.equal(teamsDevicePoliciesActivation(ledgerWith(tenantRef, OTHER_READS, { now: NOW })).enabled, false);

  // Two reads proven: only those run; the rest are skipped and the run is partial.
  const ledger = ledgerWith(tenantRef, [...OTHER_READS, 'teams-voice-network.call-queues', 'teams-voice-network.voice-routes'], { now: NOW });
  const live = fakeTeams();
  const some = await collectTeamsVoiceNetwork(client, { tenantRef, ledger, powershell: live.powershell, now });
  assert.deepEqual(some.activation.families, ['voiceRoute', 'callQueue']);
  assert.deepEqual([...new Set(live.calls.map((call) => call.cmdlet))], ['Get-CsOnlineVoiceRoute', 'Get-CsCallQueue']);
  assert.equal(some.run.outcome, 'partial');
  assert.equal(some.result.skipped.length, Object.keys(VOICE_NETWORK_FAMILIES).length - 2);
  const { rows } = await client.query('SELECT resource_key FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [some.run.id]);
  assert.deepEqual(rows.map((row) => row.resource_key), [`call-queue:${guid(1)}`, 'voice-route:keel-rt-1']);

  // Every device read proven: the device workload runs in full.
  const all = ledgerWith(tenantRef, [...OTHER_READS, ...DEVICE_POLICIES.operations], { now: NOW });
  const devices = await collectTeamsDevicePolicies(client, { tenantRef, ledger: all, powershell: fakeTeams().powershell, now });
  assert.equal(devices.run.outcome, 'complete');
  assert.equal(devices.run.workload, TEAMS_DEVICE_POLICIES_WORKLOAD);
});

test('the kinds sit in Teams\' calling and device groups, in the portal\'s order', () => {
  const network = typeInfo(TEAMS_VOICE_NETWORK_WORKLOAD);
  const devices = typeInfo(TEAMS_DEVICE_POLICIES_WORKLOAD);
  assert.equal(network.service, 'Teams');
  assert.equal(network.category, 'calling');
  assert.equal(devices.category, 'devices');
  assert.equal(devices.categoryName, 'Devices and clients');
  assert.ok(compareInService('teams-voice-policies', TEAMS_VOICE_NETWORK_WORKLOAD) < 0, 'voice policies before the routes and sites they use');
  assert.ok(compareInService(TEAMS_VOICE_NETWORK_WORKLOAD, TEAMS_DEVICE_POLICIES_WORKLOAD) < 0, 'calling before devices');
  assert.ok(compareInService('teams-org-policies', TEAMS_VOICE_NETWORK_WORKLOAD) < 0);
  const portal = readFileSync(new URL('../../portal/lib/restore-workloads-view.ts', import.meta.url), 'utf8');
  assert.match(portal, /"teams-voice-policies", "teams-voice-network", "teams-device-policies"/);
});
