/** Task-76 production setup host: boundary coverage over a fixture Microsoft
 * Graph (engine/test/setupGraphFixture.mjs). The real GraphReader, GraphWriter,
 * planner, executor and journal run unchanged; only fetch is the fixture.
 * Nothing here is live evidence.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { planBootstrap } from '../bootstrap/plan.mjs';
import { BootstrapJournal, migrateBootstrapJournal } from '../bootstrap/journal.mjs';
import { approveBootstrapPlan, executeBootstrap } from '../bootstrap/execute.mjs';
import { loadSetupState } from '../bootstrap/onboarding.mjs';
import { createGraphSetupHost, parseSetupOperations } from '../bootstrap/graphHost.mjs';
import {
  COLLECTOR_APP_ID, OPERATOR_ID, RESTORER_APP_ID, TENANT_ID, fakeGetToken, fixtureTenant, installFixtureGraph, writesIn,
} from '../test/setupGraphFixture.mjs';

const tenantRef = 'sha256:setup-host-fixture';
const missingKillSwitch = join(tmpdir(), 'keel-setup-host-no-kill-switch');
const collectorConfig = { tenantId: TENANT_ID, clientId: COLLECTOR_APP_ID, certPath: '/etc/keel/collector.crt', keyPath: '/etc/keel/collector.key' };
const restorerConfig = { tenantId: TENANT_ID, clientId: RESTORER_APP_ID, certPath: '/etc/keel/restorer.crt', keyPath: '/etc/keel/restorer.key' };

function host(options = {}) {
  return createGraphSetupHost({
    tenantRef, tenantId: TENANT_ID,
    collector: { config: collectorConfig, credentialRef: 'file:/etc/keel/tenant-target.json' },
    restorer: { config: restorerConfig, credentialRef: 'file:/etc/keel/restorer-target.json' },
    build: 'fixture-build-1', getToken: fakeGetToken(), killSwitchPath: missingKillSwitch,
    ...options,
  });
}

function graph(t, tenant) {
  const restore = installFixtureGraph(tenant);
  t.after(restore);
  return tenant;
}

async function database(t) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const { rows: [owner] } = await client.query("INSERT INTO principal(email, display_name) VALUES ('owner@example.test', 'Setup Owner') RETURNING *");
  await client.query("INSERT INTO role_grant(principal_id, role, granted_by, reason) VALUES ($1, 'admin', 'fixture', 'fixture'), ($1, 'approver', 'fixture', 'fixture')", [owner.id]);
  await migrateBootstrapJournal(client);
  return { db, client, owner };
}

async function run({ client, owner, setupHost, workloads }) {
  const journal = new BootstrapJournal({ client, tenantRef, principalId: owner.id });
  const plan = await planBootstrap({ tenantRef, workloads, readAdapters: setupHost.readers, operatorPrincipalId: setupHost.operatorPrincipalId });
  const artifactId = await approveBootstrapPlan({ journal, plan, credentials: setupHost.credentials, adapters: setupHost.adapters,
    build: setupHost.build, qualificationMode: setupHost.qualificationMode });
  const result = await executeBootstrap({ journal, artifactId, adapters: setupHost.adapters, build: setupHost.build,
    qualificationMode: setupHost.qualificationMode, killSwitchPath: missingKillSwitch }).catch((error) => ({ error }));
  const { rows: events } = await client.query('SELECT step_id, state FROM bootstrap_event WHERE artifact_id = $1 ORDER BY id', [artifactId]);
  return { plan, artifactId, result, events };
}

test('configuration: separate reference-only credentials, and every write operation disabled unless named', () => {
  const composed = host();
  assert.deepEqual(composed.credentials, {
    collector: { credentialRef: 'file:/etc/keel/tenant-target.json', identityRef: COLLECTOR_APP_ID },
    restorer: { credentialRef: 'file:/etc/keel/restorer-target.json', identityRef: RESTORER_APP_ID },
  });
  assert.equal(composed.qualificationMode, 'live-qualified');
  assert.doesNotMatch(JSON.stringify(composed.credentials), /\.key|\.crt/, 'only the config file is referenced');
  assert.deepEqual(parseSetupOperations({}), {});
  assert.deepEqual(parseSetupOperations({ 'grant-consent': { enabled: false } }), {});
  assert.throws(() => parseSetupOperations({ 'create-registration': { enabled: true, qualification: 'live-qualified', expiresAt: '2099-01-01' } }), /not an operation/);
  assert.throws(() => parseSetupOperations({ 'grant-consent': { enabled: true } }), /qualification/);
  assert.throws(() => parseSetupOperations({ 'grant-consent': 'yes' }), /enabled must be/);
  assert.throws(() => host({ restorer: { config: { ...restorerConfig, clientId: COLLECTOR_APP_ID }, credentialRef: 'file:/r' } }), /separate/);
  assert.throws(() => host({ restorer: { config: { ...restorerConfig, keyPath: collectorConfig.keyPath }, credentialRef: 'file:/r' } }), /separate/);
  assert.throws(() => host({ collector: { config: { ...collectorConfig, tenantId: 'other' }, credentialRef: 'file:/c' } }), /another tenant/);
  assert.throws(() => host({ build: null }), /build/);
});

test('readers and observation only ever GET from Graph, with a token for this tenant', async (t) => {
  const tenant = graph(t, fixtureTenant());
  const composed = host({ operatorPrincipalId: OPERATOR_ID });
  const plan = await planBootstrap({ tenantRef, workloads: ['entra-collect', 'intune-collect', 'entra-restore'],
    readAdapters: composed.readers, operatorPrincipalId: OPERATOR_ID });
  for (const step of plan.steps) {
    await composed.adapters.observe({ tenantRef, plan, step, credentials: composed.credentials });
  }
  assert.ok(tenant.requests.length > 20);
  assert.deepEqual(writesIn(tenant), [], 'no request other than GET');
  assert.ok(tenant.requests.every((request) => request.host === 'graph.microsoft.com'));

  // The existing registrations are reused by app id, under their real names.
  const registration = plan.steps.find((step) => step.kind === 'registration' && step.identity === 'collector');
  assert.equal(registration.status, 'satisfied');
  assert.equal(registration.action, 'reuse-existing');
  assert.equal(registration.reference.displayName, 'KEEL Collector');
  assert.equal(registration.reference.appId, COLLECTOR_APP_ID);
  assert.ok(plan.steps.filter((step) => step.kind !== 'pim-activation').every((step) => step.status === 'satisfied'));

  // A token issued for another tenant is refused before anything is read.
  const other = host({ getToken: fakeGetToken('99999999-9999-4999-8999-999999999999') });
  const before = tenant.requests.length;
  await assert.rejects(other.readers.listApplications(), /another tenant/);
  assert.equal(tenant.requests.length, before);
});

test('a fully satisfied tenant completes the read setup with a run id and no write', async (t) => {
  const tenant = graph(t, fixtureTenant());
  const { client, owner } = await database(t);
  const composed = host();
  const read = await run({ client, owner, setupHost: composed, workloads: ['entra-collect', 'intune-collect'] });
  assert.equal(read.result.status, 'complete', read.result.error?.message);
  assert.equal(read.result.artifactId, read.artifactId);
  assert.match(read.artifactId, /^[0-9a-f]{64}$/);
  assert.equal(read.events.at(-1).state, 'complete');
  assert.ok(read.events.some((event) => event.state === 'verified'));
  assert.deepEqual(writesIn(tenant), []);

  const state = await loadSetupState(client, { tenantRef, viewerId: owner.id, readers: host().readers });
  const scope = state.scopes.find((candidate) => candidate.scope === 'read');
  assert.equal(scope.run.artifactId, read.artifactId);
  assert.equal(scope.run.state, 'complete');
  assert.ok(scope.steps.every((step) => step.progress === 'done'));
  assert.equal(state.collect.allowed, true);
});

test('unsatisfied manual steps report pending-manual and nothing is written', async (t) => {
  const tenant = graph(t, fixtureTenant({ intuneAssigned: false, operatorActive: false, operatorEligible: true }));
  const { client, owner } = await database(t);
  const composed = host({ operatorPrincipalId: OPERATOR_ID });

  const intune = await run({ client, owner, setupHost: composed, workloads: ['entra-collect', 'intune-collect'] });
  assert.equal(intune.result.status, 'pending-manual');
  assert.equal(intune.plan.steps.find((step) => step.id === intune.result.stepId).kind, 'workload-rbac');

  // PIM eligibility is visible but is not an active role: still waiting.
  const restore = await run({ client, owner, setupHost: composed, workloads: ['entra-restore'] });
  assert.equal(restore.plan.steps.find((step) => step.kind === 'pim-activation').status, 'satisfied', 'the planner sees eligibility');
  assert.equal(restore.result.status, 'pending-manual');
  assert.equal(restore.events.at(-1).state, 'pending-manual');
  assert.deepEqual(writesIn(tenant), []);

  const state = await loadSetupState(client, { tenantRef, viewerId: owner.id, readers: host().readers });
  assert.equal(state.scopes.find((scope) => scope.scope === 'restore').run.state, 'waiting-for-you');
});

test('an active Global Administrator satisfies the Privileged Role Administrator step; another role does not', async (t) => {
  const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
  const GLOBAL_READER = 'f2ef992c-3afb-46b9-b7cf-a126ee74c451';
  const tenant = graph(t, fixtureTenant({ operatorActive: false, operatorEligible: false }));
  const { client, owner } = await database(t);
  const composed = host({ operatorPrincipalId: OPERATOR_ID });

  tenant.directoryRoles.push({ principalId: OPERATOR_ID, roleDefinitionId: GLOBAL_READER, directoryScopeId: '/' });
  const reader = await run({ client, owner, setupHost: composed, workloads: ['entra-restore'] });
  assert.equal(reader.plan.steps.find((step) => step.kind === 'pim-activation').status, 'pending-manual');
  assert.equal(reader.result.status, 'pending-manual');

  tenant.directoryRoles.push({ principalId: OPERATOR_ID, roleDefinitionId: GLOBAL_ADMIN, directoryScopeId: '/' });
  // A fresh host, as the portal composes per request: its readers see the new role.
  const admin = await run({ client, owner, setupHost: host({ operatorPrincipalId: OPERATOR_ID }), workloads: ['entra-restore'] });
  assert.equal(admin.plan.steps.find((step) => step.kind === 'pim-activation').status, 'satisfied');
  assert.equal(admin.result.status, 'complete', admin.result.error?.message);
  assert.deepEqual(writesIn(tenant), []);
});

test('an unreadable Intune role check is not checked, never missing; the run stops without writing', async (t) => {
  const tenant = graph(t, fixtureTenant({ intuneReadable: false }));
  const { client, owner } = await database(t);
  const state = await loadSetupState(client, { tenantRef, viewerId: owner.id, readers: host().readers });
  const read = state.scopes.find((scope) => scope.scope === 'read');
  assert.equal(read.steps.find((step) => step.kind === 'workload-rbac').progress, 'not-checked');
  assert.equal(read.steps.find((step) => step.kind === 'registration').progress, 'done');

  const both = await run({ client, owner, setupHost: host(), workloads: ['entra-collect', 'intune-collect'] });
  assert.match(both.result.error?.message ?? '', /Intune role assignments could not be read/);
  assert.equal(both.events.at(-1).state, 'stopped');
  // Entra-only read setup is still eligible.
  const entra = await run({ client, owner, setupHost: host(), workloads: ['entra-collect'] });
  assert.equal(entra.result.status, 'complete');
  assert.deepEqual(writesIn(tenant), []);
});

test("the restorer's over-broad grant is reported as observed, not fixed", async (t) => {
  const tenant = graph(t, fixtureTenant({ operatorActive: true, restorerExtra: ['MailboxSettings.ReadWrite', 'Directory.ReadWrite.All'] }));
  const { client, owner } = await database(t);
  const composed = host({ operatorPrincipalId: OPERATOR_ID });
  const restore = await run({ client, owner, setupHost: composed, workloads: ['entra-restore'] });
  const consent = restore.plan.steps.find((step) => step.kind === 'graph-permission');
  assert.deepEqual(consent.excessScopes, ['Directory.ReadWrite.All', 'MailboxSettings.ReadWrite']);
  assert.deepEqual(consent.missingScopes, []);
  assert.equal(restore.result.status, 'complete', restore.result.error?.message);
  assert.deepEqual(writesIn(tenant), [], 'nothing is removed or narrowed');
  const restorerSp = tenant.sps.get(RESTORER_APP_ID).id;
  assert.equal(tenant.grants.get(restorerSp).length, 5, 'the extra grants are still there');

  const state = await loadSetupState(client, { tenantRef, viewerId: owner.id, readers: host().readers });
  const restoreScope = state.scopes.find((scope) => scope.scope === 'restore');
  assert.equal(restoreScope.run.state, 'complete');
  assert.ok(restoreScope.steps.every((step) => step.progress === 'done'));
  const fresh = await loadSetupState(client, { tenantRef: 'sha256:setup-host-other', viewerId: owner.id, readers: host({ tenantRef: 'sha256:setup-host-other' }).readers });
  assert.deepEqual(fresh.scopes.find((scope) => scope.scope === 'restore').steps.find((step) => step.kind === 'graph-permission').excessScopes,
    ['Directory.ReadWrite.All', 'MailboxSettings.ReadWrite'], 'the setup page carries the extra grants');
});

test('disabled write adapters never write; an enabled operation writes only the missing grant', async (t) => {
  const tenant = graph(t, fixtureTenant({ collectorScopes: ['User.Read.All', 'Group.Read.All', 'RoleManagement.Read.Directory', 'DeviceManagementConfiguration.Read.All', 'DeviceManagementManagedDevices.Read.All'] }));
  const { client, owner } = await database(t);

  // Default: consent is missing a scope and grant-consent is disabled.
  const disabled = await run({ client, owner, setupHost: host(), workloads: ['entra-collect'] });
  assert.match(disabled.result.error?.message ?? '', /not qualified/);
  assert.equal(disabled.events.at(-1).state, 'stopped');
  assert.deepEqual(writesIn(tenant), []);
  // ensure() refuses on its own too, before any request.
  const composed = host();
  const step = disabled.plan.steps.find((candidate) => candidate.kind === 'graph-permission');
  const before = tenant.requests.length;
  await assert.rejects(composed.adapters.ensure({ tenantRef, plan: disabled.plan, step, credentialRef: composed.credentials.restorer.credentialRef }), /disabled/);
  assert.equal(tenant.requests.length, before);
  assert.equal(await composed.adapters.qualify({ tenantRef, step, credentialRef: composed.credentials.restorer.credentialRef, intentHash: 'x' }), null);

  // A qualification that does not match the host's mode is refused by the executor.
  const mismatched = host({ operations: { 'grant-consent': { enabled: true, qualification: 'fixture-tested', expiresAt: '2099-01-01T00:00:00Z' } } });
  const refused = await run({ client, owner, setupHost: mismatched, workloads: ['entra-collect'] });
  assert.match(refused.result.error?.message ?? '', /not qualified/);
  assert.deepEqual(writesIn(tenant), []);

  // Explicitly enabled, matching mode: the one missing grant, with the restorer credential.
  const enabled = host({ qualificationMode: 'fixture-tested',
    operations: { 'grant-consent': { enabled: true, qualification: 'fixture-tested', expiresAt: '2099-01-01T00:00:00Z' } } });
  const granted = await run({ client, owner, setupHost: enabled, workloads: ['entra-collect'] });
  assert.equal(granted.result.status, 'complete', granted.result.error?.message);
  const writes = writesIn(tenant);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.match(writes[0].path, /\/servicePrincipals\/[^/]+\/appRoleAssignments$/);
  const collectorSp = tenant.sps.get(COLLECTOR_APP_ID).id;
  assert.ok(tenant.grants.get(collectorSp).some((grant) => grant.appRoleId && grant.principalId === collectorSp));
});

test('portal: the deployment host from /etc/keel-style files checks and completes setup end to end', async (t) => {
  const { db, owner } = await database(t);
  const directory = mkdtempSync(join(tmpdir(), 'keel-setup-host-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = {
    tenant: join(directory, 'tenant.json'), collector: join(directory, 'tenant-target.json'),
    restorer: join(directory, 'restorer-target.json'), setup: join(directory, 'setup.json'),
  };
  writeFileSync(files.tenant, JSON.stringify({ tenantId: TENANT_ID }));
  writeFileSync(files.collector, JSON.stringify(collectorConfig));
  writeFileSync(files.restorer, JSON.stringify(restorerConfig));
  writeFileSync(files.setup, JSON.stringify({ build: 'fixture-build-2', operatorPrincipalId: OPERATOR_ID }));

  const result = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', String.raw`
    const assert = require('node:assert/strict');
    globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;
    const { connect } = require('../engine/store/db.mjs');
    const fixture = require('../engine/test/setupGraphFixture.mjs');
    const { composeSetupHost, setupHost, canCheck, canProvision } = require('./lib/setup-host.ts');
    const { guardedSetup } = require('./lib/action.ts');
    const { guardedSetupState } = require('./lib/setup.ts');
    const { PRINCIPAL_ID_HEADER, CAPABILITIES_HEADER } = require('./lib/principal.ts');
    const tenant = fixture.fixtureTenant({ intuneAssigned: false });
    fixture.installFixtureGraph(tenant);
    const files = JSON.parse(process.env.FIXTURE_FILES);
    const owner = process.env.FIXTURE_OWNER;
    const env = { ...process.env, KEEL_COLLECTOR_CONFIG_PATH: files.collector, KEEL_RESTORER_CONFIG_PATH: files.restorer, KEEL_SETUP_CONFIG_PATH: files.setup };
    const host = () => composeSetupHost(env, { getToken: fixture.fakeGetToken(), killSwitchPath: process.env.FIXTURE_NO_KILL_SWITCH });
    const headers = new Headers({ 'content-type': 'application/json', [PRINCIPAL_ID_HEADER]: owner, [CAPABILITIES_HEADER]: 'configuration approve' });
    const post = (body) => guardedSetup({ host })(new Request('http://localhost/api/actions/setup', { method: 'POST', headers, body: JSON.stringify(body) }));
    const show = async () => (await guardedSetupState({ host })(new Request('http://localhost/api/setup', { headers }))).json();

    (async () => {
      const db = await connect(process.env.KEEL_DB_URL);
      try {
        // Without credential files the default host stays inert.
        assert.equal(canCheck(setupHost()), false);
        const composed = host();
        assert.equal(canCheck(composed), true);
        assert.equal(canProvision(composed), true);
        assert.equal(composed.build, 'fixture-build-2');
        assert.equal(composed.credentials.collector.credentialRef, 'file:' + files.collector);

        let view = await show();
        assert.equal(view.canCheck, true);
        assert.equal(view.checkFailed, false);
        let read = view.scopes.find(s => s.scope === 'read');
        assert.equal(read.steps.find(s => s.kind === 'registration').progress, 'done');
        assert.equal(read.steps.find(s => s.kind === 'workload-rbac').progress, 'waiting-for-you');

        // Read setup with Intune pauses on the Intune role; Entra-only completes.
        let response = await post({ scope: 'read' });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).run.status, 'pending-manual');
        response = await post({ scope: 'read', workloads: ['entra-collect'] });
        const readRun = (await response.json()).run;
        assert.equal(readRun.status, 'complete');
        // Restore setup: the operator is not active in the role, so it waits.
        response = await post({ scope: 'restore' });
        const restoreRun = (await response.json()).run;
        assert.equal(restoreRun.status, 'pending-manual');
        // The operator activates the role in PIM; continuing completes the same run.
        tenant.directoryRoles.push({ principalId: fixture.OPERATOR_ID, roleDefinitionId: fixture.PRIVILEGED_ROLE_ADMIN, directoryScopeId: '/' });
        response = await post({ resume: restoreRun.artifactId });
        assert.equal((await response.json()).run.status, 'complete');

        view = await show();
        assert.equal(view.scopes.find(s => s.scope === 'read').run.artifactId, readRun.artifactId);
        assert.equal(view.scopes.find(s => s.scope === 'restore').run.state, 'complete');
        assert.equal(view.collect.allowed, true);
        const { rows } = await db.query("SELECT artifact_id FROM bootstrap_event WHERE state = 'complete' ORDER BY id");
        assert.deepEqual(rows.map(r => r.artifact_id), [readRun.artifactId, restoreRun.artifactId]);
        assert.deepEqual(fixture.writesIn(tenant), [], 'setup on a consented tenant writes nothing');

        // A failed tenant read shows steps as not checked instead of failing the page.
        globalThis.fetch = async () => new Response('{}', { status: 500 });
        await db.query('DELETE FROM bootstrap_event'); await db.query('DELETE FROM bootstrap_plan');
        view = await show();
        assert.equal(view.checkFailed, true);
        assert.ok(view.scopes.every(s => s.steps.every(step => step.progress === 'not-checked')));
      } finally {
        await db.end();
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: new URL('../../portal/', import.meta.url), encoding: 'utf8',
    env: { ...process.env, KEEL_DB_URL: db.url, KEEL_TENANT_CONFIG_PATH: files.tenant, FIXTURE_FILES: JSON.stringify(files),
      FIXTURE_OWNER: owner.id, FIXTURE_NO_KILL_SWITCH: missingKillSwitch,
      KEEL_COLLECTOR_CONFIG_PATH: join(directory, 'absent-collector.json'), KEEL_RESTORER_CONFIG_PATH: join(directory, 'absent-restorer.json') },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
