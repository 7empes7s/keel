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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { DSC_WRITES_RECORD_FILE } from '../../tools/qualification/dscDistributionGroupsAcceptance.mjs';
import { ROLE_WRITES_RECORD_FILE } from '../../tools/qualification/exchangeRoleDefinitionsAcceptance.mjs';
import { importLedgerInputs, importSeams } from '../../cli/keel-workload-collect.mjs';
import { signEvidence, verifyEvidence } from '../../tools/release/qualification.mjs';
import { SITE_GRANTS_RECORD_FILE } from '../../tools/qualification/sharepointSiteGrantsAcceptance.mjs';
import { SITE_PERMISSIONS_RECORD_FILE } from '../../tools/qualification/sharepointSitePermissionsAcceptance.mjs';
import { STRUCTURE_WRITES_RECORD_FILE } from '../../tools/qualification/sharepointStructureWritesAcceptance.mjs';
import { READ_FAMILIES, workloadReadsRecordFile } from '../../tools/qualification/workloadReadsAcceptance.mjs';
import {
  CAPTURE_CREATE_PREFIX, PUT_BACK_RETRIES, TENANT_WIDE_UNSAFE_SWITCHES, TENANT_WIDE_WRITES, WORKLOAD_WRITES_LIVE_GATE, WRITTEN_WORKLOADS, chooseCaptureChange, narrowerValue, workloadWritesRecordFile,
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
import { ONEDRIVE_FIELDS, oneDriveEnumName } from '../collect/workloads/onedrive.mjs';
import { WORKLOAD_EFFECT_RULES, writeFamilies } from '../restore/workloads/cmdletSettings.mjs';
import { WKLD_WRITE_OPERATIONS } from '../restore/workloads/writeDeclarations.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { containerAllowlist, fakeCmdletContainer } from '../test/fakeCmdletContainer.mjs';

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

// OneDrive has its own recipe (a narrowing on one named site), tested below.
for (const workload of Object.keys(WORKLOADS)) {
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

test('the verify command exits 1 whenever it reports not ok, and names a missing --tenant or --build', async () => {
  const { dir } = await signedCapture('purview-retention-dlp');
  const out = join(dir, workloadWritesRecordFile('purview-retention-dlp'));
  const env = { ...process.env, KEEL_QUALIFICATION_HMAC_KEY: KEY };
  delete env.KEEL_QUALIFICATION_TENANT_REF;
  delete env.KEEL_QUALIFICATION_BUILD;
  const QUALIFICATION_CLI = fileURLToPath(new URL('../../tools/release/qualification.mjs', import.meta.url));
  const verify = (...extra) => spawnSync(process.execPath, [QUALIFICATION_CLI,
    'verify', '--require-live', '--gate', WORKLOAD_WRITES_LIVE_GATE, '--evidence', out, ...extra], { encoding: 'utf8', env });

  // The queue's command form: no --tenant, so the record has no expected tenant to match.
  const noTenant = verify('--build', build);
  const report = JSON.parse(noTenant.stdout);
  assert.equal(report.ok, false);
  assert.equal(noTenant.status, 1);
  assert.ok(report.failures.includes('writer capture expected tenant/build identity required'));
  assert.ok(report.failures.includes('no expected tenant: pass --tenant <tenant ref> (or set KEEL_QUALIFICATION_TENANT_REF)'));
  assert.match(noTenant.stderr, /verify: NOT OK \(\d+ failures?\), exit 1/);

  // The tenant from the environment counts the same as --tenant.
  const fromEnv = spawnSync(process.execPath, [QUALIFICATION_CLI, 'verify', '--require-live', '--gate', WORKLOAD_WRITES_LIVE_GATE,
    '--evidence', out, '--build', build], { encoding: 'utf8', env: { ...env, KEEL_QUALIFICATION_TENANT_REF: tenantRef } });
  assert.equal(fromEnv.status, 0, fromEnv.stdout);

  // Outside a git checkout with no --build, there is no build to check: exit 1, and it says so.
  const outsideGit = spawnSync(process.execPath, [QUALIFICATION_CLI, 'verify', '--require-live', '--gate', WORKLOAD_WRITES_LIVE_GATE,
    '--evidence', out, '--tenant', tenantRef], { encoding: 'utf8', env, cwd: dir });
  assert.equal(outsideGit.status, 1);
  assert.ok(JSON.parse(outsideGit.stdout).failures.includes('no expected build: pass --build <commit> (or set KEEL_QUALIFICATION_BUILD)'));

  // Another build than the record's is a mismatch, still exit 1.
  const otherBuild = verify('--tenant', tenantRef, '--build', 'another-build');
  assert.equal(otherBuild.status, 1);
  assert.equal(JSON.parse(otherBuild.stdout).ok, false);

  // With both given, the record verifies and the command exits 0 with nothing on stderr.
  const ok = verify('--tenant', tenantRef, '--build', build);
  assert.deepEqual(JSON.parse(ok.stdout), { ok: true, failures: [] });
  assert.equal(ok.status, 0);
  assert.equal(ok.stderr, '');
});

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
    DSC_WRITES_RECORD_FILE, ROLE_WRITES_RECORD_FILE, ...Object.keys(READ_FAMILIES).map(workloadReadsRecordFile),
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
  // A put-back resent after a refusal is accounted for (Q260); a second one answered ok, or too many, is not.
  assert.doesNotMatch(failures(resign((record) => send(record, { Identity: inbound(record).identity, Comment: inbound(record).before }) && Object.assign(record.subject.requests.at(-1), { outcome: 'failed' }) && record)), /no capture accounts/);
  assert.match(failures(resign((record) => send(record, { Identity: inbound(record).identity, Comment: inbound(record).before }))), /no capture accounts for this write/);
  assert.match(failures(resign((record) => {
    for (let i = 0; i <= PUT_BACK_RETRIES; i += 1) send(record, { Identity: inbound(record).identity, Comment: inbound(record).before }).subject.requests.at(-1).outcome = 'failed';
    return record;
  })), /no capture accounts for this write/);
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

// Q260, live: Set-RetentionCompliancePolicy on a policy whose deployment times out saves the
// value and then throws PolicyDeploymentException; while the change deploys, the next Set is
// refused with PolicyLockConflictException.
const DEPLOY_FAILED = { message: "|Microsoft.Exchange.Management.UnifiedPolicy.PolicyDeploymentException|Policy 'x' failed to be deployed. To fix this issue, please retry the policy operation after some time.", category: 'ConnectionError', errorId: '[],Write-ErrorMessage' };
const STILL_DEPLOYING = { message: "|Microsoft.Exchange.Management.UnifiedPolicy.PolicyLockConflictException|Previous changes to the policy 'x' are being deployed. Once deployed, additional actions can be performed.", category: 'InvalidOperation', errorId: '[],Write-ErrorMessage' };

function deployingRetentionPolicy({ lockedPutBacks }) {
  let locked = lockedPutBacks;
  return {
    cmdlet({ cmdlet, parameters, state }) {
      if (cmdlet !== 'Set-RetentionCompliancePolicy') return null;
      const target = state['Get-RetentionCompliancePolicy'].find((body) => body.Guid === parameters.Identity);
      if (!String(parameters.Comment).startsWith('KEEL capture') && locked > 0) { locked -= 1; return { error: STILL_DEPLOYING }; }
      target.Comment = parameters.Comment;
      return { error: DEPLOY_FAILED };
    },
  };
}

test('a retention policy that saves but fails to deploy is read back, and its put-back waits while it deploys', async () => {
  const live = fakeTenant('purview-retention-dlp', { hooks: deployingRetentionPolicy({ lockedPutBacks: 2 }) });
  const before = structuredClone(live.state['Get-RetentionCompliancePolicy']);
  const waits = [];
  const { evidence, dir, needsManualRevert } = await signedCapture('purview-retention-dlp', live, {
    sleep: async (ms) => { waits.push(ms); }, deployWaitAttempts: 3, deployWaitDelayMs: 1000,
  });
  const policy = evidence.subject.writes.find((item) => item.operationId === 'purview.retention-policy.update');
  assert.equal(policy.error, null);
  assert.equal(policy.ok, true);
  assert.equal(policy.readBackVerified, true);
  assert.equal(policy.restoredToOriginal, true);
  assert.deepEqual(waits.filter((ms) => ms === 1000), [1000, 1000], 'two waits for the two refused put-backs');
  assert.deepEqual(needsManualRevert, []);
  assert.deepEqual(live.state['Get-RetentionCompliancePolicy'], before);
  // The cmdlet's errors stay in the capture log.
  const sent = evidence.subject.requests.filter((item) => item.cmdlet === 'Set-RetentionCompliancePolicy').map((item) => item.outcome);
  assert.deepEqual(sent, ['failed', 'failed', 'failed', 'failed']);
  assert.deepEqual(verifyEvidence(evidence, verifyOptions(dir)).failures, []);
  const seam = ledgerEvidenceFromWorkloadWritesAcceptance(evidence, { tenantRef, build, hmacKey: KEY, evidenceDir: dir });
  assert.ok(seam.writes.some((item) => item.operationId === 'purview.retention-policy.update'));
});

test('a put-back still refused after the deployment wait is reported for a manual fix', async () => {
  const live = fakeTenant('purview-retention-dlp', { hooks: deployingRetentionPolicy({ lockedPutBacks: 10 }) });
  const { needsManualRevert } = await signedCapture('purview-retention-dlp', live, { deployWaitAttempts: 2, deployWaitDelayMs: 0 });
  assert.deepEqual(needsManualRevert.map((item) => item.operationId), ['purview.retention-policy.update']);
  assert.match(needsManualRevert[0].error, /PUTTING THE SETTING BACK FAILED \(.*being deployed/);
});

test('any other cmdlet error on the write is still a definite failure, and nothing is put back', async () => {
  const live = fakeTenant('purview-retention-dlp', {
    hooks: { cmdlet: ({ cmdlet }) => (cmdlet === 'Set-DlpComplianceRule' ? { error: { message: 'A server side error has occurred', category: 'NotSpecified', errorId: 'WriteErrorException' } } : null) },
  });
  const { evidence } = await signedCapture('purview-retention-dlp', live);
  const rule = evidence.subject.writes.find((item) => item.operationId === 'purview.dlp-rule.update');
  assert.equal(rule.ok, false);
  assert.match(rule.error, /Set-DlpComplianceRule failed/);
  assert.equal(evidence.subject.requests.filter((item) => item.cmdlet === 'Set-DlpComplianceRule').length, 1);
});

test('run-cmdlet.ps1 answers the confirmation prompt of Set-DlpComplianceRule with -Confirm:$false, and the job cannot pass Confirm', () => {
  // Q260: without it the app-only session fails with "A server side error has occurred".
  const list = /\$NoConfirmPrompt = @\(([^)]*)\)/.exec(SCRIPT)[1];
  assert.deepEqual([...list.matchAll(/'([A-Za-z-]+)'/g)].map((match) => match[1]), ['Set-DlpComplianceRule']);
  assert.match(SCRIPT, /if \(\$NoConfirmPrompt -contains \$name\) \{ \$params\['Confirm'\] = \$false \}/);
  assert.ok(SCRIPT.indexOf("$params['Confirm'] = $false") > SCRIPT.indexOf('ParameterNotAllowed'), 'added after the job parameters are checked');
  assert.ok(!moduleAllowlist('ExchangeOnlineManagement')['Set-DlpComplianceRule'].includes('Confirm'));
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
    const plan = workloadWritesCapturePlan({ workload, site: ONEDRIVE_SITE });
    const operations = new Set(plan.map((step) => step.operationId).filter(Boolean));
    assert.deepEqual([...operations].sort(), [...WRITTEN_WORKLOADS[workload].operations].sort(), workload);
    assert.ok(plan.filter((step) => step.cmdlet).every((step) => step.credential === 'restorer' && /^(Set|New)-/.test(step.cmdlet)));
  }
  assert.ok(workloadWritesCapturePlan({ workload: 'teams-org-policies', includeCreates: false }).every((step) => !String(step.operationId).endsWith('.add')));
  assert.throws(() => workloadWritesCapturePlan({ workload: 'entra' }), /--workload must be one of/);
});

// ------------------------------------------------------------ OneDrive

const ONEDRIVE_SITE = 'https://contoso-my.sharepoint.com/personal/keel-rt-alice_contoso_test';
const BOB_SITE = 'https://contoso-my.sharepoint.com/personal/bob_contoso_test';
const ONEDRIVE_GRANTS = { ...GRANTS, restorer: { permissions: ['Sites.FullControl.All'], roles: ['SharePoint Administrator'] } };
const ONEDRIVE_ALLOWLIST = { ...containerAllowlist('AllowedPnP'), ...containerAllowlist('AllowedOneDriveWrites') };
// As run-cmdlet.ps1 sends them: ConvertTo-Json writes PnP's enums as numbers (Edit is 2, Internal is 2).
const oneDriveBody = (url, extra = {}) => ({
  Url: url, Template: 'SPSPERS#10', Owner: 'keel-rt-alice@contoso.test', SharingCapability: 1, SharingDomainRestrictionMode: 0,
  SharingAllowedDomainList: '', SharingBlockedDomainList: '', DefaultSharingLinkType: 2, DefaultLinkPermission: 2,
  OverrideTenantExternalUserExpirationPolicy: false, ExternalUserExpirationInDays: 60, OverrideTenantAnonymousLinkExpirationPolicy: false,
  AnonymousLinkExpirationInDays: 0, StorageQuota: 1048576, StorageQuotaWarningLevel: 943718, LockState: 'Unlock', ...extra,
});

function oneDriveTenant(sites = [oneDriveBody(ONEDRIVE_SITE), oneDriveBody(BOB_SITE)], { hooks = {} } = {}) {
  const state = structuredClone(sites);
  const writes = [];
  const container = fakeCmdletContainer({
    module: 'PnP.PowerShell',
    allowlist: ONEDRIVE_ALLOWLIST,
    answer(cmdlet, parameters) {
      const hook = hooks.cmdlet?.({ cmdlet, parameters, state });
      if (hook?.error || hook === 'crash') return hook;
      const found = state.find((item) => item.Url.toLowerCase() === String(parameters.Identity).toLowerCase());
      if (cmdlet === 'Get-PnPTenantSite') return found ? [found] : { error: { message: `Cannot get site ${parameters.Identity}`, category: 'InvalidOperation', errorId: 'EXCEPTION' } };
      writes.push({ cmdlet, parameters });
      const { Identity, ...values } = parameters;
      if (!found) return { error: { message: `Cannot get site ${Identity}`, category: 'InvalidOperation', errorId: 'EXCEPTION' } };
      Object.assign(found, values);
      return [];
    },
  });
  return { state, writes, powershell: container.powershell };
}

const ON_TEST = { testTenantRefs: [tenantRef] };
const oneDriveCapture = (live, extra = {}) => captureWorkloadWrites({
  workload: 'onedrive-site-settings', collector: live.powershell, restorer: live.powershell, directoryTenantId: TENANT,
  configs: { collector: { tenantId: TENANT }, restorer: { tenantId: TENANT } }, tenantRef, build,
  credentials: { collector: 'app:collector', restorer: 'app:restorer' }, grants: ONEDRIVE_GRANTS, moduleVersion: '3.4.1',
  sleep: async () => {}, readBackAttempts: 2, readBackDelayMs: 0, site: ONEDRIVE_SITE, ...ON_TEST, ...extra,
});
async function signedOneDrive(live = oneDriveTenant(), extra = {}) {
  const result = await oneDriveCapture(live, extra);
  const dir = tempDir();
  const { evidence } = writeWorkloadWritesFiles({ ...result, outPath: join(dir, workloadWritesRecordFile('onedrive-site-settings')), hmacKey: KEY });
  return { ...result, evidence, dir, live };
}

test('onedrive-site-settings: narrows one default link setting on the KEEL-RT- OneDrive, puts it back, and imports as write proof', async () => {
  const live = oneDriveTenant();
  const before = structuredClone(live.state);
  const { evidence, dir, needsManualRevert } = await signedOneDrive(live);

  assert.deepEqual(verifyEvidence(evidence, verifyOptions(dir, ON_TEST)).failures, []);
  assert.deepEqual(needsManualRevert, []);
  // Edit (2) to View (1) on Alice's OneDrive, then Edit back; nothing else, and never Bob's.
  assert.deepEqual(live.writes, [
    { cmdlet: 'Set-PnPTenantSite', parameters: { Identity: ONEDRIVE_SITE, DefaultLinkPermission: 1 } },
    { cmdlet: 'Set-PnPTenantSite', parameters: { Identity: ONEDRIVE_SITE, DefaultLinkPermission: 2 } },
  ]);
  assert.deepEqual(live.state, before);
  const [write] = evidence.subject.writes;
  assert.deepEqual({ field: write.field, type: write.type, before: write.before, target: write.target, final: write.final, contentEffects: write.contentEffects },
    { field: 'DefaultLinkPermission', type: 'narrowing', before: 2, target: 1, final: 2, contentEffects: [] });
  // The record names the site by its pseudonymized address, still a KEEL-RT- person's.
  assert.match(write.fixture, /^https:\/\/t[0-9a-f]+-my\.sharepoint\.com\/personal\/keel-rt-u[0-9a-f]{12}_t[0-9a-f]{11}_example$/);
  assert.equal(write.identity, write.fixture);

  const seam = ledgerEvidenceFromWorkloadWritesAcceptance(evidence, { tenantRef, build, hmacKey: KEY, evidenceDir: dir, ...ON_TEST });
  assert.deepEqual(seam.failures, []);
  assert.deepEqual(seam.writes.map((item) => item.operationId), ['onedrive.site-settings.update']);
  assert.deepEqual(seam.runtime, { modules: { 'PnP.PowerShell': '3.4.1' } });
});

test('onedrive-site-settings: a site already at View falls back to the link type, and one at View and Direct is skipped', async () => {
  const linkType = oneDriveTenant([oneDriveBody(ONEDRIVE_SITE, { DefaultLinkPermission: 'View', DefaultSharingLinkType: 'AnonymousAccess' })]);
  const { evidence, dir } = await signedOneDrive(linkType);
  assert.deepEqual(verifyEvidence(evidence, verifyOptions(dir, ON_TEST)).failures, []);
  assert.deepEqual(linkType.writes.map((item) => item.parameters), [
    { Identity: ONEDRIVE_SITE, DefaultSharingLinkType: 'Direct' }, { Identity: ONEDRIVE_SITE, DefaultSharingLinkType: 'AnonymousAccess' },
  ]);

  const narrowest = oneDriveTenant([oneDriveBody(ONEDRIVE_SITE, { DefaultLinkPermission: 1, DefaultSharingLinkType: 1 })]);
  const skipped = await oneDriveCapture(narrowest);
  assert.deepEqual(narrowest.writes, []);
  assert.match(skipped.record.subject.skipped[0].reason, /nothing on it can be narrowed: DefaultLinkPermission must be Edit/);
  // A site following the tenant default (None) is not narrowed either: None to View could widen.
  const inherited = oneDriveTenant([oneDriveBody(ONEDRIVE_SITE, { DefaultLinkPermission: 0, DefaultSharingLinkType: 0 })]);
  await oneDriveCapture(inherited);
  assert.deepEqual(inherited.writes, []);
});

test('onedrive-site-settings: only a KEEL-RT- person\'s OneDrive on the test tenant, and never a locked one', async () => {
  const live = oneDriveTenant();
  await assert.rejects(oneDriveCapture(live, { site: BOB_SITE }), /--site must be a KEEL-RT- person's OneDrive/);
  await assert.rejects(oneDriveCapture(live, { site: 'https://contoso.sharepoint.com/sites/KEEL-RT-site' }), /--site must be/);
  await assert.rejects(oneDriveCapture(live, { testTenantRefs: [] }), /test tenant only; nothing was sent/);
  assert.deepEqual(live.writes, []);

  const locked = oneDriveTenant([oneDriveBody(ONEDRIVE_SITE, { LockState: 'ReadOnly' })]);
  const result = await oneDriveCapture(locked);
  assert.deepEqual(locked.writes, []);
  assert.match(result.record.subject.skipped[0].reason, /OneDrive is locked/);
  // A lock state that was not read counts as locked.
  const { LockState, ...noLock } = oneDriveBody(ONEDRIVE_SITE);
  const unread = oneDriveTenant([noLock]);
  await oneDriveCapture(unread);
  assert.deepEqual(unread.writes, []);
});

test('onedrive-site-settings: the gate refuses a narrowing off the test tenant, a widening, or another site', async () => {
  const { evidence, dir } = await signedOneDrive();
  const resign = (change) => signEvidence(change(structuredClone(evidence)), KEY);
  const failures = (record, extra = ON_TEST) => verifyEvidence(record, verifyOptions(dir, extra)).failures.join(' | ');

  assert.match(failures(evidence, { testTenantRefs: [] }), /narrowing capture is allowed on the test tenant only/);
  // View to Edit is a widening, not a declared narrowing.
  assert.match(failures(resign((record) => {
    Object.assign(record.subject.writes[0], { before: 1, target: 2 });
    for (const request of record.subject.requests) if (request.cmdlet) request.parameters.DefaultLinkPermission = request.parameters.DefaultLinkPermission === 1 ? 2 : 1;
    return record;
  })), /must write the declared narrower value/);
  assert.match(failures(resign((record) => {
    Object.assign(record.subject.writes[0], { field: 'SharingCapability' });
    return record;
  })), /SharingCapability is not a field a capture may write/);
  assert.match(failures(resign((record) => {
    record.subject.writes[0].fixture = BOB_SITE;
    return record;
  })), /not a KEEL-RT- fixture/);
});

test('OneDrive sharing settings read as numbers are judged as their names', () => {
  const rules = (field) => WORKLOAD_EFFECT_RULES.onedriveSiteSettings.find((item) => item.field === field).when;
  assert.equal(rules('DefaultLinkPermission')(2, 1), false, 'Edit to View narrows');
  assert.equal(rules('DefaultLinkPermission')(1, 2), true, 'View to Edit widens');
  assert.equal(rules('DefaultSharingLinkType')(2, 1), false, 'Internal to Direct narrows');
  assert.equal(rules('DefaultSharingLinkType')(1, 3), true, 'Direct to AnonymousAccess widens');
  assert.equal(rules('SharingCapability')(1, 3), false, 'ExternalUserSharingOnly to ExistingExternalUserSharingOnly narrows');
  assert.equal(rules('SharingCapability')(0, 2), true, 'Disabled to ExternalUserAndGuestSharing widens');
  assert.equal(rules('SharingDomainRestrictionMode')(1, 0), true, 'AllowList to None widens');
  assert.equal(oneDriveEnumName('DefaultLinkPermission', 0), 'None');
  assert.equal(oneDriveEnumName('DefaultLinkPermission', 'edit'), 'Edit');
  assert.equal(oneDriveEnumName('DefaultLinkPermission', 9), null);
  assert.equal(narrowerValue('onedriveSiteSettings', 'DefaultLinkPermission', '2'), '1');
  // 0 is None: the site follows the tenant default, so the value is not its own.
  assert.equal(ONEDRIVE_FIELDS.DefaultLinkPermission.inheritedWhen(0, {}), true);
  assert.equal(ONEDRIVE_FIELDS.DefaultSharingLinkType.inheritedWhen(2, {}), false);
});
