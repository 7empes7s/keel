/** Intune security baselines: templates read from the tenant, every setting matched by
 * settingDefinitionId across every settings catalog policy in the newest complete backup. */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';

import { canonicalHash, HASH_VERSION } from '../cir/canonicalHash.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import {
  intuneBaselineResults, matchBaselines, policySettings, readBaselineTemplates, recordBaselineTemplateRead,
  refreshBaselineTemplates, shapeTemplate, templateSettings, templatesDue,
} from './intuneBaselines.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let ready = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!ready) { await client.query(schemaSql()); ready = true; }
  return client;
}
let sequence = 0;
const tenant = () => { sequence += 1; return `sha256:${createHash('sha256').update(`intune-baselines-${sequence}`).digest('hex').slice(0, 16)}`; };
const HOUR = 3_600_000;

// Graph shapes, as the beta reference documents them.
const choiceTemplate = (id, option, children = []) => ({
  '@odata.type': '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstanceTemplate',
  settingInstanceTemplateId: `${id}-t`, settingDefinitionId: id, isRequired: false,
  choiceSettingValueTemplate: { settingValueTemplateId: `${id}-v`, defaultValue: { settingDefinitionOptionId: option, children } },
});
const simpleTemplate = (id, constantValue) => ({
  '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstanceTemplate',
  settingInstanceTemplateId: `${id}-t`, settingDefinitionId: id, isRequired: false,
  simpleSettingValueTemplate: { settingValueTemplateId: `${id}-v`, defaultValue: constantValue === undefined ? null : { constantValue } },
});
const groupTemplate = (id, children) => ({
  '@odata.type': '#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstanceTemplate',
  settingInstanceTemplateId: `${id}-t`, settingDefinitionId: id,
  groupSettingCollectionValueTemplate: [{ settingValueTemplateId: `${id}-v`, children }],
});
const definition = (id, name, categoryId, options = []) => ({
  id, displayName: name, categoryId, options: options.map(([itemId, displayName]) => ({ itemId, displayName })),
});

const choice = (id, value, children = []) => ({
  '@odata.type': '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance',
  settingDefinitionId: id, choiceSettingValue: { value, children },
});
const simple = (id, value) => ({
  '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance',
  settingDefinitionId: id, simpleSettingValue: { '@odata.type': '#microsoft.graph.deviceManagementConfigurationIntegerSettingValue', value },
});
const group = (id, children) => ({
  '@odata.type': '#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance',
  settingDefinitionId: id, groupSettingCollectionValue: [{ children }],
});
const policy = (id, name, instances) => ({ id, name, platforms: 'windows10', technologies: 'mdm', settings: instances.map((settingInstance, index) => ({ id: String(index), settingInstance })) });

const RTM = 'device_vendor_msft_policy_config_defender_allowrealtimemonitoring';
const CLOUD = 'device_vendor_msft_policy_config_defender_allowcloudprotection';
const SCAN = 'device_vendor_msft_policy_config_defender_avgcpuloadfactor';
const ASR = 'device_vendor_msft_policy_config_defender_attacksurfacereductionrules';
const ASR_OFFICE = `${ASR}_blockofficecommunicationappfromcreatingchildprocesses`;
const FW = 'vendor_msft_firewall_mdmstore_domainprofile_enablefirewall';
const UNSET = 'device_vendor_msft_policy_config_lanmanworkstation_enableinsecureguestlogons';

const SETTING_TEMPLATES = [
  { settingInstanceTemplate: choiceTemplate(RTM, `${RTM}_1`), settingDefinitions: [definition(RTM, 'Allow realtime monitoring', 'cat-av', [[`${RTM}_0`, 'Not allowed'], [`${RTM}_1`, 'Allowed']])] },
  { settingInstanceTemplate: choiceTemplate(CLOUD, `${CLOUD}_1`), settingDefinitions: [definition(CLOUD, 'Allow cloud protection', 'cat-av', [[`${CLOUD}_0`, 'Not allowed'], [`${CLOUD}_1`, 'Allowed']])] },
  { settingInstanceTemplate: simpleTemplate(SCAN, 50), settingDefinitions: [definition(SCAN, 'Average CPU load factor', 'cat-av')] },
  // A choice whose child is set with it, and a group (no value of its own) with a child.
  { settingInstanceTemplate: groupTemplate(ASR, [choiceTemplate(ASR_OFFICE, `${ASR_OFFICE}_block`)]),
    settingDefinitions: [definition(ASR, 'Attack surface reduction rules', 'cat-asr'), definition(ASR_OFFICE, 'Block Office communication apps from creating child processes', 'cat-asr', [[`${ASR_OFFICE}_block`, 'Block'], [`${ASR_OFFICE}_audit`, 'Audit']])] },
  { settingInstanceTemplate: choiceTemplate(FW, `${FW}_true`), settingDefinitions: [definition(FW, 'Enable domain network firewall', 'cat-fw', [[`${FW}_true`, 'True'], [`${FW}_false`, 'False']])] },
  // Microsoft leaves the value to the admin: matched when any policy sets it.
  { settingInstanceTemplate: simpleTemplate(UNSET), settingDefinitions: [definition(UNSET, 'Enable insecure guest logons', 'cat-net')] },
];
const TEMPLATE = { id: 'tmpl-win-24h2', displayName: 'Security Baseline for Windows 10 and later', displayVersion: 'Version 24H2', lifecycleState: 'active', platforms: 'windows10', technologies: 'mdm', templateFamily: 'baseline' };
const CATEGORIES = new Map([['cat-av', 'Defender'], ['cat-asr', 'Attack Surface Reduction'], ['cat-fw', 'Firewall']]);

test('without a default, a recommended definition allowing one option is Microsoft\'s value', () => {
  const template = { settingDefinitionId: 'x', choiceSettingValueTemplate: { defaultValue: null, recommendedValueDefinition: { allowedOptions: [{ itemId: 'x_1' }] } } };
  assert.deepEqual(templateSettings(template), [{ id: 'x', expected: ['x_1'] }]);
  const several = { settingDefinitionId: 'y', choiceSettingValueTemplate: { recommendedValueDefinition: { allowedOptions: [{ itemId: 'y_0' }, { itemId: 'y_1' }] } } };
  assert.deepEqual(templateSettings(several), [{ id: 'y', expected: null }]);
});

test('a template lists every setting with its recommended value, children included, groups left out', () => {
  const settings = SETTING_TEMPLATES.flatMap((entry) => templateSettings(entry.settingInstanceTemplate));
  assert.deepEqual(settings, [
    { id: RTM, expected: [`${RTM}_1`] },
    { id: CLOUD, expected: [`${CLOUD}_1`] },
    { id: SCAN, expected: ['50'] },
    { id: ASR_OFFICE, expected: [`${ASR_OFFICE}_block`] },
    { id: FW, expected: [`${FW}_true`] },
    { id: UNSET, expected: null },
  ]);
  const shaped = shapeTemplate(TEMPLATE, SETTING_TEMPLATES, CATEGORIES);
  assert.equal(shaped.settings.length, 6);
  assert.equal(shaped.version, 'Version 24H2');
  const office = shaped.settings.find((setting) => setting.id === ASR_OFFICE);
  assert.equal(office.name, 'Block Office communication apps from creating child processes');
  assert.equal(office.category, 'Attack Surface Reduction');
  assert.equal(office.labels[`${ASR_OFFICE}_block`], 'Block');
  assert.equal(shaped.settings.find((setting) => setting.id === UNSET).category, null);
});

test('a policy lists what it sets, children of choices and groups included', () => {
  const found = policySettings(group(ASR, [choice(ASR_OFFICE, `${ASR_OFFICE}_audit`)]));
  assert.deepEqual(found, [{ id: ASR_OFFICE, values: [`${ASR_OFFICE}_audit`] }]);
  assert.deepEqual(policySettings(simple(SCAN, 50)), [{ id: SCAN, values: ['50'] }]);
});

test('every baseline setting is matched across every settings catalog policy, never by policy name', () => {
  const template = shapeTemplate(TEMPLATE, SETTING_TEMPLATES, CATEGORIES);
  const policies = [
    // Not made from the baseline, named nothing like it: still counts.
    policy('p-av', 'KEEL-RT-antivirus', [choice(RTM, `${RTM}_1`), simple(SCAN, 30), choice(CLOUD, `${CLOUD}_1`)]),
    policy('p-av2', 'KEEL-RT-antivirus-2', [choice(CLOUD, `${CLOUD}_0`)]),
    policy('p-asr', 'KEEL-RT-asr', [group(ASR, [choice(ASR_OFFICE, `${ASR_OFFICE}_block`)])]),
    policy('p-net', 'KEEL-RT-network', [simple(UNSET, 0), choice(RTM, `${RTM}_1`)]),
  ];
  const [result] = matchBaselines([template], policies);
  const by = Object.fromEntries(result.settings.map((setting) => [setting.id, setting]));
  assert.equal(by[RTM].result, 'match');
  assert.deepEqual(by[RTM].setBy.map((entry) => entry.policyName), ['KEEL-RT-antivirus', 'KEEL-RT-network']);
  assert.equal(by[CLOUD].result, 'conflict');
  assert.equal(by[SCAN].result, 'different');
  assert.deepEqual(by[SCAN].setBy[0].values, ['30']);
  assert.equal(by[ASR_OFFICE].result, 'match');
  assert.equal(by[FW].result, 'not-configured');
  assert.equal(by[UNSET].result, 'match');
  assert.deepEqual(result.counts, { conflict: 1, different: 1, 'not-configured': 1, match: 3, unknown: 0 });
  // Without a complete policy read, nothing is guessed.
  const [unread] = matchBaselines([template], null);
  assert.equal(unread.counts.unknown, 6);
});

/** A reader standing in for Graph: path -> body, or a failure. */
function fakeReader(routes) {
  const calls = [];
  const answer = (path) => {
    calls.push(path);
    const route = routes[path];
    if (!route) return { ok: false, status: 404, error: 'not found' };
    return route.fail ? { ok: false, status: route.fail, error: 'boom' } : { ok: true, status: 200, body: route };
  };
  return {
    calls,
    async get(_version, path) { return answer(path); },
    async collect(_version, path) {
      const res = answer(path);
      return res.ok ? { items: res.body.value, pages: 1, capped: false, error: null } : { items: [], pages: 0, capped: false, error: res };
    },
  };
}

const LIST = '/deviceManagement/configurationPolicyTemplates';
const settingsPath = (id) => `${LIST}/${id}/settingTemplates?$expand=settingDefinitions`;

test('reads every baseline template version (not other families, not drafts) with category names', async () => {
  const reader = fakeReader({
    [LIST]: { value: [
      TEMPLATE,
      { ...TEMPLATE, id: 'tmpl-win-23h2', displayVersion: 'Version 23H2', lifecycleState: 'superseded' },
      { ...TEMPLATE, id: 'tmpl-draft', lifecycleState: 'draft' },
      { id: 'tmpl-av', displayName: 'Microsoft Defender Antivirus', templateFamily: 'endpointSecurityAntivirus', lifecycleState: 'active' },
      { id: 'tmpl-broken', displayName: 'Microsoft Edge baseline', templateFamily: 'baseline', lifecycleState: 'active' },
    ] },
    [settingsPath('tmpl-win-24h2')]: { value: SETTING_TEMPLATES },
    [settingsPath('tmpl-win-23h2')]: { value: SETTING_TEMPLATES.slice(0, 2) },
    [settingsPath('tmpl-broken')]: { fail: 500 },
    '/deviceManagement/configurationCategories/cat-av?$select=id,displayName': { id: 'cat-av', displayName: 'Defender' },
  });
  const read = await readBaselineTemplates(reader);
  assert.equal(read.outcome, 'partial');
  assert.deepEqual(read.templates.map((template) => [template.templateId, template.settings.length]), [['tmpl-win-24h2', 6], ['tmpl-win-23h2', 2]]);
  assert.deepEqual(read.failures.map((failure) => failure.templateId), ['tmpl-broken']);
  assert.ok(!reader.calls.some((path) => path.includes('tmpl-draft') || path.includes('tmpl-av')));
  assert.equal(read.templates[0].settings[0].category, 'Defender');
  // A category that could not be read leaves the setting ungrouped, not failed.
  assert.equal(read.templates[0].settings.find((setting) => setting.id === FW).category, null);

  const failed = await readBaselineTemplates(fakeReader({ [LIST]: { fail: 403 } }));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.templates, []);
});

async function snapshot(client, tenantRef, completedAt, outcome, policies) {
  const { rows: [row] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
     VALUES ($1, 'complete', $2, $3, $4) RETURNING id::text AS id`,
    [tenantRef, new Date(completedAt.getTime() - 600_000), completedAt, { configurationPolicy: { outcome, itemCount: policies.length } }],
  );
  for (const payload of policies) {
    await client.query(
      `INSERT INTO resource_version
         (snapshot_id, natural_key, resource_type, payload, payload_hash, hash_version, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, 'configurationPolicy', $3, $4, $5, 'high', 'access-affecting', 'full', '{}')`,
      [row.id, `configurationPolicy:${payload.name}`, payload, canonicalHash(payload, 'configurationPolicy'), HASH_VERSION],
    );
  }
  return row.id;
}

test('results use the newest template read and the newest complete settings catalog backup', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const now = new Date();
  const template = shapeTemplate(TEMPLATE, SETTING_TEMPLATES, CATEGORIES);

  const empty = await intuneBaselineResults(client, { tenantRef, now });
  assert.equal(empty.templates, null);
  assert.deepEqual(empty.baselines, []);

  await recordBaselineTemplateRead(client, { tenantRef, read: { outcome: 'complete', templates: [template], failures: [] }, readAt: new Date(now.getTime() - 3 * HOUR) });
  // A newer read failed: the older templates are still used, and the failure is said.
  await recordBaselineTemplateRead(client, { tenantRef, read: { outcome: 'failed', error: 'Forbidden', templates: [], failures: [] }, readAt: new Date(now.getTime() - HOUR) });
  const complete = await snapshot(client, tenantRef, new Date(now.getTime() - 2 * HOUR), 'complete', [policy('p1', 'KEEL-RT-av', [choice(RTM, `${RTM}_0`)])]);
  // The newest backup's settings catalog read was partial, so it is not used.
  await snapshot(client, tenantRef, new Date(now.getTime() - HOUR / 2), 'partial', []);

  const results = await intuneBaselineResults(client, { tenantRef, now });
  assert.equal(results.templates.outcome, 'complete');
  assert.equal(results.lastFailure.error, 'Forbidden');
  assert.equal(results.policies.snapshotId, complete);
  assert.equal(results.policies.count, 1);
  const rtm = results.baselines[0].settings.find((setting) => setting.id === RTM);
  assert.equal(rtm.result, 'different');
  assert.equal(rtm.setBy[0].policyName, 'KEEL-RT-av');
  assert.equal(results.baselines[0].counts['not-configured'], 5);

  // No complete policy read for another tenant: every setting is could not check.
  const other = tenant();
  await recordBaselineTemplateRead(client, { tenantRef: other, read: { outcome: 'complete', templates: [template], failures: [] }, readAt: new Date(now.getTime() - HOUR) });
  const unread = await intuneBaselineResults(client, { tenantRef: other, now });
  assert.equal(unread.policies, null);
  assert.equal(unread.baselines[0].counts.unknown, 6);
});

test('templates are read at most once a day, only the newest reads are kept, and a failure never throws', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const now = new Date();
  assert.equal(await templatesDue(client, { tenantRef, now }), true);

  const reader = fakeReader({ [LIST]: { value: [TEMPLATE] }, [settingsPath('tmpl-win-24h2')]: { value: SETTING_TEMPLATES } });
  const lines = [];
  const logger = { log: (line) => lines.push(line) };
  const read = await refreshBaselineTemplates(client, { tenantRef, reader, now, logger });
  assert.equal(read.outcome, 'complete');
  assert.match(lines[0], /intune security baselines: complete, 1 baseline versions with 6 settings/);
  assert.equal(await templatesDue(client, { tenantRef, now }), false);
  assert.equal(await refreshBaselineTemplates(client, { tenantRef, reader, now, logger }), null);
  assert.equal(await templatesDue(client, { tenantRef, now: new Date(now.getTime() + 25 * HOUR) }), true);

  for (let index = 1; index <= 4; index += 1) {
    await recordBaselineTemplateRead(client, { tenantRef, read: { outcome: 'failed', error: 'x', templates: [], failures: [] }, readAt: new Date(now.getTime() + index * 1000) });
  }
  // The newest 3 stay, plus the newest usable read, so failures never empty the page.
  const { rows } = await client.query('SELECT outcome FROM intune_baseline_template_read WHERE tenant_ref = $1 ORDER BY read_at', [tenantRef]);
  assert.deepEqual(rows.map((row) => row.outcome), ['complete', 'failed', 'failed', 'failed']);
  assert.equal((await intuneBaselineResults(client, { tenantRef, now: new Date(now.getTime() + 10_000) })).templates.outcome, 'complete');
  // A partial read counts as fresh, so a template that keeps failing is retried daily.
  const partial = tenant();
  await recordBaselineTemplateRead(client, { tenantRef: partial, read: { outcome: 'partial', templates: [], failures: [] }, readAt: now });
  assert.equal(await templatesDue(client, { tenantRef: partial, now }), false);

  const broken = { query: async () => { throw new Error('database gone'); } };
  assert.equal(await refreshBaselineTemplates(broken, { tenantRef, reader, now, logger }), null);
  assert.match(lines.at(-1), /intune security baselines not read: database gone/);
});
