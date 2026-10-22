/**
 * "Make it pass" for the five Defender email checks: a failing setting of one mail
 * protection policy is put right by a one-setting workload restore, through the same
 * dry run, approval and promotion as every restore. Exercises the registry's service
 * fix, the fix candidates Compliance lists, benchmarks/workloadFix.mjs and the full
 * cli/keel-restore.mjs dry run -> approval -> promotion path, against the isolated
 * test database and a fake PowerShell container behind the real job transport (it
 * enforces the run-cmdlet.ps1 allowlists). Every policy is named KEEL-RT-. No tenant
 * is read or written. Mutation checks:
 *
 * - Write without an approved request, or with the requester's own.
 * - Write a setting that sends mail to quarantine without the content-effect approval.
 * - Write anything but the one setting (other live values are kept).
 * - Promote after the policy changed live since the dry run.
 * - Plan a fix for a setting that already passes, or a policy that is gone.
 * - Restore a backup whose mail protection is weaker than the tenant's (an allowed
 *   sender domain added, Safe Links click-through on, a switch off, a softer action).
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { evaluateControl } from '../benchmarks/evaluate.mjs';
import {
  ComplianceFixRefusal, fixFor, isWorkloadFix, listFixCandidates, parseWorkloadFixTarget, workloadFixTarget, workloadSettingNeedsFix,
} from '../benchmarks/fix.mjs';
import { registerControl, registerFixMatcher, registerPredicate } from '../benchmarks/registry.mjs';
import { runComplianceChecks } from '../benchmarks/runChecks.mjs';
import { planWorkloadComplianceFix } from '../benchmarks/workloadFix.mjs';
import { FAMILIES, readMailFlow, recordMailFlowRun } from '../collect/workloads/mailFlow.mjs';
import { approveRequest, requestApproval, SelfApprovalError } from '../govern/approvals.mjs';
import { complianceFindings } from '../govern/baselineCompliance.mjs';
import { getDryRunArtifactById } from '../restore/dryRunArtifact.mjs';
import { planWorkloadSettingsRestore, restoreReadFamilies, WEAKENING_RULES, weakensMailProtection } from '../restore/workloads/cmdletSettings.mjs';
import { WKLD_WRITE_OPERATIONS } from '../restore/workloads/writeDeclarations.mjs';
import { approveContentEffects, contentEffectsDigest } from '../safety/contentEffects.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { containerAllowlist, fakeCmdletContainer } from '../test/fakeCmdletContainer.mjs';
import { JOB_HANDLERS as HANDLERS } from '../../cli/keel-worker.mjs';
import { runRestore } from '../../cli/keel-restore.mjs';

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

const quiet = { log() {}, error() {} };
const MAIL = 'exchange-mail-flow';
const PHISH = 'keel-custom.defender-email.anti-phish-spoof-protection';
const SPAM = 'keel-custom.defender-email.anti-spam-phish-quarantined';
const DOMAINS = 'keel-custom.defender-email.anti-spam-no-allowed-domains';
const MALWARE = 'keel-custom.defender-email.malware-file-filter';
const LINKS = 'keel-custom.defender-email.safe-links-email';

let tenantSeq = 0;
function nextTenant() {
  tenantSeq += 1;
  const tenantId = `0a1b2c3d-0000-4000-8000-${String(tenantSeq).padStart(12, '0')}`;
  return { tenantId, tenantRef: tenantRefFor(tenantId) };
}
let guidSeq = 0;
const guid = () => `00000000-0000-4000-8000-${String(guidSeq += 1).padStart(12, '0')}`;

/** A mail protection policy as Get- answers it: every read field, recommended values, named KEEL-RT-. */
function policy(family, over = {}) {
  const body = Object.fromEntries(FAMILIES[family].fields.map((field) => [field, null]));
  const Guid = guid();
  const recommended = {
    antiPhishPolicy: { IsDefault: false, Enabled: true, EnableSpoofIntelligence: true, HonorDmarcPolicy: true, EnableUnauthenticatedSender: true },
    antiSpamPolicy: { IsDefault: false, PhishSpamAction: 'Quarantine', HighConfidencePhishAction: 'Quarantine', PhishZapEnabled: true, AllowedSenderDomains: [], InlineSafetyTipsEnabled: true },
    antiMalwarePolicy: { IsDefault: false, EnableFileFilter: true, ZapEnabled: true, CustomNotifications: false },
    safeLinksPolicy: { IsBuiltInProtection: false, EnableSafeLinksForEmail: true, ScanUrls: true, AllowClickThrough: false },
  }[family];
  return { ...body, ...recommended, Name: `KEEL-RT-${family}-${Guid.slice(-4)}`, Guid, ...over };
}

const GETS = Object.fromEntries(Object.entries(FAMILIES).map(([family, spec]) => [spec.cmdlet, family]));
const SETS = Object.fromEntries(Object.values(WKLD_WRITE_OPERATIONS).filter((write) => write.workload === MAIL).map((write) => [write.method, write.family]));

/** A fake Exchange tenant holding `policies` ({ family: [bodies] }). Set- applies; a null list reads back empty, as Exchange does. */
function fakeTenant(policies) {
  const state = structuredClone(policies);
  const writes = [];
  const container = fakeCmdletContainer({
    module: 'ExchangeOnlineManagement',
    allowlist: { ...containerAllowlist('AllowedMailFlow'), ...containerAllowlist('AllowedExchangeWrites') },
    answer(cmdlet, parameters) {
      if (GETS[cmdlet]) return state[GETS[cmdlet]] ?? [];
      writes.push({ cmdlet, parameters });
      const { Identity, ...values } = parameters;
      const found = (state[SETS[cmdlet]] ?? []).find((body) => body.Guid === Identity);
      if (!found) return { error: { message: `The operation couldn't be performed because object '${Identity}' couldn't be found.`, category: 'NotSpecified', errorId: 'ManagementObjectNotFoundException' } };
      for (const [field, value] of Object.entries(values)) found[field] = value === null && Array.isArray(found[field]) ? [] : value;
      return [];
    },
  });
  return { state, writes, calls: container.calls, powershell: container.powershell };
}

const readLive = (tenant) => readMailFlow({ powershell: tenant.powershell, families: restoreReadFamilies(MAIL) });

/** Records the service read the checks use, from the fake tenant, and runs the checks. */
async function recordRead(client, tenantRef, tenant, now = new Date()) {
  const result = await readMailFlow({ powershell: tenant.powershell, families: Object.keys(FAMILIES).filter((name) => name !== 'safeAttachmentPolicy') });
  const run = await recordMailFlowRun(client, { tenantRef, result: { ...result, observedFrom: new Date(now.getTime() - 60_000).toISOString(), observedTo: now.toISOString() } });
  await runComplianceChecks(client, { tenantRef, actor: 'test', now: new Date(now.getTime() + 1000) });
  return String(run.id);
}

let principalSeq = 0;
async function principal(client, label, role) {
  const { rows: [person] } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id', [`${label}-${principalSeq += 1}@contoso.example`]);
  await grantRole(client, { principalId: person.id, role, grantedBy: person.id, activeFrom: new Date(Date.now() - 60_000) });
  return person.id;
}

const enabled = () => Object.fromEntries(Object.entries(WKLD_WRITE_OPERATIONS)
  .filter(([, write]) => write.workload === MAIL)
  .map(([id]) => [id, { operationId: id, state: 'live-qualified', enabled: true, reasons: [] }]));

/** The CLI with the fake tenant behind both credentials, and the server's credential files. */
function cli(tenant, tenantId, { qualifications = enabled } = {}) {
  const configs = new Map([
    ['/fixtures/collector.json', JSON.stringify({ tenantId, clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' })],
    ['/fixtures/restorer.json', JSON.stringify({ tenantId, clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' })],
  ]);
  const readFile = (path) => configs.get(path) ?? (() => { throw new Error(`unexpected file read: ${path}`); })();
  const dependencies = {
    workloadConnection: async () => ({ powershell: tenant.powershell }),
    workloadQualifications: async () => qualifications(),
    credentialPaths: () => ({ collectorConfig: '/fixtures/collector.json', targetConfig: '/fixtures/restorer.json' }),
    sleep: async () => {},
  };
  const run = (options) => runRestore({ readFile, dbUrl: database.url, dependencies, logger: quiet, ...options });
  const plan = (controlId, naturalKey, artifactId = crypto.randomUUID()) => run({
    complianceFix: { controlId, naturalKey }, mode: 'dry-run', persistArtifactId: artifactId, requestedBy: 'requester',
    collectorConfig: JSON.parse(configs.get('/fixtures/collector.json')), collectorConfigPath: '/fixtures/collector.json',
  }).then((result) => ({ ...result, artifactId }));
  return { run, plan };
}

async function approve(client, tenantRef, artifactId) {
  const requester = await principal(client, 'restorer', 'restorer');
  const request = await requestApproval(client, { tenantRef, action: 'restore', params: { artifactId }, requestedBy: requester, executor: 'cli' });
  await assert.rejects(approveRequest(client, { tenantRef, id: request.id, decidedBy: requester }), SelfApprovalError);
  await approveRequest(client, { tenantRef, id: request.id, decidedBy: await principal(client, 'approver', 'approver') });
}

// ------------------------------------------------------------------ registry

test('each Defender email check declares a fix: its failing settings, set to what the check expects', () => {
  const settings = (controlId) => ({ ...fixFor(controlId).settings });
  assert.deepEqual(settings(PHISH), { EnableSpoofIntelligence: true, HonorDmarcPolicy: true, EnableUnauthenticatedSender: true });
  assert.deepEqual(settings(SPAM), { PhishSpamAction: 'Quarantine', HighConfidencePhishAction: 'Quarantine', PhishZapEnabled: true });
  assert.deepEqual(settings(DOMAINS), { AllowedSenderDomains: null }, 'a list is emptied by writing null');
  assert.deepEqual(settings(MALWARE), { EnableFileFilter: true, ZapEnabled: true });
  assert.deepEqual(settings(LINKS), { EnableSafeLinksForEmail: true, ScanUrls: true, AllowClickThrough: false });
  for (const controlId of [PHISH, SPAM, DOMAINS, MALWARE, LINKS]) {
    const fix = fixFor(controlId);
    assert.equal(isWorkloadFix(fix), true);
    assert.equal(fix.workload, MAIL);
    const write = Object.values(WKLD_WRITE_OPERATIONS).find((entry) => entry.workload === MAIL && entry.family === fix.family);
    for (const field of Object.keys(fix.settings)) assert.ok(write.fields.includes(field), `${field} is a declared write`);
  }

  registerPredicate('mail-fix-test', () => 'pass');
  registerFixMatcher('mail-fix-test', () => true);
  const base = {
    title: 't', description: 'd', framework: 'keel-custom', edition: '1.0.0', profile: 'default', evaluatorVersion: 1,
    requiredObservations: [{ resourceType: MAIL, maxAgeMs: 1000, parts: ['antiSpamPolicy'] }], predicate: { name: 'mail-fix-test' },
  };
  assert.throws(() => registerControl({ ...base, controlId: 'mail-fix.a', fix: { workload: MAIL, family: 'antiSpamPolicy', settings: { BulkThreshold: 6 }, matcher: 'mail-fix-test' } }), /not one Set-HostedContentFilterPolicy is declared to write/);
  assert.throws(() => registerControl({ ...base, controlId: 'mail-fix.b', fix: { workload: MAIL, family: 'antiPhishPolicy', settings: { HonorDmarcPolicy: true }, matcher: 'mail-fix-test' } }), /a kind of a service read the control reads/);
  assert.throws(() => registerControl({ ...base, controlId: 'mail-fix.c', fix: { workload: MAIL, family: 'antiSpamPolicy', settings: { PhishZapEnabled: { on: true } }, matcher: 'mail-fix-test' } }), /plain value or null/);
  assert.throws(() => registerControl({ ...base, controlId: 'mail-fix.d', fix: { workload: MAIL, family: 'antiSpamPolicy', settings: {}, matcher: 'mail-fix-test' } }), /at least one setting/);
  assert.throws(() => registerControl({ ...base, controlId: 'mail-fix.e', fix: { workload: MAIL, family: 'antiSpamPolicy', settings: { PhishZapEnabled: true }, matcher: 'nope' } }), /not allowlisted/);
});

test('a target names one setting of one policy; only a failing setting of a checked policy needs the fix', () => {
  const key = workloadFixTarget('anti-spam-policy:abc', 'PhishSpamAction');
  assert.deepEqual(parseWorkloadFixTarget(key), { resourceKey: 'anti-spam-policy:abc', setting: 'PhishSpamAction' });
  assert.equal(parseWorkloadFixTarget('anti-spam-policy:abc'), null);
  assert.equal(parseWorkloadFixTarget('#PhishSpamAction'), null);

  const weak = { kind: 'antiSpamPolicy', ...policy('antiSpamPolicy', { PhishSpamAction: 'MoveToJmf' }) };
  assert.equal(workloadSettingNeedsFix(SPAM, weak, 'PhishSpamAction'), true);
  assert.equal(workloadSettingNeedsFix(SPAM, weak, 'PhishZapEnabled'), false, 'a passing setting');
  assert.equal(workloadSettingNeedsFix(SPAM, weak, 'BulkThreshold'), false, 'a setting the fix does not change');
  assert.equal(workloadSettingNeedsFix(SPAM, { ...weak, kind: 'antiPhishPolicy' }, 'PhishSpamAction'), false, 'another kind');
  // The anti-phishing check skips a custom policy that is turned off, so its fix does too.
  const off = { kind: 'antiPhishPolicy', ...policy('antiPhishPolicy', { Enabled: false, HonorDmarcPolicy: false }) };
  assert.equal(workloadSettingNeedsFix(PHISH, off, 'HonorDmarcPolicy'), false);
  assert.equal(workloadSettingNeedsFix(PHISH, { ...off, Enabled: true }, 'HonorDmarcPolicy'), true);
});

// ------------------------------------------------------------- candidates

test('Compliance lists each failing setting of each policy from the newest service read', async (t) => {
  const client = await schemaClient(t);
  const { tenantRef } = nextTenant();
  const weak = policy('antiSpamPolicy', { Name: 'KEEL-RT-Sales', PhishSpamAction: 'MoveToJmf', PhishZapEnabled: false });
  const tenant = fakeTenant({ antiSpamPolicy: [policy('antiSpamPolicy', { Name: 'KEEL-RT-Good' }), weak] });
  const collectionId = await recordRead(client, tenantRef, tenant);

  const candidates = await listFixCandidates(client, { tenantRef, controlId: SPAM });
  assert.deepEqual(candidates.map((c) => [c.name, c.field, c.from, c.to, c.resourceType, c.snapshotId]), [
    ['KEEL-RT-Sales', 'PhishSpamAction', 'MoveToJmf', 'Quarantine', 'exchangeAntiSpamPolicy', collectionId],
    ['KEEL-RT-Sales', 'PhishZapEnabled', false, true, 'exchangeAntiSpamPolicy', collectionId],
  ]);
  assert.equal(candidates[0].naturalKey, workloadFixTarget(`anti-spam-policy:${weak.Guid}`, 'PhishSpamAction'));

  const { findings } = await complianceFindings(client, { tenantRef });
  const finding = findings.find((entry) => entry.controlId === SPAM);
  assert.equal(finding.verdict, 'fail');
  assert.deepEqual(finding.fix, {
    resourceType: 'exchangeAntiSpamPolicy', field: null, to: null,
    settings: { PhishSpamAction: 'Quarantine', HighConfidencePhishAction: 'Quarantine', PhishZapEnabled: true },
  });
  assert.equal(finding.fixCandidates.length, 2);
  assert.deepEqual(findings.find((entry) => entry.controlId === DOMAINS).fixCandidates, [], 'a passing control offers nothing');
});

// ------------------------------------------------------------- planning

test('a fix is planned from the live policy and changes only its one setting', () => {
  const { tenantId, tenantRef } = nextTenant();
  const weak = policy('antiSpamPolicy', { PhishSpamAction: 'MoveToJmf', PhishZapEnabled: false });
  const resourceKey = `anti-spam-policy:${weak.Guid}`;
  const tenant = fakeTenant({ antiSpamPolicy: [weak] });
  return readLive(tenant).then((live) => {
    const plan = planWorkloadComplianceFix({ controlId: SPAM, target: workloadFixTarget(resourceKey, 'PhishSpamAction'), live, sourceCollectionId: '7', tenantId, tenantRef });
    assert.equal(plan.workload, MAIL);
    assert.deepEqual(plan.operations.map((op) => [op.cmdlet, op.parameters]), [
      ['Set-HostedContentFilterPolicy', { Identity: weak.Guid, PhishSpamAction: 'Quarantine' }],
    ], 'PhishZapEnabled also fails, but this fix changes only the setting it names');
    assert.deepEqual(plan.manual, []);
    assert.deepEqual(plan.contentEffects.map((effect) => [effect.field, effect.effect]), [['PhishSpamAction', 'irreversible']]);
    assert.deepEqual({ ...plan.complianceFix }, {
      controlId: SPAM, evaluatorVersion: 1, naturalKey: workloadFixTarget(resourceKey, 'PhishSpamAction'), resourceType: 'exchangeAntiSpamPolicy',
      resourceKey, targetId: weak.Guid, name: weak.Name, field: 'PhishSpamAction', from: 'MoveToJmf', to: 'Quarantine',
    });
    assert.equal(plan.source.collectionId, '7');

    const target = (setting) => workloadFixTarget(resourceKey, setting);
    assert.throws(() => planWorkloadComplianceFix({ controlId: SPAM, target: target('HighConfidencePhishAction'), live, sourceCollectionId: '7', tenantId, tenantRef }), /already passes/);
    assert.throws(() => planWorkloadComplianceFix({ controlId: SPAM, target: target('BulkThreshold'), live, sourceCollectionId: '7', tenantId, tenantRef }), /does not name a setting/);
    assert.throws(() => planWorkloadComplianceFix({ controlId: SPAM, target: workloadFixTarget('anti-spam-policy:gone', 'PhishSpamAction'), live, sourceCollectionId: '7', tenantId, tenantRef }), /not in the tenant now/);
    assert.throws(() => planWorkloadComplianceFix({ controlId: SPAM, target: target('PhishSpamAction'), live: { ...live, failures: [{ family: 'antiSpamPolicy', status: 'denied' }] }, sourceCollectionId: '7', tenantId, tenantRef }), /could not be checked/);
    assert.throws(() => planWorkloadComplianceFix({ controlId: SPAM, target: target('PhishSpamAction'), live, sourceCollectionId: null, tenantId, tenantRef }), /no complete service read/);
    // A null list the check counts as failing, but writing null changes nothing: refused, not a no-op plan.
    const nullDomains = { ...live, resources: live.resources.map((entry) => ({ ...entry, fields: { ...entry.fields, AllowedSenderDomains: null } })) };
    assert.throws(() => planWorkloadComplianceFix({ controlId: DOMAINS, target: target('AllowedSenderDomains'), live: nullDomains, sourceCollectionId: '7', tenantId, tenantRef }), /would not change AllowedSenderDomains/);
    assert.throws(() => planWorkloadComplianceFix({ controlId: 'keel-custom.named-location.no-untrusted-all-countries', target: target('PhishSpamAction'), live, sourceCollectionId: '7', tenantId, tenantRef }), ComplianceFixRefusal);
  });
});

// ------------------------------------------------------- dry run to write

test('make it pass: the dry run writes nothing; the promotion needs another person and the content-effect approval, then writes the one setting', async (t) => {
  const client = await schemaClient(t);
  const { tenantId, tenantRef } = nextTenant();
  const weak = policy('antiSpamPolicy', { PhishSpamAction: 'MoveToJmf', PhishZapEnabled: false, BulkThreshold: 7 });
  const tenant = fakeTenant({ antiSpamPolicy: [weak] });
  await recordRead(client, tenantRef, tenant);
  const [candidate] = await listFixCandidates(client, { tenantRef, controlId: SPAM });
  // Live differs from the read in another setting: the fix keeps the live value.
  tenant.state.antiSpamPolicy[0].BulkThreshold = 5;
  const { run, plan } = cli(tenant, tenantId);

  const dry = await plan(SPAM, candidate.naturalKey);
  assert.equal(tenant.writes.length, 0, 'the dry run sends nothing');
  assert.equal(dry.mode, 'dry-run');
  const artifact = await getDryRunArtifactById(client, { id: dry.artifactId });
  assert.equal(artifact.status, 'completed');
  assert.deepEqual([artifact.complianceFix.field, artifact.complianceFix.from, artifact.complianceFix.to], ['PhishSpamAction', 'MoveToJmf', 'Quarantine']);
  assert.deepEqual(artifact.workloadRestore.operations.map((op) => op.parameters), [{ Identity: weak.Guid, PhishSpamAction: 'Quarantine' }]);

  // Never a direct enforce.
  await assert.rejects(run({ complianceFix: { controlId: SPAM, naturalKey: candidate.naturalKey }, mode: 'enforce' }), /only ever planned as a dry run/);
  // Mutation check: no approval writes nothing.
  await assert.rejects(run({ artifactId: dry.artifactId, mode: 'enforce' }), /needs an approved request/);
  await approve(client, tenantRef, dry.artifactId);
  // Mutation check: quarantining mail is a content effect; without its own approval nothing is sent.
  await assert.rejects(run({ artifactId: dry.artifactId, mode: 'enforce' }), /blocked-content-effect/);
  assert.equal(tenant.writes.length, 0);

  await approveContentEffects(client, {
    tenantRef, artifactId: dry.artifactId, approverId: await principal(client, 'effects', 'approver'),
    effectsDigest: contentEffectsDigest(artifact.workloadRestore.contentEffects), justification: 'KEEL-RT- policy',
  });
  const result = await run({ artifactId: dry.artifactId, mode: 'enforce' });
  assert.equal(result.outcome, 'verified');
  assert.deepEqual(tenant.writes, [{ cmdlet: 'Set-HostedContentFilterPolicy', parameters: { Identity: weak.Guid, PhishSpamAction: 'Quarantine' } }]);
  const after = tenant.state.antiSpamPolicy[0];
  assert.equal(after.PhishSpamAction, 'Quarantine');
  assert.equal(after.BulkThreshold, 5, 'mutation check: every other live value is kept');
  assert.equal(after.PhishZapEnabled, false, 'the other failing setting is its own fix');
});

test('emptying allowed sender domains sends null and reads back as an empty list; Safe Links needs no content-effect approval', async (t) => {
  const client = await schemaClient(t);
  const { tenantId, tenantRef } = nextTenant();
  const domains = policy('antiSpamPolicy', { AllowedSenderDomains: ['fabrikam.example'] });
  const links = policy('safeLinksPolicy', { AllowClickThrough: true });
  const tenant = fakeTenant({ antiSpamPolicy: [domains], safeLinksPolicy: [links] });
  await recordRead(client, tenantRef, tenant);
  const { run, plan } = cli(tenant, tenantId);

  const [domain] = await listFixCandidates(client, { tenantRef, controlId: DOMAINS });
  assert.deepEqual([domain.field, domain.from, domain.to], ['AllowedSenderDomains', ['fabrikam.example'], null]);
  const dry = await plan(DOMAINS, domain.naturalKey);
  await approve(client, tenantRef, dry.artifactId);
  const artifact = await getDryRunArtifactById(client, { id: dry.artifactId });
  assert.deepEqual(artifact.workloadRestore.contentEffects.map((effect) => effect.field), ['AllowedSenderDomains'], 'filtering more mail can quarantine it');
  await approveContentEffects(client, {
    tenantRef, artifactId: dry.artifactId, approverId: await principal(client, 'effects', 'approver'),
    effectsDigest: contentEffectsDigest(artifact.workloadRestore.contentEffects), justification: 'KEEL-RT- policy',
  });
  assert.equal((await run({ artifactId: dry.artifactId, mode: 'enforce' })).outcome, 'verified');
  assert.deepEqual(tenant.writes.at(-1), { cmdlet: 'Set-HostedContentFilterPolicy', parameters: { Identity: domains.Guid, AllowedSenderDomains: null } });
  assert.deepEqual(tenant.state.antiSpamPolicy[0].AllowedSenderDomains, []);

  const [link] = await listFixCandidates(client, { tenantRef, controlId: LINKS });
  const linkRun = await plan(LINKS, link.naturalKey);
  const linkArtifact = await getDryRunArtifactById(client, { id: linkRun.artifactId });
  assert.deepEqual(linkArtifact.workloadRestore.contentEffects, []);
  await approve(client, tenantRef, linkRun.artifactId);
  assert.equal((await run({ artifactId: linkRun.artifactId, mode: 'enforce' })).outcome, 'verified');
  assert.equal(tenant.state.safeLinksPolicy[0].AllowClickThrough, false);

  // After the next read the checks pass.
  await recordRead(client, tenantRef, tenant, new Date(Date.now() + 5000));
  const { findings } = await complianceFindings(client, { tenantRef });
  assert.equal(findings.find((entry) => entry.controlId === DOMAINS).verdict, 'pass');
  assert.equal(findings.find((entry) => entry.controlId === LINKS).verdict, 'pass');
});

test('make it pass is refused when the setting already passes, the policy is gone, or it changed since the dry run', async (t) => {
  const client = await schemaClient(t);
  const { tenantId, tenantRef } = nextTenant();
  const weak = policy('antiMalwarePolicy', { ZapEnabled: false });
  const tenant = fakeTenant({ antiMalwarePolicy: [weak] });
  await recordRead(client, tenantRef, tenant);
  const [candidate] = await listFixCandidates(client, { tenantRef, controlId: MALWARE });
  const { run, plan } = cli(tenant, tenantId);

  // Fixed outside Keel: nothing planned.
  tenant.state.antiMalwarePolicy[0].ZapEnabled = true;
  await assert.rejects(plan(MALWARE, candidate.naturalKey), /compliance fix refused: .* already passes/);
  // Gone live.
  tenant.state.antiMalwarePolicy = [];
  await assert.rejects(plan(MALWARE, candidate.naturalKey), /compliance fix refused: .* not in the tenant now/);

  // Changed live between the dry run and the promotion: stale, nothing written.
  tenant.state.antiMalwarePolicy = [{ ...weak }];
  const dry = await plan(MALWARE, candidate.naturalKey);
  await approve(client, tenantRef, dry.artifactId);
  const artifact = await getDryRunArtifactById(client, { id: dry.artifactId });
  await approveContentEffects(client, {
    tenantRef, artifactId: dry.artifactId, approverId: await principal(client, 'effects', 'approver'),
    effectsDigest: contentEffectsDigest(artifact.workloadRestore.contentEffects), justification: 'KEEL-RT- policy',
  });
  tenant.state.antiMalwarePolicy[0].EnableFileFilter = false;
  await assert.rejects(run({ artifactId: dry.artifactId, mode: 'enforce' }), /changed since the dry run/);
  assert.equal(tenant.writes.length, 0);
});

test('a write stays off until it is live-qualified for the tenant', async (t) => {
  const client = await schemaClient(t);
  const { tenantId, tenantRef } = nextTenant();
  const weak = policy('antiPhishPolicy', { EnableUnauthenticatedSender: false });
  const tenant = fakeTenant({ antiPhishPolicy: [weak] });
  await recordRead(client, tenantRef, tenant);
  const [candidate] = await listFixCandidates(client, { tenantRef, controlId: PHISH });
  const off = () => ({ 'mailflow.anti-phish-policy.update': { operationId: 'mailflow.anti-phish-policy.update', state: 'disabled', enabled: false, reasons: ['no proof yet'] } });
  const { run, plan } = cli(tenant, tenantId, { qualifications: off });
  const dry = await plan(PHISH, candidate.naturalKey);
  await approve(client, tenantRef, dry.artifactId);
  await assert.rejects(run({ artifactId: dry.artifactId, mode: 'enforce' }), /disabled/);
  assert.equal(tenant.writes.length, 0);
});

test('the worker passes a service fix target through unchanged', () => {
  const target = workloadFixTarget('anti-spam-policy:00000000-0000-4000-8000-000000000001', 'PhishSpamAction');
  assert.deepEqual(HANDLERS.restore.argsFor({
    complianceFix: { controlId: SPAM, naturalKey: target },
    collectorConfig: '/etc/keel/tenant.json', targetConfig: '/etc/keel/restorer.json', artifactId: 'a-1',
  }, { requested_by: 'p-1' }).slice(0, 4), ['--compliance-fix', SPAM, '--object', target]);
});

test('every Defender email fix is a check the evaluator itself would pass afterwards', () => {
  // The value each fix writes is what the check expects (an emptied list reads back as []).
  for (const controlId of [PHISH, SPAM, DOMAINS, MALWARE, LINKS]) {
    const fix = fixFor(controlId);
    const fixed = policy(fix.family, Object.fromEntries(Object.entries(fix.settings).map(([field, to]) => [field, to === null ? [] : to])));
    const now = new Date();
    const observation = { resourceType: MAIL, window: { startedAt: now.toISOString(), endedAt: now.toISOString() }, completeness: 'complete' };
    const result = evaluateControl({ controlId, tenantRef: 'sha256:pure', now, observations: { [MAIL]: { observation, resources: [{ kind: fix.family, ...fixed }] } } });
    assert.equal(result.verdict, 'pass', controlId);
  }
});

// ------------------------------------------------------- weakening guard

const MAIL_PROTECTION_TYPES = ['exchangeAntiPhishPolicy', 'exchangeAntiSpamPolicy', 'exchangeAntiMalwarePolicy', 'exchangeSafeLinksPolicy'];

test('every written mail protection setting has a weakening rule, except the notification switch', () => {
  for (const write of Object.values(WKLD_WRITE_OPERATIONS).filter((item) => MAIL_PROTECTION_TYPES.includes(item.resourceType))) {
    for (const field of write.fields) {
      if (write.resourceType === 'exchangeAntiMalwarePolicy' && field === 'CustomNotifications') continue;
      assert.equal(typeof WEAKENING_RULES[write.resourceType]?.[field], 'function', `${write.resourceType}.${field} has no weakening rule`);
    }
  }
  const weakens = (type, field, before, after) => weakensMailProtection(type, field, before, after);
  assert.equal(weakens('exchangeAntiSpamPolicy', 'AllowedSenderDomains', [], ['evil.example']), true);
  assert.equal(weakens('exchangeAntiSpamPolicy', 'AllowedSenderDomains', null, ['evil.example']), true);
  assert.equal(weakens('exchangeAntiSpamPolicy', 'AllowedSenderDomains', ['a.example', 'b.example'], ['a.example']), false);
  assert.equal(weakens('exchangeAntiSpamPolicy', 'AllowedSenderDomains', ['a.example'], ['b.example']), true, 'swapping a domain still adds one');
  assert.equal(weakens('exchangeSafeLinksPolicy', 'AllowClickThrough', false, true), true);
  assert.equal(weakens('exchangeSafeLinksPolicy', 'AllowClickThrough', true, false), false);
  assert.equal(weakens('exchangeSafeLinksPolicy', 'ScanUrls', true, false), true);
  assert.equal(weakens('exchangeSafeLinksPolicy', 'ScanUrls', false, true), false);
  assert.equal(weakens('exchangeAntiSpamPolicy', 'PhishSpamAction', 'Quarantine', 'MoveToJmf'), true);
  assert.equal(weakens('exchangeAntiSpamPolicy', 'PhishSpamAction', 'Delete', 'Quarantine'), false);
  assert.equal(weakens('exchangeAntiSpamPolicy', 'PhishSpamAction', 'MoveToJmf', 'Quarantine'), false);
  assert.equal(weakens('exchangeAntiSpamPolicy', 'HighConfidencePhishAction', 'MoveToJmf', 'SomethingNew'), true, 'an action KEEL cannot rank is never written');
  assert.equal(weakens('exchangeAntiSpamPolicy', 'HighConfidencePhishAction', 'SomethingNew', 'Quarantine'), true);
  assert.equal(weakens('exchangeAntiPhishPolicy', 'HonorDmarcPolicy', true, false), true);
  assert.equal(weakens('exchangeAntiMalwarePolicy', 'ZapEnabled', true, false), true);
  assert.equal(weakens('exchangeAntiMalwarePolicy', 'CustomNotifications', true, false), false);
  assert.equal(weakens('exchangeTransportRule', 'Mode', 'Enforce', 'Audit'), false, 'other types keep their own rules');
});

/** The source a restore plans from: a backup read of `bodies`. */
const backupOf = (read) => ({ collectionId: '9', outcome: 'complete', observedTo: null, observations: read.resources.map(({ resourceKey, kind, identity, fields, fieldCoverage }) => ({ resourceKey, kind, identity, fields, fieldCoverage })) });

test('a restore never writes a weaker mail protection setting from a backup; it lists it for an administrator', async () => {
  const { tenantId, tenantRef } = nextTenant();
  const spam = policy('antiSpamPolicy');
  const links = policy('safeLinksPolicy');
  const phish = policy('antiPhishPolicy');
  const malware = policy('antiMalwarePolicy');
  const live = await readLive(fakeTenant({ antiSpamPolicy: [spam], safeLinksPolicy: [links], antiPhishPolicy: [phish], antiMalwarePolicy: [malware] }));
  // A tampered or old backup of the same policies, each one weaker.
  const backup = await readLive(fakeTenant({
    antiSpamPolicy: [{ ...spam, AllowedSenderDomains: ['evil.example'], PhishSpamAction: 'MoveToJmf', InlineSafetyTipsEnabled: false }],
    safeLinksPolicy: [{ ...links, AllowClickThrough: true, ScanUrls: false }],
    antiPhishPolicy: [{ ...phish, HonorDmarcPolicy: false }],
    antiMalwarePolicy: [{ ...malware, ZapEnabled: false, CustomNotifications: true }],
  }));
  const plan = planWorkloadSettingsRestore({ workload: MAIL, source: backupOf(backup), live, tenantId, tenantRef });
  assert.deepEqual(plan.operations.map((op) => [op.cmdlet, op.parameters]), [
    ['Set-MalwareFilterPolicy', { Identity: malware.Guid, CustomNotifications: true }],
  ], 'only the change that does not weaken protection is written');
  const weakened = plan.manual.filter((entry) => entry.weakensProtection === true).map((entry) => entry.field).sort();
  assert.deepEqual(weakened, ['AllowClickThrough', 'AllowedSenderDomains', 'HonorDmarcPolicy', 'InlineSafetyTipsEnabled', 'PhishSpamAction', 'ScanUrls', 'ZapEnabled']);
  for (const entry of plan.manual.filter((item) => item.weakensProtection)) assert.match(entry.reason, /weaken mail protection/);

  // The stricter direction (the live tenant weaker than the backup) is written as before.
  const back = planWorkloadSettingsRestore({ workload: MAIL, source: backupOf(live), live: backup, tenantId, tenantRef });
  assert.equal(back.manual.filter((entry) => entry.weakensProtection).length, 0);
  assert.deepEqual(back.operations.map((op) => op.changes.map((change) => change.field).sort()).sort(), [
    ['AllowClickThrough', 'ScanUrls'], ['AllowedSenderDomains', 'InlineSafetyTipsEnabled', 'PhishSpamAction'], ['CustomNotifications', 'ZapEnabled'], ['HonorDmarcPolicy'],
  ].sort());
});
