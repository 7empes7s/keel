// Exchange audit, encryption and organization settings (Get-AdminAuditLogConfig,
// Get-IRMConfiguration, Get-OMEConfiguration and the other org-wide reads), read-only.
//
// Acceptance:
//  - every read is declared in workloadContract.mjs, passes the scope validator, is run by
//    the read-only probe, and ships disabled (fixture proof never enables it);
//  - only the Get cmdlets run, with no parameters; the Node and container allowlists
//    match; no write exists;
//  - org-wide settings are one observation keyed `organization`, the rest one per Guid,
//    with declared fields only (the OME logo bytes are dropped);
//  - collection stays off until Exchange and every read here are qualified, and never
//    waits on the other Exchange cmdlet workloads;
//  - the audit log being switched off between two reads is a change (workload drift);
//  - the read capture tool can qualify it although it has no writes;
//  - it sits in Exchange's "Organization settings" group, last in the service.
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays the ops/powershell/run-cmdlet.ps1 contract through the real
// engine/powershell/jobQueue.mjs spawn path. No tenant is touched.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  EXCHANGE_ORG_CONFIG_CMDLET_PARAMETERS, EXCHANGE_ORG_CONFIG_DESCRIPTOR, EXCHANGE_ORG_CONFIG_OPERATIONS, EXCHANGE_ORG_CONFIG_WORKLOAD,
  ExchangeOrgConfigScopeError, FAMILIES, FAMILY_NAMES, assertExchangeOrgConfigCmdlet, collectExchangeOrgConfig, exchangeOrgConfigActivation,
  readExchangeOrgConfig,
} from '../collect/workloads/exchangeOrgConfig.mjs';
import { EXCHANGE_OPERATIONS } from '../collect/workloads/exchange.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOAD_DESCRIPTORS, WORKLOADS, buildWorkloadLedger, descriptorProblems } from '../collect/workloadContract.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { detectWorkloadDrift } from '../govern/workloadDrift.mjs';
import { compareInService, typeInfo } from '../insights/taxonomy.mjs';
import { runFixtureHarness } from '../../tools/qualification/workloads.mjs';
import { readModule, workloadReads } from '../../tools/qualification/workloadReadsAcceptance.mjs';
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
const EXO_VERSION = '3.5.0';
let tenantSeq = 0;
const nextTenant = () => `sha256:org-config-${tenantSeq += 1}`;
const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-00000000c0c0`;
const WHEN = '2026-10-01T00:00:00Z';

// Each answer carries every declared field (set to a plain value), its Guid, and
// internal properties a careless reader would keep.
const answer = (familyName, n, over = {}) => ({
  ...Object.fromEntries(FAMILIES[familyName].fields.map((field) => [field, field === 'WhenChangedUTC' ? WHEN : `KEEL-RT-${familyName}-${n}-${field}`])),
  Guid: guid(n), DistinguishedName: 'CN=internal', OrganizationId: 'internal', ...over,
});
const BASE = () => ({
  'Get-AdminAuditLogConfig': [answer('adminAuditLog', 1, { Name: 'Admin Audit Log Settings', UnifiedAuditLogIngestionEnabled: true, AdminAuditLogEnabled: true })],
  'Get-IRMConfiguration': [answer('irm', 2, { AzureRMSLicensingEnabled: true })],
  'Get-OMEConfiguration': [answer('messageEncryption', 3, { Identity: 'OME Configuration', OTPEnabled: true, Image: 'iVBORw0KGgo-logo-bytes' })],
  'Get-PerimeterConfig': [answer('perimeter', 4, { Name: 'Perimeter Settings', GatewayIPAddresses: [] })],
  'Get-AvailabilityConfig': [],
  'Get-AvailabilityAddressSpace': [],
  'Get-MessageClassification': [answer('messageClassification', 5, { Name: 'KEEL-RT-classification' }), answer('messageClassification', 6, { Name: 'KEEL-RT-classification-2' })],
  'Get-PolicyTipConfig': [],
  'Get-ResourceConfig': [answer('resourceConfig', 7, { Name: 'Resource Schema', ResourcePropertySchema: ['Room/Whiteboard'] })],
  'Get-PartnerApplication': [],
  'Get-OnPremisesOrganization': [],
});

function containerAllowlist(variable) {
  const script = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(script)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z0-9-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const ALLOWED = containerAllowlist('AllowedExchangeOrgConfig');

/** A fake Exchange Online behind the real jobQueue spawn path. `state.output[cmdlet]` is each answer. */
function fakeExchange(state = { output: BASE() }) {
  const calls = [];
  const envelope = (body, exitCode = 0) => ({ stdout: JSON.stringify(body), exitCode });
  function run(job) {
    if (job.mode !== 'cmdlet' || job.module !== 'ExchangeOnlineManagement' || !ALLOWED[job.cmdlet]) {
      return envelope({ ok: false, error: { message: `cmdlet ${job.cmdlet} is not allowed`, category: null, errorId: 'CmdletNotAllowed' } }, 1);
    }
    calls.push({ cmdlet: job.cmdlet, parameters: job.parameters ?? {} });
    const error = state.errors?.[job.cmdlet];
    if (error) return envelope({ ok: false, error }, 1);
    return envelope({ ok: true, output: structuredClone(state.output[job.cmdlet] ?? []) });
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
          child.stdout.emit('data', Buffer.from(result.stdout));
          child.emit('close', result.exitCode);
        });
      },
    };
    return child;
  }
  return { calls, state, powershell: { spawnFn, timeoutMs: 200, tenantConfigPath: '/etc/keel/tenant.json' } };
}

const liveCapture = (operationId, tenantRef) => {
  const descriptor = WORKLOAD_DESCRIPTORS.find((item) => item.id === operationId);
  const version = descriptor.operation.kind === 'graph' ? descriptor.operation.version : descriptor.operation.module === 'PnP.PowerShell' ? '3.4.1' : EXO_VERSION;
  return { operationId, kind: 'live-capture', synthetic: false, tenantRef, capturedAt: '2026-10-29T00:00:00Z', version, ok: true, proofRef: `${operationId}@sha256:x` };
};
const fixtureRun = (operationId) => ({ operationId, kind: 'fixture', synthetic: true, ok: true, proofRef: `${operationId}.fixture` });
const GRANTS = Object.freeze({
  permissions: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.permissions))],
  roles: [...new Set(WORKLOAD_DESCRIPTORS.flatMap((descriptor) => descriptor.rbac.roles))],
});
const RUNTIME = Object.freeze({ modules: { ExchangeOnlineManagement: EXO_VERSION, 'PnP.PowerShell': '3.4.1', MicrosoftTeams: '6.0.0' } });
function ledgerWith(tenantRef, live) {
  const evidence = WORKLOAD_DESCRIPTORS.map((descriptor) => (live.includes(descriptor.id) ? liveCapture(descriptor.id, tenantRef) : fixtureRun(descriptor.id)));
  return buildWorkloadLedger({ evidence, grants: GRANTS, runtime: RUNTIME, tenantRef, now: NOW });
}
const ALL_READS = Object.freeze(WORKLOAD_DESCRIPTORS.map((descriptor) => descriptor.id));
const OTHER_READS = Object.freeze(ALL_READS.filter((id) => !EXCHANGE_ORG_CONFIG_OPERATIONS.includes(id)));
const CMDLETS = FAMILY_NAMES.map((name) => FAMILIES[name].cmdlet);

test('the reads are declared, in scope, probed, Get-only and ship disabled', async () => {
  assert.ok(WORKLOADS.includes(EXCHANGE_ORG_CONFIG_WORKLOAD));
  const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === EXCHANGE_ORG_CONFIG_WORKLOAD);
  assert.deepEqual(declared.map((descriptor) => descriptor.id), [...EXCHANGE_ORG_CONFIG_OPERATIONS]);
  assert.deepEqual(declared.map((descriptor) => descriptor.operation.cmdlet), CMDLETS);
  const probe = readFileSync(new URL('../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const exo = /# --- Exchange Online ---([\s\S]*?)# --- Security & Compliance/.exec(probe)[1];
  for (const descriptor of declared) {
    assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
    assert.equal(descriptor.operation.module, 'ExchangeOnlineManagement');
    assert.deepEqual(descriptor.operation.parameters, []);
    assert.deepEqual(descriptor.rbac.roles, ['Exchange Administrator']);
    const name = descriptor.operation.cmdlet;
    assert.ok(exo.includes(`-Workload 'exo' -Name '${name}' -Block { ${name} }`), name);
  }
  // Message classifications are labels, not mail; message reads stay refused.
  const like = declared.find((descriptor) => descriptor.operation.cmdlet === 'Get-MessageClassification');
  for (const name of ['Get-MessageTrace', 'Get-Message', 'Get-MessageTraceDetail']) {
    assert.match(descriptorProblems({ ...like, operation: { ...like.operation, cmdlet: name, probeName: name } }).join('; '), /reads content/, name);
  }
  const bare = buildWorkloadLedger({ grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(EXCHANGE_ORG_CONFIG_OPERATIONS.every((id) => bare.rows.find((row) => row.id === id).enabled === false));
  const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

  assert.equal(EXCHANGE_ORG_CONFIG_DESCRIPTOR.enabledByDefault, false);
  assert.equal(EXCHANGE_ORG_CONFIG_DESCRIPTOR.readOnly, true);
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === EXCHANGE_ORG_CONFIG_WORKLOAD));
  assert.ok(WORKLOAD_COLLECTORS.some((entry) => entry.workload === EXCHANGE_ORG_CONFIG_WORKLOAD && entry.powershellFamily === 'exchange'));
  assert.deepEqual(Object.values(WORKLOAD_WRITE_OPERATIONS).filter((operation) => operation.workload === EXCHANGE_ORG_CONFIG_WORKLOAD), [], 'no writer');

  assert.deepEqual(Object.fromEntries(Object.entries(EXCHANGE_ORG_CONFIG_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), ALLOWED,
    'the Node and container allowlists are identical');
  for (const cmdlet of ['Set-AdminAuditLogConfig', 'Set-IRMConfiguration', 'Set-OMEConfiguration', 'New-MessageClassification',
    'Remove-PartnerApplication', 'Set-OnPremisesOrganization', 'Search-UnifiedAuditLog', 'Search-AdminAuditLog']) {
    assert.throws(() => assertExchangeOrgConfigCmdlet({ cmdlet }), ExchangeOrgConfigScopeError, cmdlet);
  }
  assert.throws(() => assertExchangeOrgConfigCmdlet({ cmdlet: 'Get-OMEConfiguration', parameters: { Identity: 'x' } }), /does not take Identity/);

  // The read capture tool qualifies it, in the Exchange module, though it has no writes.
  assert.equal(readModule(EXCHANGE_ORG_CONFIG_WORKLOAD), 'ExchangeOnlineManagement');
  assert.deepEqual(workloadReads(EXCHANGE_ORG_CONFIG_WORKLOAD).map((read) => read.cmdlet), CMDLETS);
});

test('the settings sit in Exchange organization settings, last in the service', () => {
  const info = typeInfo(EXCHANGE_ORG_CONFIG_WORKLOAD);
  assert.equal(info.known, true);
  assert.equal(info.service, 'Exchange');
  assert.equal(info.categoryName, 'Organization settings');
  assert.equal(info.name, 'Exchange audit, encryption or organization setting');
  const order = [EXCHANGE_ORG_CONFIG_WORKLOAD, 'exchange-extended', 'exchange-mail-flow', 'exchange-role-groups', 'exchange-mailbox-settings'].sort(compareInService);
  assert.deepEqual(order, ['exchange-mailbox-settings', 'exchange-role-groups', 'exchange-mail-flow', 'exchange-extended', EXCHANGE_ORG_CONFIG_WORKLOAD]);
});

test('org-wide settings are one observation each, the rest one per Guid, declared fields only', async () => {
  const exchange = fakeExchange();
  const result = await readExchangeOrgConfig({ powershell: exchange.powershell, now: () => NOW });
  assert.deepEqual(exchange.calls, CMDLETS.map((cmdlet) => ({ cmdlet, parameters: {} })));
  assert.equal(result.outcome, 'complete', JSON.stringify(result.discovery));
  assert.deepEqual(result.resources.map((resource) => resource.resourceKey), [
    'admin-audit-log:organization', 'irm:organization', `ome:${guid(3)}`, 'perimeter:organization',
    `message-classification:${guid(5)}`, `message-classification:${guid(6)}`, 'resource-config:organization',
  ]);
  const audit = result.resources[0];
  assert.equal(audit.fields.UnifiedAuditLogIngestionEnabled, true);
  assert.equal(audit.fields.DistinguishedName, undefined);
  assert.deepEqual(Object.keys(audit.fields), [...FAMILIES.adminAuditLog.fields]);
  const ome = result.resources[2];
  assert.equal(ome.fields.Image, undefined, 'the logo bytes are never kept');
  assert.equal(ome.fields.Identity, 'OME Configuration');

  // A second, different org-wide answer is a conflict; an unidentified object is counted.
  const odd = BASE();
  odd['Get-IRMConfiguration'].push(answer('irm', 9, { AzureRMSLicensingEnabled: false }));
  odd['Get-MessageClassification'].push({ ...answer('messageClassification', 8), Guid: 'not-a-guid' });
  const partial = await readExchangeOrgConfig({ powershell: fakeExchange({ output: odd }).powershell, now: () => NOW });
  assert.equal(partial.outcome, 'partial');
  assert.equal(partial.discovery.conflicts.length, 1);
  assert.equal(partial.discovery.unidentified, 1);

  // The audit log settings always exist: an empty answer is a gap, a failure is a failure.
  const empty = BASE();
  empty['Get-AdminAuditLogConfig'] = [];
  const gap = await readExchangeOrgConfig({ powershell: fakeExchange({ output: empty }).powershell, now: () => NOW });
  assert.equal(gap.outcome, 'partial');
  assert.deepEqual(gap.discovery.empty, ['adminAuditLog']);
  const denied = await readExchangeOrgConfig({
    powershell: fakeExchange({ output: BASE(), errors: { 'Get-PartnerApplication': { message: 'Access is denied', category: 'PermissionDenied', errorId: 'x' } } }).powershell,
    now: () => NOW,
  });
  assert.equal(denied.outcome, 'partial');
  assert.equal(denied.failures[0].family, 'partnerApplication');
  assert.equal(denied.failures[0].status, 'denied');
});

test('collection stays off until Exchange and these reads are qualified, then the audit log switched off is a change', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const exchange = fakeExchange();
  const oneMissing = ALL_READS.filter((id) => id !== 'exchange-org-config.partner-applications');
  for (const ledger of [ledgerWith(tenantRef, OTHER_READS), ledgerWith(tenantRef, oneMissing), ledgerWith(tenantRef, ALL_READS.filter((id) => !EXCHANGE_OPERATIONS.includes(id)))]) {
    const disabled = await collectExchangeOrgConfig(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => NOW });
    assert.equal(disabled.run.outcome, 'disabled');
  }
  assert.deepEqual(exchange.calls, [], 'nothing is sent while disabled');
  assert.match(exchangeOrgConfigActivation(ledgerWith(tenantRef, oneMissing)).reasons.join('; '), /exchange-org-config\.partner-applications is fixture-tested/);
  // Exchange (and what it follows) is needed beside these reads, not the other Exchange cmdlet workloads.
  const others = ALL_READS.filter((id) => /^(mailflow|exchange-extended|exchange-role-groups|exchange-recipients|exchange-distribution-groups)\./.test(id));
  assert.ok(others.length > 20);
  assert.equal(exchangeOrgConfigActivation(ledgerWith(tenantRef, ALL_READS.filter((id) => !others.includes(id)))).enabled, true);

  const ledger = ledgerWith(tenantRef, ALL_READS);
  const first = await collectExchangeOrgConfig(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => new Date('2026-10-29T02:00:00Z') });
  assert.equal(first.run.outcome, 'complete');
  const { rows } = await client.query('SELECT resource_key, fields FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [first.run.id]);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.find((row) => row.resource_key === 'admin-audit-log:organization').fields.kind, 'adminAuditLog');

  exchange.state.output['Get-AdminAuditLogConfig'] = [answer('adminAuditLog', 1, {
    Name: 'Admin Audit Log Settings', UnifiedAuditLogIngestionEnabled: false, AdminAuditLogEnabled: true, WhenChangedUTC: '2026-10-29T09:00:00Z',
  })];
  const second = await collectExchangeOrgConfig(client, { tenantRef, ledger, powershell: exchange.powershell, now: () => new Date('2026-10-30T02:00:00Z') });
  const drift = await detectWorkloadDrift(client, { collectionId: second.run.id });
  assert.equal(drift.status, 'detected');
  const { rows: changes } = await client.query('SELECT resource_key, change_type, fields FROM workload_drift WHERE tenant_ref = $1', [tenantRef]);
  assert.deepEqual(changes.map((row) => [row.resource_key, row.change_type]), [['admin-audit-log:organization', 'modified']]);
  assert.deepEqual(changes[0].fields.map((field) => field.path), ['UnifiedAuditLogIngestionEnabled']);
});
