/** ScubaGear's config lists per tenant: sensitive users, partner domains and the
 * emergency accounts the sign-in and admin role rules leave out. A rule that needs a
 * list reads "could not check" until the tenant sets it, then runs on it. */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { grantRole } from '../../authz/administration.mjs';
import { registerBreakGlassAccount } from '../../safety/breakGlassReadiness.mjs';
import { schemaSql } from '../../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../../test/dbTestHelper.mjs';
import { evaluateControl } from '../evaluate.mjs';
import {
  configHasList, DEFAULT_SCUBA_CONFIG, getScubaConfigLists, listForRule, loadScubaConfig, normaliseEntries, ROLE_EXCLUSION_RULES,
  SCUBA_CONFIG_LIST_EVIDENCE_KIND, SCUBA_LISTS, scubaConfigFrom, ScubaConfigListError, setScubaConfigList, SIGN_IN_EXCLUSION_RULES,
} from './config.mjs';
import { scubaRuleOutcomes } from './controls.mjs';
import { FIXTURE_BACKUPS } from './fixtureTenant.mjs';
import { openPinnedScubaGear } from './import.mjs';
import { regoRuleInputs } from './rego.mjs';

const HOUR = 3_600_000;
// Fixed, so nothing here depends on the wall clock: backups ended an hour before it.
const NOW = new Date('2026-06-01T12:00:00.000Z');
const TENANT = 'sha256:0123456789abcdef';
const ADA = '00000000-0000-4000-8000-0000000000a1'; // the fixture's permanent Global Administrator
const CAL = '00000000-0000-4000-8000-0000000000c3'; // permanent User Administrator
const EMERGENCY = '00000000-0000-4000-8000-0000000000e9';

function observations(backups) {
  return Object.fromEntries(Object.entries(backups).map(([resourceType, resources]) => [resourceType, {
    observation: {
      resourceType, tenantRef: TENANT, completeness: 'complete',
      window: { startedAt: new Date(NOW - 2 * HOUR).toISOString(), endedAt: new Date(NOW - HOUR).toISOString() },
    },
    resources,
  }]));
}
const run = (policyId, { backups = FIXTURE_BACKUPS, config } = {}) => evaluateControl({
  controlId: `scubagear.${policyId}`, tenantRef: TENANT, observations: observations(backups), now: NOW,
  ...(config ? { settings: { scubaConfig: config } } : {}),
});

/** The fixture with the default anti-phish policy changed, and sign-in rules leaving `excluded` out. */
function backupsWith({ antiPhish = {}, excluded = [] } = {}) {
  const backups = structuredClone(FIXTURE_BACKUPS);
  const policy = backups['exchange-mail-flow'].find((entry) => entry.kind === 'antiPhishPolicy');
  Object.assign(policy, antiPhish);
  for (const rule of backups.conditionalAccessPolicy) rule.conditions.users.excludeUsers = [...excluded];
  return backups;
}

test('the lists a tenant sets match the Rego that reads them', () => {
  const pinned = openPinnedScubaGear();
  const read = (file) => pinned.read(file);
  const aad = read(pinned.pin.products.aad.rego);
  const signIn = [...new Set([...aad.matchAll(/UserExclusionsFullyExempt\(policy, "(MS\.AAD\.[^"]+)"\)/g)].map((match) => match[1]))].sort();
  assert.deepEqual([...SIGN_IN_EXCLUSION_RULES].sort(), signIn);
  const roles = [...new Set([...aad.matchAll(/PrivilegedRoleExclusions\(Role, "(MS\.AAD\.[^"]+)"\)/g)].map((match) => match[1]))].sort();
  assert.deepEqual([...ROLE_EXCLUSION_RULES].sort(), roles);
  const suite = read(pinned.pin.products.securitysuite.rego);
  assert.match(suite, /ListConfigValues\("MS\.SECURITYSUITE\.2\.1v1", "SensitiveUsers"\)/);
  assert.match(suite, /PartnerDomainConfig\("MS\.SECURITYSUITE\.2\.3v1"\)/);
  assert.match(read('Rego/Utils/SecuritySuite.rego'), /PartnerDomainConfig\(PolicyID\) := ListConfigValues\(PolicyID, "PartnerDomains"\)/);
  // Every rule that reads a config section of its own has a list Keel keeps.
  const files = [...Object.values(pinned.pin.products).map((product) => product.rego), ...pinned.pin.regoUtils].map((file) => ({ file, source: read(file) }));
  const needing = [...regoRuleInputs(files)].filter(([, entry]) => ['SecuritySuite', 'Defender'].some((section) => entry.members.has(section))).map(([id]) => id).sort();
  assert.deepEqual(needing, Object.values(SCUBA_LISTS).map((spec) => spec.policyId).sort());
  for (const { rule, reason } of scubaRuleOutcomes()) if (listForRule(rule.id)) assert.equal(reason, null, `${rule.id} runs once its list is set`);
});

test('entries are cleaned, and an entry of the wrong kind refuses the whole list', () => {
  assert.deepEqual(normaliseEntries('sensitive-users', [' Ada@Contoso.example ', 'ben@contoso.example', 'ada@contoso.example', '']), ['ada@contoso.example', 'ben@contoso.example']);
  assert.deepEqual(normaliseEntries('partner-domains', ['Fabrikam.example', 'sub.fabrikam.example']), ['fabrikam.example', 'sub.fabrikam.example']);
  assert.throws(() => normaliseEntries('sensitive-users', ['ada@contoso.example', 'not an address']), /not an email address: not an address/);
  assert.throws(() => normaliseEntries('partner-domains', ['https://fabrikam.example']), /not a domain name/);
  assert.throws(() => normaliseEntries('partner-domains', ['fabrikam']), /not a domain name/);
  assert.throws(() => normaliseEntries('sensitive-users', [42]), /must be text/);
  assert.throws(() => normaliseEntries('other', []), ScubaConfigListError);
  assert.throws(() => normaliseEntries('partner-domains', Array.from({ length: 501 }, (_, i) => `d${i}.example`)), /at most 500/);
});

test('the config holds each list for its rule, and emergency accounts for every sign-in rule and the admin role rule', () => {
  assert.deepEqual(scubaConfigFrom(), { M365Environment: 'commercial', Aad: {}, Exo: {} });
  const config = scubaConfigFrom({
    lists: [{ list: 'sensitive-users', entries: ['ada@contoso.example'] }, { list: 'partner-domains', entries: [] }],
    emergencyAccounts: [{ accountId: EMERGENCY, label: 'bg' }],
  });
  assert.deepEqual(config.SecuritySuite, { 'MS.SECURITYSUITE.2.1v1': { SensitiveUsers: ['ada@contoso.example'] } });
  assert.deepEqual(config.Aad['MS.AAD.1.1v1'], { CapExclusions: { Users: [EMERGENCY] } });
  assert.deepEqual(config.Aad['MS.AAD.7.4v1'], { RoleExclusions: { Users: [EMERGENCY] } });
  assert.equal(Object.keys(config.Aad).length, SIGN_IN_EXCLUSION_RULES.length + ROLE_EXCLUSION_RULES.length);
  assert.equal(configHasList(config, 'MS.SECURITYSUITE.2.1v1'), true);
  assert.equal(configHasList(config, 'MS.SECURITYSUITE.2.3v1'), false);
  assert.equal(configHasList(DEFAULT_SCUBA_CONFIG, 'MS.AAD.1.1v1'), true);
});

test('sensitive users: could not check without the list, then the rule runs on it', () => {
  assert.equal(run('MS.SECURITYSUITE.2.1v1').reason, 'scubagear:needs-setting:sensitive-users');
  const config = scubaConfigFrom({ lists: [{ list: 'sensitive-users', entries: ['ada@keel-rt-contoso.example'] }] });
  // The default policy protects nobody by name: a fail for the tenant, not for the list.
  assert.equal(run('MS.SECURITYSUITE.2.1v1', { config }).verdict, 'fail');
  const protecting = backupsWith({ antiPhish: { EnableTargetedUserProtection: true, TargetedUsersToProtect: ['Ada;Ada@KEEL-RT-contoso.example'], TargetedUserProtectionAction: 'Quarantine' } });
  assert.equal(run('MS.SECURITYSUITE.2.1v1', { backups: protecting, config }).verdict, 'pass');
  // A sensitive user the policy leaves out is a fail.
  const two = scubaConfigFrom({ lists: [{ list: 'sensitive-users', entries: ['ada@keel-rt-contoso.example', 'ben@keel-rt-contoso.example'] }] });
  assert.equal(run('MS.SECURITYSUITE.2.1v1', { backups: protecting, config: two }).verdict, 'fail');
});

test('partner domains: could not check without the list, then the rule runs on it', () => {
  assert.equal(run('MS.SECURITYSUITE.2.3v1').reason, 'scubagear:needs-setting:partner-domains');
  const config = scubaConfigFrom({ lists: [{ list: 'partner-domains', entries: ['fabrikam.example'] }] });
  assert.equal(run('MS.SECURITYSUITE.2.3v1', { config }).verdict, 'fail');
  const protecting = backupsWith({ antiPhish: { EnableTargetedDomainsProtection: true, TargetedDomainsToProtect: ['Fabrikam.example'], TargetedDomainProtectionAction: 'Quarantine' } });
  assert.equal(run('MS.SECURITYSUITE.2.3v1', { backups: protecting, config }).verdict, 'pass');
});

test('emergency accounts: a sign-in rule may leave them out, and they may hold an admin role permanently', () => {
  const excluding = backupsWith({ excluded: [EMERGENCY] });
  // ScubaGear's default: a rule that leaves anyone out does not count.
  assert.equal(run('MS.AAD.1.1v1').verdict, 'pass');
  assert.equal(run('MS.AAD.1.1v1', { backups: excluding }).verdict, 'fail');
  const config = scubaConfigFrom({ emergencyAccounts: [{ accountId: EMERGENCY, label: 'bg' }] });
  assert.equal(run('MS.AAD.1.1v1', { backups: excluding, config }).verdict, 'pass');
  // Leaving out anyone else still fails.
  assert.equal(run('MS.AAD.1.1v1', { backups: backupsWith({ excluded: [EMERGENCY, ADA] }), config }).verdict, 'fail');
  // Ada holds Global Administrator and Cal User Administrator, both permanently. Each
  // role is allowed only once everyone holding it permanently is an emergency account.
  const roles = (accounts) => run('MS.AAD.7.4v1', { config: scubaConfigFrom({ emergencyAccounts: accounts.map((accountId) => ({ accountId, label: accountId })) }) });
  assert.match(roles([]).details[0].value, /2 role\(s\).*Global Administrator/);
  const ada = roles([ADA]);
  assert.equal(ada.verdict, 'fail');
  assert.match(ada.details[0].value, /1 role\(s\).*User Administrator$/);
  assert.equal(roles([ADA, CAL]).verdict, 'pass');
});

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });
let ready = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!ready) { await client.query(schemaSql()); ready = true; }
  return client;
}
async function person(client, role) {
  const { rows: [row] } = await client.query('INSERT INTO principal (email) VALUES ($1) RETURNING id::text AS id', [`${role}-${randomUUID()}@contoso.example`]);
  if (role) await grantRole(client, { principalId: row.id, role, grantedBy: row.id });
  return row.id;
}

test('a list is kept per tenant, needs configuration, and its audit record holds counts only', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = `sha256:${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = await person(client, 'admin');
  const viewer = await person(client, 'viewer');

  const empty = await getScubaConfigLists(client, { tenantRef });
  assert.deepEqual(empty.lists.map((entry) => [entry.list, entry.entries, entry.updatedBy]), [['sensitive-users', [], null], ['partner-domains', [], null]]);
  assert.deepEqual(empty.emergencyAccounts, []);

  await assert.rejects(setScubaConfigList(client, { tenantRef, list: 'sensitive-users', entries: ['ada@contoso.example'], actor: viewer }), /forbidden/);
  await assert.rejects(setScubaConfigList(client, { tenantRef, list: 'sensitive-users', entries: ['nope'], actor: admin }), ScubaConfigListError);

  const set = await setScubaConfigList(client, { tenantRef, list: 'sensitive-users', entries: ['Ben@contoso.example', 'ada@contoso.example'], actor: admin, now: new Date() });
  assert.equal(set.changed, true);
  assert.deepEqual(set.list.entries, ['ada@contoso.example', 'ben@contoso.example']);
  assert.equal(set.list.updatedBy, admin);
  const again = await setScubaConfigList(client, { tenantRef, list: 'sensitive-users', entries: ['ada@contoso.example', 'BEN@contoso.example'], actor: admin });
  assert.equal(again.changed, false);
  await setScubaConfigList(client, { tenantRef, list: 'sensitive-users', entries: ['ada@contoso.example', 'cal@contoso.example'], actor: admin });

  const { rows: records } = await client.query('SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = $2 ORDER BY seq', [tenantRef, SCUBA_CONFIG_LIST_EVIDENCE_KIND]);
  assert.deepEqual(records.map((row) => row.subject), [
    { list: 'sensitive-users', policyId: 'MS.SECURITYSUITE.2.1v1', count: 2, previousCount: 0, added: 2, removed: 0 },
    { list: 'sensitive-users', policyId: 'MS.SECURITYSUITE.2.1v1', count: 2, previousCount: 2, added: 1, removed: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(records), /contoso/);

  // Another tenant sees none of it.
  const other = await getScubaConfigLists(client, { tenantRef: 'sha256:fedcba9876543210' });
  assert.deepEqual(other.lists[0].entries, []);

  // Emergency accounts come from Emergency access; a retired one is no longer left out.
  await registerBreakGlassAccount(client, { tenantRef, actor: admin, accountId: EMERGENCY, label: 'bg1@contoso.example' });
  const config = await loadScubaConfig(client, { tenantRef });
  assert.deepEqual(config.SecuritySuite, { 'MS.SECURITYSUITE.2.1v1': { SensitiveUsers: ['ada@contoso.example', 'cal@contoso.example'] } });
  assert.deepEqual(config.Aad['MS.AAD.3.1v1'], { CapExclusions: { Users: [EMERGENCY] } });

  // An empty list unsets it.
  await setScubaConfigList(client, { tenantRef, list: 'sensitive-users', entries: [], actor: admin });
  assert.equal((await loadScubaConfig(client, { tenantRef })).SecuritySuite, undefined);
});
