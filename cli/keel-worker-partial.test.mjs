// Issue #447: a collect that saved its snapshot but could not read some types in
// full ends as a finished job that names those types. Every other non-zero exit
// stays a failure. Drives runJob with a fake client and fixture scripts; no
// database and no tenant.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INCOMPLETE_TYPES_PREFIX, PARTIAL_EXIT_CODE } from '../engine/collect/incomplete.mjs';
import { JOB_HANDLERS, partialResult, runJob } from './keel-worker.mjs';

const dir = mkdtempSync(join(tmpdir(), 'keel-worker-partial-'));
const missing = [{ type: 'deviceManagementSettings', outcome: 'failed', httpStatus: 400 }];
const line = `${INCOMPLETE_TYPES_PREFIX}${JSON.stringify(missing)}`;

function script(name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

const scripts = {
  partial: script('partial.mjs', `console.log('snapshot 11111111-1111-1111-1111-111111111111 complete');\nconsole.log(${JSON.stringify(line)});\nprocess.exitCode = 3;\n`),
  partialNoList: script('partial-no-list.mjs', `console.log('snapshot 11111111-1111-1111-1111-111111111111 complete');\nprocess.exitCode = 3;\n`),
  partialBadList: script('partial-bad-list.mjs', `console.log(${JSON.stringify(`${INCOMPLETE_TYPES_PREFIX}[{"type":`)});\nprocess.exitCode = 3;\n`),
  partialEmptyList: script('partial-empty-list.mjs', `console.log(${JSON.stringify(`${INCOMPLETE_TYPES_PREFIX}[]`)});\nprocess.exitCode = 3;\n`),
  failedWithList: script('failed-with-list.mjs', `console.log(${JSON.stringify(line)});\nprocess.exitCode = 1;\n`),
};

function fakeClient() {
  const completed = [];
  const failed = [];
  const client = {
    async query(sql, params) {
      if (sql.includes("SET status = 'succeeded'")) {
        completed.push(params);
        return { rows: [{ id: params[0], status: 'succeeded', result: params[1] }] };
      }
      if (sql.includes("SET status = 'failed'")) {
        failed.push(params);
        return { rows: [{ id: params[0], status: 'failed', error: params[1] }] };
      }
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [] };
      if (sql.includes('FROM principal WHERE id::text = $1')) return { rows: [{ id: params[0], email: 'op@example.com', disabled_at: null }] };
      if (sql.includes('FROM role_grant')) return { rows: [{ role: 'operator', scope: '*' }] };
      if (sql.includes('FROM auto_remediation_execution')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { client, completed, failed };
}

async function run(kind, scriptPath, { partialExitCode = PARTIAL_EXIT_CODE } = {}) {
  const fake = fakeClient();
  const handler = { script: scriptPath, argsFor: () => [], acceptsDbUrl: false };
  if (partialExitCode !== null) handler.partialExitCode = partialExitCode;
  await runJob(fake.client, { id: `job-${kind}`, kind, params: {}, requested_by: 'principal-op', created_at: new Date() }, {
    dbUrl: 'postgres://unused', onInFlightChange: () => {}, handlers: { [kind]: handler },
  });
  return fake;
}

// Both entry points to the collector treat exit 3 as partial.
assert.equal(JOB_HANDLERS.collect.partialExitCode, PARTIAL_EXIT_CODE);
assert.equal(JOB_HANDLERS.backup.partialExitCode, PARTIAL_EXIT_CODE);
// So does the content backup: locked OneDrives or one refused mailbox are partly done.
assert.equal(JOB_HANDLERS['content-collect'].partialExitCode, PARTIAL_EXIT_CODE);

// A partial content backup finishes and keeps each workload's unread items.
{
  const workloads = [{ type: 'content:onedrive', outcome: 'partial', httpStatus: null, items: 2996, reasonCount: 1, reasons: ['KEEL-RT-user: HTTP 423 notAllowed'] }];
  const contentLine = `${INCOMPLETE_TYPES_PREFIX}${JSON.stringify(workloads)}`;
  const contentPartial = script('content-partial.mjs', `console.log('onedrive: partial');\nconsole.log(${JSON.stringify(contentLine)});\nprocess.exitCode = 3;\n`);
  const contentFailed = script('content-failed.mjs', `console.log(${JSON.stringify(contentLine)});\nprocess.exitCode = 1;\n`);
  const fake = await run('content-collect', contentPartial);
  assert.equal(fake.failed.length, 0, `content-collect: a partial run must not fail: ${fake.failed[0]?.[1]}`);
  assert.equal(fake.completed[0][1].partial, true);
  assert.deepEqual(fake.completed[0][1].incompleteTypes, workloads);
  const failedRun = await run('content-collect', contentFailed);
  assert.equal(failedRun.completed.length, 0, 'content-collect exit 1 stays a failure');
  assert.match(failedRun.failed[0][1], /^exit code 1/);
}

// A partial collect finishes, keeps its stdout (completions.mjs reads the snapshot id
// from it) and names each type it did not read in full.
for (const kind of ['collect', 'backup']) {
  const fake = await run(kind, scripts.partial);
  assert.equal(fake.failed.length, 0, `${kind}: a partial collect must not fail: ${fake.failed[0]?.[1]}`);
  assert.equal(fake.completed.length, 1);
  const result = fake.completed[0][1];
  assert.equal(result.partial, true);
  assert.deepEqual(result.incompleteTypes, missing);
  assert.match(result.stdout, /snapshot 11111111-1111-1111-1111-111111111111 complete/);
  assert.ok(Number.isFinite(result.durationMs));
}

// Exit 3 without a readable, non-empty list stays a failure: nothing is hidden.
for (const name of ['partialNoList', 'partialBadList', 'partialEmptyList']) {
  const fake = await run('collect', scripts[name]);
  assert.equal(fake.completed.length, 0, `${name} must not finish`);
  assert.equal(fake.failed.length, 1);
  assert.match(fake.failed[0][1], /^exit code 3/);
}

// Exit 1 is a failure even when a list was printed.
{
  const fake = await run('collect', scripts.failedWithList);
  assert.equal(fake.completed.length, 0);
  assert.match(fake.failed[0][1], /^exit code 1/);
}

// A kind with no partial exit code fails on exit 3.
{
  const fake = await run('prune', scripts.partial, { partialExitCode: null });
  assert.equal(fake.completed.length, 0);
  assert.match(fake.failed[0][1], /^exit code 3/);
}

// partialResult itself: a signal or a missing handler code is never partial.
assert.equal(partialResult({ partialExitCode: 3 }, { code: 3, signal: 'SIGTERM', stdout: line }, 1), null);
assert.equal(partialResult({}, { code: 3, stdout: line }, 1), null);
assert.equal(partialResult({ partialExitCode: 3 }, { code: 3, stdout: `${INCOMPLETE_TYPES_PREFIX}[{"outcome":"failed"}]` }, 1), null);
