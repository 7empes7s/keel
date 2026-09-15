import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOB_KIND_CAPABILITIES } from '../engine/authz/jobCapabilities.mjs';
import {
  isProcessGroupAlive, JOB_HANDLERS, JOB_TIMEOUT_MS, runJob, signalProcessGroup, startJobChild,
} from './keel-worker.mjs';

function acceptedJobKindsFromSchema(schema) {
  const match = schema.match(
    /ALTER TABLE job ADD CONSTRAINT job_kind_check\s+CHECK \(kind IN \(([^)]+)\)\)/,
  );
  assert.ok(match, 'schema.sql must declare the job_kind_check accepted-kinds source');
  return [...match[1].matchAll(/'([^']+)'/g)].map(([, kind]) => kind);
}

function assertSchemaJobKindCoverage(schema, handlers, capabilities) {
  for (const kind of acceptedJobKindsFromSchema(schema)) {
    assert.ok(
      handlers[kind] !== undefined,
      `schema-accepted kind ${kind} must have a worker handler`,
    );
    assert.ok(
      capabilities[kind] !== undefined,
      `schema-accepted kind ${kind} must have a capability mapping`,
    );
  }
}

const schemaSql = readFileSync(new URL('../engine/store/schema.sql', import.meta.url), 'utf8');

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
  'policy-evaluate': { script: okScriptPath, argsFor: () => [] },
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
      if (sql.includes('FROM auto_remediation_execution')) {
        return { rows: [] };
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

// The database CHECK constraint is the closed inventory. A schema-accepted kind must
// have both a dispatch handler and an enqueue/worker capability mapping; deriving this
// from JOB_HANDLERS would hide a kind absent from both tables.
assert.ok(
  JOB_HANDLERS['policy-evaluate'] !== undefined,
  'policy-evaluate must have a worker dispatch handler',
);
assertSchemaJobKindCoverage(schemaSql, JOB_HANDLERS, JOB_KIND_CAPABILITIES);
const fixtureSchemaSql = schemaSql.replace(
  ",'notify'));",
  ",'notify','fixture-schema-kind'));",
);
assert.notEqual(fixtureSchemaSql, schemaSql, 'the fixture must add a schema-accepted kind');
assert.throws(
  () => assertSchemaJobKindCoverage(fixtureSchemaSql, JOB_HANDLERS, JOB_KIND_CAPABILITIES),
  /schema-accepted kind fixture-schema-kind must have a worker handler/,
  'a schema kind absent from both tables must fail without a handler being added first',
);
assert.throws(
  () => assertSchemaJobKindCoverage(fixtureSchemaSql, {
    ...JOB_HANDLERS,
    'fixture-schema-kind': { script: okScriptPath, argsFor: () => [] },
  }, JOB_KIND_CAPABILITIES),
  /schema-accepted kind fixture-schema-kind must have a capability mapping/,
  'a schema kind with a handler but no capability mapping must also fail',
);

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
    offsite: 'configuration',
    'drift-detect': 'collect',
    backup: 'backup',
    'baseline-create': 'baseline-create',
    'baseline-activate': 'baseline-create',
    'policy-evaluate': 'policies',
    remediate: 'remediate',
    restore: 'restore',
    notify: 'configuration',
  },
  'every job kind must map to exactly the capability that kind requires',
);

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

// --- plan task 27: policy evaluation is a policies-authorized tenant-scoped job ---
assert.equal(
  JOB_HANDLERS['policy-evaluate'].script,
  join(cliDir, 'keel-policy-evaluate.mjs'),
);
assert.deepEqual(
  JOB_HANDLERS['policy-evaluate'].argsFor({ tenantRef: 'sha256:tenant-a' }),
  ['--tenant-ref', 'sha256:tenant-a'],
);
assert.throws(
  () => JOB_HANDLERS['policy-evaluate'].argsFor({}),
  /params.tenantRef must be a non-empty string/,
);
{
  const policyAdmin = {
    id: 'principal-policy-admin', email: 'policy-admin@example.com', disabled_at: null,
  };
  const fake = makeAuthzFakeClient({
    principal: policyAdmin,
    grants: [{ role: 'admin', active_from: hoursAgo(1), active_until: null }],
  });
  await runJob(fake.client, authzJobFor('policy-evaluate', {
    requested_by: policyAdmin.id, params: { tenantRef: 'sha256:tenant-a' },
  }), {
    dbUrl: 'postgres://unused',
    onInFlightChange: () => {},
    handlers: fixtureHandlers,
  });
  assert.equal(fake.failedCalls.length, 0, `unexpected failure: ${fake.failedCalls[0]?.[1]}`);
  assert.equal(fake.completedCalls.length, 1, 'a requester holding policies runs policy-evaluate');
}
{
  const fake = makeAuthzFakeClient({
    principal: operatorPrincipal,
    grants: [{ role: 'operator', active_from: hoursAgo(1), active_until: null }],
  });
  await runAuthzJob(fake, authzJobFor('policy-evaluate', {
    params: { tenantRef: 'sha256:tenant-a' },
  }));
  assertJobFailedUnRun(
    fake, /requester no longer authorized for kind: policy-evaluate/,
    'policy-evaluate under a principal without policies',
  );
}

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
  }),
  ['--collector-config', '/etc/keel/tenant-target.json',
    '--target-config', '/etc/keel/restorer-target.json',
    '--snapshot-id', 'snapshot-1',
    '--select', 'group:Admins', '--select', 'conditionalAccessPolicy:Protect-Admins'],
  'the raw selection becomes repeatable --select flags; the closure is the CLI\'s job',
);
assert.throws(
  () => JOB_HANDLERS.restore.argsFor({
    snapshotId: 'snapshot-1', selection: ['group:Admins'],
    collectorConfig: '/etc/keel/tenant-target.json', targetConfig: '/etc/keel/restorer-target.json',
    mode: 'enforce',
  }),
  /params.artifactId is required to enforce a restore/,
  'a direct selection-scoped enforce, with no artifactId, must be refused',
);
assert.throws(
  () => JOB_HANDLERS.restore.argsFor({
    planId: 'plan-1',
    collectorConfig: '/etc/keel/tenant-target.json',
    targetConfig: '/etc/keel/restorer-target.json',
    mode: 'enforce',
  }),
  /params.artifactId is required to enforce a restore/,
  'a direct plan-scoped enforce, with no artifactId, must be refused too',
);
assert.deepEqual(
  JOB_HANDLERS.restore.argsFor({ artifactId: 'artifact-1' }),
  ['--artifact', 'artifact-1', '--enforce'],
  'an already-queued artifact-only job promotes the completed dry run',
);
assert.deepEqual(
  JOB_HANDLERS.restore.argsFor({
    mode: 'enforce',
    artifactId: 'artifact-1',
    // This is the artifact-derived audit projection minted by approveRequest. The
    // worker ignores it and sends only --artifact; no caller-supplied scope can ride
    // alongside a valid artifact into the restore CLI.
    snapshotId: 'snapshot-from-artifact',
    selection: ['group:Admins'],
    closureKeys: ['group:Admins'],
    targetTenantId: 'target-from-artifact',
    collectorConfigPath: '/etc/keel/tenant-target.json',
    targetConfigPath: '/etc/keel/restorer-target.json',
    reconciliationResources: null,
  }),
  ['--artifact', 'artifact-1', '--enforce'],
  'an artifact-backed enforce job always dispatches via the artifact-only CLI path',
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

// --- plan task 20: delivery jobs have a narrow, durable payload and are run only
// by a principal still allowed to manage notification configuration ---
assert.equal(
  JOB_HANDLERS.notify.script,
  join(cliDir, 'keel-notify.mjs'),
  'a notify job must dispatch through the delivery-log CLI',
);
assert.deepEqual(
  JOB_HANDLERS.notify.argsFor({ deliveryId: 'delivery-1' }),
  ['--delivery-id', 'delivery-1'],
);
assert.throws(
  () => JOB_HANDLERS.notify.argsFor({}),
  /params.deliveryId must be a non-empty string/,
);
{
  const notifyHandlers = { notify: { ...JOB_HANDLERS.notify, script: okScriptPath } };
  const adminPrincipal = {
    id: 'principal-alerts-admin', email: 'alerts-admin@example.com', disabled_at: null,
  };
  const fake = makeAuthzFakeClient({
    principal: adminPrincipal,
    grants: [{ role: 'admin', active_from: hoursAgo(1), active_until: null }],
  });
  await runJob(fake.client, authzJobFor('notify', {
    requested_by: adminPrincipal.id, params: { deliveryId: 'delivery-1' },
  }), {
    dbUrl: 'postgres://unused',
    onInFlightChange: () => {},
    handlers: notifyHandlers,
  });
  assert.equal(fake.failedCalls.length, 0, `unexpected failure: ${fake.failedCalls[0]?.[1]}`);
  assert.equal(fake.completedCalls.length, 1, 'a currently authorized notification job runs');
}

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

// Task 42: exercise shell dispatch against a fake, never the shipping script.
assert.equal(JOB_HANDLERS.offsite.script, join(cliDir, '../ops/keel-offsite.sh'));
assert.equal(JOB_HANDLERS.offsite.executable, 'bash');
assert.deepEqual(JOB_HANDLERS.offsite.argsFor({}), []);
assert.deepEqual(JOB_HANDLERS.offsite.argsFor({ dryRun: true }), ['--dry-run']);
for (const params of [null, [], { dryRun: 'yes' }, { config: '/tmp/other' }, { tier: 'tier1' }]) {
  assert.throws(() => JOB_HANDLERS.offsite.argsFor(params), /offsite params/);
}
assert.throws(() => JOB_HANDLERS.offsite.resultFor({ stdout: 1, stderr: '', durationMs: 1 }), /invalid offsite result/);
const offsiteFixture = join(fixtureDir, 'offsite.sh');
writeFileSync(offsiteFixture, '#!/bin/bash\nset -eu\n[ "$#" -eq 1 ]\n[ "$1" = "--dry-run" ]\necho verified-fixture\n');
const offsiteHandlers = { offsite: { ...JOB_HANDLERS.offsite, script: offsiteFixture } };
{
  const principal = { id: 'offsite-admin', email: 'offsite@fixture.invalid', disabled_at: null };
  const fake = makeAuthzFakeClient({ principal, grants: [{ role: 'admin', active_from: hoursAgo(1), active_until: null }] });
  await runJob(fake.client, authzJobFor('offsite', { requested_by: principal.id, params: { dryRun: true } }), {
    dbUrl: 'postgres://unused', onInFlightChange: () => {}, handlers: offsiteHandlers,
  });
  assert.equal(fake.failedCalls.length, 0);
  assert.equal(fake.completedCalls.length, 1);
  const result = fake.completedCalls[0][1];
  assert.equal(result.stdout, 'verified-fixture\n');
  assert.equal(result.dryRun, true);
  assert.equal(result.shipped, false);
  assert.ok(result.durationMs >= 0);
}
{
  const principal = { id: 'offsite-viewer', email: 'viewer@fixture.invalid', disabled_at: null };
  const fake = makeAuthzFakeClient({ principal, grants: [{ role: 'viewer', active_from: hoursAgo(1), active_until: null }] });
  await runJob(fake.client, authzJobFor('offsite', { requested_by: principal.id, params: { dryRun: true } }), {
    dbUrl: 'postgres://unused', onInFlightChange: () => {}, handlers: offsiteHandlers,
  });
  assertJobFailedUnRun(fake, /requester no longer authorized for kind: offsite/, 'read-only offsite');
}
console.log('keel-worker offsite — all assertions passed');
