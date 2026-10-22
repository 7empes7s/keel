// The approved setup for service settings (workloadApproved.mjs) and drift against it.
//
// Acceptance:
//  - accepting a changed setting makes the read that found it the approved value, with
//    who and why, and records evidence; the next read with the same value records
//    nothing and resolves the alert; a later different value is a new change;
//  - accepting a removal takes the resource out of the approved setup, and accepting
//    an addition puts it in, so the next read shows no change for either;
//  - only the newest change to a setting, on its own tenant, with a reason, is accepted;
//  - taking the approved setup for the first time keeps a change still waiting for
//    review at its earlier value (it stays a change, not recorded twice), while a change
//    a person already settled is approved as read;
//  - a difference whose alert a person resolved by hand is recorded again on the next
//    read and reopens the alert.
// Mutation checks:
//  - seed the approved setup from the newest read without keeping waiting changes;
//  - accept into the approved setup from the read before the change;
//  - accept a change when a newer one exists.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { applyConditionEvent } from '../notify/alerts.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { ServiceChangeError, acceptServiceChange } from './workloadApproved.mjs';
import { detectWorkloadDrift } from './workloadDrift.mjs';

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

const WORKLOAD = 'exchange-mail-flow';
const RULE = 'transport-rule:KEEL-RT-rule';
const OTHER = 'transport-rule:KEEL-RT-other';
const rule = (over = {}) => ({ identity: 'KEEL-RT-rule', kind: 'transportRule', Name: 'KEEL-RT-rule', State: 'Disabled', Mode: 'Enforce', WhenChangedUTC: '2026-10-01T00:00:00Z', ...over });
const other = (over = {}) => ({ identity: 'KEEL-RT-other', kind: 'transportRule', Name: 'KEEL-RT-other', State: 'Enabled', Mode: 'Audit', ...over });
let day = 0;

async function read(client, tenantRef, observations, outcome = 'complete') {
  const at = new Date(Date.parse('2026-10-12T02:00:00Z') + (day += 1) * 86_400_000).toISOString();
  const { rows: [collection] } = await client.query(
    `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
     VALUES ($1, $2, $3, $4, $4, $4) RETURNING id`,
    [tenantRef, WORKLOAD, outcome, at],
  );
  for (const [resourceKey, fields] of Object.entries(observations)) {
    await client.query('INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, $2, $3)', [collection.id, resourceKey, fields]);
  }
  return collection.id;
}

const changes = async (client, tenantRef) => (await client.query(
  'SELECT * FROM workload_drift WHERE tenant_ref = $1 ORDER BY detected_at, id', [tenantRef],
)).rows;
const alertOf = async (client, tenantRef, key) => (await client.query(
  `SELECT * FROM alert WHERE tenant_ref = $1 AND resource_key = $2 AND control = 'baseline' AND condition = 'drift'`,
  [tenantRef, `${WORKLOAD}:${key}`],
)).rows[0];
const approved = async (client, tenantRef) => new Map((await client.query(
  'SELECT * FROM workload_approved WHERE tenant_ref = $1 AND workload = $2', [tenantRef, WORKLOAD],
)).rows.map((row) => [row.resource_key, row]));
const tenant = () => `sha256:wa-${crypto.randomUUID()}`;

test('accepting a changed setting approves the read that found it', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  const first = await read(client, tenantRef, { [RULE]: rule() });
  assert.equal((await detectWorkloadDrift(client, { collectionId: first })).status, 'first-run');
  const second = await read(client, tenantRef, { [RULE]: rule({ State: 'Enabled' }) });
  const found = await detectWorkloadDrift(client, { collectionId: second });
  assert.equal(found.drift.length, 1);
  const [change] = await changes(client, tenantRef);
  assert.equal(change.previous_collection_id, first);

  const accepted = await acceptServiceChange(client, { tenantRef, changeId: change.id, actor: 'principal-a', reason: 'Turned on on purpose for KEEL-RT' });
  assert.equal(accepted.resourceKey, RULE);
  assert.equal(accepted.alertId, (await alertOf(client, tenantRef, RULE)).id, 'names the alert still open, for the caller to settle');
  const row = (await approved(client, tenantRef)).get(RULE);
  assert.equal(row.fields.State, 'Enabled');
  assert.equal(row.collection_id, second, 'the read that found the change, not the one before');
  assert.equal(row.approved_by, 'principal-a');
  assert.equal(row.reason, 'Turned on on purpose for KEEL-RT');
  const { rows: [evidence] } = await client.query(
    `SELECT * FROM evidence WHERE tenant_ref = $1 AND kind = 'disposition' ORDER BY seq DESC LIMIT 1`, [tenantRef],
  );
  assert.equal(evidence.subject.serviceChangeId, change.id);
  assert.equal(evidence.subject.action, 'accept');

  const third = await read(client, tenantRef, { [RULE]: rule({ State: 'Enabled', WhenChangedUTC: '2026-10-20T00:00:00Z' }) });
  const quiet = await detectWorkloadDrift(client, { collectionId: third });
  assert.deepEqual([quiet.drift.length, quiet.outstanding, quiet.resolved], [0, 0, 1]);
  assert.equal((await alertOf(client, tenantRef, RULE)).state, 'resolved');

  const fourth = await read(client, tenantRef, { [RULE]: rule({ State: 'Disabled' }) });
  const again = await detectWorkloadDrift(client, { collectionId: fourth });
  assert.equal(again.drift.length, 1);
  assert.deepEqual(again.drift[0].fields.map((field) => [field.path, field.before, field.after]), [['State', 'Enabled', 'Disabled']]);
  assert.equal(again.drift[0].previousCollectionId, second);
  assert.equal((await alertOf(client, tenantRef, RULE)).state, 'reopened');
});

test('accepting a removal and an addition updates the approved setup', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  await detectWorkloadDrift(client, { collectionId: await read(client, tenantRef, { [RULE]: rule() }) });
  const second = await read(client, tenantRef, { [OTHER]: other() });
  await detectWorkloadDrift(client, { collectionId: second });
  const rows = await changes(client, tenantRef);
  assert.deepEqual(rows.map((row) => [row.resource_key, row.change_type]).sort(), [[OTHER, 'added'], [RULE, 'removed']]);

  for (const row of rows) await acceptServiceChange(client, { tenantRef, changeId: row.id, actor: 'principal-a', reason: 'Replaced the rule' });
  const now = await approved(client, tenantRef);
  assert.deepEqual([...now.keys()], [OTHER]);

  const third = await read(client, tenantRef, { [OTHER]: other() });
  const quiet = await detectWorkloadDrift(client, { collectionId: third });
  assert.deepEqual([quiet.drift.length, quiet.outstanding, quiet.resolved], [0, 0, 2]);
});

test('only the newest change on its own tenant, with a reason, is accepted', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  await detectWorkloadDrift(client, { collectionId: await read(client, tenantRef, { [RULE]: rule() }) });
  await detectWorkloadDrift(client, { collectionId: await read(client, tenantRef, { [RULE]: rule({ State: 'Enabled' }) }) });
  await detectWorkloadDrift(client, { collectionId: await read(client, tenantRef, { [RULE]: rule({ State: 'Enabled', Mode: 'Audit' }) }) });
  const [older, newer] = await changes(client, tenantRef);
  assert.ok(older && newer, 'a further change to the same setting is a new change');

  await assert.rejects(acceptServiceChange(client, { tenantRef, changeId: older.id, actor: 'principal-a', reason: 'ok' }), /newer change/);
  await assert.rejects(acceptServiceChange(client, { tenantRef: tenant(), changeId: newer.id, actor: 'principal-a', reason: 'ok' }), ServiceChangeError);
  await assert.rejects(acceptServiceChange(client, { tenantRef, changeId: newer.id, actor: 'principal-a', reason: '  ' }), /reason/);
  assert.equal((await approved(client, tenantRef)).get(RULE).fields.State, 'Disabled', 'nothing was accepted');
});

test('taking the approved setup keeps a waiting change at its earlier value', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  // Two reads compared read to read before the approved setup existed: one change still
  // waiting (alert open) and one a person already resolved.
  const first = await read(client, tenantRef, { [RULE]: rule(), [OTHER]: other() });
  const second = await read(client, tenantRef, { [RULE]: rule({ State: 'Enabled' }), [OTHER]: other({ Mode: 'Enforce' }) });
  const legacy = async (resourceKey, fields, state) => {
    await client.query(
      `INSERT INTO workload_drift (tenant_ref, workload, collection_id, previous_collection_id, resource_key, change_type, fields, blast_radius)
       VALUES ($1, $2, $3, $4, $5, 'modified', $6, 'access-affecting')`,
      [tenantRef, WORKLOAD, second, first, resourceKey, JSON.stringify(fields)],
    );
    await applyConditionEvent(client, {
      tenantRef, resourceKey: `${WORKLOAD}:${resourceKey}`, control: 'baseline', condition: 'drift', status: 'firing',
      eventId: `legacy:${resourceKey}:${tenantRef}`, occurredAt: new Date('2026-10-12T03:00:00Z'), source: 'workload-drift',
    });
    if (state === 'resolved') await client.query(`UPDATE alert SET state = 'resolved', condition_active = false WHERE tenant_ref = $1 AND resource_key = $2`, [tenantRef, `${WORKLOAD}:${resourceKey}`]);
  };
  await legacy(RULE, [{ path: 'State', kind: 'changed', before: 'Disabled', after: 'Enabled' }], 'open');
  await legacy(OTHER, [{ path: 'Mode', kind: 'changed', before: 'Audit', after: 'Enforce' }], 'resolved');

  const third = await read(client, tenantRef, { [RULE]: rule({ State: 'Enabled' }), [OTHER]: other({ Mode: 'Enforce' }) });
  const found = await detectWorkloadDrift(client, { collectionId: third });
  assert.deepEqual([found.drift.length, found.outstanding], [0, 1], 'the waiting change stays, and is not recorded twice');
  const now = await approved(client, tenantRef);
  assert.equal(now.get(RULE).fields.State, 'Disabled');
  assert.equal(now.get(RULE).collection_id, first);
  assert.equal(now.get(OTHER).fields.Mode, 'Enforce', 'a settled change is approved as read');
  assert.equal((await alertOf(client, tenantRef, RULE)).state, 'open');
});

test('a difference whose alert was resolved by hand is recorded again', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  await detectWorkloadDrift(client, { collectionId: await read(client, tenantRef, { [RULE]: rule() }) });
  await detectWorkloadDrift(client, { collectionId: await read(client, tenantRef, { [RULE]: rule({ State: 'Enabled' }) }) });
  await client.query(`UPDATE alert SET state = 'resolved', condition_active = false, resolved_at = now() WHERE tenant_ref = $1`, [tenantRef]);
  const next = await read(client, tenantRef, { [RULE]: rule({ State: 'Enabled' }) });
  const found = await detectWorkloadDrift(client, { collectionId: next });
  assert.equal(found.drift.length, 1, 'still not the approved value');
  assert.equal((await changes(client, tenantRef)).length, 2);
  assert.equal((await alertOf(client, tenantRef, RULE)).state, 'reopened');
});

test('a partial read resolves only the settings it read', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = tenant();
  await detectWorkloadDrift(client, { collectionId: await read(client, tenantRef, { [RULE]: rule(), [OTHER]: other() }) });
  await detectWorkloadDrift(client, { collectionId: await read(client, tenantRef, { [RULE]: rule({ State: 'Enabled' }), [OTHER]: other({ Mode: 'Enforce' }) }) });
  // The partial read has the rule back as approved and did not read the other one.
  const partial = await read(client, tenantRef, { [RULE]: rule() }, 'partial');
  const found = await detectWorkloadDrift(client, { collectionId: partial });
  assert.equal(found.resolved, 1);
  assert.equal((await alertOf(client, tenantRef, RULE)).state, 'resolved');
  assert.equal((await alertOf(client, tenantRef, OTHER)).state, 'open', 'not read, so not known to be put back');
});
