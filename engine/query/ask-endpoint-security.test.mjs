/** Ask files Intune endpoint security policies under Defender, as the lists do.
 *
 * Endpoint security policies (antivirus, firewall…) are stored as Intune settings catalog
 * policies (configurationPolicy) and told apart by templateReference.templateFamily
 * (insights/taxonomy.mjs#settingKind). No row is stored under their kind, so Ask has to
 * read the stored type and keep the rows by family: "What changed in Defender" holds
 * them, and a settings catalog question holds the rest. Change records keep the stored
 * type and carry the family, so the portal files each one (settingKind).
 *
 * Every time is fixed (NOW below and backups placed relative to it), so the result does
 * not depend on the day the test runs.
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { schemaSql } from '../store/loadSchema.mjs';
import { settingKind } from '../insights/taxonomy.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { answerQuestion } from './execute.mjs';

const NOW = new Date('2026-10-29T15:00:00Z');
const TENANT = 'sha256:00000000e5ec0001';
const CENTRAL = { central: true, entities: [] };
const HOUR = 3_600_000;

const policy = (name, family) => ({ id: `${name}-id`, name, templateReference: { templateId: family === 'none' ? '' : `${name}_1`, templateFamily: family } });
const POLICIES = [
  ['KEEL-RT-Antivirus', 'endpointSecurityAntivirus'],
  ['KEEL-RT-Firewall', 'endpointSecurityFirewall'],
  ['KEEL-RT-Catalog', 'none'],
  // Endpoint privilege management is an Intune Suite feature: it stays under Intune.
  ['KEEL-RT-Privilege', 'endpointSecurityEndpointPrivilegeManagement'],
];

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

before(async () => {
  client = await database.connect();
  await client.query(schemaSql());
  const digest = JSON.stringify({ configurationPolicy: { outcome: 'complete', itemCount: POLICIES.length } });
  const { rows: [baseline] } = await client.query(`INSERT INTO baseline (tenant_ref, set_by) VALUES ($1, 'fixture') RETURNING id`, [TENANT]);
  const snapshot = async (at) => (await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest)
     VALUES ($1, 'complete', $2::timestamptz - interval '5 minutes', $2, $3::jsonb) RETURNING id`,
    [TENANT, at, digest],
  )).rows[0].id;
  const earlier = await snapshot(new Date(NOW.getTime() - 26 * HOUR));
  const latest = await snapshot(new Date(NOW.getTime() - 2 * HOUR));
  for (const [name, family] of POLICIES) {
    const before = policy(name, family);
    const changed = { ...before, description: 'changed' };
    for (const [id, payload] of [[earlier, before], [latest, changed]]) {
      await client.query(
        `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
         VALUES ($1, $2, 'configurationPolicy', $3::jsonb, md5($3::text), 'high', 'medium', 'full', '{}'::jsonb)`,
        [id, `configurationPolicy:${name}`, JSON.stringify(payload)],
      );
    }
    await client.query(
      `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
                          before_hash, after_hash, before_payload, after_payload, blast_radius, detected_at)
       VALUES ($1, $2, $3, $4, 'configurationPolicy', 'modified', 'a', 'b', $5::jsonb, $6::jsonb, 'medium', $7)`,
      [TENANT, baseline.id, latest, `configurationPolicy:${name}`, JSON.stringify(before), JSON.stringify(changed), new Date(NOW.getTime() - 2 * HOUR + 60_000)],
    );
  }
});

after(async () => {
  await client?.end();
  await database.cleanup();
});

const ask = (question) => answerQuestion(client, { tenantRef: TENANT, scope: CENTRAL, question, now: NOW });
const ofRequest = (params) => answerQuestion(client, { tenantRef: TENANT, scope: CENTRAL, request: { intent: 'changes', params: { period: 'this-week', ...params } }, now: NOW });
const names = (answer) => answer.records.map((record) => record.name).sort();
// Records keep the stored type and carry the template family; the portal files them by both.
const kindOf = (row) => settingKind(row.resourceType, row.templateFamily);

test('"What changed in Defender" lists the endpoint security policies', async () => {
  const answer = await ask('What changed in Defender this week?');
  assert.ok(answer.plan.params.resourceTypes.includes('defenderEndpointSecurityPolicy'), JSON.stringify(answer.plan));
  assert.deepEqual(names(answer), ['KEEL-RT-Antivirus', 'KEEL-RT-Firewall']);
  assert.equal(answer.total, 2);
  assert.ok(answer.records.every((record) => kindOf(record) === 'defenderEndpointSecurityPolicy'));
  assert.deepEqual([...new Set(answer.summary.map(kindOf))], ['defenderEndpointSecurityPolicy']);
  assert.equal(answer.summary.reduce((sum, row) => sum + row.count, 0), 2);
  // The window still opens at the earlier backup of the stored type.
  assert.ok(answer.records.every((record) => record.window.from && record.window.from < record.window.to));
});

test('antivirus and endpoint security questions keep only those policies', async () => {
  for (const question of ['What antivirus settings changed this week?', 'Which endpoint security policies changed this week?']) {
    const answer = await ask(question);
    assert.deepEqual(names(answer), ['KEEL-RT-Antivirus', 'KEEL-RT-Firewall'], question);
  }
});

test('Intune and settings catalog questions leave the endpoint security policies to Defender', async () => {
  const intune = await ask('What changed in Intune this week?');
  assert.deepEqual(names(intune), ['KEEL-RT-Catalog', 'KEEL-RT-Privilege']);
  assert.ok(intune.records.every((record) => kindOf(record) === 'configurationPolicy'));
  const catalog = await ofRequest({ resourceType: 'configurationPolicy' });
  assert.deepEqual(names(catalog), ['KEEL-RT-Catalog', 'KEEL-RT-Privilege']);
  assert.equal(catalog.total, 2);
  // Both kinds together are every stored policy, each counted once.
  const both = await ofRequest({ resourceTypes: ['configurationPolicy', 'defenderEndpointSecurityPolicy'] });
  assert.equal(both.total, POLICIES.length);
  const one = await ofRequest({ resourceType: 'defenderEndpointSecurityPolicy' });
  assert.deepEqual(names(one), ['KEEL-RT-Antivirus', 'KEEL-RT-Firewall']);
  assert.notEqual(one.status, 'unknown', 'the stored type was compared, so the answer is known');
});

test('coverage counts endpoint security policies apart from the rest of the settings catalog', async () => {
  const answer = await answerQuestion(client, { tenantRef: TENANT, scope: CENTRAL, request: { intent: 'coverage', params: {} }, now: NOW });
  const count = (type) => answer.records.find((record) => record.resourceType === type);
  assert.equal(count('defenderEndpointSecurityPolicy')?.count, 2);
  assert.equal(count('defenderEndpointSecurityPolicy')?.outcome, 'complete');
  assert.equal(count('configurationPolicy')?.count, 2);
  const one = await answerQuestion(client, { tenantRef: TENANT, scope: CENTRAL, request: { intent: 'coverage', params: { resourceType: 'defenderEndpointSecurityPolicy' } }, now: NOW });
  assert.deepEqual(one.records.map((record) => [record.resourceType, record.count]), [['defenderEndpointSecurityPolicy', 2]]);
});
