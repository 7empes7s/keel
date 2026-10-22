/** Defender email controls: anti-phishing, anti-spam, malware and Safe Links, checked
 * against the mail protection policies Keel backs up (the exchange-mail-flow read),
 * each naming the policy and setting that fails. */
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { evaluateControl } from './evaluate.mjs';
import { listControls, registerControl } from './registry.mjs';
import { runComplianceChecks } from './runChecks.mjs';
import { complianceFindings } from '../govern/baselineCompliance.mjs';
import { recordMailFlowRun } from '../collect/workloads/mailFlow.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const HOUR = 3_600_000;
const PHISH = 'keel-custom.defender-email.anti-phish-spoof-protection';
const SPAM = 'keel-custom.defender-email.anti-spam-phish-quarantined';
const DOMAINS = 'keel-custom.defender-email.anti-spam-no-allowed-domains';
const MALWARE = 'keel-custom.defender-email.malware-file-filter';
const LINKS = 'keel-custom.defender-email.safe-links-email';
const MAIL = [PHISH, SPAM, DOMAINS, MALWARE, LINKS];

let ready = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!ready) { await client.query(schemaSql()); ready = true; }
  return client;
}

let sequence = 0;
const tenant = () => { sequence += 1; return `sha256:${createHash('sha256').update(`defender-${sequence}`).digest('hex').slice(0, 16)}`; };

// Policies as the mail flow read stores them, with Microsoft's recommended values.
const phish = (over = {}) => ({ Name: 'Office365 AntiPhish Default', IsDefault: true, Enabled: true, EnableSpoofIntelligence: true, HonorDmarcPolicy: true, EnableUnauthenticatedSender: true, ...over });
const spam = (over = {}) => ({ Name: 'Default', IsDefault: true, PhishSpamAction: 'Quarantine', HighConfidencePhishAction: 'Quarantine', PhishZapEnabled: true, AllowedSenderDomains: [], ...over });
const malware = (over = {}) => ({ Name: 'Default', IsDefault: true, EnableFileFilter: true, ZapEnabled: true, ...over });
const links = (over = {}) => ({ Name: 'Built-In Protection Policy', IsBuiltInProtection: true, EnableSafeLinksForEmail: true, ScanUrls: true, AllowClickThrough: false, ...over });

/** One stored mail flow run: `objects` are [kind, fields]; `families` sets each family's status. */
async function mailRun(client, tenantRef, { at, outcome = 'complete', objects = [], families = {}, unknownFields = {}, discovery = {} }) {
  const resources = objects.map(([kind, fields]) => {
    const identity = randomUUID();
    return { resourceKey: `${kind}:${identity}`, kind, identity, fields, fieldCoverage: {} };
  });
  const run = await recordMailFlowRun(client, {
    tenantRef,
    result: {
      outcome,
      observedFrom: new Date(at.getTime() - 120_000).toISOString(),
      observedTo: at.toISOString(),
      discovery: { families, objects: resources.length, capped: false, unidentified: 0, ...discovery },
      unknownFields,
      resources,
    },
  });
  return String(run.id);
}

const facts = (pairs) => pairs.map(([kind, fields]) => ({ kind, identity: randomUUID(), ...fields }));
function evaluate(controlId, objects, now = new Date()) {
  const observation = { resourceType: 'exchange-mail-flow', window: { startedAt: new Date(now.getTime() - HOUR).toISOString(), endedAt: now.toISOString() }, completeness: 'complete' };
  return evaluateControl({ controlId, tenantRef: 'sha256:pure', now, observations: { 'exchange-mail-flow': { observation, resources: facts(objects) } } });
}

test('the five Defender email controls are registered on the mail protection read', () => {
  const controls = listControls().filter((control) => MAIL.includes(control.controlId));
  assert.equal(controls.length, 5);
  for (const control of controls) {
    assert.equal(control.requiredObservations.length, 1);
    assert.equal(control.requiredObservations[0].resourceType, 'exchange-mail-flow');
    assert.equal(control.requiredObservations[0].parts.length, 1);
    assert.deepEqual(control.frameworkRefs, [], 'original controls cite no licensed benchmark');
  }
});

test('recommended settings pass; each weak setting fails with the policy, setting, value and what it should be', () => {
  assert.equal(evaluate(PHISH, [['antiPhishPolicy', phish()]]).verdict, 'pass');
  assert.equal(evaluate(SPAM, [['antiSpamPolicy', spam()]]).verdict, 'pass');
  assert.equal(evaluate(DOMAINS, [['antiSpamPolicy', spam()]]).verdict, 'pass');
  assert.equal(evaluate(MALWARE, [['antiMalwarePolicy', malware()]]).verdict, 'pass');
  assert.equal(evaluate(LINKS, [['safeLinksPolicy', links()]]).verdict, 'pass');

  const weakPhish = evaluate(PHISH, [['antiPhishPolicy', phish()], ['antiPhishPolicy', phish({ Name: 'Sales', IsDefault: false, EnableSpoofIntelligence: false, HonorDmarcPolicy: false })]]);
  assert.equal(weakPhish.verdict, 'fail');
  assert.deepEqual(weakPhish.details, [
    { subject: 'Sales', setting: 'EnableSpoofIntelligence', value: false, expected: true },
    { subject: 'Sales', setting: 'HonorDmarcPolicy', value: false, expected: true },
  ]);

  const weakSpam = evaluate(SPAM, [['antiSpamPolicy', spam({ HighConfidencePhishAction: 'MoveToJmf' })]]);
  assert.deepEqual(weakSpam.details, [{ subject: 'Default', setting: 'HighConfidencePhishAction', value: 'MoveToJmf', expected: 'Quarantine' }]);
  assert.equal(evaluate(SPAM, [['antiSpamPolicy', spam({ PhishSpamAction: 'quarantine' })]]).verdict, 'pass', 'Exchange values compare without case');

  const allowed = evaluate(DOMAINS, [['antiSpamPolicy', spam({ AllowedSenderDomains: ['partner.test'] })]]);
  assert.deepEqual(allowed.details, [{ subject: 'Default', setting: 'AllowedSenderDomains', value: ['partner.test'], expected: [] }]);

  const weakMalware = evaluate(MALWARE, [['antiMalwarePolicy', malware({ EnableFileFilter: false })]]);
  assert.deepEqual(weakMalware.details, [{ subject: 'Default', setting: 'EnableFileFilter', value: false, expected: true }]);

  const clickThrough = evaluate(LINKS, [['safeLinksPolicy', links({ AllowClickThrough: true })]]);
  assert.deepEqual(clickThrough.details, [{ subject: 'Built-In Protection Policy', setting: 'AllowClickThrough', value: true, expected: false }]);
});

test('a missing value is never a pass, a turned-off custom anti-phishing policy is skipped, and no policy is not applicable', () => {
  const missing = evaluate(MALWARE, [['antiMalwarePolicy', { Name: 'Default', IsDefault: true }]]);
  assert.equal(missing.verdict, 'fail');
  assert.deepEqual(missing.details.map((line) => [line.setting, line.value]), [['EnableFileFilter', null], ['ZapEnabled', null]]);

  const off = evaluate(PHISH, [['antiPhishPolicy', phish()], ['antiPhishPolicy', phish({ Name: 'Old', IsDefault: false, Enabled: false, EnableSpoofIntelligence: false })]]);
  assert.equal(off.verdict, 'pass', 'a custom anti-phishing policy that is turned off applies to no one');

  // Other kinds in the same read are ignored; Safe Links without the licence has no policy.
  assert.equal(evaluate(LINKS, [['antiSpamPolicy', spam()]]).verdict, 'not-applicable');
  assert.equal(evaluate(LINKS, [['antiSpamPolicy', spam()]]).details, null);
});

test('parts is only accepted for a service read', () => {
  assert.throws(() => registerControl({
    controlId: 'keel-custom.test.parts-on-graph-type', title: 't', description: 'd', framework: 'keel-custom', edition: '1.0.0', profile: 'default',
    evaluatorVersion: 1, requiredObservations: [{ resourceType: 'group', maxAgeMs: HOUR, parts: ['x'] }],
    predicate: { name: 'group-role-assignable-not-synced', args: {} },
  }), /parts is only for a service read/);
});

test('checks run against the newest mail protection read, record what failed, and link back to that read', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const now = new Date();
  const all = { antiPhishPolicy: { status: 'read' }, antiSpamPolicy: { status: 'read' }, antiMalwarePolicy: { status: 'read' }, safeLinksPolicy: { status: 'read' } };
  // Older run: everything recommended. Newest run: weak spam and malware settings.
  await mailRun(client, tenantRef, { at: new Date(now.getTime() - 26 * HOUR), families: all, objects: [['antiPhishPolicy', phish()], ['antiSpamPolicy', spam()], ['antiMalwarePolicy', malware()], ['safeLinksPolicy', links()]] });
  const newest = await mailRun(client, tenantRef, {
    at: new Date(now.getTime() - 2 * HOUR), families: all,
    objects: [['antiPhishPolicy', phish()], ['antiSpamPolicy', spam({ AllowedSenderDomains: ['partner.test'] })], ['antiMalwarePolicy', malware({ ZapEnabled: false })], ['safeLinksPolicy', links()], ['transportRule', { Name: 'Not a policy' }]],
  });

  const result = await runComplianceChecks(client, { tenantRef, actor: 'scheduler', now });
  const byControl = Object.fromEntries(result.evaluations.map((evaluation) => [evaluation.control_id, evaluation]));
  assert.deepEqual(MAIL.map((id) => byControl[id].verdict), ['pass', 'pass', 'fail', 'fail', 'pass']);
  assert.deepEqual(byControl[MALWARE].details, [{ subject: 'Default', setting: 'ZapEnabled', value: false, expected: true }]);
  assert.equal(byControl[PHISH].details, null);
  assert.deepEqual(byControl[MALWARE].evidence_refs.map((ref) => ref.id.split(':')[0]), ['antiMalwarePolicy'], 'only the kind the control reads is its evidence');

  const { findings } = await complianceFindings(client, { tenantRef, now });
  const found = findings.find((finding) => finding.controlId === DOMAINS);
  assert.deepEqual(found.details, [{ subject: 'Default', setting: 'AllowedSenderDomains', value: ['partner.test'], expected: [] }]);
  assert.equal(found.links.backup.state, 'linked');
  assert.deepEqual(found.evidence.map((entry) => [entry.collectionId, entry.snapshotId]), [[newest, null]]);
  assert.equal(found.title, 'No anti-spam policy lets whole sender domains skip filtering');
});

test('a kind the newest read missed falls back to an older full read; Safe Links not licensed is not applicable', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const now = new Date();
  await mailRun(client, tenantRef, { at: new Date(now.getTime() - 10 * HOUR), families: { antiMalwarePolicy: { status: 'read' } }, outcome: 'partial', objects: [['antiMalwarePolicy', malware({ EnableFileFilter: false })]], unknownFields: {} });
  // Newest: malware read failed, anti-phishing missing a field, Safe Links not licensed.
  await mailRun(client, tenantRef, {
    at: new Date(now.getTime() - HOUR), outcome: 'partial',
    families: { antiMalwarePolicy: { status: 'failed' }, antiPhishPolicy: { status: 'read' }, antiSpamPolicy: { status: 'read' }, safeLinksPolicy: { status: 'not-licensed' } },
    unknownFields: { antiPhishPolicy: { HonorDmarcPolicy: 1 } },
    objects: [['antiPhishPolicy', phish()], ['antiSpamPolicy', spam()]],
  });
  const result = await runComplianceChecks(client, { tenantRef, actor: 'scheduler', now, controls: listControls().filter((control) => MAIL.includes(control.controlId)) });
  const byControl = Object.fromEntries(result.evaluations.map((evaluation) => [evaluation.control_id, evaluation]));
  assert.equal(byControl[MALWARE].verdict, 'fail', 'the older full malware read is used');
  assert.equal(byControl[PHISH].verdict, 'unknown', 'a read missing a field the control needs is never a guessed pass');
  assert.equal(byControl[PHISH].reason, 'exchange-mail-flow:observation-partial');
  assert.equal(byControl[SPAM].verdict, 'pass');
  assert.equal(byControl[LINKS].verdict, 'not-applicable');
});

test('no mail protection read yet, only refused runs, or a read too old: could not check', async (t) => {
  const client = await schemaClient(t);
  const controls = listControls().filter((control) => control.controlId === MALWARE);
  const none = tenant();
  await recordMailFlowRun(client, { tenantRef: none, result: { outcome: 'disabled', observedFrom: new Date().toISOString(), observedTo: new Date().toISOString(), reasons: ['not qualified'] } });
  const [unread] = (await runComplianceChecks(client, { tenantRef: none, actor: 'scheduler', controls })).evaluations;
  assert.deepEqual([unread.verdict, unread.reason], ['unknown', 'exchange-mail-flow:no-observation']);

  const old = tenant();
  await mailRun(client, old, { at: new Date(Date.now() - 40 * HOUR), objects: [['antiMalwarePolicy', malware()]] });
  const [stale] = (await runComplianceChecks(client, { tenantRef: old, actor: 'scheduler', controls })).evaluations;
  assert.deepEqual([stale.verdict, stale.reason], ['unknown', 'exchange-mail-flow:stale-observation']);

  const failed = tenant();
  await mailRun(client, failed, { at: new Date(Date.now() - HOUR), outcome: 'failed' });
  const [broken] = (await runComplianceChecks(client, { tenantRef: failed, actor: 'scheduler', controls })).evaluations;
  assert.deepEqual([broken.verdict, broken.reason], ['unknown', 'exchange-mail-flow:observation-failed']);

  // Another tenant's read is never used.
  const other = tenant();
  const [mine] = (await runComplianceChecks(client, { tenantRef: other, actor: 'scheduler', controls })).evaluations;
  assert.equal(mine.reason, 'exchange-mail-flow:no-observation');
});
