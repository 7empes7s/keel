/** Connections data (delegated-access DESIGN 3.4, build step 2) over the fixture
 * Microsoft Graph: the real setup host observes, connections are derived and recorded,
 * and every change leaves an access_event. Nothing here is live evidence. */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createGraphSetupHost } from './graphHost.mjs';
import { CONNECTION_APPS, certificateExpiry, deriveConnection, loadConnections, syncConnections } from './connections.mjs';
import {
  COLLECTOR_APP_ID, CONTENT_READER_APP_ID, CONTENT_READER_SCOPES, RESTORER_APP_ID, TENANT_ID, fakeGetToken, fixtureTenant,
  installFixtureGraph, writesIn,
} from '../test/setupGraphFixture.mjs';

const tenantRef = 'sha256:connections-fixture';
const NOW = new Date('2026-10-22T12:00:00Z');
const config = (clientId, name) => ({ tenantId: TENANT_ID, clientId, certPath: `/etc/keel/${name}.crt`, keyPath: `/etc/keel/${name}.key` });
const EXPIRY = {
  '/etc/keel/collector.crt': '2027-01-20T00:00:00.000Z',
  '/etc/keel/restorer.crt': '2026-10-01T00:00:00.000Z',
  '/etc/keel/content.crt': null,
};

function host({ contentReader = true } = {}) {
  return createGraphSetupHost({
    tenantRef, tenantId: TENANT_ID,
    collector: { config: config(COLLECTOR_APP_ID, 'collector'), credentialRef: 'file:/etc/keel/tenant.json' },
    restorer: { config: config(RESTORER_APP_ID, 'restorer'), credentialRef: 'file:/etc/keel/restorer.json' },
    contentReader: contentReader ? { config: config(CONTENT_READER_APP_ID, 'content'), credentialRef: 'file:/etc/keel/content-reader.json' } : null,
    build: 'fixture-build-1', getToken: fakeGetToken(), killSwitchPath: join(tmpdir(), 'keel-connections-no-kill-switch'),
    readCertificateExpiry: (path) => EXPIRY[path] ?? null,
  });
}

async function database(t) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  await client.query(schemaSql());
  return client;
}

const events = async (client) => (await client.query(`SELECT c.role, e.action, e.actor, e.before, e.after
  FROM access_event e JOIN access_connection c ON c.id = e.connection_id ORDER BY e.id`)).rows;
const byRole = (connections) => Object.fromEntries(connections.map((c) => [c.role, c]));

test('derive: unknown is never absent, and each state comes from what was observed', () => {
  assert.equal(deriveConnection({ identity: 'collector', appId: null, plan: null }).state, 'not-created');
  assert.equal(deriveConnection({ identity: 'collector', appId: COLLECTOR_APP_ID, plan: null }).state, 'not-checked');
  assert.equal(deriveConnection({ identity: 'collector', appId: COLLECTOR_APP_ID, plan: null,
    credentialExpiresAt: '2026-10-01T00:00:00Z', now: NOW }).state, 'needs-reconnect');

  const plan = (fields = {}, roles = []) => ({ steps: [
    { kind: 'registration', identity: 'collector', reference: { appId: COLLECTOR_APP_ID, displayName: 'KEEL Collector' },
      servicePrincipalObjectId: 'sp-1', ...fields.registration },
    { kind: 'graph-permission', identity: 'collector', requiredScopes: ['A', 'B'], consentedScopes: ['A', 'B'], missingScopes: [],
      excessScopes: [], ...fields.consent },
    ...roles.map((status) => ({ kind: 'workload-rbac', identity: 'collector', name: 'Read Only Operator', status })),
  ] });
  const derive = (p, extra = {}) => deriveConnection({ identity: 'collector', appId: COLLECTOR_APP_ID, plan: p,
    servicePrincipals: [{ id: 'sp-1' }], now: NOW, ...extra });

  assert.equal(derive(plan()).state, 'working');
  assert.equal(derive(plan({ registration: { reference: null, servicePrincipalObjectId: null } })).state, 'not-created');
  assert.equal(derive(plan({ registration: { servicePrincipalObjectId: null } })).state, 'waiting-for-consent');
  assert.equal(derive(plan({ consent: { consentedScopes: [], missingScopes: ['A', 'B'] } })).state, 'waiting-for-consent');
  assert.equal(derive(plan({ consent: { consentedScopes: ['A'], missingScopes: ['B'] } })).state, 'missing-permission');
  assert.equal(derive(plan({}, ['pending-manual'])).state, 'missing-permission');
  // A role Keel cannot see is not called missing.
  const unseen = derive(plan({}, ['pending-manual']), { uncheckedKinds: ['workload-rbac'] });
  assert.equal(unseen.state, 'working');
  assert.equal(unseen.observed.missingRoles, null);
  assert.equal(derive(plan(), { servicePrincipals: [{ id: 'sp-1', accountEnabled: false }] }).state, 'switched-off');
  assert.equal(derive(plan(), { credentialExpiresAt: '2026-10-01T00:00:00Z' }).state, 'needs-reconnect');
  assert.deepEqual(derive(plan()).wanted, { permissions: ['A', 'B'], roles: [] });
});

test('certificate expiry is read from the host certificate file; an unreadable file is null', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'keel-connections-cert-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cert = join(directory, 'app.crt');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'app.key'),
    '-out', cert, '-days', '30', '-subj', '/CN=KEEL-RT-connections'], { encoding: 'utf8' });
  if (made.status !== 0) return t.skip('openssl is not available');
  const expiry = Date.parse(certificateExpiry(cert));
  const days = (expiry - Date.now()) / 86_400_000;
  assert.ok(days > 29 && days <= 30.01, `expected about 30 days, got ${days}`);
  assert.equal(certificateExpiry(join(directory, 'missing.crt')), null);
  assert.equal(certificateExpiry(join(directory, 'app.key')), null);
  assert.equal(certificateExpiry(undefined), null);
});

test('setup host: the content reader is observed only, and must be its own app in the same tenant', () => {
  const composed = host();
  assert.deepEqual(composed.apps.collector, { appId: COLLECTOR_APP_ID, credentialRef: 'file:/etc/keel/tenant.json', credentialExpiresAt: EXPIRY['/etc/keel/collector.crt'] });
  assert.equal(composed.apps['content-reader'].appId, CONTENT_READER_APP_ID);
  assert.equal(host({ contentReader: false }).apps['content-reader'], null);
  assert.doesNotMatch(JSON.stringify(composed.apps), /\.key|\.crt/, 'no certificate or key path leaves the host');
  assert.deepEqual(Object.keys(composed.credentials).sort(), ['collector', 'restorer'], 'nothing writes as or for the content reader');
  const build = (contentReader) => () => createGraphSetupHost({
    tenantRef, tenantId: TENANT_ID,
    collector: { config: config(COLLECTOR_APP_ID, 'collector'), credentialRef: 'file:/c' },
    restorer: { config: config(RESTORER_APP_ID, 'restorer'), credentialRef: 'file:/r' },
    contentReader, build: 'b', getToken: fakeGetToken(),
  });
  assert.throws(build({ config: config(COLLECTOR_APP_ID, 'content'), credentialRef: 'file:/x' }), /its own app registration/);
  assert.throws(build({ config: { ...config(CONTENT_READER_APP_ID, 'content'), tenantId: 'other' }, credentialRef: 'file:/x' }), /another tenant/);
  assert.throws(build({ config: { tenantId: TENANT_ID, clientId: 'nope' }, credentialRef: 'file:/x' }), /app id/);
});

test('sync: the three apps are recorded with state and certificate expiry, and only changes write events', async (t) => {
  const client = await database(t);
  const tenant = fixtureTenant({ contentReaderScopes: CONTENT_READER_SCOPES.filter((scope) => scope !== 'Tasks.Read.All') });
  t.after(installFixtureGraph(tenant));

  let composed = host();
  await syncConnections(client, { tenantRef, apps: composed.apps, readers: composed.readers, now: NOW });
  assert.deepEqual(writesIn(tenant), [], 'recording connections never writes to the tenant');
  let connections = await loadConnections(client, { tenantRef, now: NOW });
  assert.deepEqual(connections.map((c) => c.role), CONNECTION_APPS.map((app) => app.role), 'required first, in a fixed order');
  let view = byRole(connections);
  assert.equal(view['settings-reader'].state, 'working');
  assert.equal(view['settings-reader'].required, true);
  assert.equal(view['settings-reader'].appId, COLLECTOR_APP_ID);
  assert.equal(view['settings-reader'].credentialExpiresAt, '2027-01-20T00:00:00.000Z');
  assert.equal(view['settings-reader'].credentialExpiresInDays, 89);
  assert.equal(view['settings-restorer'].state, 'needs-reconnect', 'an expired certificate needs reconnecting');
  assert.equal(view['settings-restorer'].credentialExpiresInDays, -22);
  assert.equal(view['content-reader'].state, 'missing-permission');
  assert.deepEqual(view['content-reader'].observed.missingPermissions, ['Tasks.Read.All']);
  assert.equal(view['content-reader'].credentialExpiresAt, null, 'an unreadable certificate is unknown, not expired');
  assert.equal(view['content-reader'].observed.displayName, 'KEEL Content Reader');
  assert.doesNotMatch(JSON.stringify(connections), /etc\/keel|credentialRef/, 'no credential path reaches the portal');
  assert.deepEqual((await events(client)).map((e) => [e.role, e.action, e.actor]), [
    ['settings-reader', 'recorded', 'keel:setup-check'],
    ['content-reader', 'recorded', 'keel:setup-check'],
    ['settings-restorer', 'recorded', 'keel:setup-check'],
  ]);

  // The same tenant read again changes nothing: no new event.
  composed = host();
  await syncConnections(client, { tenantRef, apps: composed.apps, readers: composed.readers, now: new Date(NOW.getTime() + 60_000) });
  assert.equal((await events(client)).length, 3);
  view = byRole(await loadConnections(client, { tenantRef }));
  assert.equal(view['settings-reader'].observed.at, new Date(NOW.getTime() + 60_000).toISOString(), 'the observation time still moves');

  // The admin grants the missing permission: one state change, with before and after.
  const contentSp = tenant.sps.get(CONTENT_READER_APP_ID).id;
  const graphSp = tenant.graphSp;
  tenant.grants.get(contentSp).push({ id: 'grant-tasks', principalId: contentSp, resourceId: graphSp.id,
    appRoleId: graphSp.appRoles.find((role) => role.value === 'Tasks.Read.All').id });
  composed = host();
  await syncConnections(client, { tenantRef, apps: composed.apps, readers: composed.readers, now: NOW });
  const changed = (await events(client)).slice(3);
  assert.deepEqual(changed.map((e) => [e.role, e.action]), [['content-reader', 'state-changed']]);
  assert.equal(changed[0].before.state, 'missing-permission');
  assert.equal(changed[0].after.state, 'working');
  assert.deepEqual(changed[0].before.observed.missingPermissions, ['Tasks.Read.All']);
  assert.deepEqual(changed[0].after.observed.missingPermissions, []);

  // The tenant cannot be read: nothing is claimed, the last observation stands.
  await syncConnections(client, { tenantRef, apps: composed.apps, readers: null, now: NOW });
  const failing = { ...composed.readers, listApplications: async () => { throw new Error('graph down'); } };
  await syncConnections(client, { tenantRef, apps: composed.apps, readers: failing, now: NOW });
  assert.equal((await events(client)).length, 4);
  assert.equal(byRole(await loadConnections(client, { tenantRef }))['content-reader'].state, 'working');

  // The service principal is switched off in Entra.
  tenant.sps.get(COLLECTOR_APP_ID).accountEnabled = false;
  composed = host();
  await syncConnections(client, { tenantRef, apps: composed.apps, readers: composed.readers, now: NOW });
  assert.equal(byRole(await loadConnections(client, { tenantRef }))['settings-reader'].state, 'switched-off');
});

test('sync: without a content-reader file it is not created, and a first look without a tenant read is not checked', async (t) => {
  const client = await database(t);
  const composed = host({ contentReader: false });
  await syncConnections(client, { tenantRef, apps: composed.apps, readers: null, now: NOW });
  const view = byRole(await loadConnections(client, { tenantRef, now: NOW }));
  assert.equal(view['settings-reader'].state, 'not-checked');
  assert.equal(view['settings-restorer'].state, 'needs-reconnect');
  assert.equal(view['content-reader'].state, 'not-created');
  assert.equal(view['content-reader'].appId, null);
});
