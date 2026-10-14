// Wave 1 READ-TEAMS-PV: Purview retention labels, adaptive scopes, auto-labeling, and
// eDiscovery cases and holds, read-only.
//
// Acceptance:
//  - each read is declared in workloadContract.mjs, passes the scope validator, is run
//    by the read-only probe in the Security & Compliance session, and ships disabled;
//  - the Node and container allowlists hold Get cmdlets only and are identical; no
//    cmdlet that reads case evidence is allowed, and -Case, -Policy and -CaseType take
//    only values KEEL itself read;
//  - holds are read per case (Standard and Premium), hold queries per hold, and every
//    child keeps its parent; a rule naming a policy that was not read is a gap;
//  - an unlicensed family is not-licensed and makes the run partial; one failed case
//    does not stop the other cases' holds;
//  - without qualification nothing is sent and a disabled run is recorded.
//
// Everything runs against the isolated test database and a fake PowerShell container
// that plays ops/powershell/run-cmdlet.ps1 through the real jobQueue spawn path.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  CORE_OPERATIONS, FAMILIES, FAMILY_NAMES, LICENSED_FAMILIES, PURVIEW_EXTENDED_CMDLET_PARAMETERS, PURVIEW_EXTENDED_DESCRIPTOR,
  PURVIEW_EXTENDED_EXCLUDED_CMDLETS, PURVIEW_EXTENDED_MISSING, PURVIEW_EXTENDED_OPERATIONS, PURVIEW_EXTENDED_WORKLOAD,
  PurviewExtendedScopeError, assertPurviewExtendedCmdlet, collectPurviewExtended, purviewExtendedActivation, readPurviewExtended,
} from './purviewExtended.mjs';
import { WORKLOAD_DESCRIPTORS, buildWorkloadLedger, descriptorProblems } from '../workloadContract.mjs';
import { listWorkloads } from '../registry.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../coverage/qualification.mjs';
import { runFixtureHarness } from '../../../tools/qualification/workloads.mjs';
import { createIsolatedTestDatabase } from '../../test/dbTestHelper.mjs';
import { ALL_READS, GRANTS, RUNTIME, containerAllowlist, fakeCmdletContainer, ledgerWith, notFound } from '../../test/fakeCmdletContainer.mjs';
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
const ALLOWED = containerAllowlist('AllowedPurviewExtended');
const guid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-0000000000fe`;
const WHEN = '2026-09-01T00:00:00Z';

const CASE = { Identity: guid(20), Name: 'KEEL-RT-case', Description: 'fixture', Status: 'Active', CaseType: 'eDiscovery', CreatedDateTime: WHEN, SearchCount: 3, LastSearchResult: 'mail from a@contoso.test' };
const PREMIUM = { Identity: guid(21), Name: 'KEEL-RT-premium', Description: '', Status: 'Active', CaseType: 'AdvancedEdiscovery', CreatedDateTime: WHEN };
const HOLDS = {
  [guid(20)]: [{ Name: 'KEEL-RT-hold', Guid: guid(30), Comment: '', Enabled: true, Mode: 'Enforce', ExchangeLocation: ['keel-rt-alice@contoso.test'], SharePointLocation: [], PublicFolderLocation: [], WhenChangedUTC: WHEN, DistributionStatus: 'Success' }],
  [guid(21)]: [{ Name: 'KEEL-RT-premium-hold', Guid: guid(31), Comment: '', Enabled: true, Mode: 'Enforce', ExchangeLocation: [], SharePointLocation: ['https://contoso.sharepoint.test/sites/KEEL-RT'], PublicFolderLocation: [], WhenChangedUTC: WHEN }],
};
const RULES = {
  [guid(30)]: [{ Name: 'KEEL-RT-hold rule', Guid: guid(40), Policy: guid(30), Comment: '', Disabled: false, ContentMatchQuery: 'subject:"KEEL-RT"', WhenChangedUTC: WHEN }],
  [guid(31)]: [],
};

// What the Security & Compliance session answers, with extras a careless reader would keep.
const SAMPLE = Object.freeze({
  'Get-ComplianceTag': [{ Name: 'KEEL-RT-keep-7y', Guid: guid(1), Comment: '', IsRecordLabel: false, Regulatory: false, RetentionAction: 'Keep', RetentionDuration: 2555, RetentionType: 'CreationAgeInDays', WhenChangedUTC: WHEN, ObjectVersion: 'internal' }],
  'Get-AdaptiveScope': [{ Name: 'KEEL-RT-finance', Guid: guid(2), Comment: '', LocationType: 'User', FilterConditions: { Conditions: [{ Value: 'Finance', Operator: 'Equals', Name: 'Department' }], Conjunction: 'And' }, RawQuery: null, WhenChangedUTC: WHEN }],
  'Get-AutoSensitivityLabelPolicy': [{ Name: 'KEEL-RT-auto', Guid: guid(3), Comment: '', Mode: 'TestWithoutNotifications', Enabled: true, ApplySensitivityLabel: 'KEEL-RT-confidential', ExchangeLocation: ['All'], WhenChangedUTC: WHEN }],
  'Get-AutoSensitivityLabelRule': [{ Name: 'KEEL-RT-auto rule', Guid: guid(4), Policy: guid(3), ParentPolicyName: 'KEEL-RT-auto', Disabled: false, Workload: 'Exchange', ContentContainsSensitiveInformation: [{ name: 'Credit Card Number', mincount: '1' }], WhenChangedUTC: WHEN, MatchCount: 12 }],
});
function answer(overrides = {}) {
  return (cmdlet, parameters) => {
    if (cmdlet in overrides) {
      const override = overrides[cmdlet];
      return typeof override === 'function' ? override(parameters) : override;
    }
    if (cmdlet === 'Get-ComplianceCase') return parameters.CaseType === 'AdvancedEdiscovery' ? [PREMIUM] : [CASE];
    if (cmdlet === 'Get-CaseHoldPolicy') return HOLDS[parameters.Case] ?? [];
    if (cmdlet === 'Get-CaseHoldRule') return RULES[parameters.Policy] ?? [];
    return SAMPLE[cmdlet];
  };
}
const container = (overrides) => fakeCmdletContainer({ module: 'ExchangeOnlineManagement', allowlist: ALLOWED, answer: answer(overrides) });
// Purview follows Exchange, which follows Teams, which follows SharePoint.
const GATE = ALL_READS.filter((id) => ['sharepoint.', 'teams.settings', 'teams.membership', 'teams.team-discovery', 'teams.group-membership', 'exchange.']
  .some((prefix) => id.startsWith(prefix)));

test('each Purview governance read is declared, in scope, probed, read-only and ships disabled', async () => {
  const declared = WORKLOAD_DESCRIPTORS.filter((descriptor) => descriptor.workload === PURVIEW_EXTENDED_WORKLOAD);
  assert.deepEqual(declared.map((descriptor) => descriptor.id), [...PURVIEW_EXTENDED_OPERATIONS]);
  assert.deepEqual(declared.map((descriptor) => descriptor.operation.cmdlet), FAMILY_NAMES.map((name) => FAMILIES[name].cmdlet));
  assert.equal(new Set(declared.map((descriptor) => descriptor.operation.probeName)).size, declared.length, 'each read has its own probe row');
  for (const descriptor of declared) {
    assert.deepEqual(descriptorProblems(descriptor), [], descriptor.id);
    assert.equal(descriptor.operation.module, 'ExchangeOnlineManagement');
  }

  const probe = readFileSync(new URL('../../../ops/powershell/probe-workloads.ps1', import.meta.url), 'utf8');
  const scc = /# --- Security & Compliance([\s\S]*?)# --- Teams/.exec(probe)[1];
  for (const descriptor of declared) assert.ok(scc.includes(`-Workload 'scc' -Name '${descriptor.operation.probeName}'`), descriptor.id);

  const { evidence, results } = await runFixtureHarness({ descriptors: declared, runtime: RUNTIME });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const fixtured = buildWorkloadLedger({ descriptors: declared, evidence, grants: GRANTS, runtime: RUNTIME, tenantRef: 'sha256:t', now: NOW });
  assert.ok(fixtured.rows.every((row) => row.state === 'fixture-tested' && row.enabled === false));

  assert.equal(PURVIEW_EXTENDED_DESCRIPTOR.enabledByDefault, false);
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === PURVIEW_EXTENDED_WORKLOAD && descriptor.enabledByDefault === false));
  assert.deepEqual(Object.values(WORKLOAD_WRITE_OPERATIONS).filter((operation) => operation.workload === PURVIEW_EXTENDED_WORKLOAD), []);
  assert.ok(Object.keys(ALLOWED).every((cmdlet) => cmdlet.startsWith('Get-')));
  assert.deepEqual(Object.fromEntries(Object.entries(PURVIEW_EXTENDED_CMDLET_PARAMETERS).map(([name, list]) => [name, [...list]])), ALLOWED);
  for (const cmdlet of [...PURVIEW_EXTENDED_EXCLUDED_CMDLETS, 'Set-ComplianceTag', 'New-CaseHoldPolicy', 'Remove-ComplianceCase', 'Get-Label']) {
    assert.throws(() => assertPurviewExtendedCmdlet({ cmdlet }), PurviewExtendedScopeError, cmdlet);
    assert.ok(!(cmdlet in ALLOWED), `${cmdlet} is not allowed by the container`);
  }
  assert.throws(() => assertPurviewExtendedCmdlet({ cmdlet: 'Get-ComplianceCase', parameters: { CaseType: 'ComplianceWorkspace' } }), /CaseType may only be/);
  assert.throws(() => assertPurviewExtendedCmdlet({ cmdlet: 'Get-CaseHoldPolicy', parameters: { Case: 'KEEL-RT-case; Remove-ComplianceCase' } }), /must be a Guid/);
  assert.throws(() => assertPurviewExtendedCmdlet({ cmdlet: 'Get-CaseHoldRule', parameters: { Case: guid(1) } }), /does not take Case/);
  assert.deepEqual([...LICENSED_FAMILIES], ['autoLabelPolicy', 'autoLabelRule', 'premiumCase']);
  assert.ok(PURVIEW_EXTENDED_MISSING.some((entry) => entry.reason === 'content' && entry.family === 'ediscoveryCase'));
});

test('holds are read per case and queries per hold, and every child keeps its parent', async () => {
  const fake = container();
  const result = await readPurviewExtended({ powershell: fake.powershell, now: () => NOW });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(fake.calls, [
    { cmdlet: 'Get-ComplianceTag', parameters: {} },
    { cmdlet: 'Get-AdaptiveScope', parameters: {} },
    { cmdlet: 'Get-AutoSensitivityLabelPolicy', parameters: {} },
    { cmdlet: 'Get-AutoSensitivityLabelRule', parameters: {} },
    { cmdlet: 'Get-ComplianceCase', parameters: {} },
    { cmdlet: 'Get-ComplianceCase', parameters: { CaseType: 'AdvancedEdiscovery' } },
    { cmdlet: 'Get-CaseHoldPolicy', parameters: { Case: guid(20) } },
    { cmdlet: 'Get-CaseHoldPolicy', parameters: { Case: guid(21) } },
    { cmdlet: 'Get-CaseHoldRule', parameters: { Policy: guid(30) } },
    { cmdlet: 'Get-CaseHoldRule', parameters: { Policy: guid(31) } },
  ]);
  const byKey = Object.fromEntries(result.resources.map((resource) => [resource.resourceKey, resource]));
  assert.deepEqual(Object.keys(byKey).sort(), [
    `adaptive-scope:${guid(2)}`, `auto-label-policy:${guid(3)}`, `auto-label-rule:${guid(4)}`, `case-hold-rule:${guid(40)}`,
    `case-hold:${guid(30)}`, `case-hold:${guid(31)}`, `ediscovery-case:${guid(20)}`, `ediscovery-premium-case:${guid(21)}`, `retention-label:${guid(1)}`,
  ]);
  assert.equal(byKey[`case-hold:${guid(30)}`].case, `ediscovery-case:${guid(20)}`);
  assert.equal(byKey[`case-hold:${guid(31)}`].case, `ediscovery-premium-case:${guid(21)}`);
  assert.equal(byKey[`case-hold-rule:${guid(40)}`].parent, guid(30));
  assert.equal(byKey[`case-hold-rule:${guid(40)}`].fields.ContentMatchQuery, 'subject:"KEEL-RT"');
  assert.equal(byKey[`auto-label-rule:${guid(4)}`].parentStatus, 'found');
  assert.equal(result.discovery.unparented, 0);
  // Case evidence and counters are never kept.
  const text = JSON.stringify(result.resources);
  for (const leaked of ['SearchCount', 'LastSearchResult', 'MatchCount', 'DistributionStatus', 'ObjectVersion']) assert.ok(!text.includes(leaked), leaked);
  assert.equal(result.discovery.contentRead, false);
  assert.equal(result.outcome, 'partial', 'sample answers omit some declared fields');
});

test('unlicensed, failed and orphaned reads are gaps; one failed case does not stop the others', async () => {
  const result = await readPurviewExtended({
    powershell: container({
      'Get-AutoSensitivityLabelPolicy': { error: notFound('Get-AutoSensitivityLabelPolicy') },
      'Get-CaseHoldPolicy': (parameters) => (parameters.Case === guid(20) ? { error: { message: 'Internal error', category: 'InvalidOperation', errorId: 'Boom' } } : HOLDS[parameters.Case]),
    }).powershell,
    now: () => NOW,
  });
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.unavailable.map((entry) => [entry.family, entry.status]), [['autoLabelPolicy', 'not-licensed']]);
  // The policy family was not read, so the rule's parent is unchecked, not missing.
  assert.equal(result.resources.find((resource) => resource.kind === 'autoLabelRule').parentStatus, 'unchecked');
  assert.deepEqual(result.failures.map((failure) => [failure.family, failure.parent, failure.parameters]), [['caseHold', `ediscovery-case:${guid(20)}`, { Case: guid(20) }]]);
  assert.ok(result.resources.some((resource) => resource.resourceKey === `case-hold:${guid(31)}`), 'the premium case still has its hold');
  assert.equal(result.discovery.families.caseHold.status, 'partial');

  const orphan = await readPurviewExtended({
    powershell: container({ 'Get-AutoSensitivityLabelRule': [{ ...SAMPLE['Get-AutoSensitivityLabelRule'][0], Policy: guid(99) }] }).powershell,
    families: ['autoLabelPolicy', 'autoLabelRule'],
    now: () => NOW,
  });
  assert.equal(orphan.discovery.unparented, 1);
  assert.equal(orphan.resources.find((resource) => resource.kind === 'autoLabelRule').parentStatus, 'missing');
  assert.equal(orphan.outcome, 'partial');

  const empty = await readPurviewExtended({
    powershell: container({ 'Get-ComplianceTag': [], 'Get-AdaptiveScope': [], 'Get-ComplianceCase': [] }).powershell,
    families: ['retentionLabel', 'adaptiveScope', 'ediscoveryCase', 'caseHold', 'caseHoldRule'],
    now: () => NOW,
  });
  assert.equal(empty.outcome, 'complete-empty', 'a tenant with no labels, scopes or cases is not a gap');
});

test('without qualification nothing is sent; licensed reads run only once their own row is enabled', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = 'sha256:read-teams-pv-purview';
  const fake = container();
  const bare = await collectPurviewExtended(client, { tenantRef, ledger: buildWorkloadLedger({ now: NOW }), powershell: fake.powershell, now: () => NOW });
  assert.equal(bare.run.outcome, 'disabled');
  assert.equal(fake.calls.length, 0);
  assert.ok(bare.run.digest.reasons.some((reason) => reason.startsWith('Exchange is not qualified yet')));

  // Core reads qualified, licensed ones not: those are skipped and the run is partial.
  const core = ledgerWith(tenantRef, [...GATE, ...CORE_OPERATIONS], { now: NOW });
  const activation = purviewExtendedActivation(core);
  assert.equal(activation.enabled, true, activation.reasons.join('; '));
  assert.deepEqual(activation.skipped.map((entry) => entry.family), ['autoLabelPolicy', 'autoLabelRule', 'premiumCase']);
  const run = await collectPurviewExtended(client, { tenantRef, ledger: core, powershell: fake.powershell, now: () => NOW });
  assert.equal(run.run.outcome, 'partial');
  assert.ok(!fake.calls.some((call) => call.cmdlet.startsWith('Get-AutoSensitivityLabel') || call.parameters.CaseType));
  assert.deepEqual(fake.calls.filter((call) => call.cmdlet === 'Get-CaseHoldPolicy').map((call) => call.parameters.Case), [guid(20)]);
  const { rows } = await client.query('SELECT resource_key, fields FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key', [run.run.id]);
  assert.equal(rows.length, run.result.resources.length);
  const hold = rows.find((row) => row.resource_key === `case-hold:${guid(30)}`);
  assert.equal(hold.fields.case, `ediscovery-case:${guid(20)}`);
  assert.equal(hold.fields.parentStatus, 'found');
  assert.deepEqual(run.run.digest.skipped.map((entry) => entry.family), ['autoLabelPolicy', 'autoLabelRule', 'premiumCase']);

  const all = ledgerWith(tenantRef, [...GATE, ...PURVIEW_EXTENDED_OPERATIONS], { now: NOW });
  assert.deepEqual(purviewExtendedActivation(all).skipped, []);
});
