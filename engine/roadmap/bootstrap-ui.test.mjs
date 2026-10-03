/** Task-76 boundary coverage: guided onboarding over the real task-74 planner,
 * task-75 executor and journal in an isolated database, then the real portal
 * routes and setup page (through tsx, as engine/roadmap/coverage-ui.test.mjs
 * does). Provisioning goes through injected fake adapters only; no Microsoft
 * call is made and nothing here is live evidence.
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
import {
  firstCollectReadiness, loadSetupState, selectWorkloads, stepProgress, workloadsForScope,
} from '../bootstrap/onboarding.mjs';

const tenantRef = 'sha256:bootstrap-ui-fixture';
const credentials = {
  collector: { credentialRef: 'vault:collector', identityRef: 'collector-app' },
  restorer: { credentialRef: 'vault:restorer', identityRef: 'restorer-app' },
};
const readers = Object.fromEntries(['Applications', 'ServicePrincipals', 'AppRoleAssignments',
  'RoleAssignments', 'RoleEligibilitySchedules', 'SubscribedSkus'].map((n) => [`list${n}`, async () => []]));

// The same fake identity adapter shape task-75's tests use: ensure() makes a step
// satisfied, manual steps are satisfied only when the operator has done them.
function fakeTenant(ref = tenantRef) {
  const state = new Map();
  const manualDone = new Set();
  const writes = [];
  let loseNextAck = false;
  const satisfied = (step) => ({ tenantRef: ref, status: 'satisfied', objectId: `${step.identity}-${step.kind}`,
    ...(step.kind === 'registration' ? { appId: `${step.identity}-app`, servicePrincipalId: `${step.identity}-sp` } : {}) });
  const adapters = {
    async prerequisites() { return { revision: 'prerequisites-v1', allowed: true, killSwitch: false }; },
    async qualify({ step, credentialRef, intentHash }) {
      return { tenantRef: ref, credentialRef, intentHash, operation: step.action, build: 'fixture-v1', projection: 'identity-v1',
        status: 'fixture-tested', expiresAt: new Date(Date.now() + 60000).toISOString() };
    },
    async observe({ step }) {
      if (['pim-activation', 'workload-rbac'].includes(step.kind)) {
        return manualDone.has(step.name) ? { tenantRef: ref, status: 'satisfied' } : { tenantRef: ref, status: 'absent' };
      }
      return state.get(step.id) ?? { tenantRef: ref, status: 'absent' };
    },
    async ensure({ step }) {
      writes.push(step.id);
      state.set(step.id, satisfied(step));
      if (loseNextAck) { loseNextAck = false; throw new Error('simulated lost acknowledgement'); }
    },
  };
  return { adapters, manualDone, writes, loseAck() { loseNextAck = true; } };
}

async function database(t) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  t.after(async () => { await client.end(); await db.cleanup(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const { rows: [owner] } = await client.query("INSERT INTO principal(email, display_name) VALUES ('owner@example.test', 'Setup Owner') RETURNING *");
  await client.query("INSERT INTO role_grant(principal_id, role, granted_by, reason) VALUES ($1, 'admin', 'fixture', 'fixture'), ($1, 'approver', 'fixture', 'fixture')", [owner.id]);
  return { db, client, owner };
}

async function runSetup({ client, owner, tenant, workloads }) {
  await migrateBootstrapJournal(client);
  const journal = new BootstrapJournal({ client, tenantRef, principalId: owner.id });
  const plan = await planBootstrap({ tenantRef, workloads, readAdapters: readers });
  const artifactId = await approveBootstrapPlan({ journal, plan, credentials, adapters: tenant.adapters,
    build: 'fixture-v1', qualificationMode: 'fixture-tested' });
  const execute = () => executeBootstrap({ journal, artifactId, adapters: tenant.adapters,
    build: 'fixture-v1', qualificationMode: 'fixture-tested' });
  return { artifactId, journal, result: await execute().catch((error) => ({ error })), execute };
}

test('setup scopes keep read and write workloads apart', () => {
  assert.deepEqual(workloadsForScope('read'), ['entra-collect', 'intune-collect']);
  assert.deepEqual(workloadsForScope('restore'), ['entra-restore']);
  assert.deepEqual(selectWorkloads('read', ['entra-collect']), ['entra-collect']);
  assert.throws(() => selectWorkloads('read', ['entra-restore']), /subset/);
  assert.throws(() => selectWorkloads('read', []), /subset/);
  assert.throws(() => workloadsForScope('everything'), /unknown setup scope/);
});

test('a manual step is done only when it was seen in the tenant', () => {
  const step = { id: 'step-1', kind: 'workload-rbac', status: 'pending-manual' };
  assert.equal(stepProgress(step, [{ step_id: 'step-1', state: 'pending-manual', evidence: { kind: 'workload-rbac' } }]), 'waiting-for-you');
  assert.equal(stepProgress(step, [{ step_id: 'step-1', state: 'observed', evidence: { status: 'absent' } }]), 'to-do');
  assert.equal(stepProgress(step, [{ step_id: 'step-1', state: 'observed', evidence: { status: 'satisfied' } }]), 'done');
  assert.equal(stepProgress(step, [{ step_id: 'step-1', state: 'uncertain', evidence: {} }]), 'unclear');
  // Before any run: no readers means not checked, never present or absent.
  assert.equal(stepProgress({ ...step, status: 'satisfied' }, null), 'not-checked');
  assert.equal(stepProgress(step, null, { observed: true }), 'waiting-for-you');
  // PIM eligibility the planner saw is not an active role (task-75).
  assert.equal(stepProgress({ id: 'p', kind: 'pim-activation', status: 'satisfied' }, null, { observed: true }), 'waiting-for-you');
});

test('the first collection waits for confirmed read grants; restore prerequisites never block it', async (t) => {
  const { client, owner } = await database(t);
  assert.deepEqual(await firstCollectReadiness(client, { tenantRef }), { allowed: false, basis: 'not-set-up', missing: [] });

  // Restore setup paused on PIM: it has no read steps and does not decide collection.
  const restoreTenant = fakeTenant();
  const restore = await runSetup({ client, owner, tenant: restoreTenant, workloads: ['entra-restore'] });
  assert.equal(restore.result.status, 'pending-manual');
  assert.equal(restoreTenant.writes.length, 0, 'manual authority is checked before any write');
  assert.equal((await firstCollectReadiness(client, { tenantRef })).basis, 'not-set-up');

  // Intune RBAC missing stops the read setup that includes Intune, before any write.
  const tenant = fakeTenant();
  const both = await runSetup({ client, owner, tenant, workloads: ['entra-collect', 'intune-collect'] });
  assert.equal(both.result.status, 'pending-manual');
  assert.equal(tenant.writes.length, 0);
  const blocked = await firstCollectReadiness(client, { tenantRef });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.basis, 'read-access-unconfirmed');
  assert.ok(blocked.missing.includes('Read Only Operator'), 'the waiting manual step is named');
  assert.ok(blocked.missing.includes('keel-collector'), 'unprovisioned registration is named');

  // The Entra-only read setup is still eligible and completes.
  const entra = await runSetup({ client, owner, tenant, workloads: ['entra-collect'] });
  assert.equal(entra.result.status, 'complete');
  assert.ok(tenant.writes.length > 0);
  assert.deepEqual(await firstCollectReadiness(client, { tenantRef }), { allowed: true, basis: 'read-access-confirmed', missing: [] });

  // A newer read run that stopped (a revoked grant) withdraws the confirmation.
  const revoked = fakeTenant();
  const second = await runSetup({ client, owner, tenant: revoked, workloads: ['entra-collect'] });
  revoked.adapters.prerequisites = async () => ({ revision: 'prerequisites-v2', allowed: false, killSwitch: false });
  await assert.rejects(second.execute(), /revoked or changed prerequisites/);
  assert.equal((await firstCollectReadiness(client, { tenantRef })).allowed, false);

  // A completed collection is proof the read grants worked.
  await client.query("INSERT INTO snapshot(tenant_ref, status, completed_at) VALUES ($1, 'complete', now())", [tenantRef]);
  assert.equal((await firstCollectReadiness(client, { tenantRef })).basis, 'collected-before');
});

test('setup state reads the journal for each scope and reports steps not checked without readers', async (t) => {
  const { client, owner } = await database(t);
  const before = await loadSetupState(client, { tenantRef, viewerId: owner.id });
  assert.equal(before.scopes.length, 2);
  for (const scope of before.scopes) {
    assert.equal(scope.run, null);
    assert.ok(scope.steps.length > 0);
    assert.ok(scope.steps.every((step) => step.progress === 'not-checked'), 'no readers: nothing assumed');
  }
  assert.ok(before.scopes[1].steps.every((step) => step.identity === 'restorer'));
  assert.equal(before.collect.allowed, false);

  const tenant = fakeTenant();
  const read = await runSetup({ client, owner, tenant, workloads: ['entra-collect', 'intune-collect'] });
  const paused = await loadSetupState(client, { tenantRef, viewerId: owner.id });
  const readScope = paused.scopes.find((scope) => scope.scope === 'read');
  assert.equal(readScope.run.artifactId, read.artifactId);
  assert.equal(readScope.run.state, 'waiting-for-you');
  assert.equal(readScope.run.approvedByName, 'Setup Owner');
  assert.equal(readScope.run.resumableByViewer, true);
  assert.equal(readScope.steps.find((step) => step.kind === 'workload-rbac').progress, 'waiting-for-you');
  assert.equal(paused.scopes.find((scope) => scope.scope === 'restore').run, null);

  const other = await loadSetupState(client, { tenantRef, viewerId: 'someone-else' });
  assert.equal(other.scopes.find((scope) => scope.scope === 'read').run.resumableByViewer, false);

  tenant.manualDone.add('Read Only Operator');
  assert.equal((await read.execute()).status, 'complete');
  const done = await loadSetupState(client, { tenantRef, viewerId: owner.id });
  const finished = done.scopes.find((scope) => scope.scope === 'read');
  assert.equal(finished.run.state, 'complete');
  assert.ok(finished.steps.every((step) => step.progress === 'done'));
  assert.equal(done.collect.allowed, true);
  assert.equal(done.firstCollection, null);
});

test('portal: setup route, first-collect gate and setup page', async (t) => {
  const { db, client, owner } = await database(t);
  const { rows: [reader] } = await client.query("INSERT INTO principal(email, display_name) VALUES ('reader@example.test', 'Read Only') RETURNING *");
  await client.query("INSERT INTO role_grant(principal_id, role, granted_by, reason) VALUES ($1, 'viewer', 'fixture', 'fixture')", [reader.id]);
  const { rows: [adminOnly] } = await client.query("INSERT INTO principal(email, display_name) VALUES ('admin@example.test', 'Admin Only') RETURNING *");
  await client.query("INSERT INTO role_grant(principal_id, role, granted_by, reason) VALUES ($1, 'admin', 'fixture', 'fixture'), ($1, 'operator', 'fixture', 'fixture')", [adminOnly.id]);
  await client.query("INSERT INTO role_grant(principal_id, role, granted_by, reason) VALUES ($1, 'operator', 'fixture', 'fixture')", [owner.id]);
  const { rows: [colleague] } = await client.query("INSERT INTO principal(email, display_name) VALUES ('colleague@example.test', 'Colleague') RETURNING *");
  await client.query("INSERT INTO role_grant(principal_id, role, granted_by, reason) VALUES ($1, 'admin', 'fixture', 'fixture'), ($1, 'approver', 'fixture', 'fixture')", [colleague.id]);
  const directory = mkdtempSync(join(tmpdir(), 'keel-bootstrap-ui-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'tenant.json');
  writeFileSync(config, JSON.stringify({ tenantId: 'bootstrap-ui-tenant' }));

  const result = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', String.raw`
    const assert = require('node:assert/strict');
    globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;
    const { renderToStaticMarkup } = require('react-dom/server');
    const { connect } = require('../engine/store/db.mjs');
    const { guardedSetup } = require('./lib/action.ts');
    const { guardedSetupState } = require('./lib/setup.ts');
    const { POST: collect } = require('./app/api/actions/collect/route.ts');
    const { POST: defaultSetup } = require('./app/api/actions/setup/route.ts');
    const { tenantRef } = require('./lib/runtime-config.ts');
    const { PRINCIPAL_ID_HEADER, CAPABILITIES_HEADER } = require('./lib/principal.ts');
    const { workAsyncStorage } = require('next/dist/server/app-render/work-async-storage.external.js');
    const { workUnitAsyncStorage } = require('next/dist/server/app-render/work-unit-async-storage.external.js');
    const ids = JSON.parse(process.env.FIXTURE_IDS);
    const ref = tenantRef();

    const state = new Map(); const manualDone = new Set(); const writes = []; let loseAck = false;
    const adapters = {
      async prerequisites() { return { revision: 'prerequisites-v1', allowed: true, killSwitch: false }; },
      async qualify({ step, credentialRef, intentHash }) {
        return { tenantRef: ref, credentialRef, intentHash, operation: step.action, build: 'fixture-v1', projection: 'identity-v1',
          status: 'fixture-tested', expiresAt: new Date(Date.now() + 60000).toISOString() };
      },
      async observe({ step }) {
        if (['pim-activation', 'workload-rbac'].includes(step.kind)) return { tenantRef: ref, status: manualDone.has(step.name) ? 'satisfied' : 'absent' };
        return state.get(step.id) ?? { tenantRef: ref, status: 'absent' };
      },
      async ensure({ step }) {
        writes.push(step);
        state.set(step.id, { tenantRef: ref, status: 'satisfied', objectId: step.identity + '-' + step.kind,
          ...(step.kind === 'registration' ? { appId: step.identity + '-app', servicePrincipalId: step.identity + '-sp' } : {}) });
        if (loseAck) { loseAck = false; throw new Error('simulated lost acknowledgement'); }
      },
    };
    const readers = Object.fromEntries(['Applications', 'ServicePrincipals', 'AppRoleAssignments',
      'RoleAssignments', 'RoleEligibilitySchedules', 'SubscribedSkus'].map(n => ['list' + n, async () => []]));
    const host = () => ({ readers, adapters, build: 'fixture-v1', qualificationMode: 'fixture-tested', operatorPrincipalId: null,
      credentials: { collector: { credentialRef: 'vault:collector', identityRef: 'collector-app' },
        restorer: { credentialRef: 'vault:restorer', identityRef: 'restorer-app' } } });
    const setup = guardedSetup({ host });
    const show = guardedSetupState({ host });

    const headers = (principal, capabilities) => {
      const h = new Headers({ 'content-type': 'application/json' });
      if (principal) h.set(PRINCIPAL_ID_HEADER, principal);
      if (capabilities) h.set(CAPABILITIES_HEADER, capabilities.join(' '));
      return h;
    };
    const post = (route, path, principal, capabilities, body) => route(new Request('http://localhost' + path,
      { method: 'POST', headers: headers(principal, capabilities), body: JSON.stringify(body ?? {}) }));
    const OWNER = [ids.owner, ['configuration', 'approve', 'users', 'roles', 'policies', 'collect', 'backup']];
    const ADMIN_ONLY = [ids.adminOnly, ['configuration', 'users', 'roles', 'policies', 'collect', 'backup']];
    const READER = [ids.reader, ['read']];

    (async () => {
      const db = await connect(process.env.KEEL_DB_URL);
      const count = async (sql) => Number((await db.query(sql)).rows[0].count);
      const plans = () => count("SELECT count(*) FROM bootstrap_plan");
      const events = () => count("SELECT count(*) FROM bootstrap_event");
      const jobs = () => count("SELECT count(*) FROM job WHERE kind IN ('collect', 'backup')");
      try {
        // Without a qualified host the route changes nothing.
        assert.equal((await post(defaultSetup, '/api/actions/setup', ...OWNER, { scope: 'read' })).status, 409);

        // Start collect with missing read grants: refused, nothing queued.
        let response = await post(collect, '/api/actions/collect', ...OWNER, { tier: 'tier1' });
        assert.equal(response.status, 409, 'first collect without confirmed read grants');
        assert.equal((await response.json()).error, 'setup_incomplete');
        response = await post(collect, '/api/actions/backup', ...OWNER, { tier: 'tier1' });
        assert.equal(response.status, 409);
        assert.equal(await jobs(), 0);

        // Read capability alone, or configuration without approve, cannot provision:
        // the route refuses before it touches the setup journal at all.
        const journalExists = async () => (await db.query("SELECT to_regclass('bootstrap_plan') IS NOT NULL AS ready")).rows[0].ready;
        for (const [who, caps] of [READER, ADMIN_ONLY]) {
          assert.equal((await post(setup, '/api/actions/setup', who, caps, { scope: 'read' })).status, 403, 'setup needs configuration and approve');
        }
        assert.equal(await journalExists(), false, 'a refused request never reaches the journal');
        const denied = await count("SELECT count(*) FROM evidence WHERE kind = 'action-attempt' AND subject->>'action' = 'setup' AND subject->>'decision' = 'denied'");
        assert.equal(denied, 2, 'each refusal is recorded');
        // Forged headers still meet the journal's own database check.
        assert.equal((await post(setup, '/api/actions/setup', ids.reader, ['read', 'configuration', 'approve'], { scope: 'read' })).status, 403);
        assert.equal(await plans().catch(() => 0), 0, 'no setup run was approved');
        assert.equal(writes.length, 0);
        assert.equal((await show(new Request('http://localhost/api/setup', { headers: headers(...READER) }))).status, 403);
        assert.equal((await post(setup, '/api/actions/setup', ...OWNER, { scope: 'read', workloads: ['entra-restore'] })).status, 400);

        // Intune RBAC missing: the full read setup stops before any write...
        response = await post(setup, '/api/actions/setup', ...OWNER, { scope: 'read' });
        assert.equal(response.status, 200);
        const paused = (await response.json()).run;
        assert.equal(paused.status, 'pending-manual');
        assert.equal(writes.length, 0);
        assert.equal((await post(collect, '/api/actions/collect', ...OWNER, {})).status, 409);

        // ...and an expired session cannot continue it, nor erase its progress.
        const recorded = await events();
        assert.equal((await post(setup, '/api/actions/setup', null, null, { resume: paused.artifactId })).status, 403);
        assert.equal((await post(setup, '/api/actions/setup', ids.owner, null, { resume: paused.artifactId })).status, 403);
        assert.equal(await events(), recorded, 'denied requests add nothing to the journal');
        let view = await (await show(new Request('http://localhost/api/setup', { headers: headers(...OWNER) }))).json();
        let read = view.scopes.find(s => s.scope === 'read');
        assert.equal(read.run.artifactId, paused.artifactId);
        assert.equal(read.run.state, 'waiting-for-you');
        assert.equal(read.steps.find(s => s.kind === 'workload-rbac').progress, 'waiting-for-you');
        assert.equal(view.canProvision, true);

        // The page shows it as waiting, never done, to a configuration holder only.
        const page = require('./app/setup/page.tsx').default;
        const render = (h) => workAsyncStorage.run({ route: '/setup', forceStatic: false }, () =>
          workUnitAsyncStorage.run({ type: 'request', phase: 'render', headers: h, implicitTags: [],
            url: { pathname: '/setup', search: '' }, rootParams: {}, resumeDataCache: null, isHmrRefresh: false, fallbackParams: null,
          }, () => page()));
        await assert.rejects(render(headers(...READER)), e => e.digest === 'NEXT_HTTP_ERROR_FALLBACK;403');
        const html = renderToStaticMarkup(await render(headers(...OWNER)));
        assert.match(html, /Give keel-collector the Intune role &quot;Read Only Operator&quot;<\/h3><span class="pill pill-warn">Waiting for you/);
        assert.doesNotMatch(html, /Read Only Operator&quot;<\/h3><span class="pill pill-ok">Done/);
        assert.match(html, /steps are left before KEEL can read your tenant/);
        assert.match(html, new RegExp(paused.artifactId));
        const explanation = html.replace(/<details class="technical-details"[\s\S]*?<\/details>/g, '');
        assert.doesNotMatch(explanation, /\b(artifact|adapter|observation|qualifi|capabilit|fixture)/i, 'internal words stay in the record');

        // Retry resumes the journal: an Entra-only read setup survives a lost
        // acknowledgement without creating anything twice.
        loseAck = true;
        response = await post(setup, '/api/actions/setup', ...OWNER, { scope: 'read', workloads: ['entra-collect'] });
        assert.equal(response.status, 409);
        assert.equal((await response.json()).error, 'setup_stopped');
        view = await (await show(new Request('http://localhost/api/setup', { headers: headers(...OWNER) }))).json();
        read = view.scopes.find(s => s.scope === 'read');
        assert.equal(read.run.state, 'stopped');
        assert.ok(read.steps.some(s => s.progress === 'unclear'));
        const entraRun = read.run.artifactId;
        const created = writes.filter(s => s.kind === 'registration').length;
        assert.equal(created, 1);
        // Only the person who approved a run may continue it; to anyone else it is not found.
        assert.equal((await post(setup, '/api/actions/setup', ids.colleague, ['configuration', 'approve'], { resume: entraRun })).status, 404);
        response = await post(setup, '/api/actions/setup', ...OWNER, { resume: entraRun });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).run.status, 'complete');
        assert.equal(writes.filter(s => s.kind === 'registration').length, 1, 'resume observed instead of recreating');

        // Read grants confirmed: the first collection may start; restore setup is still separate.
        response = await post(collect, '/api/actions/collect', ...OWNER, { tier: 'tier1' });
        assert.equal(response.status, 202);
        assert.equal(await jobs(), 1);
        response = await post(setup, '/api/actions/setup', ...OWNER, { scope: 'restore' });
        assert.equal((await response.json()).run.status, 'pending-manual', 'restore waits on PIM; collection did not');
        view = await (await show(new Request('http://localhost/api/setup', { headers: headers(...OWNER) }))).json();
        assert.equal(view.collect.allowed, true);
        assert.equal(view.scopes.find(s => s.scope === 'restore').run.state, 'waiting-for-you');
      } finally {
        await db.end();
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: new URL('../../portal/', import.meta.url), encoding: 'utf8',
    env: { ...process.env, KEEL_DB_URL: db.url, KEEL_TENANT_CONFIG_PATH: config, __NEXT_EXPERIMENTAL_AUTH_INTERRUPTS: '1',
      FIXTURE_IDS: JSON.stringify({ owner: owner.id, reader: reader.id, adminOnly: adminOnly.id, colleague: colleague.id }) },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
