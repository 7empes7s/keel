// Roadmap task-101: configuration-only workload descriptors and their qualification.
//
// Acceptance:
//  - a descriptor requesting a content endpoint fails the scope validator;
//  - fixture proof is not live qualification;
//  - missing workload RBAC gives a named pending prerequisite;
//  - version drift invalidates operation evidence.
// Mutation checks:
//  - allow a content endpoint under a container name;
//  - mark a synthetic probe live-qualified;
//  - reuse proof after an API version change.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  WORKLOAD_DESCRIPTORS, WorkloadScopeError, buildWorkloadLedger, evidenceFromProbeRows, readGraphConfiguration,
  scopeProblems, validateWorkloadDescriptor, workloadRow,
} from '../collect/workloadContract.mjs';
import { HARNESS_PROOF_REF, evidenceFromCaptureText, main, runFixtureHarness } from '../../tools/qualification/workloads.mjs';

const TENANT = 'sha256:task-101-tenant';
const NOW = new Date('2026-10-03T21:00:00.000Z');
const CAPTURED = '2026-10-02T09:00:00.000Z';
const byId = (id) => WORKLOAD_DESCRIPTORS.find((descriptor) => descriptor.id === id);
const ALL_GRANTS = Object.freeze({
  permissions: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.permissions))],
  roles: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.roles))],
});

function liveCapture(id, overrides = {}) {
  return {
    operationId: id, kind: 'live-capture', synthetic: false, tenantRef: TENANT, capturedAt: CAPTURED,
    version: 'v1.0', ok: true, error: null, observed: { pages: 1 }, proofRef: `capture-${id}`, ...overrides,
  };
}

function probeRow(cmdlet, overrides = {}) {
  return {
    workload: 'exo', connected: true, cmdlet, ok: true, count: 3, error: null,
    module: 'ExchangeOnlineManagement', moduleVersion: '3.5.0', capturedAt: CAPTURED, synthetic: false, ...overrides,
  };
}

const graphDescriptor = (id, endpoint, workload = 'sharepoint-site-settings') => ({
  ...byId('sharepoint.site-properties'), id, workload, operation: { kind: 'graph', method: 'GET', endpoint, version: 'v1.0' },
});

test('every declared operation is in configuration scope and complete', () => {
  assert.equal(new Set(WORKLOAD_DESCRIPTORS.map((descriptor) => descriptor.workload)).size, 5, 'all five workloads are declared');
  for (const descriptor of WORKLOAD_DESCRIPTORS) {
    assert.doesNotThrow(() => validateWorkloadDescriptor(descriptor), descriptor.id);
    assert.equal(typeof descriptor.auth.application, 'boolean');
    assert.ok(descriptor.paging && descriptor.throttle && descriptor.consistency, descriptor.id);
  }
  const ledger = buildWorkloadLedger({ now: NOW });
  assert.ok(ledger.rows.every((row) => row.state === 'disabled' && !row.enabled), 'nothing is enabled before proof');
});

test('a content endpoint fails the scope validator, whatever container it sits under', async () => {
  const content = [
    '/sites/{site-id}/drive/root/children',
    '/sites/{site-id}/drives',
    '/sites/{site-id}/lists/{list-id}/items',
    '/sites/{site-id}/pages',
    "/sites/{site-id}/drive/root:/Board/plan.docx:/content",
    '/sites/{site-id}?$expand=drive',
    '/teams/{team-id}/channels/{channel-id}/messages',
    '/teams/{team-id}/channels/{channel-id}/filesFolder/children',
    '/users/{user-id}/mailFolders/inbox/messages',
    '/users/{user-id}/messages/{message-id}/attachments',
    '/users/{user-id}/drive/items/{item-id}/permissions',
    '/drives/{drive-id}/items/{item-id}/extractSensitivityLabels',
    '/groups/{group-id}/calendar/events',
  ];
  for (const endpoint of content) {
    const descriptor = graphDescriptor('fixture.content', endpoint);
    assert.notEqual(scopeProblems(descriptor.operation).length, 0, endpoint);
    assert.throws(() => validateWorkloadDescriptor(descriptor), WorkloadScopeError, endpoint);
    // Proof cannot rescue an out-of-scope descriptor.
    const row = workloadRow(descriptor, { evidence: [liveCapture('fixture.content')], grants: ALL_GRANTS, tenantRef: TENANT, now: NOW });
    assert.equal(row.state, 'refused', endpoint);
    assert.equal(row.enabled, false, endpoint);
  }
  for (const cmdlet of ['Get-PnPListItem', 'Get-PnPFile', 'Get-PnPFolderItem', 'Get-MailboxFolderPermission', 'Search-Mailbox', 'Set-Label', 'Get-MessageTraceV2']) {
    assert.notEqual(scopeProblems({ kind: 'cmdlet', cmdlet, module: 'x' }).length, 0, cmdlet);
  }
  assert.deepEqual(scopeProblems({ kind: 'graph', method: 'POST', endpoint: '/admin/sharepoint/settings' }), ['POST is not a read']);

  // The reader re-checks every next page: a nextLink that wanders into content is refused.
  const descriptor = byId('teams.membership');
  const transport = async (url) => (url.includes('skiptoken')
    ? { status: 200, body: { value: [] } }
    : { status: 200, body: { value: [{ id: 'm1' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/teams/t1/channels/c1/messages?$skiptoken=x' } });
  await assert.rejects(readGraphConfiguration(descriptor, { transport, substitute: { 'team-id': 't1' } }), /refused a next page/);
});

test('fixture proof is fixture-tested, never live-qualified and never enabled', async () => {
  const { evidence, results } = await runFixtureHarness();
  assert.ok(results.every((result) => result.ok), JSON.stringify(results.filter((result) => !result.ok)));
  assert.ok(evidence.every((item) => item.synthetic === true && item.kind === 'fixture' && item.proofRef === HARNESS_PROOF_REF));
  const paged = results.find((result) => result.id === 'teams.membership');
  assert.deepEqual(paged.observed, { pages: 2, throttled: 1, retryAfterHonouredMs: 2000 }, 'the harness follows paging and Retry-After');

  const ledger = buildWorkloadLedger({ evidence, grants: ALL_GRANTS, tenantRef: TENANT, now: NOW });
  for (const row of ledger.rows) {
    assert.equal(row.state, 'fixture-tested', row.id);
    assert.equal(row.enabled, false, row.id);
    assert.equal(row.proof.live, null, row.id);
  }

  // A synthetic record dressed as a live capture, or a capture with no synthetic flag, still does not qualify.
  for (const disguised of [
    liveCapture('teams.settings', { synthetic: true }),
    liveCapture('teams.settings', { synthetic: undefined }),
    { ...evidence.find((item) => item.operationId === 'teams.settings'), kind: 'live-capture', tenantRef: TENANT, capturedAt: CAPTURED },
  ]) {
    const row = workloadRow(byId('teams.settings'), { evidence: [disguised], grants: ALL_GRANTS, tenantRef: TENANT, now: NOW });
    assert.notEqual(row.state, 'live-qualified', JSON.stringify(disguised));
    assert.match(row.reasons.join(' '), /synthetic evidence/);
  }
  // A probe row that does not say it was a real read counts as synthetic.
  const { evidence: unlabelled } = evidenceFromProbeRows([probeRow('Get-Label', { synthetic: undefined })], { tenantRef: TENANT, proofRef: 'p' });
  assert.equal(unlabelled[0].synthetic, true);

  // The genuine article qualifies: non-synthetic, this tenant, recent, current version.
  const live = workloadRow(byId('teams.settings'), { evidence: [liveCapture('teams.settings')], grants: ALL_GRANTS, tenantRef: TENANT, now: NOW });
  assert.equal(live.state, 'live-qualified');
  assert.equal(live.enabled, true);
  const otherTenant = workloadRow(byId('teams.settings'), { evidence: [liveCapture('teams.settings', { tenantRef: 'sha256:other' })], grants: ALL_GRANTS, tenantRef: TENANT, now: NOW });
  assert.equal(otherTenant.state, 'disabled');
  const unchecked = workloadRow(byId('teams.settings'), { evidence: [liveCapture('teams.settings')], tenantRef: TENANT, now: NOW });
  assert.equal(unchecked.state, 'live-qualified');
  assert.equal(unchecked.enabled, false, 'unchecked grants keep a qualified read off');
});

test('missing workload RBAC is a named pending prerequisite', () => {
  const grants = { permissions: ALL_GRANTS.permissions.filter((name) => name !== 'TeamMember.Read.All'), roles: ALL_GRANTS.roles.filter((name) => name !== 'Compliance Administrator') };
  const ledger = buildWorkloadLedger({
    evidence: [liveCapture('teams.membership'), liveCapture('purview.label-definitions', { version: '3.5.0' })],
    grants, runtime: { modules: { ExchangeOnlineManagement: '3.5.0' } }, tenantRef: TENANT, now: NOW,
  });
  const members = ledger.rows.find((row) => row.id === 'teams.membership');
  assert.equal(members.state, 'pending-prerequisite', 'missing grants win over earlier live proof');
  assert.equal(members.enabled, false);
  assert.deepEqual(members.prerequisite.permissions, ['TeamMember.Read.All']);
  assert.deepEqual(members.prerequisite.roles, []);
  assert.match(members.prerequisite.message, /grant TeamMember\.Read\.All to the collector app/);
  const labels = ledger.rows.find((row) => row.id === 'purview.label-definitions');
  assert.equal(labels.state, 'pending-prerequisite');
  assert.deepEqual(labels.prerequisite.roles, ['Compliance Administrator']);
  assert.match(labels.prerequisite.message, /assign it the Compliance Administrator role/);
  assert.equal(ledger.rows.find((row) => row.id === 'teams.settings').state, 'disabled', 'unrelated operations are untouched');

  // A capture refused for authorization names what the operation needs; any other failure does not.
  const { evidence: denied, runtime } = evidenceFromProbeRows([
    probeRow('Get-CASMailbox', { ok: false, count: null, error: "The user isn't assigned to any management roles. Access denied." }),
    probeRow('Get-LabelPolicy', { ok: false, count: null, error: 'The operation timed out.' }),
  ], { tenantRef: TENANT, proofRef: 'probe.json' });
  const refused = buildWorkloadLedger({ evidence: denied, runtime, tenantRef: TENANT, now: NOW });
  const access = refused.rows.find((row) => row.id === 'exchange.client-access');
  assert.equal(access.state, 'pending-prerequisite');
  assert.equal(access.prerequisite.source, 'authorization failure');
  assert.deepEqual(access.prerequisite.roles, ['Exchange Administrator']);
  const timeout = refused.rows.find((row) => row.id === 'purview.label-publication');
  assert.equal(timeout.state, 'disabled', 'a timeout is not a missing prerequisite');
  assert.match(timeout.reasons.join(' '), /the read failed/);
});

test('a version change invalidates operation evidence', () => {
  // Graph: proof at v1.0 does not carry over when the operation moves to beta.
  const v1 = byId('teams.settings');
  const beta = { ...v1, operation: { ...v1.operation, version: 'beta' } };
  const proof = [liveCapture('teams.settings')];
  assert.equal(workloadRow(v1, { evidence: proof, grants: ALL_GRANTS, tenantRef: TENANT, now: NOW }).state, 'live-qualified');
  const drifted = workloadRow(beta, { evidence: proof, grants: ALL_GRANTS, tenantRef: TENANT, now: NOW });
  assert.equal(drifted.state, 'disabled');
  assert.equal(drifted.enabled, false);
  assert.deepEqual(drifted.invalidated, [{ proofRef: 'capture-teams.settings', version: 'v1.0', reason: 'version changed to beta' }]);

  // Cmdlets: proof under module 3.5.0 stops counting once a newer capture reports 3.6.0.
  const older = evidenceFromProbeRows([probeRow('Get-Label')], { tenantRef: TENANT, proofRef: 'probe-old.json' });
  const newer = evidenceFromProbeRows([probeRow('Get-TransportRule', { moduleVersion: '3.6.0' })], { tenantRef: TENANT, proofRef: 'probe-new.json' });
  const atOld = buildWorkloadLedger({ evidence: older.evidence, runtime: older.runtime, grants: ALL_GRANTS, tenantRef: TENANT, now: NOW });
  assert.equal(atOld.rows.find((row) => row.id === 'purview.label-definitions').state, 'live-qualified');
  const atNew = buildWorkloadLedger({
    evidence: older.evidence, runtime: { modules: { ...older.runtime.modules, ...newer.runtime.modules } }, grants: ALL_GRANTS, tenantRef: TENANT, now: NOW,
  });
  const labels = atNew.rows.find((row) => row.id === 'purview.label-definitions');
  assert.equal(labels.state, 'disabled');
  assert.equal(labels.version, '3.6.0');
  assert.equal(labels.invalidated[0].version, '3.5.0');

  // Rows from before version recording never qualify.
  const legacy = evidenceFromProbeRows([{ workload: 'scc', connected: true, cmdlet: 'Get-Label', ok: true, count: 4, error: null }], { tenantRef: TENANT, proofRef: 'legacy.json' });
  const legacyRow = buildWorkloadLedger({ evidence: legacy.evidence, runtime: legacy.runtime, grants: ALL_GRANTS, tenantRef: TENANT, now: NOW })
    .rows.find((row) => row.id === 'purview.label-definitions');
  assert.equal(legacyRow.state, 'disabled');
  assert.match(legacyRow.reasons.join(' '), /predates version recording/);
});

test('the command line reads supplied captures and never qualifies without a tenant', async () => {
  const probe = JSON.stringify([
    probeRow('Get-Label'), probeRow('Get-LabelPolicy'),
    probeRow('Get-PnPTenantSite -IncludeOneDriveSites', { workload: 'spo', module: 'PnP.PowerShell', moduleVersion: '3.4.1' }),
  ]);
  const graphCapture = JSON.stringify({ captures: [liveCapture('sharepoint.tenant-settings', { tenantRef: undefined })] });
  const grants = JSON.stringify(ALL_GRANTS);
  const files = { 'probe.json': probe, 'graph.json': graphCapture, 'grants.json': grants };
  const lines = [];
  const code = await main(['--json', '--tenant-ref', TENANT, '--now', NOW.toISOString(), '--capture', 'probe.json', '--capture', 'graph.json', '--grants', 'grants.json'], {
    out: (line) => lines.push(line), readFile: (path) => files[path],
  });
  assert.equal(code, 0);
  const { ledger } = JSON.parse(lines.join('\n'));
  const state = Object.fromEntries(ledger.rows.map((row) => [row.id, row.state]));
  assert.equal(state['purview.label-definitions'], 'live-qualified');
  assert.equal(state['purview.label-publication'], 'live-qualified');
  assert.equal(state['onedrive.site-settings'], 'live-qualified');
  assert.equal(state['sharepoint.site-sharing'], 'disabled', 'a OneDrive capture does not qualify the per-site read');
  assert.equal(state['sharepoint.tenant-settings'], 'live-qualified', 'the capture is stamped with the named tenant');
  assert.match(ledger.rows.find((row) => row.id === 'purview.label-definitions').proof.live.proofRef, /^probe\.json@sha256:[0-9a-f]{64}$/);

  await assert.rejects(main(['--capture', 'probe.json'], { out: () => {}, readFile: (path) => files[path] }), /--capture needs --tenant-ref/);
  const { evidence } = evidenceFromCaptureText(probe, { tenantRef: TENANT, label: 'probe.json' });
  assert.equal(evidence.length, 3);
});

test('the PowerShell probe reads configuration only and records its version', () => {
  const script = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const cmdlets = [...script.matchAll(/-Name '([A-Za-z-]+)'/g), ...script.matchAll(/name = "([^"]+)"/g)].map((match) => match[1]);
  for (const descriptor of WORKLOAD_DESCRIPTORS.filter((candidate) => candidate.operation.kind === 'cmdlet')) {
    assert.ok(cmdlets.includes(descriptor.operation.probeName), `the probe runs ${descriptor.operation.probeName}`);
  }
  for (const name of cmdlets) {
    assert.deepEqual(scopeProblems({ kind: 'cmdlet', cmdlet: name.split(' ')[0], module: 'x' }), [], name);
  }
  assert.match(script, /moduleVersion = /);
  assert.match(script, /synthetic\s+= \$false/);
  assert.match(script, /capturedAt\s+= \$capturedAt/);
  assert.doesNotMatch(script, /\b(Set|New|Remove|Add|Update|Grant|Revoke)-(PnP|Cs|Label|Mailbox|CASMailbox|Team)/, 'the probe never writes');
});
