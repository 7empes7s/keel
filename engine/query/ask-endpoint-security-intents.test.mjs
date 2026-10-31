/** Older endpoint security policies are filed under Defender by their template's area.
 *
 * An older endpoint security policy (deviceManagementIntent) names only the template it
 * was made from (templateId). Its area is that template's templateSubtype, looked up in
 * the newest stored copy of the template when the row is read (insights/templateAreas.mjs).
 * Templates are read weekly and intents daily, so the backups that hold the intents here
 * hold no templates: the lookup reaches the older backup that does, and nothing is
 * written onto the stored policy.
 *
 * Every time is fixed (NOW below and backups placed relative to it), so the result does
 * not depend on the day the test runs.
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { compareSnapshots } from '../govern/compare.mjs';
import { loadChangeFeed } from '../insights/feed.mjs';
import { settingArea, settingKind, typeInfo } from '../insights/taxonomy.mjs';
import { loadTemplateAreas } from '../insights/templateAreas.mjs';
import { listLatestOpenDrift } from '../store/governance.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { answerQuestion } from './execute.mjs';

const NOW = new Date('2026-10-29T15:00:00Z');
const TENANT = 'sha256:00000000e5ec0002';
const OTHER_TENANT = 'sha256:00000000e5ec0003';
const CENTRAL = { central: true, entities: [] };
const HOUR = 3_600_000;

const FIREWALL_TEMPLATE = '4356d05c-a4ab-4a07-9ece-739f7c792910';
const EDR_TEMPLATE = 'e44c2ca3-2f9a-400a-a113-6cc88efd773d';
const BASELINE_TEMPLATE = '034ccd46-190c-4afc-adf1-ad7cc11262eb';
const UNREAD_TEMPLATE = '00000000-0000-4000-8000-0000000000aa';
const TEMPLATES = [
  { id: FIREWALL_TEMPLATE, displayName: 'Microsoft Defender Firewall', templateType: 'securityTemplate', templateSubtype: 'firewall' },
  { id: EDR_TEMPLATE, displayName: 'Endpoint detection and response', templateType: 'securityTemplate', templateSubtype: 'endpointDetectionReponse' },
  { id: BASELINE_TEMPLATE, displayName: 'MDM Security Baseline', templateType: 'securityBaseline', templateSubtype: 'none' },
];

const intent = (name, templateId) => ({ id: `${name}-id`, displayName: name, templateId, isAssigned: false });
const INTENTS = [
  ['KEEL-RT-Old-Firewall', FIREWALL_TEMPLATE],
  ['KEEL-RT-Old-EDR', EDR_TEMPLATE],
  ['KEEL-RT-Old-Baseline', BASELINE_TEMPLATE],
  // Its template was never read: it stays where intents are listed today, under Intune.
  ['KEEL-RT-Old-Unread', UNREAD_TEMPLATE],
];

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
let earlier;
let latest;

const snapshot = async (tenant, at, digest) => (await client.query(
  `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
   VALUES ($1, 'complete', $2::timestamptz - interval '5 minutes', $2, $3::jsonb) RETURNING id`,
  [tenant, at, JSON.stringify(digest)],
)).rows[0].id;

const version = (snapshotId, type, key, payload) => client.query(
  `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
   VALUES ($1, $2, $3, $4::jsonb, md5($4::text), 'tier2', 'access-affecting', 'full', '{}'::jsonb)`,
  [snapshotId, `${type}:${key}`, type, JSON.stringify(payload)],
);

before(async () => {
  client = await database.connect();
  await client.query(schemaSql());
  // The weekly backup that read the templates, before the daily ones.
  const weekly = await snapshot(TENANT, new Date(NOW.getTime() - 5 * 24 * HOUR), { deviceManagementTemplate: { outcome: 'complete', itemCount: TEMPLATES.length } });
  for (const template of TEMPLATES) await version(weekly, 'deviceManagementTemplate', template.id, template);
  // Another tenant's copy of a template says nothing about this tenant's.
  const other = await snapshot(OTHER_TENANT, new Date(NOW.getTime() - 24 * HOUR), {});
  await version(other, 'deviceManagementTemplate', UNREAD_TEMPLATE, { id: UNREAD_TEMPLATE, templateSubtype: 'antivirus' });

  const digest = { deviceManagementIntent: { outcome: 'complete', itemCount: INTENTS.length } };
  earlier = await snapshot(TENANT, new Date(NOW.getTime() - 26 * HOUR), digest);
  latest = await snapshot(TENANT, new Date(NOW.getTime() - 2 * HOUR), digest);
  const { rows: [baseline] } = await client.query(`INSERT INTO baseline (tenant_ref, set_by) VALUES ($1, 'fixture') RETURNING id`, [TENANT]);
  for (const [name, templateId] of INTENTS) {
    const was = intent(name, templateId);
    const now = { ...was, description: 'changed' };
    await version(earlier, 'deviceManagementIntent', name, was);
    await version(latest, 'deviceManagementIntent', name, now);
    await client.query(
      `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
                          before_hash, after_hash, before_payload, after_payload, blast_radius, detected_at)
       VALUES ($1, $2, $3, $4, 'deviceManagementIntent', 'modified', 'a', 'b', $5::jsonb, $6::jsonb, 'access-affecting', $7)`,
      [TENANT, baseline.id, latest, `deviceManagementIntent:${name}`, JSON.stringify(was), JSON.stringify(now), new Date(NOW.getTime() - 2 * HOUR + 60_000)],
    );
  }
});

after(async () => {
  await client?.end();
  await database.cleanup();
});

const ask = (question) => answerQuestion(client, { tenantRef: TENANT, scope: CENTRAL, question, now: NOW });
const names = (answer) => answer.records.map((record) => record.name).sort();
const kindOf = (row) => settingKind(row.resourceType, row.templateFamily);

test('the taxonomy files an older endpoint security policy under Defender by its template subtype', () => {
  assert.equal(settingKind('deviceManagementIntent', 'firewall'), 'defenderEndpointSecurityIntent');
  assert.equal(settingKind('deviceManagementIntent', 'endpointDetectionReponse'), 'defenderEndpointSecurityIntent');
  assert.equal(settingArea('deviceManagementIntent', 'endpointDetectionReponse'), 'Endpoint detection and response');
  assert.equal(settingKind('deviceManagementIntent', 'none'), 'deviceManagementIntent', 'a security baseline stays Intune');
  assert.equal(settingKind('deviceManagementIntent', null), 'deviceManagementIntent');
  // A settings catalog family does not move an intent, nor a subtype a settings catalog policy.
  assert.equal(settingKind('deviceManagementIntent', 'endpointSecurityFirewall'), 'deviceManagementIntent');
  assert.equal(settingKind('configurationPolicy', 'firewall'), 'configurationPolicy');
  const info = typeInfo('defenderEndpointSecurityIntent');
  assert.deepEqual([info.service, info.category, info.name], ['Defender', 'endpoint', 'Endpoint security policy (older format)']);
});

test('"What changed in Defender" lists older endpoint security policies, by the area of their template', async () => {
  const answer = await ask('What changed in Defender this week?');
  assert.ok(answer.plan.params.resourceTypes.includes('defenderEndpointSecurityIntent'), JSON.stringify(answer.plan));
  assert.deepEqual(names(answer), ['KEEL-RT-Old-EDR', 'KEEL-RT-Old-Firewall']);
  const family = Object.fromEntries(answer.records.map((record) => [record.name, record.templateFamily]));
  assert.deepEqual(family, { 'KEEL-RT-Old-EDR': 'endpointDetectionReponse', 'KEEL-RT-Old-Firewall': 'firewall' });
  assert.ok(answer.records.every((record) => record.resourceType === 'deviceManagementIntent' && kindOf(record) === 'defenderEndpointSecurityIntent'));
  assert.equal(answer.summary.reduce((sum, row) => sum + row.count, 0), 2);
});

test('security baselines and policies whose template was never read stay under Intune', async () => {
  const intune = await ask('What changed in Intune this week?');
  assert.deepEqual(names(intune), ['KEEL-RT-Old-Baseline', 'KEEL-RT-Old-Unread']);
  const family = Object.fromEntries(intune.records.map((record) => [record.name, record.templateFamily ?? null]));
  // Another tenant's copy of the unread template is not used.
  assert.deepEqual(family, { 'KEEL-RT-Old-Baseline': 'none', 'KEEL-RT-Old-Unread': null });
  assert.ok(intune.records.every((record) => kindOf(record) === 'deviceManagementIntent'));
});

test('coverage counts older endpoint security policies apart from security baselines', async () => {
  const answer = await answerQuestion(client, { tenantRef: TENANT, scope: CENTRAL, request: { intent: 'coverage', params: {} }, now: NOW });
  const count = (type) => answer.records.find((record) => record.resourceType === type)?.count;
  assert.equal(count('defenderEndpointSecurityIntent'), 2);
  assert.equal(count('deviceManagementIntent'), 2);
});

test('the change feed, open changes and comparisons carry the area too', async () => {
  const { rows } = await loadChangeFeed(client, { tenantRef: TENANT, now: NOW });
  const feed = Object.fromEntries(rows.map((entry) => [entry.object.name, [entry.kind, entry.service]]));
  assert.deepEqual(feed['KEEL-RT-Old-Firewall'], ['defenderEndpointSecurityIntent', 'Defender']);
  assert.deepEqual(feed['KEEL-RT-Old-Baseline'], ['deviceManagementIntent', 'Intune']);

  const { rows: [baseline] } = await client.query('SELECT id FROM baseline WHERE tenant_ref = $1', [TENANT]);
  const open = await listLatestOpenDrift(client, { tenantRef: TENANT, baselineId: baseline.id });
  const openFamily = Object.fromEntries(open.map((row) => [row.natural_key, row.template_family]));
  assert.equal(openFamily['deviceManagementIntent:KEEL-RT-Old-Firewall'], 'firewall');
  assert.equal(openFamily['deviceManagementIntent:KEEL-RT-Old-Unread'], null);

  const compared = await compareSnapshots(client, { leftSnapshotId: earlier, rightSnapshotId: latest, sections: ['settings'], now: NOW });
  const items = compared.settings.groups.find((group) => group.resourceType === 'deviceManagementIntent').items;
  const compareFamily = Object.fromEntries(items.map((item) => [item.naturalKey, item.templateFamily ?? null]));
  assert.equal(compareFamily['deviceManagementIntent:KEEL-RT-Old-Firewall'], 'firewall');
  assert.equal(compareFamily['deviceManagementIntent:KEEL-RT-Old-Unread'], null);
});

test('nothing is written onto the stored policy', async () => {
  const { rows } = await client.query(
    `SELECT payload FROM resource_version WHERE resource_type = 'deviceManagementIntent' AND snapshot_id = $1`, [latest],
  );
  assert.ok(rows.every((row) => !('templateSubtype' in row.payload) && !('templateReference' in row.payload)));
});

test('rows read live take the area from the same stored templates', async () => {
  const areas = await loadTemplateAreas(client, TENANT);
  assert.equal(areas.get(FIREWALL_TEMPLATE), 'firewall');
  assert.equal(areas.get(BASELINE_TEMPLATE), 'none');
  assert.equal(areas.has(UNREAD_TEMPLATE), false, "another tenant's copy is not used");
});
