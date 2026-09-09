import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOB_KIND_CAPABILITIES } from '../engine/authz/jobCapabilities.mjs';
import {
  isProcessGroupAlive, JOB_HANDLERS, runJob, signalProcessGroup, startJobChild,
} from './keel-worker.mjs';

const fixtureDir = mkdtempSync(join(tmpdir(), 'keel-worker-test-'));
const grandchildPidPath = join(fixtureDir, 'grandchild.pid');
const fixturePath = join(fixtureDir, 'spawns-grandchild.mjs');

writeFileSync(fixturePath, `
  import { spawn } from 'node:child_process';
  import { writeFileSync } from 'node:fs';
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  writeFileSync(process.argv[2], String(grandchild.pid));
  setInterval(() => {}, 1000);
`);

const execution = startJobChild(fixturePath, [grandchildPidPath], { timeoutMs: 100 });
const processGroupId = execution.child.pid;

try {
  await assert.rejects(execution.completed, /execution timed out after 100ms/);
  assert.equal(
    isProcessGroupAlive(processGroupId),
    false,
    'the timed-out child process group, including its grandchild, must be gone',
  );

  const grandchildPid = Number(readFileSync(grandchildPidPath, 'utf8'));
  assert.throws(() => process.kill(grandchildPid, 0), { code: 'ESRCH' });
} finally {
  if (isProcessGroupAlive(processGroupId)) signalProcessGroup(processGroupId, 'SIGKILL');
}

// --- an unknown kind fails the job rather than completing it ---
// Drives runJob with a fake client; no database needed. The dispatch table's default
// branch must call fail(), never complete().
const failedCalls = [];
const completedCalls = [];
const fakeClient = {
  async query(sql, params) {
    if (sql.includes("SET status = 'succeeded'")) {
      completedCalls.push(params);
      return { rows: [{ id: params[0], status: 'succeeded' }] };
    }
    if (sql.includes("SET status = 'failed'")) {
      failedCalls.push(params);
      return { rows: [{ id: params[0], status: 'failed', error: params[1] }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
};
await runJob(fakeClient, { id: 'job-unknown-kind', kind: 'bogus', params: {} }, {
  dbUrl: 'postgres://unused',
  onInFlightChange: () => {},
});
assert.equal(completedCalls.length, 0, 'an unknown kind must never complete the job');
assert.equal(failedCalls.length, 1, 'an unknown kind must fail the job');
assert.match(failedCalls[0][1], /no worker handler registered for kind: bogus/);

// --- plan task 25: a job is re-authorized at execution, not only at enqueue ---
// Drives runJob with a fake client; no database needed. The fake answers the principal
// and role_grant lookups the authz path issues, mirroring the window predicate in
// capabilitiesForPrincipal so the `at` runJob passes is what decides — a mutation that
// evaluates can() at created_at takes a different path through this fake.
const okScriptPath = join(fixtureDir, 'succeeds.mjs');
writeFileSync(okScriptPath, `console.log('fixture job ran');\n`);

// The real collect handler spawns keel-collect against a tenant; a test must never do
// that, so every kind used here dispatches to a fixture script that exits 0. 'unmapped-kind'
// has a handler but no entry in JOB_KIND_CAPABILITIES — the branch under test. 'restore'
// is the destructive kind the re-authorization path is driven with: a real restore handler
// would write to the tenant, so a fixture stands in.
const fixtureHandlers = {
  collect: { script: okScriptPath, argsFor: () => [] },
  restore: { script: okScriptPath, argsFor: () => [] },
  'unmapped-kind': { script: okScriptPath, argsFor: () => [] },
};

function makeAuthzFakeClient({ principal = null, grants = [] } = {}) {
  const authzFailed = [];
  const authzCompleted = [];
  const client = {
    async query(sql, params) {
      if (sql.includes("SET status = 'succeeded'")) {
        authzCompleted.push(params);
        return { rows: [{ id: params[0], status: 'succeeded' }] };
      }
      if (sql.includes("SET status = 'failed'")) {
        authzFailed.push(params);
        return { rows: [{ id: params[0], status: 'failed', error: params[1] }] };
      }
      if (sql.includes('FROM principal WHERE id::text = $1')) {
        return { rows: principal && principal.id === params[0] ? [principal] : [] };
      }
      if (sql.includes('FROM role_grant')) {
        const at = params[1];
        const live = grants.filter((grant) =>
          grant.active_from <= at && (grant.active_until === null || grant.active_until > at));
        return { rows: live.map((grant) => ({ role: grant.role })) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { client, failedCalls: authzFailed, completedCalls: authzCompleted };
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000);
const hoursFromNow = (h) => new Date(Date.now() + h * 3600_000);
const operatorPrincipal = {
  id: 'principal-operator', email: 'operator@example.com', disabled_at: null,
};

function authzJobFor(kind, overrides = {}) {
  return {
    id: `job-${kind}-authz`,
    kind,
    params: {},
    requested_by: operatorPrincipal.id,
    created_at: new Date(),
    ...overrides,
  };
}

async function runAuthzJob(fake, job) {
  await runJob(fake.client, job, {
    dbUrl: 'postgres://unused',
    onInFlightChange: () => {},
    handlers: fixtureHandlers,
  });
}

function assertJobFailedUnRun(fake, pattern, label) {
  assert.equal(fake.completedCalls.length, 0, `${label}: the job must be left un-run`);
  assert.equal(fake.failedCalls.length, 1, `${label}: the job must fail, not skip`);
  assert.match(fake.failedCalls[0][1], pattern);
}

// a requester who still holds the capability runs the job
{
  const fake = makeAuthzFakeClient({
    principal: operatorPrincipal,
    grants: [{ role: 'operator', active_from: hoursAgo(1), active_until: null }],
  });
  await runAuthzJob(fake, authzJobFor('collect'));
  assert.equal(fake.failedCalls.length, 0, `unexpected failure: ${fake.failedCalls[0]?.[1]}`);
  assert.equal(fake.completedCalls.length, 1, 'a still-authorized requester runs the job');
}

// the same job fails, un-run, when the grant has since expired — created_at sits inside
// the grant window, so a mutation evaluating can() at created_at runs the job and fails
// this test
{
  const fake = makeAuthzFakeClient({
    principal: operatorPrincipal,
    grants: [{ role: 'operator', active_from: hoursAgo(3), active_until: hoursAgo(1) }],
  });
  await runAuthzJob(fake, authzJobFor('collect', { created_at: hoursAgo(2) }));
  assertJobFailedUnRun(
    fake, /requester no longer authorized for kind: collect/, 'expired grant',
  );
}

// when the principal has since been disabled
{
  const fake = makeAuthzFakeClient({
    principal: { ...operatorPrincipal, disabled_at: hoursAgo(1) },
    grants: [{ role: 'operator', active_from: hoursAgo(2), active_until: null }],
  });
  await runAuthzJob(fake, authzJobFor('collect'));
  assertJobFailedUnRun(
    fake, /requester no longer authorized for kind: collect/, 'disabled principal',
  );
}

// when the grant's active_from is still in the future
{
  const fake = makeAuthzFakeClient({
    principal: operatorPrincipal,
    grants: [{ role: 'operator', active_from: hoursFromNow(1), active_until: null }],
  });
  await runAuthzJob(fake, authzJobFor('collect'));
  assertJobFailedUnRun(
    fake, /requester no longer authorized for kind: collect/, 'future grant',
  );
}

// when requested_by resolves to no principal at all — deny by default, never run
// unauthenticated
{
  const fake = makeAuthzFakeClient({ principal: null });
  await runAuthzJob(fake, authzJobFor('collect', { requested_by: 'principal-ghost' }));
  assertJobFailedUnRun(
    fake, /requester no longer resolves to a principal: principal-ghost/, 'ghost requester',
  );
}

// a kind with no capability mapping fails rather than defaulting to allowed
{
  const fake = makeAuthzFakeClient({
    principal: operatorPrincipal,
    grants: [{ role: 'operator', active_from: hoursAgo(1), active_until: null }],
  });
  await runAuthzJob(fake, authzJobFor('unmapped-kind'));
  assertJobFailedUnRun(
    fake, /no capability mapping for kind: unmapped-kind/, 'unmapped kind',
  );
}

// --- the kind -> capability mapping is asserted as data, per kind ---
// Weakening a single entry — restore -> collect, the mutation that survived the first
// attempt at this task — must fail here, not rely on the behavioural tests alone. The
// table is the single source of truth shared by the portal (enqueue) and the worker
// (execution), so it is asserted in full.
assert.deepEqual(
  JOB_KIND_CAPABILITIES,
  {
    collect: 'collect',
    prune: 'collect',
    'drift-detect': 'collect',
    backup: 'backup',
    'baseline-create': 'baseline-create',
    'baseline-activate': 'baseline-create',
    remediate: 'remediate',
    restore: 'restore',
  },
  'every job kind must map to exactly the capability that kind requires',
);
// Every kind the worker can dispatch is present in the mapping — a registered kind with
// no entry would be denied at execution time, which is a misconfiguration, not a policy.
for (const kind of Object.keys(JOB_HANDLERS)) {
  assert.ok(
    JOB_KIND_CAPABILITIES[kind] !== undefined,
    `registered kind ${kind} must have a capability mapping`,
  );
}

// --- the re-authorization path is driven with a destructive kind, not only collect ---
// A principal holding collect (operator) but NOT restore must not run a restore job —
// that is precisely the privilege escalation this task exists to close.
{
  const fake = makeAuthzFakeClient({
    principal: operatorPrincipal,
    grants: [{ role: 'operator', active_from: hoursAgo(1), active_until: null }],
  });
  await runAuthzJob(fake, authzJobFor('restore'));
  assertJobFailedUnRun(
    fake, /requester no longer authorized for kind: restore/, 'restore under a mere collect grant',
  );
}

// a restorer principal — whose role grants restore but not collect — runs the restore job
{
  const restorerPrincipal = {
    id: 'principal-restorer', email: 'restorer@example.com', disabled_at: null,
  };
  const fake = makeAuthzFakeClient({
    principal: restorerPrincipal,
    grants: [{ role: 'restorer', active_from: hoursAgo(1), active_until: null }],
  });
  await runAuthzJob(fake, authzJobFor('restore', { requested_by: restorerPrincipal.id }));
  assert.equal(fake.failedCalls.length, 0, `unexpected failure: ${fake.failedCalls[0]?.[1]}`);
  assert.equal(fake.completedCalls.length, 1, 'a requester holding restore runs the restore job');
}

console.log('keel-worker.test.mjs — all assertions passed');
