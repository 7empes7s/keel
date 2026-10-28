// Wave 2 WKLD live gate: tools/qualification/workloadWritesLive.mjs captures one live
// write per writer family of a workload, and its record imports as live write proof.
//
// Acceptance:
//  - a capture writes only KEEL-RT- objects (matched by the prefix), one harmless field
//    each, reads it back and puts it back; every other object is untouched;
//  - a named Teams policy family also re-creates a KEEL-RT-capture-* policy;
//  - the signed record verifies with --require-live, and its seam yields one
//    live-write-capture per proven write, which workloadWriteQualification accepts;
//  - a family with no fixture, nothing harmless to change, or a preservation lock is
//    skipped; a write not put back is not proof and is reported for a manual fix;
//  - a record naming a non-fixture object, a content-bearing field or an undeclared
//    cmdlet fails the gate; a record filed under another workload is refused on import;
//  - nothing is sent when the configs name another tenant, or without
//    --confirm-live-tenant-write.
//
// Everything runs against a fake PowerShell container behind the real
// engine/powershell/jobQueue.mjs spawn path, which enforces the allowlists parsed from
// ops/powershell/run-cmdlet.ps1. No tenant is touched.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { DSC_WRITES_RECORD_FILE } from '../../tools/qualification/dscDistributionGroupsAcceptance.mjs';
import { importLedgerInputs, importSeams } from '../../cli/keel-workload-collect.mjs';
import { signEvidence, verifyEvidence } from '../../tools/release/qualification.mjs';
import { SITE_GRANTS_RECORD_FILE } from '../../tools/qualification/sharepointSiteGrantsAcceptance.mjs';
import { SITE_PERMISSIONS_RECORD_FILE } from '../../tools/qualification/sharepointSitePermissionsAcceptance.mjs';
import { STRUCTURE_WRITES_RECORD_FILE } from '../../tools/qualification/sharepointStructureWritesAcceptance.mjs';
import { READ_FAMILIES, workloadReadsRecordFile } from '../../tools/qualification/workloadReadsAcceptance.mjs';
import {
  CAPTURE_CREATE_PREFIX, TENANT_WIDE_UNSAFE_SWITCHES, TENANT_WIDE_WRITES, WORKLOAD_WRITES_LIVE_GATE, WRITTEN_WORKLOADS, chooseCaptureChange, workloadWritesRecordFile,
} from '../../tools/qualification/workloadWritesAcceptance.mjs';
import {
  captureWorkloadWrites, ledgerEvidenceFromWorkloadWritesAcceptance, main, pinnedModuleVersions, workloadWritesCapturePlan, writeWorkloadWritesFiles,
} from '../../tools/qualification/workloadWritesLive.mjs';
import { FAMILIES as EXCHANGE_EXTENDED_FAMILIES } from '../collect/workloads/exchangeExtended.mjs';
import { FAMILIES as MAIL_FLOW_FAMILIES } from '../collect/workloads/mailFlow.mjs';
import { FAMILIES as PURVIEW_EXTENDED_FAMILIES } from '../collect/workloads/purviewExtended.mjs';
import { FAMILIES as RETENTION_DLP_FAMILIES } from '../collect/workloads/purviewRetentionDlp.mjs';
import { FAMILIES as TEAMS_EXTENDED_FAMILIES } from '../collect/workloads/teamsExtended.mjs';
import { FAMILIES as TEAMS_POLICY_FAMILIES } from '../collect/workloads/teamsPolicies.mjs';
import { workloadWriteQualification } from '../coverage/qualification.mjs';
import { writeFamilies } from '../restore/workloads/cmdletSettings.mjs';
import { WKLD_WRITE_OPERATIONS } from '../restore/workloads/writeDeclarations.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { fakeCmdletContainer } from '../test/fakeCmdletContainer.mjs';

const KEY = 'workload-writers-test-key';
const TENANT = '00000000-0000-4000-8000-0000000000e1';
const tenantRef = tenantRefFor(TENANT);
const build = 'build-wkld-capture';
const ORG = 'keelrt.onmicrosoft.com';
const VERSIONS = { ExchangeOnlineManagement: '3.5.0', MicrosoftTeams: '6.0.0' };
const GRANTS = {
  collector: { permissions: ['Exchange.ManageAsApp'], roles: ['Global Reader'] },
  restorer: { permissions: ['Exchange.ManageAsApp'], roles: ['Exchange Administrator', 'Compliance Administrator', 'Teams Administrator'] },
};
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'wkld-capture-')); dirs.push(dir); return dir; };

const WORKLOADS = Object.freeze({
  'exchange-mail-flow': { families: MAIL_FLOW_FAMILIES, keyed: 'guid' },
  'exchange-extended': { families: EXCHANGE_EXTENDED_FAMILIES, keyed: 'guid' },
  'teams-org-policies': { families: TEAMS_POLICY_FAMILIES, keyed: 'policy' },
  'teams-voice-policies': { families: TEAMS_EXTENDED_FAMILIES, keyed: 'policy' },
  'purview-retention-dlp': { families: RETENTION_DLP_FAMILIES, keyed: 'guid' },
  'purview-governance': { families: PURVIEW_EXTENDED_FAMILIES, keyed: 'guid' },
});

const SCRIPT = readFileSync(new URL('../../ops/powershell/run-cmdlet.ps1', import.meta.url), 'utf8');
function allowlist(variable) {
  const block = new RegExp(`\\$${variable} = @\\{([\\s\\S]*?)\\n\\}`).exec(SCRIPT)[1];
  return Object.fromEntries([...block.matchAll(/'([A-Za-z0-9-]+)'\s*=\s*@\(([^)]*)\)/g)]
    .map(([, name, entries]) => [name, [...entries.matchAll(/'([A-Za-z0-9]+)'/g)].map((match) => match[1])]));
}
const MODULE_TABLES = {
  ExchangeOnlineManagement: ['Allowed', 'AllowedMailFlow', 'AllowedExchangeExtended', 'AllowedPurviewRetentionDlp', 'AllowedPurviewExtended', 'AllowedExchangeWrites', 'AllowedPurviewWrites'],
  MicrosoftTeams: ['AllowedTeamsPolicy', 'AllowedTeamsExtended', 'AllowedTeamsWrites'],
};
const moduleAllowlist = (module) => Object.assign({}, ...MODULE_TABLES[module].map(allowlist));
const getKey = (spec) => `${spec.cmdlet}${spec.parameters?.QuarantinePolicyType ? `:${spec.parameters.QuarantinePolicyType}` : ''}`;
const TEXT = new Set(['Comments', 'Comment', 'Description', 'AdminDisplayName', 'Notes']);

let guidSeq = 0;
const guid = () => `00000000-0000-4000-8000-${String(guidSeq += 1).padStart(12, '0')}`;

/** One object of a family: text fields hold text, the rest an opaque value. */
function object(workload, family, { name, policy = null }) {
  const spec = WORKLOADS[workload].families[family];
  const body = Object.fromEntries(spec.fields.map((field) => [field, TEXT.has(field) ? `${name} original note` : `${name}-${field}`]));
  if (WORKLOADS[workload].keyed === 'guid') body.Guid = guid();
  body.Identity = WORKLOADS[workload].keyed === 'policy' ? (name === 'Global' ? 'Global' : `Tag:${name}`) : body.Guid;
  if ('Name' in body) body.Name = name;
  if ('Policy' in body) body.Policy = policy;
  if ('RestrictiveRetention' in body) body.RestrictiveRetention = false;
  return body;
}

/** Per written family: a KEEL-RT- fixture and an object that is not one (Global, or a real-looking name). */
function tenantState(workload) {
  const state = {};
  const { families } = WORKLOADS[workload];
  const put = (family, body) => { (state[getKey(families[family])] ??= []).push(body); };
  const other = WORKLOADS[workload].keyed === 'policy' ? 'Global' : 'Contoso production';
  for (const family of Object.keys(writeFamilies(workload))) {
    if (families[family].policyFamily) continue;
    put(family, object(workload, family, { name: `KEEL-RT-20261015-${family}` }));
    put(family, object(workload, family, { name: other }));
  }
  for (const family of Object.keys(writeFamilies(workload))) {
    const parentFamily = families[family].policyFamily;
    if (!parentFamily) continue;
    for (const parent of state[getKey(families[parentFamily])]) put(family, object(workload, family, { name: `${parent.Name.startsWith('KEEL-RT-') ? 'KEEL-RT-20261015' : 'Contoso'}-${family}`, policy: parent.Guid }));
  }
  return state;
}

function writeTargets(workload) {
  const targets = {};
  for (const write of Object.values(WKLD_WRITE_OPERATIONS)) {
    if (write.workload !== workload) continue;
    (targets[write.method] ??= new Set()).add(getKey(WORKLOADS[workload].families[write.family]));
  }
  return targets;
}

/**
 * Set-QuarantinePolicy as live (#339): a quarantine policy by its Name; the global settings
 * only as DefaultGlobalTag, though their read answers Name DefaultGlobalPolicy.
 */
function quarantineTarget(state, identity) {
  const id = String(identity).toLowerCase();
  if (id === 'defaultglobaltag') return state['Get-QuarantinePolicy:GlobalQuarantinePolicy']?.[0] ?? null;
  return (state['Get-QuarantinePolicy'] ?? []).find((body) => String(body.Name ?? '').toLowerCase() === id) ?? null;
}

/** A fake tenant behind the real job transport. `hooks.cmdlet` may return { error } or 'crash'. */
function fakeTenant(workload, { state = tenantState(workload), hooks = {}, organization = ORG, organizationTenant = TENANT } = {}) {
  const { module } = WRITTEN_WORKLOADS[workload];
  if (module === 'ExchangeOnlineManagement') state['Get-OrganizationConfig'] ??= [{ Name: organization, ExternalDirectoryOrganizationId: organizationTenant }];
  const targets = writeTargets(workload);
  const writes = [];
  const container = fakeCmdletContainer({
    module,
    allowlist: moduleAllowlist(module),
    answer(cmdlet, parameters) {
      const hook = hooks.cmdlet?.({ cmdlet, parameters, state });
      if (hook?.error || hook === 'crash') return hook;
      if (cmdlet.startsWith('Get-')) return state[`${cmdlet}${parameters.QuarantinePolicyType ? `:${parameters.QuarantinePolicyType}` : ''}`] ?? [];
      writes.push({ cmdlet, parameters });
      const { Identity, ...values } = parameters;
      const lists = [...(targets[cmdlet] ?? [])].map((key) => (state[key] ??= []));
      if (cmdlet.startsWith('New-')) {
        lists[0].push({ Identity: `Tag:${Identity}`, ...values });
        return [];
      }
      // As live (#339): Set-QuarantinePolicy fails its Identity argument transformation on a Guid; it takes the Name.
      if (cmdlet === 'Set-QuarantinePolicy' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(Identity))) {
        return { error: { message: `Cannot process argument transformation on parameter 'Identity'. Cannot convert value "${Identity}"`, category: 'InvalidData', errorId: 'ParameterArgumentTransformationError,Set-QuarantinePolicy' } };
      }
      const found = cmdlet === 'Set-QuarantinePolicy' ? quarantineTarget(state, Identity) : lists.flat().find((body) => String(body.Guid ?? '').toLowerCase() === String(Identity).toLowerCase()
        || String(body.Identity ?? '').toLowerCase() === String(Identity).toLowerCase());
      if (!found) return { error: { message: `object '${Identity}' couldn't be found.`, category: 'NotSpecified', errorId: 'ManagementObjectNotFoundException' } };
      Object.assign(found, values);
      return [];
    },
  });
  return { state, writes, powershell: container.powershell };
}

let suffixSeq = 0;
const capture = (workload, live, extra = {}) => captureWorkloadWrites({
  workload, collector: live.powershell, restorer: live.powershell, directoryTenantId: TENANT, configs: { collector: { tenantId: TENANT, organization: ORG }, restorer: { tenantId: TENANT, organization: ORG } },
  tenantRef, build, credentials: { collector: 'app:collector', restorer: 'app:restorer' }, grants: GRANTS,
  moduleVersion: VERSIONS[WRITTEN_WORKLOADS[workload].module], sleep: async () => {}, readBackAttempts: 2, readBackDelayMs: 0,
  suffix: () => `t${suffixSeq += 1}`, ...extra,
});
const verifyOptions = (dir, extra = {}) => ({ gate: WORKLOAD_WRITES_LIVE_GATE, tenantRef, build, hmacKey: KEY, requireLive: true, evidenceDir: dir, ...extra });
const isFixture = (body) => /^keel-rt-/i.test(String(body.Name ?? String(body.Identity ?? '').replace(/^tag:/i, '')));

async function signedCapture(workload, live = fakeTenant(workload), extra = {}) {
  const result = await capture(workload, live, extra);
  const dir = tempDir();
  const { evidence } = writeWorkloadWritesFiles({ ...result, outPath: join(dir, workloadWritesRecordFile(workload)), hmacKey: KEY });
  return { ...result, evidence, dir, live };
}

// ------------------------------------------------------------ every workload

for (const workload of Object.keys(WRITTEN_WORKLOADS)) {
  test(`${workload}: one write per family on KEEL-RT- fixtures only, put back, and it imports as write proof`, async () => {
    const live = fakeTenant(workload);
    const before = structuredClone(live.state);
    const { evidence, dir, needsManualRevert } = await signedCapture(workload, live);

    assert.deepEqual(verifyEvidence(evidence, verifyOptions(dir)).failures, []);
    assert.deepEqual(needsManualRevert, []);
    assert.deepEqual(evidence.subject.refusals.remove.refused && !evidence.subject.refusals.remove.sent, true);
    assert.deepEqual(evidence.subject.refusals.undeclaredParameter.refused && !evidence.subject.refusals.undeclaredParameter.sent, true);

    // Only KEEL-RT- objects were written; every object present before is back as it was.
    const all = Object.values(live.state).flat();
    for (const write of live.writes) {
      if (write.cmdlet.startsWith('New-')) {
        assert.ok(write.parameters.Identity.startsWith(CAPTURE_CREATE_PREFIX), write.parameters.Identity);
        continue;
      }
      const target = write.cmdlet === 'Set-QuarantinePolicy' ? quarantineTarget(live.state, write.parameters.Identity)
        : all.find((body) => [body.Guid, body.Identity].some((id) => String(id ?? '').toLowerCase() === String(write.parameters.Identity).toLowerCase()));
      assert.ok(target && isFixture(target), `${write.cmdlet} wrote ${write.parameters.Identity}`);
      assert.deepEqual(Object.keys(write.parameters).filter((name) => name !== 'Identity').length, 1, 'one field per write');
    }
    for (const [key, list] of Object.entries(before)) {
      assert.deepEqual(live.state[key].filter((body) => !String(body.Identity ?? '').toUpperCase().startsWith(`TAG:${CAPTURE_CREATE_PREFIX.toUpperCase()}`)), list, key);
    }
    assert.ok(live.writes.every((write) => /^(Set|New)-/.test(write.cmdlet)), 'nothing is deleted');

    // Every family with a comment or description is proven; creates for named Teams policies.
    const families = writeFamilies(workload);
    const expected = Object.values(families).flatMap(({ update, add }) => [
      ...(WKLD_WRITE_OPERATIONS[update].fields.some((field) => TEXT.has(field)) ? [update] : []),
      ...(add ? [add] : []),
    ]).sort();
    const seam = ledgerEvidenceFromWorkloadWritesAcceptance(evidence, { tenantRef, build, hmacKey: KEY, evidenceDir: dir });
    assert.deepEqual(seam.failures, []);
    assert.deepEqual(seam.writes.map((item) => item.operationId).sort(), expected);
    assert.ok(seam.writes.every((item) => item.kind === 'live-write-capture' && item.synthetic === false && item.readBackVerified === true));
    assert.ok(seam.writes.every((item) => item.proofRef === `${WORKLOAD_WRITES_LIVE_GATE}/${workload}@${evidence.subject.captureLogSha256}`));
    assert.deepEqual(seam.runtime, { modules: { [WRITTEN_WORKLOADS[workload].module]: VERSIONS[WRITTEN_WORKLOADS[workload].module] } });
    assert.deepEqual(seam.reads, []);
    // Families left out are listed with a reason, never silently dropped.
    const skippedOps = evidence.subject.skipped.map((item) => item.operationId);
    for (const [, { update }] of Object.entries(families)) assert.ok(expected.includes(update) || skippedOps.includes(update), update);

    // The write proof is accepted for each proven operation (its own state; enabling also needs reads and prerequisites).
    const runtime = { modules: VERSIONS };
    for (const item of seam.writes) {
      const state = workloadWriteQualification(item.operationId, { evidence: seam.writes, tenantRef, runtime, grants: GRANTS.restorer });
      assert.equal(state.state, 'live-qualified', `${item.operationId}: ${state.reasons.join('; ')}`);
    }
  });
}

// ------------------------------------------------------------ specific rules

test('the import stores the proven writes, skips absent writer records, and refuses one filed under another workload', async (t) => {
  const { evidence, dir } = await signedCapture('exchange-mail-flow');
  const saved = [];
  const client = { query: async (sql, params) => { saved.push({ sql, params }); return { rows: [] }; } };
  const seams = (await importSeams()).filter((entry) => entry.optional);
  const result = await importLedgerInputs(client, { tenantRef, dir, seams, verify: { hmacKey: KEY } });
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.imported.map(({ file, writes }) => ({ file, writes })), [{ file: workloadWritesRecordFile('exchange-mail-flow'), writes: 4 }]);
  assert.deepEqual(result.absent.sort(), [
    ...Object.keys(WRITTEN_WORKLOADS).filter((w) => w !== 'exchange-mail-flow').map(workloadWritesRecordFile), SITE_GRANTS_RECORD_FILE, SITE_PERMISSIONS_RECORD_FILE, STRUCTURE_WRITES_RECORD_FILE,
    DSC_WRITES_RECORD_FILE, ...Object.keys(READ_FAMILIES).map(workloadReadsRecordFile),
  ].sort());
  const inserted = saved.filter(({ sql }) => /INSERT INTO workload_ledger_evidence/.test(sql));
  assert.equal(inserted.length, 4);
  assert.ok(inserted.every(({ params }) => params[3] === 'live-write-capture' && params[8] === true));
  t.diagnostic(`stored ${inserted.map(({ params }) => params[1]).join(', ')}`);

  // The same record under the Teams file name proves nothing.
  const misfiled = (await importSeams()).find((entry) => entry.file === workloadWritesRecordFile('teams-org-policies'));
  const refused = misfiled.seam(evidence, { tenantRef, build, hmacKey: KEY, evidenceDir: dir });
  assert.equal(refused.ok, false);
  assert.match(refused.failures.join(' '), /for exchange-mail-flow, not teams-org-policies/);
});

test('a record that names a non-fixture object, a content-bearing field or an undeclared cmdlet fails the gate', async () => {
  const { evidence, dir } = await signedCapture('exchange-mail-flow');
  const resign = (change) => signEvidence(change(structuredClone(evidence)), KEY);
  const failures = (record) => verifyEvidence(record, verifyOptions(dir)).failures.join(' | ');

  assert.match(failures(resign((record) => { record.subject.writes[0].fixture = 'Contoso production'; return record; })), /not a KEEL-RT- fixture/);
  assert.match(failures(resign((record) => {
    const rule = record.subject.writes.find((item) => item.operationId === 'mailflow.transport-rule.update');
    Object.assign(rule, { field: 'Mode', type: 'text' });
    return record;
  })), /Mode is not a field a capture may write/);
  assert.match(failures(resign((record) => { record.subject.requests.push({ credential: 'restorer', cmdlet: 'Remove-TransportRule', parameters: {} }); return record; })), /Remove-TransportRule is not a declared exchange-mail-flow write/);
  assert.match(failures(resign((record) => { record.subject.requests.find((item) => item.cmdlet).credential = 'collector'; return record; })), /not the restorer/);
  assert.match(failures(resign((record) => { record.subject.grants.restorer.roles = []; return record; })), /lacks role Exchange Administrator/);
  assert.match(failures(resign((record) => { record.subject.writes.push(structuredClone(record.subject.writes[0])); return record; })), /captured twice/);
  assert.match(failures(resign((record) => { record.subject.writes = []; return record; })), /proves nothing/);
  // A write no capture made: another object, another field, or more sends than a capture needs.
  const inbound = (record) => record.subject.writes.find((item) => item.operationId === 'mailflow.inbound-connector.update');
  const send = (record, parameters) => { record.subject.requests.push({ credential: 'restorer', cmdlet: 'Set-InboundConnector', parameters, outcome: 'ok' }); return record; };
  assert.match(failures(resign((record) => send(record, { Identity: '00000000-0000-4000-8000-00000000ffff', Comment: inbound(record).target }))), /no capture accounts for this write/);
  assert.match(failures(resign((record) => send(record, { Identity: inbound(record).identity, Comment: 'something else' }))), /no capture accounts for this write/);
  assert.match(failures(resign((record) => send(record, { Identity: inbound(record).identity, Comment: inbound(record).target }))), /no capture accounts for this write/);
  assert.match(failures(resign((record) => { inbound(record).identity = 'Global'; return record; })), /not the KEEL-RT- fixture recorded/);
  // A field whose effect depends on the rest of the object (Enabled while ScanAndDropRecipients is set) is never a capture's.
  assert.match(failures(resign((record) => { Object.assign(inbound(record), { field: 'Enabled', type: 'switch', before: false, target: true }); return record; })), /Enabled is not a field a capture may write/);
  assert.match(failures(resign((record) => { record.subject.refusals.remove.sent = true; return record; })), /remove probe was not refused/);
  assert.match(failures(resign((record) => { delete record.subject.organization; return record; })), /not shown to be one Exchange organization/);
  assert.match(failures(resign((record) => { record.subject.organization.restorer.name = 'other.onmicrosoft.com'; return record; })), /not shown to be one Exchange organization/);
  assert.match(failures(resign((record) => { record.subject.organization.restorer.tenantId = 'ffffffff-0000-4000-8000-000000000000'; return record; })), /reported another tenant/);
  // A request carrying both a read and a cmdlet is a write.
  assert.match(failures(resign((record) => send(record, { Identity: 'Global', Comment: 'x' }) && Object.assign(record.subject.requests.at(-1), { read: 'exchange-mail-flow', credential: 'collector' }) && record)), /no capture accounts for this write/);
  // Unsigned: never live.
  const { proof: { runner, ...proof }, ...unsigned } = evidence;
  assert.equal(ledgerEvidenceFromWorkloadWritesAcceptance({ ...unsigned, proof }, { tenantRef, build, hmacKey: KEY, evidenceDir: dir }).ok, false);
  assert.ok(runner);
});

test('a write that is not put back is not proof and is reported for a manual fix; the others still count', async () => {
  let failRevert = true;
  const live = fakeTenant('exchange-mail-flow', {
    hooks: {
      cmdlet({ cmdlet, parameters }) {
        // The second Set-InboundConnector (the put-back) fails.
        if (cmdlet === 'Set-InboundConnector' && !String(parameters.Comment).startsWith('KEEL capture') && failRevert) {
          failRevert = false;
          return { error: { message: 'transient failure', category: 'NotSpecified', errorId: 'ServerError' } };
        }
        return null;
      },
    },
  });
  const { evidence, dir, needsManualRevert } = await signedCapture('exchange-mail-flow', live);
  assert.deepEqual(needsManualRevert.map((item) => item.operationId), ['mailflow.inbound-connector.update']);
  assert.match(needsManualRevert[0].error, /PUTTING THE SETTING BACK FAILED/);
  assert.deepEqual(verifyEvidence(evidence, verifyOptions(dir)).failures, []);
  const seam = ledgerEvidenceFromWorkloadWritesAcceptance(evidence, { tenantRef, build, hmacKey: KEY, evidenceDir: dir });
  assert.deepEqual(seam.writes.map((item) => item.operationId).sort(), ['mailflow.anti-malware-policy.update', 'mailflow.outbound-connector.update', 'mailflow.transport-rule.update']);
});

test('the setting is put back even when its read-back fails', async () => {
  let crashes = 0;
  let written = false;
  const live = fakeTenant('exchange-mail-flow', {
    hooks: {
      cmdlet({ cmdlet, parameters }) {
        if (cmdlet === 'Set-InboundConnector' && String(parameters.Comment).startsWith('KEEL capture')) written = true;
        if (cmdlet === 'Get-InboundConnector' && written && crashes < 2) { crashes += 1; return 'crash'; }
        return null;
      },
    },
  });
  const before = structuredClone(live.state['Get-InboundConnector']);
  const { evidence, needsManualRevert } = await signedCapture('exchange-mail-flow', live);
  const inbound = evidence.subject.writes.find((item) => item.operationId === 'mailflow.inbound-connector.update');
  assert.equal(crashes, 2);
  assert.equal(inbound.readBackVerified, false);
  assert.equal(inbound.restoredToOriginal, true);
  assert.equal(live.writes.filter((write) => write.cmdlet === 'Set-InboundConnector').length, 2, 'the write and its put-back');
  assert.deepEqual(live.state['Get-InboundConnector'], before);
  assert.deepEqual(needsManualRevert, []);
});

test('nothing is written when the two Exchange sessions are not one organization', async () => {
  const collector = fakeTenant('exchange-extended');
  const restorer = fakeTenant('exchange-extended', { organization: 'other.onmicrosoft.com' });
  const result = await capture('exchange-extended', collector, { restorer: restorer.powershell });
  assert.deepEqual([collector.writes, restorer.writes], [[], []]);
  assert.equal(result.record.subject.writes.length, 0);
  assert.match(result.record.subject.skipped[0].reason, /not the organization the tenant configs name.*nothing was written/);

  // Both sessions agree, but on another organization than the configs name.
  const elsewhere = fakeTenant('exchange-extended', { organization: 'other.onmicrosoft.com' });
  const moved = await capture('exchange-extended', elsewhere);
  assert.deepEqual(elsewhere.writes, []);
  assert.match(moved.record.subject.skipped[0].reason, /not the organization the tenant configs name/);

  // A session that reports another tenant id is refused; one that reports none is bound by the config.
  const foreign = fakeTenant('exchange-extended', { organizationTenant: '00000000-0000-4000-8000-0000000000ff' });
  assert.match((await capture('exchange-extended', foreign)).record.subject.skipped[0].reason, /belongs to another tenant/);
  assert.deepEqual(foreign.writes, []);
  const silent = fakeTenant('exchange-extended', { organizationTenant: '' });
  const { evidence, dir } = await signedCapture('exchange-extended', silent);
  assert.equal(evidence.subject.organization.tenantIdSource, 'config');
  assert.ok(silent.writes.length > 0);
  assert.deepEqual(verifyEvidence(evidence, verifyOptions(dir)).failures, []);
  const configs = { collector: { tenantId: TENANT, organization: ORG }, restorer: { tenantId: TENANT, organization: 'other.onmicrosoft.com' } };
  await assert.rejects(capture('exchange-extended', collector, { configs }), /same Exchange organization; nothing was sent/);
});

test('a writer record captured at another module version than the read proof it is imported with is refused', async () => {
  const { dir } = await signedCapture('exchange-mail-flow');
  const client = { query: async () => ({ rows: [] }) };
  const read = { file: 'exchange-read.json', seam: () => ({ ok: true, reads: [], writes: [], grants: null, restorerGrants: null, runtime: { modules: { ExchangeOnlineManagement: '3.10.1' } } }) };
  const writer = (await importSeams()).find((entry) => entry.file === workloadWritesRecordFile('exchange-mail-flow'));
  const readFile = (path) => (path.endsWith('exchange-read.json') ? '{}' : readFileSync(path, 'utf8'));
  const result = await importLedgerInputs(client, { tenantRef, dir, seams: [read, writer], verify: { hmacKey: KEY }, readFile });
  assert.deepEqual(result.imported.map((item) => item.file), ['exchange-read.json']);
  assert.match(result.refused[0].failures[0], /ExchangeOnlineManagement 3\.5\.0, but the read proof in this import is at 3\.10\.1/);
  assert.equal(result.exitCode, 1);
});

test('a tenant-wide setting is written only when allowed and when it is the one object, then put back', async (t) => {
  for (const workload of ['teams-org-policies', 'exchange-extended']) {
    const { families } = WORKLOADS[workload];
    const wide = Object.entries(writeFamilies(workload)).filter(([, ops]) => TENANT_WIDE_WRITES.includes(ops.update));
    assert.ok(wide.length > 0, workload);
    const state = tenantState(workload);
    for (const [family] of wide) {
      const key = getKey(families[family]);
      state[key] = state[key].filter((body) => !isFixture(body));
      for (const body of state[key]) {
        // Settings hold switches: give each non-text field a true/false value.
        for (const field of families[family].fields) if (!TEXT.has(field) && field !== 'Identity' && field !== 'Name') body[field] = false;
        if (WORKLOADS[workload].keyed === 'guid') body.IsDefault = true;
        // The global quarantine settings read as DefaultGlobalPolicy and are set as DefaultGlobalTag, as live.
        if (family === 'globalQuarantineSettings') body.Name = 'DefaultGlobalPolicy';
      }
    }
    const wideOps = wide.map(([, ops]) => ops.update);

    // Without the option: skipped, nothing tenant-wide is written.
    const off = await signedCapture(workload, fakeTenant(workload, { state: structuredClone(state) }));
    for (const id of wideOps) assert.match(off.evidence.subject.skipped.find((item) => item.operationId === id)?.reason ?? '', /no KEEL-RT- object/, id);

    // With it: written, read back and put back on the one object.
    const live = fakeTenant(workload, { state: structuredClone(state) });
    const before = structuredClone(live.state);
    const onTest = { testTenantRefs: [tenantRef] };
    const { evidence, dir, needsManualRevert } = await signedCapture(workload, live, { allowTenantWide: true, ...onTest });
    assert.deepEqual(verifyEvidence(evidence, verifyOptions(dir, onTest)).failures, []);
    assert.deepEqual(needsManualRevert, []);
    assert.equal(evidence.subject.tenantWide, true);
    const wideCaptures = evidence.subject.writes.filter((item) => item.scope === 'tenant-wide');
    assert.ok(wideCaptures.length > 0, `${workload}: no tenant-wide capture`);
    assert.ok(wideCaptures.every((item) => wideOps.includes(item.operationId) && item.restoredToOriginal && item.readBackVerified), workload);
    for (const [key, list] of Object.entries(before)) {
      assert.deepEqual(live.state[key].filter((body) => !String(body.Identity ?? '').toUpperCase().startsWith(`TAG:${CAPTURE_CREATE_PREFIX.toUpperCase()}`)), list, key);
    }
    t.diagnostic(`${workload}: ${wideCaptures.map((item) => `${item.operationId} (${item.field})`).join(', ')}; skipped ${evidence.subject.skipped.filter((item) => wideOps.includes(item.operationId)).map((item) => `${item.operationId}: ${item.reason}`).join('; ')}`);

    // The global quarantine settings are sent DefaultGlobalTag, never their Guid or read Name (#339).
    for (const write of live.writes.filter((item) => item.cmdlet === 'Set-QuarantinePolicy')) assert.equal(write.parameters.Identity, 'DefaultGlobalTag');

    // A switch that turns a tenant-wide protection off is never flipped.
    assert.ok(wideCaptures.every((item) => !TENANT_WIDE_UNSAFE_SWITCHES.includes(item.field)), workload);

    // The gate refuses a tenant-wide write in a record that did not allow them, and one on another operation.
    const failures = (change, options = onTest) => verifyEvidence(signEvidence(change(structuredClone(evidence)), KEY), verifyOptions(dir, options)).failures.join(' | ');
    // Only on the test tenant: elsewhere the tool sends nothing and the gate refuses the record.
    assert.match(failures((record) => record, { testTenantRefs: [] }), /test tenant only/);
    const elsewhere = fakeTenant(workload, { state: structuredClone(state) });
    await assert.rejects(capture(workload, elsewhere, { allowTenantWide: true, testTenantRefs: [] }), /test tenant only; nothing was sent/);
    assert.deepEqual(elsewhere.writes, []);
    assert.match(failures((record) => { record.subject.tenantWide = false; return record; }), /did not allow them/);
    const fixtureCapture = evidence.subject.writes.find((item) => item.scope === 'fixture' && item.kind === 'update');
    if (fixtureCapture) {
      assert.match(failures((record) => { record.subject.writes.find((item) => item.operationId === fixtureCapture.operationId).scope = 'tenant-wide'; return record; }), /not a tenant-wide setting a capture may write/);
    }

    // Two objects of the kind (the Teams readers keep one configuration): not the one tenant-wide object, so skipped.
    if (WORKLOADS[workload].keyed !== 'guid') continue;
    const twice = structuredClone(state);
    const [family] = wide[0];
    const key = getKey(families[family]);
    twice[key].push({ ...structuredClone(twice[key][0]), Guid: guid(), Identity: WORKLOADS[workload].keyed === 'guid' ? 'x' : 'Tag:Other' });
    const doubled = fakeTenant(workload, { state: twice });
    const result = await signedCapture(workload, doubled, { allowTenantWide: true, ...onTest });
    assert.match(result.evidence.subject.skipped.find((item) => item.operationId === wide[0][1].update)?.reason, /returned 2 objects/);
  }
});

test('a locked retention policy and its rules are never written; a family with no fixture is skipped', async () => {
  const state = tenantState('purview-retention-dlp');
  const policies = state['Get-RetentionCompliancePolicy'];
  policies.find((body) => body.Name.startsWith('KEEL-RT-')).RestrictiveRetention = true;
  // No KEEL-RT- DLP policy (only the DLP rule under the real one stays a candidate by name).
  state['Get-DlpCompliancePolicy'] = state['Get-DlpCompliancePolicy'].filter((body) => !body.Name.startsWith('KEEL-RT-'));
  state['Get-DlpComplianceRule'] = state['Get-DlpComplianceRule'].filter((body) => !body.Name.startsWith('KEEL-RT-'));
  const live = fakeTenant('purview-retention-dlp', { state });
  const { evidence } = await signedCapture('purview-retention-dlp', live);
  const reasons = Object.fromEntries(evidence.subject.skipped.map((item) => [item.operationId, item.reason]));
  assert.match(reasons['purview.retention-policy.update'], /preservation lock/);
  assert.match(reasons['purview.retention-rule.update'], /its policy reports a preservation lock/);
  assert.match(reasons['purview.dlp-policy.update'], /no KEEL-RT- object/);
  assert.match(reasons['purview.dlp-rule.update'], /no KEEL-RT- object/);
  assert.deepEqual(live.writes, []);
});

test('a policy with no text field changes a switch only when the classifier finds no content effect', () => {
  const write = WKLD_WRITE_OPERATIONS['exchange-extended.mobile-device-policy.update'];
  const observed = (fields) => ({ fields, fieldCoverage: Object.fromEntries(Object.keys(fields).map((field) => [field, { status: 'observed' }])) });
  const change = chooseCaptureChange(write, observed({ AllowNonProvisionableDevices: 'x', PasswordEnabled: true }), { marker: 'KEEL capture' });
  assert.deepEqual(change, { field: 'PasswordEnabled', type: 'switch', before: true, after: false });
  // A rule never gets a switch: rules act on real mail.
  const rule = WKLD_WRITE_OPERATIONS['exchange-extended.device-access-rule.update'];
  assert.ok(chooseCaptureChange(rule, observed({ AccessLevel: 'Allow' }), { marker: 'KEEL capture' }).reason);
  // A transport rule's Comments is the only field it may take.
  const transport = WKLD_WRITE_OPERATIONS['mailflow.transport-rule.update'];
  assert.equal(chooseCaptureChange(transport, observed({ Mode: 'Enforce', Comments: null, StopRuleProcessing: false }), { marker: 'KEEL capture' }).field, 'Comments');
});

test('nothing is sent when a config names another tenant, the first read fails, or the capture is not confirmed', async () => {
  const live = fakeTenant('teams-org-policies');
  await assert.rejects(capture('teams-org-policies', live, { configs: { collector: { tenantId: TENANT }, restorer: { tenantId: '00000000-0000-4000-8000-0000000000ff' } } }), /restorer config does not name the managed tenant/);
  assert.deepEqual(live.writes, []);

  const broken = fakeTenant('teams-org-policies', { hooks: { cmdlet: ({ cmdlet }) => (cmdlet.startsWith('Get-') ? 'crash' : null) } });
  const { evidence, dir } = await signedCapture('teams-org-policies', broken);
  assert.deepEqual(broken.writes, []);
  assert.ok(evidence.subject.skipped.length > 0 && evidence.subject.writes.length === 0);
  assert.match(verifyEvidence(evidence, verifyOptions(dir)).failures.join(' '), /proves nothing/);

  const out = [];
  assert.equal(await main(['capture', '--workload', 'teams-org-policies'], { out: (line) => out.push(line), capture: () => assert.fail('sent') }), 2);
  assert.match(out.at(-1), /--confirm-live-tenant-write/);
  const files = { '/etc/keel/c.json': JSON.stringify({ tenantId: TENANT }), '/etc/keel/r.json': JSON.stringify({ tenantId: TENANT }), 'g.json': JSON.stringify(GRANTS) };
  const args = (extra) => ['capture', '--confirm-live-tenant-write', '--workload', 'teams-org-policies', '--tenant-ref', tenantRef, '--directory-tenant-id', TENANT,
    '--collector-ref', 'app:c', '--restorer-ref', 'app:r', '--collector-config', '/etc/keel/c.json', '--restorer-config', '/etc/keel/r.json',
    '--module-version', '6.0.0', '--grants', 'g.json', '--build', build, ...extra];
  const deps = { out: () => {}, readFile: (path) => files[path], capture: () => assert.fail('sent') };
  await assert.rejects(main(args(['--out', join(tempDir(), 'teams.json')]), deps), /--out must be named workload-writers-teams-org-policies-live-acceptance.json/);
  await assert.rejects(main(args(['--out', join(tempDir(), workloadWritesRecordFile('teams-org-policies')), '--tenant-ref', 'sha256:other']), deps), /--tenant-ref is not the tenant/);
});

test('a capture records the workload\'s own module version, the one the image pins', async () => {
  const pins = pinnedModuleVersions(readFileSync(new URL('../../ops/powershell/Dockerfile', import.meta.url), 'utf8'));
  assert.ok(pins.MicrosoftTeams && pins.ExchangeOnlineManagement && pins.MicrosoftTeams !== pins.ExchangeOnlineManagement);
  const files = { '/etc/keel/c.json': JSON.stringify({ tenantId: TENANT }), '/etc/keel/r.json': JSON.stringify({ tenantId: TENANT }), 'g.json': JSON.stringify(GRANTS) };
  const args = (workload, extra = []) => ['capture', '--confirm-live-tenant-write', '--workload', workload, '--tenant-ref', tenantRef, '--directory-tenant-id', TENANT,
    '--collector-ref', 'app:c', '--restorer-ref', 'app:r', '--collector-config', '/etc/keel/c.json', '--restorer-config', '/etc/keel/r.json',
    '--grants', 'g.json', '--build', build, '--out', join(tempDir(), workloadWritesRecordFile(workload)), ...extra];
  const sent = [];
  const deps = { out: () => {}, readFile: (path) => files[path], capture: (options) => { sent.push(options.moduleVersion); throw new Error('stop'); } };
  for (const [workload, module] of [['teams-org-policies', 'MicrosoftTeams'], ['teams-voice-policies', 'MicrosoftTeams'], ['exchange-extended', 'ExchangeOnlineManagement']]) {
    await assert.rejects(main(args(workload), deps), /stop/);
    assert.equal(sent.at(-1), pins[module], workload);
    await assert.rejects(main(args(workload, ['--module-version', pins[module]]), deps), /stop/);
    assert.equal(sent.at(-1), pins[module], workload);
  }
  // The Exchange module's version on a Teams capture (the 2026-10-15 records) is refused before anything is sent.
  const count = sent.length;
  await assert.rejects(main(args('teams-org-policies', ['--module-version', pins.ExchangeOnlineManagement]), deps), /is not the MicrosoftTeams version the image pins/);
  await assert.rejects(main(args('teams-org-policies'), { ...deps, pins: () => ({}) }), /pins no MicrosoftTeams version/);
  assert.equal(sent.length, count);
});

test('the offline plan names every written family and sends nothing', () => {
  for (const workload of Object.keys(WRITTEN_WORKLOADS)) {
    const plan = workloadWritesCapturePlan({ workload });
    const operations = new Set(plan.map((step) => step.operationId).filter(Boolean));
    assert.deepEqual([...operations].sort(), [...WRITTEN_WORKLOADS[workload].operations].sort(), workload);
    assert.ok(plan.filter((step) => step.cmdlet).every((step) => step.credential === 'restorer' && /^(Set|New)-/.test(step.cmdlet)));
  }
  assert.ok(workloadWritesCapturePlan({ workload: 'teams-org-policies', includeCreates: false }).every((step) => !String(step.operationId).endsWith('.add')));
  assert.throws(() => workloadWritesCapturePlan({ workload: 'entra' }), /--workload must be one of/);
});
