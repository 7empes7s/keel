import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { planBootstrap } from '../bootstrap/plan.mjs';
import { BootstrapJournal, migrateBootstrapJournal } from '../bootstrap/journal.mjs';
import { approveBootstrapPlan, executeBootstrap } from '../bootstrap/execute.mjs';
import { runBootstrap } from '../../cli/keel-bootstrap.mjs';

const tenantRef = 'sha256:bootstrap-executor-fixture';
const credentials = {
  collector: { credentialRef: 'vault:collector', identityRef: 'collector-app' },
  restorer: { credentialRef: 'vault:restorer', identityRef: 'restorer-app' },
};
const readers = Object.fromEntries(['Applications', 'ServicePrincipals', 'AppRoleAssignments',
  'RoleAssignments', 'RoleEligibilitySchedules', 'SubscribedSkus'].map(n => [`list${n}`, async () => []]));

async function fixture(t, workloads = ['entra-collect']) {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  t.after(async () => { await client.end(); await database.cleanup(); });
  const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
  await client.query(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS principal'), schema.indexOf('-- §3.3 approvals')));
  const { rows: [principal] } = await client.query("INSERT INTO principal(email, display_name) VALUES ('bootstrap@example.test', 'Fixture') RETURNING *");
  await client.query("INSERT INTO role_grant(principal_id, role, granted_by, reason) VALUES ($1, 'admin', 'fixture', 'fixture'), ($1, 'approver', 'fixture', 'fixture')", [principal.id]);
  await migrateBootstrapJournal(client);
  const journal = new BootstrapJournal({ client, tenantRef, principalId: principal.id });
  const plan = await planBootstrap({ tenantRef, workloads, readAdapters: readers });
  const state = new Map();
  const writes = [];
  const lookups = [];
  const adapters = {
    async prerequisites() { return { revision: 'prerequisites-v1', allowed: true, killSwitch: false }; },
    async qualify({ step, credentialRef, intentHash }) {
      return { tenantRef, credentialRef, intentHash, operation: step.action, build: 'fixture-v1', projection: 'identity-v1',
        status: 'fixture-tested', expiresAt: new Date(Date.now() + 60000).toISOString() };
    },
    async observe({ step }) {
      lookups.push(step.id);
      return state.get(step.id) ?? { tenantRef, status: 'absent' };
    },
    async ensure({ step, credentialRef, idempotencyKey, observed }) {
      writes.push({ step, credentialRef, idempotencyKey, observed });
      state.set(step.id, { tenantRef, status: 'satisfied', objectId: `${step.identity}-${step.kind}`,
        ...(step.kind === 'registration' ? { appId: `${step.identity}-app`, servicePrincipalId: `${step.identity}-sp` } : {}) });
    },
  };
  const approve = (overrides = {}) => approveBootstrapPlan({ journal, plan, credentials, adapters,
    build: 'fixture-v1', qualificationMode: 'fixture-tested', ...overrides });
  const execute = (artifactId) => executeBootstrap({ journal, artifactId, adapters, build: 'fixture-v1', qualificationMode: 'fixture-tested' });
  return { database, client, principal, journal, plan, state, writes, lookups, adapters, approve, execute };
}

test('crash after creation resumes by observed identity with no duplicate creation or grants', async t => {
  const f = await fixture(t);
  const artifactId = await f.approve();
  const ensure = f.adapters.ensure;
  let crash = true;
  f.adapters.ensure = async args => { await ensure(args); if (crash) { crash = false; throw new Error('simulated lost acknowledgement'); } };
  await assert.rejects(f.execute(artifactId), /uncertain/);
  const journal = new BootstrapJournal({ client: f.client, tenantRef, principalId: f.principal.id });
  const result = await executeBootstrap({ journal, artifactId, adapters: f.adapters, build: 'fixture-v1', qualificationMode: 'fixture-tested' });
  assert.equal(result.status, 'complete');
  assert.equal(f.writes.filter(w => w.step.kind === 'registration').length, 1);
  assert.equal(new Set(f.writes.map(w => w.idempotencyKey)).size, f.writes.length);
  const events = await journal.events(artifactId);
  assert.ok(events.some(e => e.state === 'desired'));
  assert.ok(events.some(e => e.state === 'uncertain'));
  assert.ok(events.some(e => e.state === 'observed'));
  const count = f.writes.length;
  await f.execute(artifactId);
  assert.equal(f.writes.length, count);
});

test('revoked local grant refuses the next operation and journal reads', async t => {
  const f = await fixture(t);
  const artifactId = await f.approve();
  const ensure = f.adapters.ensure;
  f.adapters.ensure = async args => {
    await ensure(args);
    await f.client.query('DELETE FROM role_grant WHERE principal_id = $1', [f.principal.id]);
  };
  await assert.rejects(f.execute(artifactId), /authorized/);
  assert.equal(f.writes.length, 1);
  await assert.rejects(f.journal.events(artifactId), /authorized/);
});

test('desired and observed evidence is committed before every provisioning write', async t => {
  const f = await fixture(t);
  const id = await f.approve();
  const reader = await f.database.connect();
  t.after(() => reader.end());
  const independentJournal = new BootstrapJournal({ client: reader, tenantRef, principalId: f.principal.id });
  const ensure = f.adapters.ensure;
  let checked = 0;
  f.adapters.ensure = async args => {
    // A second connection proves durability before the remote side effect,
    // rather than merely finding the events after execution has finished.
    const events = await independentJournal.events(id);
    const prior = events.filter(event => event.step_id === args.step.id);
    assert.deepEqual(prior.slice(-2).map(event => event.state), ['desired', 'observed']);
    assert.equal(prior.at(-2).evidence.intent.id, args.step.id);
    assert.deepEqual(prior.at(-1).evidence, args.observed);
    assert.ok(!prior.some(event => event.state === 'verified'));
    checked++;
    await ensure(args);
  };
  assert.equal((await f.execute(id)).status, 'complete');
  assert.equal(checked, f.plan.steps.length);
  assert.equal(f.writes.length, checked);
});

test('local grant revoked during qualification refuses the pending write', async t => {
  for (const role of ['admin', 'approver']) {
    for (const targetIndex of [0, 1]) {
      await t.test(`${role} revoked before write ${targetIndex + 1}`, async t => {
        const f = await fixture(t);
        const artifactId = await f.approve();
        const target = f.plan.steps[targetIndex];
        const qualify = f.adapters.qualify;
        let revoked = false;
        let beforeRevocation;
        f.adapters.qualify = async args => {
          const qualification = await qualify(args);
          if (args.step.id === target.id) {
            beforeRevocation = await f.journal.events(artifactId);
            const result = await f.client.query(
              'DELETE FROM role_grant WHERE principal_id = $1 AND role = $2',
              [f.principal.id, role]);
            assert.equal(result.rowCount, 1);
            revoked = true;
          }
          // External qualification stays valid: only local authorization changed.
          return qualification;
        };
        await assert.rejects(f.execute(artifactId), /bootstrap: not authorized/);
        assert.equal(revoked, true);
        assert.deepEqual(f.writes.map(write => write.step.id),
          f.plan.steps.slice(0, targetIndex).map(step => step.id));
        assert.equal(f.state.has(target.id), false);
        assert.equal(beforeRevocation.at(-1).step_id, target.id);
        assert.equal(beforeRevocation.at(-1).state, 'observed');
        assert.equal(beforeRevocation.at(-1).evidence.status, 'absent');
        await assert.rejects(f.journal.events(artifactId), /authorized/);
        // Inspect fixture storage directly: revoked execution may neither mark
        // completion nor append evidence after losing authorization.
        const { rows } = await f.client.query(
          'SELECT id, step_id, state, evidence, created_at FROM bootstrap_event WHERE tenant_ref = $1 AND artifact_id = $2 ORDER BY id',
          [tenantRef, artifactId]);
        assert.deepEqual(rows, beforeRevocation);
        assert.ok(!rows.some(event => event.state === 'complete'));
      });
    }
  }
});

test('changed prerequisites and revoked Microsoft authority stop execution', async t => {
  for (const changed of [{ revision: 'changed', allowed: true, killSwitch: false },
    { revision: 'prerequisites-v1', allowed: false, killSwitch: false },
    { revision: 'prerequisites-v1', allowed: true, killSwitch: true }]) {
    const f = await fixture(t);
    const id = await f.approve();
    f.adapters.prerequisites = async () => changed;
    await assert.rejects(f.execute(id), /prerequisites|kill switch/);
    assert.equal(f.writes.length, 0);
  }
});

test('collector and restorer credential references and identity references cannot collapse', async t => {
  const f = await fixture(t);
  for (const field of ['credentialRef', 'identityRef']) {
    const bad = structuredClone(credentials);
    bad.restorer[field] = bad.collector[field];
    await assert.rejects(f.approve({ credentials: bad }), /separate/);
  }
  const id = await f.approve();
  await f.execute(id);
  assert.ok(f.writes.every(w => w.credentialRef === credentials.restorer.credentialRef));
});

test('pending manual prerequisites block provisioning and never report complete', async t => {
  const f = await fixture(t, ['entra-restore']);
  const result = await f.execute(await f.approve());
  assert.equal(result.status, 'pending-manual');
  assert.equal(f.writes.length, 0);
});

test('changed approved artifact is refused; legacy planner output is not an approval', async t => {
  const f = await fixture(t);
  await assert.rejects(f.execute(f.plan.planId), /approved/);
  const id = await f.approve();
  await f.client.query("UPDATE bootstrap_plan SET artifact = jsonb_set(artifact, '{build}', '\"tampered\"') WHERE artifact_id = $1", [id]);
  await assert.rejects(f.execute(id), /immutable/);
  assert.equal(f.writes.length, 0);
});

test('unregistered action or widened grant cannot enter an approved artifact', async t => {
  const f = await fixture(t);
  for (const change of [p => p.steps[0].requiredScopes.push('Directory.ReadWrite.All'), p => { p.steps[0].action = 'enforce-conditional-access'; }]) {
    const plan = structuredClone(f.plan);
    change(plan);
    await assert.rejects(f.approve({ plan }), /intent/);
  }
});

test('partial registration carries observed references into idempotent ensure', async t => {
  const f = await fixture(t);
  const step = f.plan.steps[0];
  f.state.set(step.id, { tenantRef, status: 'partial', objectId: 'existing-app', appId: 'collector-app' });
  await f.execute(await f.approve());
  assert.equal(f.writes[0].observed.objectId, 'existing-app');
});

test('unknown observations, failed verification and cross-tenant observations never succeed', async t => {
  for (const mode of ['unknown', 'foreign', 'unverified']) {
    const f = await fixture(t);
    const id = await f.approve();
    if (mode === 'unknown') f.adapters.observe = async () => ({ tenantRef, status: 'unknown' });
    if (mode === 'foreign') f.adapters.observe = async () => ({ tenantRef: 'sha256:foreign', status: 'satisfied' });
    if (mode === 'unverified') f.adapters.ensure = async args => { f.writes.push(args); };
    await assert.rejects(f.execute(id), /observation|verification/);
    assert.equal(f.writes.length, mode === 'unverified' ? 1 : 0);
  }
});

async function rejectRegistrationObservation(t, { identity, phase, corrupt, error }) {
  const f = await fixture(t, ['entra-collect', 'entra-restore']);
  for (const step of f.plan.steps) {
    f.state.set(step.id, { tenantRef, status: 'satisfied', objectId: `${step.identity}-${step.kind}`,
      ...(step.kind === 'registration' ? { appId: credentials[step.identity].identityRef,
        servicePrincipalId: `${step.identity}-sp` } : {}) });
  }
  const target = f.plan.steps.find(step => step.kind === 'registration' && step.identity === identity);
  assert.ok(target);
  if (phase === 'post-write') f.state.delete(target.id);
  const observe = f.adapters.observe;
  let observations = 0;
  f.adapters.observe = async args => {
    const result = await observe(args);
    if (args.step.id === target.id && ++observations === (phase === 'initial' ? 1 : 2)) {
      const invalid = structuredClone(result);
      corrupt(invalid);
      return invalid;
    }
    return result;
  };
  const id = await f.approve();
  await assert.rejects(f.execute(id), error);
  assert.equal(observations, phase === 'initial' ? 1 : 2);
  assert.equal(f.writes.length, phase === 'post-write' ? 1 : 0);
  if (phase === 'post-write') assert.equal(f.writes[0].step.id, target.id);
  const events = await f.journal.events(id);
  assert.equal(events.at(-1).state, 'stopped');
  assert.ok(!events.some(event => event.state === 'complete'));
  const recorded = events.filter(event => event.step_id === target.id && event.state === 'observed');
  assert.deepEqual(recorded.map(event => event.evidence.status),
    phase === 'initial' ? [] : [phase === 'post-write' ? 'absent' : 'satisfied']);
  assert.equal(events.filter(event => event.step_id === target.id && event.state === 'verified').length,
    phase === 'final' ? 1 : 0);
}

test('satisfied registrations require every identifier at each observation boundary', async t => {
  for (const identity of ['collector', 'restorer']) {
    for (const phase of ['initial', 'post-write', 'final']) {
      for (const missing of ['objectId', 'appId', 'servicePrincipalId']) {
        await t.test(`${identity} ${phase}: missing ${missing}`, async t => {
          await rejectRegistrationObservation(t, { identity, phase,
            corrupt: value => { delete value[missing]; }, error: /incomplete registration observation/ });
        });
      }
    }
  }
});

test('observed registration appId must match the approved identity at each boundary', async t => {
  for (const identity of ['collector', 'restorer']) {
    for (const phase of ['initial', 'post-write', 'final']) {
      for (const appId of [credentials[identity === 'collector' ? 'restorer' : 'collector'].identityRef, 'unrelated-app']) {
        await t.test(`${identity} ${phase}: misbound ${appId}`, async t => {
          await rejectRegistrationObservation(t, { identity, phase,
            corrupt: value => { value.appId = appId; }, error: /match approved identity references/ });
        });
      }
    }
  }
});

test('complete foreign-tenant observations cannot satisfy any approved step', async t => {
  const f = await fixture(t, ['entra-collect', 'entra-restore', 'intune-collect']);
  for (const step of f.plan.steps) {
    f.state.set(step.id, { tenantRef, status: 'satisfied', objectId: `${step.identity}-${step.kind}`,
      ...(step.kind === 'registration' ? { appId: `${step.identity}-app`, servicePrincipalId: `${step.identity}-sp` } : {}) });
  }
  const observe = f.adapters.observe;
  for (const target of f.plan.steps) {
    await t.test(`${target.kind}: ${target.name}`, async () => {
      const id = await f.approve();
      const before = (await f.journal.events(id)).length;
      f.adapters.observe = async args => ({ ...await observe(args),
        ...(args.step.id === target.id ? { tenantRef: 'sha256:foreign' } : {}) });
      await assert.rejects(f.execute(id), /cross-tenant observation/);
      const events = (await f.journal.events(id)).slice(before);
      assert.ok(!events.some(e => e.state === 'complete'));
      assert.ok(!events.some(e => e.evidence.tenantRef === 'sha256:foreign'));
      assert.equal(f.writes.length, 0);
    });
  }
});

test('final verification reobserves every outcome including manual authorities', async t => {
  const f = await fixture(t, ['entra-collect', 'entra-restore', 'intune-collect']);
  for (const step of f.plan.steps) {
    f.state.set(step.id, { tenantRef, status: 'satisfied', objectId: `${step.identity}-${step.kind}`,
      ...(step.kind === 'registration' ? { appId: `${step.identity}-app`, servicePrincipalId: `${step.identity}-sp` } : {}) });
  }
  const observe = f.adapters.observe;
  for (const target of f.plan.steps) {
    await t.test(`${target.kind}: ${target.name}`, async () => {
      const id = await f.approve();
      const before = (await f.journal.events(id)).length;
      let observations = 0;
      f.adapters.observe = async args => {
        const result = await observe(args);
        if (args.step.id === target.id && ++observations === 2) return { tenantRef, status: 'absent' };
        return result;
      };
      await assert.rejects(f.execute(id), /final verification failed/);
      assert.equal(observations, 2);
      const events = (await f.journal.events(id)).slice(before);
      assert.ok(events.some(e => e.step_id === target.id && e.state === 'observed' && e.evidence.status === 'absent'));
      assert.ok(!events.some(e => e.state === 'complete'));
      assert.equal(events.at(-1).state, 'stopped');
      assert.equal(f.writes.length, 0);
    });
  }
  f.adapters.observe = observe;
  const id = await f.approve();
  assert.equal((await f.execute(id)).status, 'complete');
  const events = await f.journal.events(id);
  assert.deepEqual(events.slice(-f.plan.steps.length - 1, -1).map(e => [e.step_id, e.state, e.evidence.status]),
    f.plan.steps.map(step => [step.id, 'observed', 'satisfied']));
});

test('resume refuses to retry when persisted journal history cannot be read', async t => {
  const f = await fixture(t);
  const id = await f.approve();
  const ensure = f.adapters.ensure;
  f.adapters.ensure = async args => { await ensure(args); throw new Error('lost acknowledgement'); };
  await assert.rejects(f.execute(id), /uncertain/);
  const writes = f.writes.length;
  f.adapters.ensure = ensure;
  const journal = new BootstrapJournal({ client: f.client, tenantRef, principalId: f.principal.id });
  journal.events = async () => { throw new Error('persisted journal unavailable'); };
  await assert.rejects(executeBootstrap({ journal, artifactId: id, adapters: f.adapters,
    build: 'fixture-v1', qualificationMode: 'fixture-tested' }), /persisted journal unavailable/);
  assert.equal(f.writes.length, writes);
  assert.ok(!(await f.journal.events(id)).some(e => e.state === 'complete'));
});

test('qualification is scoped and expires, and fixture qualification cannot authorize live mode', async t => {
  for (const patch of [{ tenantRef: 'sha256:foreign' }, { credentialRef: 'vault:collector' },
    { operation: 'other' }, { intentHash: 'other' }, { projection: 'other' },
    { expiresAt: '2000-01-01' }, { build: 'other' }, { status: 'declared' }]) {
    const f = await fixture(t);
    const qualify = f.adapters.qualify;
    f.adapters.qualify = async args => ({ ...await qualify(args), ...patch });
    await assert.rejects(f.execute(await f.approve()), /qualified/);
    assert.equal(f.writes.length, 0);
  }
  const f = await fixture(t);
  await assert.rejects(executeBootstrap({ journal: f.journal, artifactId: await f.approve(), adapters: f.adapters,
    build: 'fixture-v1', qualificationMode: 'live-qualified' }), /qualification/);
});

test('tenant-scoped journal prevents foreign reads and execution', async t => {
  const f = await fixture(t);
  const id = await f.approve();
  const foreign = new BootstrapJournal({ client: f.client, tenantRef: 'sha256:foreign', principalId: f.principal.id });
  await assert.rejects(foreign.load(id), /approved/);
  await assert.rejects(foreign.events(id), /approved/);
});

test('additive migration is retry-safe and preserves approved artifacts and events', async t => {
  const f = await fixture(t);
  const id = await f.approve();
  await f.execute(id);
  const before = await f.journal.events(id);
  await migrateBootstrapJournal(f.client);
  await migrateBootstrapJournal(f.client);
  assert.deepEqual(await f.journal.events(id), before);
});

test('CLI defaults to plan mode through existing planner, never calls writer', async t => {
  const f = await fixture(t);
  const result = await runBootstrap({ tenantRef, workloads: ['entra-collect'], readAdapters: readers, journal: f.journal,
    adapters: { ensure() { assert.fail('plan must never write'); } } });
  assert.equal(result.planId, f.plan.planId);
  assert.equal((await f.client.query('SELECT count(*) FROM bootstrap_plan')).rows[0].count, '0');
});

test('a revoked previously verified privilege is never silently re-granted', async t => {
  const f = await fixture(t);
  const id = await f.approve();
  await f.execute(id);
  const count = f.writes.length;
  const consent = f.plan.steps.find(s => s.kind === 'graph-permission');
  f.state.delete(consent.id);
  await assert.rejects(f.execute(id), /revoked/);
  assert.equal(f.writes.length, count);
});

test('external prerequisites are rechecked after each write', async t => {
  const f = await fixture(t);
  const id = await f.approve();
  const ensure = f.adapters.ensure;
  f.adapters.ensure = async args => {
    await ensure(args);
    f.adapters.prerequisites = async () => ({ revision: 'prerequisites-v1', allowed: false, killSwitch: false });
  };
  await assert.rejects(f.execute(id), /prerequisites/);
  assert.equal(f.writes.length, 1);
});

test('existing automation kill switch blocks bootstrap writes', async t => {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'keel-bootstrap-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const killSwitchPath = join(dir, 'AUTOMATION_DISABLED');
  writeFileSync(killSwitchPath, 'fixture');
  await assert.rejects(executeBootstrap({ journal: f.journal, artifactId: await f.approve(), adapters: f.adapters,
    build: 'fixture-v1', qualificationMode: 'fixture-tested', killSwitchPath }), /kill switch/);
  assert.equal(f.writes.length, 0);
});

test('tenant execution lock prevents concurrent workers from duplicating writes', async t => {
  const f = await fixture(t);
  const id = await f.approve();
  const otherClient = await f.database.connect();
  t.after(() => otherClient.end());
  const other = new BootstrapJournal({ client: otherClient, tenantRef, principalId: f.principal.id });
  await f.journal.exclusive(async () => {
    await assert.rejects(executeBootstrap({ journal: other, artifactId: id, adapters: f.adapters,
      build: 'fixture-v1', qualificationMode: 'fixture-tested' }), /already running/);
  });
  assert.equal(f.writes.length, 0);
  assert.equal((await f.execute(id)).status, 'complete');
});

test('adapter secrets are not persisted, and failed writes have bounded retries', async t => {
  const f = await fixture(t);
  const id = await f.approve();
  f.adapters.ensure = async args => { f.writes.push(args); throw new Error('fixture-secret-do-not-log'); };
  for (let i = 0; i < 3; i++) await assert.rejects(f.execute(id), /uncertain/);
  await assert.rejects(f.execute(id), /quota/);
  assert.equal(f.writes.length, 3);
  assert.ok(!JSON.stringify(await f.journal.events(id)).includes('fixture-secret-do-not-log'));
});

test('reference-only credentials reject extra fields before adapters or persistence', async t => {
  for (const identity of ['collector', 'restorer']) {
    for (const extra of [{ notes: 'fixture-private-value' }, { metadata: { value: 'fixture-private-value' } }]) {
      await t.test(`${identity}: ${Object.keys(extra)[0]}`, async t => {
        const f = await fixture(t);
        const bad = structuredClone(credentials);
        Object.assign(bad[identity], extra);
        let prerequisiteCalls = 0;
        f.adapters.prerequisites = async () => {
          prerequisiteCalls++;
          return { revision: 'prerequisites-v1', allowed: true, killSwitch: false };
        };
        await assert.rejects(runBootstrap({ mode: 'approve', journal: f.journal, plan: f.plan,
          credentials: bad, adapters: f.adapters, build: 'fixture-v1', qualificationMode: 'fixture-tested' }),
        /reference-only/);
        assert.equal(prerequisiteCalls, 0);
        assert.equal(f.writes.length, 0);
        assert.equal((await f.client.query('SELECT count(*) FROM bootstrap_plan')).rows[0].count, '0');
        assert.equal((await f.client.query('SELECT count(*) FROM bootstrap_event')).rows[0].count, '0');
      });
    }
  }
});

test('missing or non-boolean adapter kill switch fails closed at approval and execution', async t => {
  const cases = [ {}, { killSwitch: null }, { killSwitch: 0 }, { killSwitch: '' },
    { killSwitch: 'false' }, { killSwitch: 'true' }, { killSwitch: {} } ];
  for (const patch of cases) {
    for (const phase of ['approval', 'execution', 'after-qualification']) {
      await t.test(`${phase}: ${JSON.stringify(patch)}`, async t => {
        const f = await fixture(t);
        const invalid = async () => ({ revision: 'prerequisites-v1', allowed: true, ...patch });
        if (phase === 'approval') {
          f.adapters.prerequisites = invalid;
          await assert.rejects(f.approve(), /kill switch blocks execution/);
          assert.equal((await f.client.query('SELECT count(*) FROM bootstrap_plan')).rows[0].count, '0');
          assert.equal((await f.client.query('SELECT count(*) FROM bootstrap_event')).rows[0].count, '0');
        } else {
          const id = await f.approve();
          if (phase === 'execution') f.adapters.prerequisites = invalid;
          else {
            const qualify = f.adapters.qualify;
            f.adapters.qualify = async args => {
              const result = await qualify(args);
              f.adapters.prerequisites = invalid;
              return result;
            };
          }
          await assert.rejects(f.execute(id), /kill switch blocks execution/);
          const events = await f.journal.events(id);
          assert.equal(events.at(-1).state, 'stopped');
          assert.ok(!events.some(event => ['verified', 'complete'].includes(event.state)));
          assert.equal(f.lookups.length, phase === 'execution' ? 0 : 1);
        }
        assert.equal(f.writes.length, 0);
        assert.equal(f.state.size, 0);
      });
    }
  }
});
