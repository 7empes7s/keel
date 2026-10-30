// Live read gate for the Wave 2 cmdlet workloads: tools/qualification/workloadReadsLive.mjs
// runs a workload's own collector once with the collector credential, and its signed record
// imports as live read proof, so the scheduled job can turn the workload on.
//
// Acceptance:
//  - a capture sends only the workload's declared Get- cmdlets, through the real job
//    transport and allowlists; the record keeps no object, value or error message;
//  - the signed record verifies with --require-live; its seam yields one live capture per
//    read that answered, and with them (and the reads each workload follows) the workload
//    activates; without them it stays off;
//  - a read that failed is not proof, and its workload stays off;
//  - a record that claims an undeclared read, a failed read as proof, a read at another
//    module version, another credential, or no signature fails the gate; one filed under
//    another workload is refused on import;
//  - nothing is sent when the collector config names another tenant or --out is misnamed.
//
// Everything runs against a fake PowerShell container. No tenant is touched.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { importLedgerInputs, importSeams } from '../../cli/keel-workload-collect.mjs';
import { signEvidence, verifyEvidence } from '../../tools/release/qualification.mjs';
import {
  READ_FAMILIES, WORKLOAD_READS_LIVE_GATE, captureWorkloadReads, ledgerEvidenceFromWorkloadReadsAcceptance, main, workloadReadsRecordFile,
} from '../../tools/qualification/workloadReadsLive.mjs';
import { main as pseudonymizeCheck } from '../../tools/qualification/pseudonymize.mjs';
import { readModule } from '../../tools/qualification/workloadReadsAcceptance.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger } from '../collect/workloadContract.mjs';
import { exchangeExtendedActivation } from '../collect/workloads/exchangeExtended.mjs';
import { exchangeDistributionGroupsActivation, exchangeRecipientsActivation } from '../collect/workloads/exchangeRecipients.mjs';
import { exchangeRoleGroupsActivation } from '../collect/workloads/exchangeRoleGroups.mjs';
import { mailFlowActivation } from '../collect/workloads/mailFlow.mjs';
import { siteSharingActivation } from '../collect/workloads/sharepoint.mjs';
import { sharePointStructureActivation } from '../collect/workloads/sharepointStructure.mjs';
import { purviewExtendedActivation } from '../collect/workloads/purviewExtended.mjs';
import { retentionDlpActivation } from '../collect/workloads/purviewRetentionDlp.mjs';
import { teamsExtendedActivation } from '../collect/workloads/teamsExtended.mjs';
import { teamsPolicyActivation } from '../collect/workloads/teamsPolicies.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { GRANTS, MODULE_VERSIONS, RUNTIME, fakeCmdletContainer } from '../test/fakeCmdletContainer.mjs';

const KEY = 'workload-reads-test-key';
const TENANT = '00000000-0000-4000-8000-0000000000e2';
const tenantRef = tenantRefFor(TENANT);
const build = 'build-wkld-reads';
const NOW = new Date('2026-10-21T20:00:00Z');
const now = () => NOW;

const ACTIVATION = {
  'exchange-mail-flow': mailFlowActivation,
  'exchange-extended': exchangeExtendedActivation,
  'exchange-role-groups': exchangeRoleGroupsActivation,
  'exchange-distribution-groups': exchangeDistributionGroupsActivation,
  'exchange-recipients': exchangeRecipientsActivation,
  'teams-org-policies': teamsPolicyActivation,
  'teams-voice-policies': teamsExtendedActivation,
  'purview-retention-dlp': retentionDlpActivation,
  'purview-governance': purviewExtendedActivation,
  // SharePoint's per-site sharing read: the rest of the SharePoint read never waits for it.
  'sharepoint-site-settings': siteSharingActivation,
  'sharepoint-structure': sharePointStructureActivation,
};
const TABLES = {
  ExchangeOnlineManagement: ['Allowed', 'AllowedMailFlow', 'AllowedExchangeExtended', 'AllowedExchangeRoleGroups', 'AllowedExchangeRecipients', 'AllowedPurviewRetentionDlp', 'AllowedPurviewExtended'],
  MicrosoftTeams: ['AllowedTeamsPolicy', 'AllowedTeamsExtended'],
  'PnP.PowerShell': ['AllowedPnP', 'AllowedPnPStructure'],
};
// The run-cmdlet.ps1 allowlists, cmdlet names with digits included (Get-AtpPolicyForO365).
const SCRIPT = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
function containerAllowlist(variable) {
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(SCRIPT)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z0-9-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
// A cmdlet in two tables (Get-Mailbox) may take either table's parameters, as run-cmdlet.ps1 allows.
const allowlistFor = (module) => TABLES[module].map(containerAllowlist).reduce((all, table) => {
  for (const [cmdlet, names] of Object.entries(table)) all[cmdlet] = [...new Set([...(all[cmdlet] ?? []), ...names])];
  return all;
}, {});

// A site template is never empty: a site always answers with its template.
const TEMPLATE = '<pnp:Provisioning xmlns:pnp="http://schemas.dev.office.com/PnP/2022/09/ProvisioningSchema"><pnp:Templates><pnp:ProvisioningTemplate ID="TEMPLATE-1"/></pnp:Templates></pnp:Provisioning>';
const NOT_EMPTY = { 'Get-PnPSiteTemplate': [TEMPLATE] };

/** A tenant that answers every allowed Get- with nothing, or with `fail[cmdlet]`. */
function fakeTenant(workload, fail = {}) {
  const module = readModule(workload);
  return fakeCmdletContainer({
    module,
    allowlist: allowlistFor(module),
    answer: (cmdlet) => fail[cmdlet] ?? NOT_EMPTY[cmdlet] ?? [],
  });
}

// What a capture names beside the collector (--site for SharePoint structure).
const READ_OPTIONS = { 'sharepoint-structure': { sites: ['https://contoso.sharepoint.com/sites/KEEL-RT-structure'], tenantHost: 'contoso.sharepoint.com' } };
const capture = (workload, live, extra = {}) => captureWorkloadReads({
  workload, collector: live.powershell, tenantRef, build, credential: 'app:collector',
  moduleVersion: MODULE_VERSIONS[readModule(workload)], now, readOptions: READ_OPTIONS[workload] ?? {}, ...extra,
});
const verifyOptions = (extra = {}) => ({ gate: WORKLOAD_READS_LIVE_GATE, tenantRef, build, hmacKey: KEY, requireLive: true, now: NOW, ...extra });
const signed = (record) => signEvidence(record, KEY, 'keel-release-runner');

/** Live proof for every read this gate does not capture: what those workloads follow. */
const CAPTURED = new Set(Object.values(READ_FAMILIES).flatMap((families) => Object.values(families).map((spec) => spec.operation)));
const BASE = WORKLOAD_DESCRIPTORS.filter((descriptor) => !CAPTURED.has(descriptor.id)).map((descriptor) => ({
  operationId: descriptor.id, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-20T00:00:00Z', ok: true,
  version: descriptor.operation.kind === 'graph' || descriptor.operation.kind === 'rest' ? descriptor.operation.version : MODULE_VERSIONS[descriptor.operation.module],
  proofRef: `${descriptor.id}@base`,
}));
const ledger = (reads) => buildWorkloadLedger({ evidence: [...BASE, ...reads], grants: GRANTS, runtime: RUNTIME, tenantRef, now: NOW });

for (const workload of Object.keys(READ_FAMILIES)) {
  test(`${workload}: a read-only capture imports as live read proof and turns the workload on`, async () => {
    const live = fakeTenant(workload);
    const { record, diagnostics } = await capture(workload, live);
    assert.ok(live.calls.length > 0 && live.calls.every((call) => call.cmdlet.startsWith('Get-')), 'only Get- cmdlets are sent');
    assert.deepEqual(diagnostics, []);
    const evidence = signed(record);
    assert.deepEqual(verifyEvidence(evidence, verifyOptions()).failures, []);

    const seam = ledgerEvidenceFromWorkloadReadsAcceptance(evidence, { tenantRef, build, hmacKey: KEY, now: NOW });
    assert.deepEqual(seam.failures, []);
    const declared = Object.values(READ_FAMILIES[workload]).map((spec) => spec.operation);
    assert.deepEqual(seam.reads.map((item) => item.operationId).sort(), [...new Set(declared)].sort());
    assert.ok(seam.reads.every((item) => item.kind === 'live-capture' && item.synthetic === false && item.tenantRef === tenantRef));
    assert.deepEqual(seam.writes, []);
    assert.equal(seam.grants, null, 'grants are left as the other records stored them');
    const module = readModule(workload);
    assert.deepEqual(seam.runtime, { modules: { [module]: MODULE_VERSIONS[module] } });

    assert.equal(ACTIVATION[workload](ledger([])).enabled, false, 'off without the read proof');
    const activation = ACTIVATION[workload](ledger(seam.reads));
    assert.equal(activation.enabled, true, activation.reasons.join('; '));

    // The record keeps no tenant id and no error text.
    assert.doesNotMatch(JSON.stringify(evidence), new RegExp(TENANT));
  });
}

test('a captured read record carries no raw app id and passes the pseudonym check', async () => {
  const APP = '11111111-2222-4333-8444-555555555555';
  const live = fakeTenant('exchange-mail-flow');
  const { record } = await capture('exchange-mail-flow', live, { credential: `app:${APP}` });
  const evidence = signed(record);
  assert.deepEqual(verifyEvidence(evidence, verifyOptions()).failures, []);
  assert.match(evidence.subject.credentials.collector, /^app:[0-9a-f]{8}-[0-9a-f]{4}-8/);
  const text = JSON.stringify(evidence, null, 2);
  assert.doesNotMatch(text, new RegExp(APP));
  const lines = [];
  assert.equal(pseudonymizeCheck(['check', 'record.json'], { read: () => text, log: (line) => lines.push(line) }), 0, lines.join('\n'));
  // The same app id always maps to the same pseudonym for this tenant.
  const again = await capture('exchange-mail-flow', fakeTenant('exchange-mail-flow'), { credential: `app:${APP}` });
  assert.equal(again.record.subject.credentials.collector, evidence.subject.credentials.collector);
});

test('a read that fails is not proof, keeps its message out of the record, and the workload stays off', async () => {
  const live = fakeTenant('exchange-mail-flow', {
    'Get-TransportRule': { error: { message: 'could not connect: Organization contoso.onmicrosoft.com refused', category: 'OpenError', errorId: 'ConnectFailed' } },
  });
  const { record, diagnostics } = await capture('exchange-mail-flow', live);
  const failed = record.subject.reads.find((item) => item.operationId === 'mailflow.transport-rules');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /ConnectFailed/);
  assert.doesNotMatch(JSON.stringify(record), /contoso/);
  assert.match(diagnostics.find((item) => item.operationId === 'mailflow.transport-rules').message, /could not connect/);

  const evidence = signed(record);
  assert.deepEqual(verifyEvidence(evidence, verifyOptions()).failures, []);
  const seam = ledgerEvidenceFromWorkloadReadsAcceptance(evidence, { tenantRef, build, hmacKey: KEY, now: NOW });
  assert.ok(!seam.reads.some((item) => item.operationId === 'mailflow.transport-rules'));
  const activation = mailFlowActivation(ledger(seam.reads));
  assert.equal(activation.enabled, false);
  assert.match(activation.reasons.join(' '), /mailflow\.transport-rules/);
});

test('a record that overclaims, uses another credential or is unsigned fails the gate', async () => {
  const { record } = await capture('purview-retention-dlp', fakeTenant('purview-retention-dlp'));
  const tamper = (change) => { const copy = structuredClone(record); change(copy); return signed(copy); };
  const cases = [
    [tamper((r) => r.subject.reads.push({ ...r.subject.reads[0], operationId: 'purview.label-definitions' })), /not a declared purview-retention-dlp read/],
    [tamper((r) => Object.assign(r.subject.reads[0], { status: 'failed' })), /answered in full/],
    [tamper((r) => Object.assign(r.subject.reads[0], { version: '9.9.9' })), /module version/],
    [tamper((r) => { r.subject.credentials.restorer = 'app:restorer'; }), /collector credential only/],
    [tamper((r) => { r.subject.execution.module = 'MicrosoftTeams'; }), /bounded powershell-cmdlet-job transport/],
    [record, /runner/],
  ];
  for (const [evidence, reason] of cases) {
    const result = verifyEvidence(evidence, verifyOptions());
    assert.equal(result.ok, false);
    assert.match(result.failures.join(' '), reason);
    assert.equal(ledgerEvidenceFromWorkloadReadsAcceptance(evidence, { tenantRef, build, hmacKey: KEY, now: NOW }).reads.length, 0);
  }
});

test('the import stores the read proof, lists absent read records, and refuses one filed under another workload', async () => {
  const evidence = signed((await capture('exchange-extended', fakeTenant('exchange-extended'))).record);
  const files = { [workloadReadsRecordFile('exchange-extended')]: JSON.stringify(evidence) };
  const readFile = (path) => {
    const name = path.split('/').pop();
    if (files[name]) return files[name];
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  };
  const saved = [];
  const client = { query: async (sql, params) => { saved.push({ sql, params }); return { rows: [] }; } };
  const seams = (await importSeams()).filter((entry) => entry.file.startsWith('workload-reads-'));
  const result = await importLedgerInputs(client, { tenantRef, dir: '/records', seams, readFile, verify: { hmacKey: KEY, now: NOW } });
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.imported.map(({ file }) => file), [workloadReadsRecordFile('exchange-extended')]);
  assert.equal(result.absent.length, Object.keys(READ_FAMILIES).length - 1);
  const inserted = saved.filter(({ sql }) => /INSERT INTO workload_ledger_evidence/.test(sql));
  assert.equal(inserted.length, new Set(Object.values(READ_FAMILIES['exchange-extended']).map((spec) => spec.operation)).size);
  assert.ok(inserted.every(({ params }) => params[3] === 'live-capture' && params[4] === false));
  assert.ok(!saved.some(({ sql }) => /workload_ledger_grants/.test(sql)), 'the collector grants are not replaced');

  const misfiled = seams.find((entry) => entry.file === workloadReadsRecordFile('exchange-mail-flow'));
  const refused = misfiled.seam(evidence, { tenantRef, build, hmacKey: KEY, now: NOW });
  assert.equal(refused.ok, false);
  assert.match(refused.failures.join(' '), /for exchange-extended, not exchange-mail-flow/);
});

test('nothing is sent when the collector config names another tenant or --out is misnamed', async () => {
  let sent = 0;
  const deps = {
    out: () => {}, env: { KEEL_QUALIFICATION_HMAC_KEY: KEY }, write: () => {},
    readFile: () => JSON.stringify({ tenantId: '00000000-0000-4000-8000-0000000000ff' }),
    capture: async () => { sent += 1; return { record: {}, diagnostics: [] }; },
    pins: () => MODULE_VERSIONS,
  };
  const args = (out) => ['capture', '--workload', 'exchange-mail-flow', '--tenant-ref', tenantRef, '--collector-ref', 'app:collector',
    '--collector-config', '/etc/keel/exchange-collector.json', '--build', build, '--out', out];
  await assert.rejects(main(args(`/tmp/${workloadReadsRecordFile('exchange-mail-flow')}`), deps), /not the tenant the collector config names/);
  await assert.rejects(main(args('/tmp/reads.json'), deps), /must be named workload-reads-exchange-mail-flow-live-acceptance\.json/);
  assert.equal(sent, 0);
});
