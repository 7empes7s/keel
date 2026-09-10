import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOB_KIND_CAPABILITIES } from '../engine/authz/jobCapabilities.mjs';
import {
  isProcessGroupAlive, JOB_HANDLERS, JOB_TIMEOUT_MS, runJob, signalProcessGroup, startJobChild,
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
// and 'remediate' are destructive kinds the re-authorization path is driven with: real
// handlers for either would write to the tenant, so a fixture stands in for both.
const fixtureHandlers = {
  collect: { script: okScriptPath, argsFor: () => [] },
  restore: { script: okScriptPath, argsFor: () => [] },
  remediate: { script: okScriptPath, argsFor: () => [] },
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

// --- plan task 16: "back up now" dispatches to the EXISTING tier script ---
// The tiered backups are keel-collect.mjs --tier tierN (the systemd tier units run
// exactly that), so the backup handler must point at that script — never at a copy
// of its logic — and pass the tier through as a flag.
const cliDir = dirname(fileURLToPath(import.meta.url));
assert.equal(
  JOB_HANDLERS.backup.script,
  join(cliDir, 'keel-collect.mjs'),
  'a backup job must spawn the existing tiered collection script',
);
assert.deepEqual(JOB_HANDLERS.backup.argsFor({ tier: 'tier2' }), ['--tier', 'tier2']);
assert.deepEqual(JOB_HANDLERS.backup.argsFor({}), ['--tier', 'tier1'], 'tier defaults to tier1');
assert.throws(
  () => JOB_HANDLERS.backup.argsFor({ tier: 'everything' }),
  /invalid params.tier: everything/,
);

// Driven end-to-end through runJob: a requester holding the backup capability passes
// the task-25 re-authorization and dispatches. The script is swapped for the fixture
// so no real collection runs; the REAL argsFor still builds the argv.
{
  const backupHandlers = { backup: { ...JOB_HANDLERS.backup, script: okScriptPath } };
  const fake = makeAuthzFakeClient({
    principal: operatorPrincipal,
    grants: [{ role: 'operator', active_from: hoursAgo(1), active_until: null }],
  });
  await runJob(fake.client, authzJobFor('backup', { params: { tier: 'tier3' } }), {
    dbUrl: 'postgres://unused',
    onInFlightChange: () => {},
    handlers: backupHandlers,
  });
  assert.equal(fake.failedCalls.length, 0, `unexpected failure: ${fake.failedCalls[0]?.[1]}`);
  assert.equal(fake.completedCalls.length, 1, 'a requester holding backup runs the backup job');
}

// An invalid tier fails the job loudly at param validation — it never reaches spawn.
{
  const backupHandlers = { backup: { ...JOB_HANDLERS.backup, script: okScriptPath } };
  const fake = makeAuthzFakeClient({
    principal: operatorPrincipal,
    grants: [{ role: 'operator', active_from: hoursAgo(1), active_until: null }],
  });
  await runJob(fake.client, authzJobFor('backup', { params: { tier: 'everything' } }), {
    dbUrl: 'postgres://unused',
    onInFlightChange: () => {},
    handlers: backupHandlers,
  });
  assertJobFailedUnRun(fake, /invalid params: invalid params.tier: everything/, 'invalid tier');
}

// --- plan task 16: baseline handlers dispatch to thin wrappers around govern/baseline.mjs ---
assert.equal(
  JOB_HANDLERS['baseline-create'].script,
  join(cliDir, 'keel-baseline-create.mjs'),
);
assert.deepEqual(
  JOB_HANDLERS['baseline-create'].argsFor(
    { snapshotId: 'snapshot-1', label: 'golden', description: 'post-audit' },
    { requested_by: 'principal-operator' },
  ),
  ['--snapshot-id', 'snapshot-1', '--label', 'golden', '--set-by', 'principal-operator',
    '--description', 'post-audit'],
  'baseline-create forwards the snapshot, label and the job requester as set-by',
);
assert.throws(
  () => JOB_HANDLERS['baseline-create'].argsFor({ label: 'golden' }, { requested_by: 'p' }),
  /params.snapshotId must be a non-empty string/,
);
assert.equal(
  JOB_HANDLERS['baseline-activate'].script,
  join(cliDir, 'keel-baseline-activate.mjs'),
);
assert.deepEqual(
  JOB_HANDLERS['baseline-activate'].argsFor({ baselineId: 'baseline-1' }),
  ['--baseline-id', 'baseline-1'],
);
assert.throws(
  () => JOB_HANDLERS['baseline-activate'].argsFor({}),
  /params.baselineId must be a non-empty string/,
);

// --- plan task 17: restore dispatches to the EXISTING restore CLI with whitelisted args ---
// The handler must never pass arbitrary params through: every flag below is built
// explicitly from a validated param.
assert.equal(
  JOB_HANDLERS.restore.script,
  join(cliDir, 'keel-restore.mjs'),
  'a restore job must spawn the existing restore CLI so its safety gates apply',
);
assert.deepEqual(
  JOB_HANDLERS.restore.argsFor({
    planId: 'plan-1',
    collectorConfig: '/etc/keel/tenant-target.json',
    targetConfig: '/etc/keel/restorer-target.json',
  }),
  ['--collector-config', '/etc/keel/tenant-target.json',
    '--target-config', '/etc/keel/restorer-target.json', '--plan', 'plan-1'],
);
assert.deepEqual(
  JOB_HANDLERS.restore.argsFor({
    snapshotId: 'snapshot-1',
    selection: ['group:Admins', 'conditionalAccessPolicy:Protect-Admins'],
    collectorConfig: '/etc/keel/tenant-target.json',
    targetConfig: '/etc/keel/restorer-target.json',
    mode: 'enforce',
  }),
  ['--collector-config', '/etc/keel/tenant-target.json',
    '--target-config', '/etc/keel/restorer-target.json',
    '--snapshot-id', 'snapshot-1',
    '--select', 'group:Admins', '--select', 'conditionalAccessPolicy:Protect-Admins',
    '--enforce'],
  'the raw selection becomes repeatable --select flags; the closure is the CLI\'s job',
);
// Both credential configs are required — the read/write separation needs each.
assert.throws(
  () => JOB_HANDLERS.restore.argsFor({ planId: 'plan-1', targetConfig: '/t.json' }),
  /params.collectorConfig must be a non-empty string/,
);
assert.throws(
  () => JOB_HANDLERS.restore.argsFor({ planId: 'plan-1', collectorConfig: '/c.json' }),
  /params.targetConfig must be a non-empty string/,
);
// The two restore scopes never mix, and a selection scope is always complete.
assert.throws(
  () => JOB_HANDLERS.restore.argsFor({
    planId: 'plan-1', snapshotId: 'snapshot-1', collectorConfig: '/c.json', targetConfig: '/t.json',
  }),
  /mutually exclusive/,
);
assert.throws(
  () => JOB_HANDLERS.restore.argsFor({
    snapshotId: 'snapshot-1', selection: [], collectorConfig: '/c.json', targetConfig: '/t.json',
  }),
  /params.selection must be a non-empty array/,
);
assert.throws(
  () => JOB_HANDLERS.restore.argsFor({
    snapshotId: 'snapshot-1', selection: ['group:Admins', 42], collectorConfig: '/c.json', targetConfig: '/t.json',
  }),
  /params.selection entry must be a non-empty string/,
);
assert.throws(
  () => JOB_HANDLERS.restore.argsFor({
    snapshotId: 'snapshot-1', selection: ['group:Admins'],
    collectorConfig: '/c.json', targetConfig: '/t.json', mode: 'yolo',
  }),
  /invalid params.mode: yolo/,
);
// A restore replays throttled write waves and can take hours; it must not inherit the
// 30-minute default.
assert.ok(
  JOB_TIMEOUT_MS.restore > JOB_TIMEOUT_MS.default,
  'restore must have its own, longer timeout',
);

// --- plan task 19: remediate dispatches to the EXISTING remediate CLI, which itself
// dispatches through runRestore, so remediation inherits every restore safety gate ---
assert.equal(
  JOB_HANDLERS.remediate.script,
  join(cliDir, 'keel-remediate.mjs'),
  'a remediate job — automatic or operator-approved — must spawn the remediate CLI so restore\'s safety gates apply',
);
assert.deepEqual(
  JOB_HANDLERS.remediate.argsFor({
    driftIds: ['drift-1', 'drift-2'],
    collectorConfig: '/etc/keel/tenant-target.json',
    targetConfig: '/etc/keel/restorer-target.json',
    mode: 'enforce',
  }),
  ['--drift-id', 'drift-1', '--drift-id', 'drift-2',
    '--collector-config', '/etc/keel/tenant-target.json',
    '--target-config', '/etc/keel/restorer-target.json',
    '--enforce'],
);
// An operator-approved remediate request (task 15) never supplies credential config
// paths — this portal manages exactly one tenant (§2.2), so the standing collector and
// restorer registrations are the default, not a per-request value the caller must know.
assert.deepEqual(
  JOB_HANDLERS.remediate.argsFor({ driftIds: ['drift-1'] }),
  ['--drift-id', 'drift-1',
    '--collector-config', '/etc/keel/tenant-target.json',
    '--target-config', '/etc/keel/restorer-target.json'],
);
assert.throws(
  () => JOB_HANDLERS.remediate.argsFor({}),
  /params.driftIds must be a non-empty array/,
);
assert.throws(
  () => JOB_HANDLERS.remediate.argsFor({ driftIds: [] }),
  /params.driftIds must be a non-empty array/,
);
assert.throws(
  () => JOB_HANDLERS.remediate.argsFor({ driftIds: ['drift-1'], mode: 'yolo' }),
  /invalid params.mode: yolo/,
);
// remediate replays the identical apply path as restore and gets the identical ceiling.
assert.equal(
  JOB_TIMEOUT_MS.remediate,
  JOB_TIMEOUT_MS.restore,
  'remediate must share restore\'s longer timeout, not the 30-minute default',
);

// Driven end-to-end through runJob: a requester holding the remediate capability
// (restorer) passes the task-25 re-authorization and dispatches. The script is
// swapped for the fixture so no real remediation runs; the REAL argsFor still builds
// the argv.
{
  const remediateHandlers = { remediate: { ...JOB_HANDLERS.remediate, script: okScriptPath } };
  const restorerPrincipal = {
    id: 'principal-remediate-restorer', email: 'remediate-restorer@example.com', disabled_at: null,
  };
  const fake = makeAuthzFakeClient({
    principal: restorerPrincipal,
    grants: [{ role: 'restorer', active_from: hoursAgo(1), active_until: null }],
  });
  await runJob(fake.client, authzJobFor('remediate', {
    requested_by: restorerPrincipal.id, params: { driftIds: ['drift-1'] },
  }), {
    dbUrl: 'postgres://unused',
    onInFlightChange: () => {},
    handlers: remediateHandlers,
  });
  assert.equal(fake.failedCalls.length, 0, `unexpected failure: ${fake.failedCalls[0]?.[1]}`);
  assert.equal(fake.completedCalls.length, 1, 'a requester holding remediate runs the remediate job');
}

// A principal holding only collect (operator) must not run a remediate job.
{
  const fake = makeAuthzFakeClient({
    principal: operatorPrincipal,
    grants: [{ role: 'operator', active_from: hoursAgo(1), active_until: null }],
  });
  await runAuthzJob(fake, authzJobFor('remediate', { params: { driftIds: ['drift-1'] } }));
  assertJobFailedUnRun(
    fake, /requester no longer authorized for kind: remediate/, 'remediate under a mere collect grant',
  );
}

console.log('keel-worker.test.mjs — all assertions passed');
