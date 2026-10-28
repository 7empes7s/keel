// Security audit finding 4: a value from a job's params must never reach the restore
// CLI as a flag. A workload restore target "--allow-tenant-wide-test-writes" used to
// switch that option on, because the worker put it into argv and keel-restore read
// flags with argv.includes.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { JOB_HANDLERS } from './keel-worker.mjs';
import { main, parseRestoreArgs } from './keel-restore.mjs';

const job = { requested_by: 'p-1' };
const workload = (request) => ({
  workloadRestore: { workload: 'teams-org-policies', collectionId: 'c-1', ...request }, artifactId: 'a-1',
});
const argv = (...args) => ['node', 'keel-restore.mjs', ...args];

test('the worker refuses a param value that starts with "-"', () => {
  for (const injected of ['--allow-tenant-wide-test-writes', '--enforce', '--help', '-x']) {
    assert.throws(() => JOB_HANDLERS.restore.argsFor(workload({ targets: ['messaging-policy:global', injected] }), job),
      /targets entry must not start with "-"/);
    assert.throws(() => JOB_HANDLERS.restore.argsFor(workload({ targets: ['k'], workload: injected }), job),
      /workload must not start with "-"/);
    assert.throws(() => JOB_HANDLERS.restore.argsFor(workload({ teamId: injected }), job),
      /teamId must not start with "-"/);
    assert.throws(() => JOB_HANDLERS.restore.argsFor({ ...workload({ targets: ['k'] }), artifactId: injected }, job),
      /artifactId must not start with "-"/);
    assert.throws(() => JOB_HANDLERS.restore.argsFor(workload({ targets: ['k'] }), { requested_by: injected }),
      /requested_by must not start with "-"/);
    assert.throws(() => JOB_HANDLERS.restore.argsFor({ mode: 'enforce', artifactId: injected }, job),
      /artifactId must not start with "-"/);
    assert.throws(() => JOB_HANDLERS['baseline-activate'].argsFor({ baselineId: injected }, job),
      /baselineId must not start with "-"/);
  }
  // Ordinary values still pass through unchanged.
  assert.deepEqual(JOB_HANDLERS.restore.argsFor(workload({ targets: ['messaging-policy:global'] }), job),
    ['--workload', 'teams-org-policies', '--collection', 'c-1', '--target', 'messaging-policy:global',
      '--persist-artifact', 'a-1', '--requested-by', 'p-1']);
});

test('keel-restore reads a target that looks like a flag as an error, never as the flag', () => {
  assert.throws(() => parseRestoreArgs(argv('--workload', 'teams-org-policies', '--collection', 'c-1',
    '--target', 'messaging-policy:global', '--target', '--allow-tenant-wide-test-writes')),
  /--target' argument is ambiguous/);
  // An inline "--target=--x" is not a flag either: it is refused as a value.
  assert.throws(() => parseRestoreArgs(argv('--workload', 'w', '--target=--allow-tenant-wide-test-writes')),
    /--target needs a value that does not start with "-"/);
  assert.throws(() => parseRestoreArgs(argv('--persist-artifact', '--enforce')), /argument is ambiguous/);
});

test('keel-restore refuses unknown flags, positionals, repeats and empty values', () => {
  assert.throws(() => parseRestoreArgs(argv('--help')), /Unknown option '--help'/);
  assert.throws(() => parseRestoreArgs(argv('--reinstate')), /Unknown option '--reinstate'/);
  assert.throws(() => parseRestoreArgs(argv('--plan', 'p', 'extra')), /Unexpected argument 'extra'/);
  assert.throws(() => parseRestoreArgs(argv('--plan', 'p', '--plan', 'q')), /--plan may be given only once/);
  assert.throws(() => parseRestoreArgs(argv('--enforce', '--enforce')), /--enforce may be given only once/);
  assert.throws(() => parseRestoreArgs(argv('--target=')), /--target needs a value/);
});

test('keel-restore parses the flags it supports', () => {
  const parsed = parseRestoreArgs(argv('--workload', 'teams-org-policies', '--collection', 'c-1',
    '--target', 'a', '--target', 'b', '--allow-tenant-wide-test-writes', '--persist-artifact', 'a-1'));
  assert.equal(parsed.workload, 'teams-org-policies');
  assert.equal(parsed.collection, 'c-1');
  assert.deepEqual(parsed.target, ['a', 'b']);
  assert.equal(parsed['allow-tenant-wide-test-writes'], true);
  assert.equal(parsed.enforce, false);
  assert.deepEqual(parsed.select, []);
  assert.equal(parsed.plan, undefined);
});

test('main stops before reading any file when a target is a flag', async () => {
  const reads = [];
  await assert.rejects(main({
    argv: argv('--workload', 'teams-org-policies', '--collection', 'c-1',
      '--target', 'messaging-policy:global', '--target', '--allow-tenant-wide-test-writes'),
    readFile: (path) => { reads.push(path); throw new Error('unexpected read'); },
    dbUrl: 'postgres://fixture.invalid/unused',
    logger: { log() {}, error() {} },
  }), /argument is ambiguous/);
  assert.deepEqual(reads, []);
});
