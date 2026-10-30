/** CISA ScubaGear's own Rego rules, run unchanged on Keel backups: the compiled rules
 * give OPA's own answers, every rule of every product gets an answer, and a rule Keel
 * cannot check is never a pass. */
import { strict as assert } from 'node:assert';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluateControl } from '../evaluate.mjs';
import { CONTROL_VERDICTS, listControls, maskedFacts, SENSITIVE_MASK } from '../registry.mjs';
import { ADAPTERS, allowedDomains, CouldNotBuild } from './adapters.mjs';
import { plainDetails, REGO_BUILT_NAMES, SCUBA_FRAMEWORK, staticReason, verdictOf } from './controls.mjs';
import { FIXTURE_BACKUPS, FIXTURE_EXPECTED, fixtureDocument } from './fixtureTenant.mjs';
import { openPinnedScubaGear } from './import.mjs';
import { BUILD_DIR, BUILD_MANIFEST, goSprintf, indexOfN, loadRules, readBuild, regexFindN, scubaRules, timeFormat } from './opa.mjs';

const HOUR = 3_600_000;
// Fixed, so nothing here depends on the wall clock: backups ended an hour before it.
const NOW = new Date('2026-06-01T12:00:00.000Z');
const TENANT = 'sha256:0123456789abcdef';
const { pin } = openPinnedScubaGear();
const golden = JSON.parse(readFileSync(join(BUILD_DIR, 'golden.json'), 'utf8'));

function observations(backups = FIXTURE_BACKUPS) {
  return Object.fromEntries(Object.entries(backups).map(([resourceType, resources]) => [resourceType, {
    observation: {
      resourceType, tenantRef: TENANT, completeness: 'complete',
      window: { startedAt: new Date(NOW - 2 * HOUR).toISOString(), endedAt: new Date(NOW - HOUR).toISOString() },
    },
    resources,
  }]));
}
const scuba = () => listControls({ framework: SCUBA_FRAMEWORK });
const run = (controlId, backups) => evaluateControl({ controlId, tenantRef: TENANT, observations: observations(backups), now: NOW });
const id = (policyId) => `scubagear.${policyId}`;

test('the host built-ins give the same text as OPA\'s Go versions', () => {
  assert.equal(goSprintf('%v of %v roles: %s', [2, 3, 'ok']), '2 of 3 roles: ok');
  assert.equal(goSprintf('%v', [['a', 'b']]), '["a", "b"]');
  assert.equal(goSprintf('%v', [1.5]), '1.5');
  assert.equal(goSprintf('%v', [1234567.5]), '1.2345675e+06');
  assert.equal(goSprintf('%d%%', [40]), '40%');
  assert.equal(goSprintf('%v %v', [1]), '1 %!v(MISSING)');
  assert.deepEqual(indexOfN('a,b,c', ','), [1, 3]);
  assert.deepEqual(indexOfN('é,é', ','), [1]);
  assert.deepEqual(indexOfN('abc', ''), []);
  assert.equal(timeFormat(0), '1970-01-01T00:00:00Z');
  assert.equal(timeFormat(1_700_000_000_123_456_000), '2023-11-14T22:13:20.123456Z');
  assert.equal(timeFormat([1_700_000_000_000_000_000, 'UTC']), '2023-11-14T22:13:20Z');
  assert.throws(() => timeFormat([0, 'Europe/Paris']), /only UTC/);
  assert.deepEqual(regexFindN('(SSN)|(ITIN)', 'SSN, ITIN and SSN', -1), ['SSN', 'ITIN', 'SSN']);
  assert.deepEqual(regexFindN('(SSN)|(ITIN)', 'SSN, ITIN and SSN', 2), ['SSN', 'ITIN']);
  assert.deepEqual(regexFindN('a*', 'baaab', -1), ['', 'aaa', '']);
  assert.deepEqual(regexFindN('x', 'abc', -1), []);
});

test('the compiled rules are refused when they or their Rego differ from the pinned release', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-scuba-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const build = JSON.parse(readFileSync(BUILD_MANIFEST, 'utf8'));
  const manifest = join(dir, 'rules.json');
  const wasm = readFileSync(join(BUILD_DIR, build.module));

  copyFileSync(BUILD_MANIFEST, manifest);
  writeFileSync(join(dir, build.module), wasm);
  assert.equal(readBuild({ manifestPath: manifest }).build.moduleSha256, build.moduleSha256);

  const tampered = Buffer.from(wasm);
  tampered[tampered.length - 1] ^= 1;
  writeFileSync(join(dir, build.module), tampered);
  assert.throws(() => readBuild({ manifestPath: manifest }), /does not match its hash/);

  writeFileSync(join(dir, build.module), wasm);
  const otherSource = { ...build, sources: build.sources.map((source, i) => (i === 0 ? { ...source, sha256: '0'.repeat(64) } : source)) };
  writeFileSync(manifest, JSON.stringify(otherSource));
  assert.throws(() => readBuild({ manifestPath: manifest }), /differs from the pinned copy/);

  writeFileSync(manifest, JSON.stringify({ ...build, scubaGearCommit: 'f'.repeat(40) }));
  assert.throws(() => readBuild({ manifestPath: manifest }), /another ScubaGear release/);
});

const PRODUCTS = ['aad', 'exo', 'powerbi', 'powerplatform', 'securitysuite', 'sharepoint', 'teams'];

test('the compiled rules give native OPA\'s answers on the fixture tenant', () => {
  const rules = scubaRules();
  assert.deepEqual([...rules.entrypoints].sort(), PRODUCTS.map((product) => `${product}/tests`));
  for (const product of PRODUCTS) {
    const got = rules.evaluate(`${product}/tests`, fixtureDocument(product, { version: pin.version }))
      .map(({ PolicyId, Criticality, RequirementMet }) => ({ PolicyId, Criticality, RequirementMet }))
      .sort((a, b) => a.PolicyId.localeCompare(b.PolicyId, 'en', { numeric: true }) || a.Criticality.localeCompare(b.Criticality));
    assert.deepEqual(got, golden[product], `${product} differs from opa eval`);
  }
  // A second load is a fresh instance with the same answers.
  const again = loadRules().evaluate('exo/tests', fixtureDocument('exo', { version: pin.version }));
  assert.equal(again.length, golden.exo.length);
});

test('every rule of every product is a control, and each gets an answer on the fixture tenant', () => {
  const controls = scuba();
  assert.equal(controls.length, 109);
  assert.deepEqual([...new Set(controls.map((control) => control.profile))].sort(), PRODUCTS);
  const verdicts = {};
  for (const control of controls) {
    const result = run(control.controlId);
    assert.ok(CONTROL_VERDICTS.includes(result.verdict), control.controlId);
    if (result.verdict === 'unknown') assert.match(result.reason, /^scubagear:/, `${control.controlId}: ${result.reason}`);
    verdicts[control.controlId.slice('scubagear.'.length)] = result.verdict;
  }
  // Every rule Keel can check has a worked-out answer, and gets exactly it.
  const checked = Object.fromEntries(Object.entries(verdicts).filter(([, verdict]) => verdict !== 'unknown'));
  assert.deepEqual(checked, { ...FIXTURE_EXPECTED });
  assert.equal(Object.keys(checked).length, 64);
});

test('a rule Keel cannot check says why, and is never a pass', () => {
  const reason = (policyId) => run(id(policyId)).reason;
  assert.equal(reason('MS.AAD.2.2v1'), 'scubagear:check-by-hand');
  assert.equal(reason('MS.AAD.5.2v1'), 'scubagear:not-read:risky_delegated_permission_classifications');
  assert.equal(reason('MS.AAD.7.5v1'), 'scubagear:field-not-read:privileged_roles.StartDateTime');
  assert.match(reason('MS.AAD.9.1v1'), /^scubagear:field-not-read:conditional_access_policies\.AgentIdRiskLevels,/);
  assert.equal(reason('MS.EXO.2.2v3'), 'scubagear:not-read:spf_records');
  assert.equal(reason('MS.EXO.13.1v1'), 'scubagear:field-not-read:org_config.AuditDisabled,Name');
  assert.equal(reason('MS.SECURITYSUITE.1.3v1'), 'scubagear:not-read:built_in_protection_rules');
  assert.equal(reason('MS.SECURITYSUITE.2.1v1'), 'scubagear:needs-setting:SecuritySuite,Defender');
  assert.equal(reason('MS.SECURITYSUITE.3.1v1'), 'scubagear:field-not-read:dlp_compliance_policies.Enabled');
  assert.equal(reason('MS.SECURITYSUITE.6.1v1'), 'scubagear:field-not-read:hosted_content_filter_policies.RecommendedPolicyType');
  assert.equal(reason('MS.SHAREPOINT.1.2v1'), 'scubagear:field-not-read:SPO_tenant.ODBSharingCapability');
  assert.equal(reason('MS.TEAMS.5.1v2'), 'scubagear:not-read:tenant_app_settings');
  assert.equal(reason('MS.POWERPLATFORM.1.1v1'), 'scubagear:not-read:environment_creation');
  const unchecked = scuba().filter((control) => control.unchecked);
  assert.equal(unchecked.length, 45);
  for (const control of unchecked) assert.deepEqual(control.requiredObservations, []);
});

test('a field-limited read flags any field the rule names that Keel does not keep', () => {
  const adapters = { org_config: { fields: ['Name'] }, scuba_config: { setting: true } };
  const sources = { org_config: { state: 'read' }, scuba_config: { state: 'run-setting' } };
  const rule = (members) => ({ id: 'X', inputs: ['org_config', 'scuba_config'], members });
  assert.equal(staticReason(rule(['org_config', 'Name']), { adapters, sources }), null);
  assert.equal(staticReason(rule(['Name', 'AuditDisabled']), { adapters, sources }), 'scubagear:field-not-read:org_config.AuditDisabled');
  assert.equal(staticReason({ ...rule([]), manual: true }, { adapters, sources }), 'scubagear:check-by-hand');
  assert.equal(staticReason({ id: 'Y', inputs: ['nothing_here'], members: [] }, { adapters, sources }), 'scubagear:not-read:nothing_here');
});

test('a missing or old backup is could not check, not a pass', () => {
  const withoutPolicies = { ...FIXTURE_BACKUPS };
  delete withoutPolicies.conditionalAccessPolicy;
  const result = run(id('MS.AAD.1.1v1'), withoutPolicies);
  assert.equal(result.verdict, 'unknown');
  assert.match(result.reason, /^conditionalAccessPolicy:/);

  const stale = evaluateControl({ controlId: id('MS.AAD.1.1v1'), tenantRef: TENANT, observations: observations(), now: new Date(NOW.getTime() + 48 * HOUR) });
  assert.equal(stale.verdict, 'unknown');
});

test('a role held through a group is could not check, since Keel does not back up group members', () => {
  const GROUP = 'aaaaaaaa-0000-4000-8000-0000000000a1';
  const holder = FIXTURE_BACKUPS.roleAssignment[0];
  const backups = {
    ...FIXTURE_BACKUPS,
    group: [{ id: GROUP, displayName: 'KEEL-RT-Admins', isAssignableToRole: true }],
    roleAssignment: [...FIXTURE_BACKUPS.roleAssignment, { ...holder, id: 'ra-group-ga', principalId: GROUP }],
  };
  const result = run(id('MS.AAD.7.1v1'), backups);
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.reason, 'scubagear:incomplete:privileged_users');
  assert.match(result.details[0].value, /group/);
});

test('a backup that cannot answer what a role rule asks is could not check, never a pass', () => {
  const unknown = (policyId, backups, reason) => {
    const result = run(id(policyId), backups);
    assert.equal(result.verdict, 'unknown', policyId);
    assert.equal(result.reason, reason, policyId);
  };
  // PIM policies backed up without their rules: no offenders would be found.
  const noRules = { ...FIXTURE_BACKUPS, unifiedRoleManagementPolicy: FIXTURE_BACKUPS.unifiedRoleManagementPolicy.map(({ rules, ...policy }) => policy) };
  for (const policyId of ['MS.AAD.7.6v1', 'MS.AAD.7.7v1', 'MS.AAD.7.8v1', 'MS.AAD.7.9v1']) unknown(policyId, noRules, 'scubagear:incomplete:privileged_roles');
  // A privileged role missing from the role backup would drop its holders.
  const noGlobalAdmin = { ...FIXTURE_BACKUPS, roleDefinition: FIXTURE_BACKUPS.roleDefinition.filter((role) => role.displayName !== 'Global Administrator') };
  unknown('MS.AAD.7.3v1', noGlobalAdmin, 'scubagear:incomplete:privileged_users');
  unknown('MS.AAD.7.6v1', noGlobalAdmin, 'scubagear:incomplete:privileged_roles');
  // A role holder in no backup may be a group newer than the group backup.
  const stranger = { ...FIXTURE_BACKUPS, roleAssignmentSchedule: [...FIXTURE_BACKUPS.roleAssignmentSchedule, { ...FIXTURE_BACKUPS.roleAssignmentSchedule[0], id: 'sched-x', principalId: 'bbbbbbbb-0000-4000-8000-0000000000b1' }] };
  unknown('MS.AAD.7.6v1', stranger, 'scubagear:incomplete:privileged_roles');
  // A user backup that does not say whether an admin is synced.
  const unsaid = { ...FIXTURE_BACKUPS, user: FIXTURE_BACKUPS.user.map(({ onPremisesImmutableId, ...user }) => user) };
  unknown('MS.AAD.7.3v1', unsaid, 'scubagear:incomplete:privileged_users');
});

test('daily backups are allowed a day and a half, the others six hours', () => {
  const reads = (policyId) => Object.fromEntries(scuba().find((control) => control.controlId === id(policyId)).requiredObservations.map((read) => [read.resourceType, read.maxAgeMs]));
  assert.equal(reads('MS.AAD.7.3v1').user, 36 * HOUR);
  assert.equal(reads('MS.AAD.7.3v1').roleAssignment, 6 * HOUR);
  assert.equal(reads('MS.AAD.5.7v1').appManagementPolicy, 36 * HOUR);
});

test('a hidden field reaches the rules only as set or not set, and never shows in a finding', () => {
  const ben = FIXTURE_BACKUPS.user.find((user) => user.onPremisesImmutableId);
  assert.equal(maskedFacts('user', ben).onPremisesImmutableId, SENSITIVE_MASK);
  assert.equal(maskedFacts('user', { ...ben, onPremisesImmutableId: null }).onPremisesImmutableId, null);
  assert.ok(ADAPTERS.privileged_users.masked);
  const document = JSON.stringify(fixtureDocument('aad', { version: pin.version }));
  assert.ok(!document.includes(ben.onPremisesImmutableId));
  for (const control of scuba()) {
    assert.ok(!JSON.stringify(run(control.controlId)).includes(ben.onPremisesImmutableId), control.controlId);
  }
});

test('ScubaGear\'s report text and verdicts map the way its own report does', () => {
  assert.equal(verdictOf({ RequirementMet: true, Criticality: 'Shall' }), 'pass');
  assert.equal(verdictOf({ RequirementMet: false, Criticality: 'Should' }), 'fail');
  assert.equal(verdictOf({ RequirementMet: false, Criticality: 'Shall/Not-Implemented' }), 'not-applicable');
  assert.equal(verdictOf({ RequirementMet: false, Criticality: 'Shall/3rd Party' }), 'not-applicable');
  assert.equal(
    plainDetails('2 admins:<br/>KEEL-RT-Ada (62e90394-69f5-4237-9190-012177145e10) &amp; <b>Ben</b>'),
    '2 admins:; KEEL-RT-Ada ((id)) & Ben',
  );
  assert.equal(plainDetails('x'.repeat(500)).length, 400);
  assert.equal(plainDetails(undefined), null);
});

test('each name the rules build themselves is a string in that product\'s pinned Rego', () => {
  const pinned = openPinnedScubaGear();
  for (const [product, names] of Object.entries(REGO_BUILT_NAMES)) {
    const source = [pin.products[product].rego, ...pin.regoUtils].map((file) => pinned.read(file)).join('\n');
    for (const name of names) assert.ok(source.includes(`"${name}"`), `${product}: ${name}`);
  }
});

test('Teams external access domains are read as a list, and an unknown shape is never guessed at', () => {
  assert.deepEqual(allowedDomains({ AllowedDomain: [{ Domain: 'a.example' }, { Domain: 'b.example' }] }), ['a.example', 'b.example']);
  assert.deepEqual(allowedDomains({ AllowedDomain: { Domain: 'a.example' } }), ['a.example']);
  assert.deepEqual(allowedDomains({}), []);
  assert.deepEqual(allowedDomains({ AllowAllKnownDomains: {} }), []);
  assert.deepEqual(allowedDomains(['a.example']), ['a.example']);
  assert.throws(() => allowedDomains(null), CouldNotBuild);
  assert.throws(() => allowedDomains('Domain=a.example'), CouldNotBuild);
  assert.throws(() => allowedDomains({ AllowedDomain: [{ Name: 'a.example' }] }), CouldNotBuild);

  // Every domain allowed fails 2.1; an unreadable list is could not check.
  const federation = (AllowedDomains) => ({
    ...FIXTURE_BACKUPS,
    'teams-org-policies': FIXTURE_BACKUPS['teams-org-policies'].map((fact) => (fact.kind === 'federationConfiguration' ? { ...fact, AllowedDomains } : fact)),
  });
  assert.equal(run(id('MS.TEAMS.2.1v2'), federation({})).verdict, 'fail');
  const unreadable = run(id('MS.TEAMS.2.1v2'), federation('everything'));
  assert.equal(unreadable.verdict, 'unknown');
  assert.equal(unreadable.reason, 'scubagear:incomplete:federation_configuration');
});

test('SharePoint sharing settings become the admin API\'s numbers, and a setting not read is could not check', () => {
  const tenant = (fields) => ({ ...FIXTURE_BACKUPS, 'sharepoint-site-settings': [{ ...FIXTURE_BACKUPS['sharepoint-site-settings'][0], ...fields }] });
  assert.equal(run(id('MS.SHAREPOINT.1.1v1'), tenant({ sharingCapability: 'externalUserAndGuestSharing' })).verdict, 'fail');
  assert.equal(run(id('MS.SHAREPOINT.1.1v1'), tenant({ sharingCapability: 'disabled' })).verdict, 'pass');
  assert.equal(run(id('MS.SHAREPOINT.1.3v1'), tenant({ sharingDomainRestrictionMode: 'allowList', sharingAllowedDomainList: ['KEEL-RT-partner.example'] })).verdict, 'pass');
  const unread = run(id('MS.SHAREPOINT.1.1v1'), tenant({ sharingCapability: null }));
  assert.equal(unread.verdict, 'unknown');
  assert.equal(unread.reason, 'scubagear:incomplete:SPO_tenant');
});

test('a rule that needs another product\'s backup is could not check without it', () => {
  // The default Power Platform environment is found by the tenant id, from the organization backup.
  const withoutOrganization = { ...FIXTURE_BACKUPS };
  delete withoutOrganization.organization;
  const result = run(id('MS.POWERPLATFORM.2.1v1'), withoutOrganization);
  assert.equal(result.verdict, 'unknown');
  assert.match(result.reason, /^organization:/);
  // A tenant without Defender for Office 365 gets ScubaGear's own answer: the rule is not met.
  const withoutDefender = { ...FIXTURE_BACKUPS, 'exchange-extended': FIXTURE_BACKUPS['exchange-extended'].filter((fact) => fact.kind !== 'defenderForOffice') };
  const unlicensed = run(id('MS.SECURITYSUITE.1.4v1'), withoutDefender);
  assert.equal(unlicensed.verdict, 'fail');
  assert.match(unlicensed.details[0].value, /license for Microsoft Defender/);
});
