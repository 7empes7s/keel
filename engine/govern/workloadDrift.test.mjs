// Workload drift for SharePoint site settings: a change to a site's app grants between
// two scheduled workload collections is a workload_drift row and a `baseline / drift`
// alert, as a configuration change is for a snapshot.
//
// Acceptance:
//  - the first usable run has nothing to compare with and raises nothing;
//  - a run whose only change is a site's lastModifiedDateTime raises nothing;
//  - an app grant added to a site is one `modified` row and one open warning alert;
//  - detecting the same run again neither doubles the row nor refires the alert;
//  - a later run with no further change leaves the alert open;
//  - a failed run is skipped, and the next run compares with the last usable one;
//  - every collected workload raises drift, not only SharePoint: a mail flow rule's
//    setting change is an access-affecting row, a rename is cosmetic, and a move of
//    WhenChangedUTC alone raises nothing;
//  - workloads not tracked for drift (content reads) raise nothing.
// Mutation checks:
//  - compare with any previous run instead of the last usable one;
//  - count lastModifiedDateTime as a setting;
//  - resolve the alert when a run shows no further change.
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { WORKLOAD_DESCRIPTORS } from '../collect/workloadContract.mjs';
import { saveLedgerInputs } from '../collect/workloadLedgerStore.mjs';
import { SHAREPOINT_OPERATIONS, SHAREPOINT_WORKLOAD } from '../collect/workloads/sharepoint.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { DRIFT_WORKLOADS, detectWorkloadDrift } from './workloadDrift.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { readOnlyGraphTransport, runWorkloadCollection } from '../../cli/keel-workload-collect.mjs';

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

const HOST = 'contoso.sharepoint.com';
const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const SITE_ID = `${HOST},00000001-0000-4000-8000-000000000001,00000101-0000-4000-8000-000000000101`;
const SITE_KEY = `site:${SITE_ID}`;
const ALERT_KEY = `${SHAREPOINT_WORKLOAD}:${SITE_KEY}`;
const descriptor = (id) => WORKLOAD_DESCRIPTORS.find((item) => item.id === id);
const silent = { log() {} };
let tick = Date.parse('2026-10-12T02:00:00Z');
const clock = () => new Date((tick += 1000));

async function qualifySharePoint(client, tenantRef) {
  const capturedAt = '2026-10-07T11:09:31.077Z';
  const reads = SHAREPOINT_OPERATIONS.map((id) => ({
    operationId: id, kind: 'live-capture', synthetic: false, tenantRef, capturedAt,
    version: descriptor(id).operation.version, ok: true, error: null, observed: { pages: 1 }, proofRef: 'fixture',
  }));
  const grants = {
    permissions: [...new Set(SHAREPOINT_OPERATIONS.flatMap((id) => descriptor(id).rbac.permissions))],
    roles: [...new Set(SHAREPOINT_OPERATIONS.flatMap((id) => descriptor(id).rbac.roles))],
  };
  await saveLedgerInputs(client, { tenantRef, evidence: reads, grants });
}

/** A fake SharePoint Graph with one KEEL-RT- site whose state a test can change. */
function fakeSharePoint() {
  const state = { grants: [], lastModified: '2026-10-01T00:00:00Z', discoveryDenied: false };
  const fetchImpl = async (url) => {
    const path = decodeURIComponent(new URL(url).pathname).replace('/v1.0', '');
    let status = 200;
    let body;
    if (path === '/admin/sharepoint/settings') {
      body = { sharingCapability: 'externalUserSharingOnly', sharingDomainRestrictionMode: 'none', sharingAllowedDomainList: [], sharingBlockedDomainList: [], isResharingByExternalUsersEnabled: false };
    } else if (path === '/sites/getAllSites') {
      if (state.discoveryDenied) { status = 403; body = { error: { code: 'accessDenied' } }; } else {
        body = { value: [{ id: SITE_ID, webUrl: `https://${HOST}/sites/KEEL-RT-perms`, displayName: 'KEEL-RT-perms' }] };
      }
    } else if (path === `/sites/${SITE_ID}/permissions`) {
      body = { value: state.grants };
    } else if (path === `/sites/${SITE_ID}`) {
      body = {
        id: SITE_ID, name: 'KEEL-RT-perms', displayName: 'KEEL-RT-perms', webUrl: `https://${HOST}/sites/KEEL-RT-perms`,
        createdDateTime: '2025-01-01T00:00:00Z', lastModifiedDateTime: state.lastModified, siteCollection: { hostname: HOST },
      };
    } else { status = 404; body = { error: { code: 'itemNotFound' } }; }
    return { status, headers: new Headers(), text: async () => JSON.stringify(body) };
  };
  return { state, fetchImpl };
}

async function run(client, tenantRef, graph) {
  const result = await runWorkloadCollection(client, {
    tenantRef, config: { tenantId: TENANT_ID }, scope: { sharepointHost: HOST },
    transport: readOnlyGraphTransport(async () => 'token', graph.fetchImpl), now: clock, logger: silent,
  });
  return result.runs.find((item) => item.workload === SHAREPOINT_WORKLOAD);
}

const driftRows = async (client, tenantRef) => (await client.query(
  'SELECT * FROM workload_drift WHERE tenant_ref = $1 ORDER BY detected_at, id', [tenantRef],
)).rows;
const alerts = async (client, tenantRef) => (await client.query(
  `SELECT * FROM alert WHERE tenant_ref = $1 AND control = 'baseline' AND condition = 'drift'`, [tenantRef],
)).rows;

test('an app grant added to a site is a drift row and an open alert', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = `sha256:wd-${crypto.randomUUID()}`;
  await qualifySharePoint(client, tenantRef);
  const graph = fakeSharePoint();

  const first = await run(client, tenantRef, graph);
  assert.equal(first.outcome, 'complete');
  assert.deepEqual(first.drift, { status: 'first-run', changes: 0 });

  graph.state.lastModified = '2026-10-12T01:00:00Z';
  const touched = await run(client, tenantRef, graph);
  assert.deepEqual(touched.drift, { status: 'detected', changes: 0 }, 'lastModifiedDateTime is not a setting');

  graph.state.grants = [{ id: 'grant-1', roles: ['write'], grantedToIdentitiesV2: [{ application: { id: 'app-1', displayName: 'KEEL-RT-app' } }] }];
  const granted = await run(client, tenantRef, graph);
  assert.deepEqual(granted.drift, { status: 'detected', changes: 1 });

  const [row, ...more] = await driftRows(client, tenantRef);
  assert.equal(more.length, 0);
  assert.equal(row.workload, SHAREPOINT_WORKLOAD);
  assert.equal(row.resource_key, SITE_KEY);
  assert.equal(row.change_type, 'modified');
  assert.equal(row.blast_radius, 'access-affecting');
  assert.equal(row.collection_id, granted.collectionId);
  assert.equal(row.previous_collection_id, touched.collectionId);
  assert.deepEqual(row.fields.map((field) => field.path), ['appPermissionGrants']);
  assert.deepEqual(row.fields[0].before, []);
  assert.equal(row.fields[0].after[0].applications[0].displayName, 'KEEL-RT-app');

  const [alert, ...others] = await alerts(client, tenantRef);
  assert.equal(others.length, 0);
  assert.equal(alert.resource_key, ALERT_KEY);
  assert.equal(alert.state, 'open');
  assert.equal(alert.condition_active, true);
  assert.equal(alert.severity, 'warning');
  assert.equal(alert.detail.resourceType, SHAREPOINT_WORKLOAD);
  assert.equal(alert.detail.changeType, 'modified');
  assert.deepEqual(alert.detail.fields, ['appPermissionGrants']);

  // Detecting the same run again changes nothing.
  const again = await detectWorkloadDrift(client, { collectionId: granted.collectionId });
  assert.equal(again.drift.length, 1);
  assert.equal((await driftRows(client, tenantRef)).length, 1);
  assert.equal((await alerts(client, tenantRef))[0].firing_count, alert.firing_count);

  // No further change: nothing new, and the alert stays open for a person to handle.
  const quiet = await run(client, tenantRef, graph);
  assert.deepEqual(quiet.drift, { status: 'detected', changes: 0 });
  const [still] = await alerts(client, tenantRef);
  assert.equal(still.state, 'open');
  assert.equal(still.condition_active, true);

  // Removing the grant is drift again, on the same alert.
  graph.state.grants = [];
  const removed = await run(client, tenantRef, graph);
  assert.deepEqual(removed.drift, { status: 'detected', changes: 1 });
  assert.equal((await driftRows(client, tenantRef)).length, 2);
  const [refired, ...none] = await alerts(client, tenantRef);
  assert.equal(none.length, 0);
  assert.equal(refired.firing_count, alert.firing_count + 1);
});

test('a failed run is skipped and the next run compares with the last usable one', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = `sha256:wd-${crypto.randomUUID()}`;
  await qualifySharePoint(client, tenantRef);
  const graph = fakeSharePoint();

  const first = await run(client, tenantRef, graph);
  graph.state.discoveryDenied = true;
  const failed = await run(client, tenantRef, graph);
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.drift, { status: 'not-usable', changes: 0 });

  graph.state.discoveryDenied = false;
  graph.state.grants = [{ id: 'grant-2', roles: ['read'], grantedToIdentitiesV2: [{ application: { id: 'app-2', displayName: 'KEEL-RT-reader' } }] }];
  const next = await run(client, tenantRef, graph);
  assert.deepEqual(next.drift, { status: 'detected', changes: 1 });
  const [row] = await driftRows(client, tenantRef);
  assert.equal(row.previous_collection_id, first.collectionId, 'compared with the last usable run, not the failed one');
  assert.equal((await alerts(client, tenantRef)).length, 1);
});

async function storedRun(client, tenantRef, workload, at, observations) {
  const { rows: [collection] } = await client.query(
    `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
     VALUES ($1, $2, 'complete', $3, $3, $3) RETURNING id`,
    [tenantRef, workload, at],
  );
  for (const [resourceKey, fields] of Object.entries(observations)) {
    await client.query(
      `INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, $2, $3)`,
      [collection.id, resourceKey, fields],
    );
  }
  return collection.id;
}

test('every collected workload raises drift', () => {
  for (const { workload } of WORKLOAD_COLLECTORS) assert.ok(DRIFT_WORKLOADS[workload], `${workload} raises drift`);
});

test('a mail flow rule change is drift; a rename is cosmetic; WhenChangedUTC alone is not a change', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = `sha256:wd-${crypto.randomUUID()}`;
  const rule = (over) => ({ identity: 'KEEL-RT-rule', kind: 'transportRule', Name: 'KEEL-RT-rule', State: 'Disabled', Mode: 'Enforce', WhenChangedUTC: '2026-10-01T00:00:00Z', ...over });
  const connector = (over) => ({ identity: 'KEEL-RT-connector', kind: 'inboundConnector', Name: 'KEEL-RT-connector', Enabled: false, WhenChangedUTC: '2026-10-01T00:00:00Z', ...over });
  await storedRun(client, tenantRef, 'exchange-mail-flow', '2026-10-12T02:00:00Z', {
    'transport-rule:KEEL-RT-rule': rule({}), 'inbound-connector:KEEL-RT-connector': connector({}), 'remote-domain:Default': { identity: 'Default', kind: 'remoteDomain', AutoForwardEnabled: false, WhenChangedUTC: '2026-10-01T00:00:00Z' },
  });
  const second = await storedRun(client, tenantRef, 'exchange-mail-flow', '2026-10-13T02:00:00Z', {
    'transport-rule:KEEL-RT-rule': rule({ State: 'Enabled', WhenChangedUTC: '2026-10-12T09:00:00Z' }),
    'inbound-connector:KEEL-RT-connector': connector({ Name: 'KEEL-RT-connector renamed', WhenChangedUTC: '2026-10-12T09:00:00Z' }),
    'remote-domain:Default': { identity: 'Default', kind: 'remoteDomain', AutoForwardEnabled: false, WhenChangedUTC: '2026-10-12T09:30:00Z' },
  });
  const result = await detectWorkloadDrift(client, { collectionId: second });
  assert.equal(result.status, 'detected');
  const rows = await driftRows(client, tenantRef);
  assert.deepEqual(rows.map((row) => [row.workload, row.resource_key, row.change_type, row.blast_radius]).sort(), [
    ['exchange-mail-flow', 'inbound-connector:KEEL-RT-connector', 'modified', 'cosmetic'],
    ['exchange-mail-flow', 'transport-rule:KEEL-RT-rule', 'modified', 'access-affecting'],
  ]);
  const rule_ = rows.find((row) => row.resource_key.startsWith('transport-rule:'));
  assert.deepEqual(rule_.fields.map((field) => [field.path, field.before, field.after]), [['State', 'Disabled', 'Enabled']]);
  const keys = (await alerts(client, tenantRef)).map((alert) => alert.resource_key).sort();
  assert.deepEqual(keys, ['exchange-mail-flow:inbound-connector:KEEL-RT-connector', 'exchange-mail-flow:transport-rule:KEEL-RT-rule']);
});

test('workloads not tracked for drift raise nothing', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = `sha256:wd-${crypto.randomUUID()}`;
  const ids = [];
  for (const at of ['2026-10-12T02:00:00Z', '2026-10-13T02:00:00Z']) {
    ids.push(await storedRun(client, tenantRef, 'exchange-mail', at, { org: { org: { value: ids.length } } }));
  }
  const result = await detectWorkloadDrift(client, { collectionId: ids[1] });
  assert.equal(result.status, 'not-tracked');
  assert.deepEqual([(await driftRows(client, tenantRef)).length, (await alerts(client, tenantRef)).length], [0, 0]);
});
