// Strict argv parsing for every CLI in cli/ (follow-up to security audit finding 4).
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseCliArgs } from './args.mjs';
import { JOB_HANDLERS } from './keel-worker.mjs';
import { parseRestoreArgs } from './keel-restore.mjs';
import { main as remediateMain } from './keel-remediate.mjs';

const CLI = dirname(fileURLToPath(import.meta.url));
const SPEC = {
  name: 'keel-x',
  strings: ['config', 'tenant-ref'],
  text: ['reason'],
  repeatable: ['target'],
  booleans: ['help', 'enforce'],
  short: { h: 'help' },
  positionals: 1,
};
const parse = (...args) => parseCliArgs(args, SPEC);

test('parseCliArgs reads the options it is given', () => {
  const { values, positionals } = parse('run', '--config', '/etc/keel/tenant.json', '--target', 'a', '--target', 'b', '--enforce');
  assert.deepEqual(positionals, ['run']);
  assert.equal(values.config, '/etc/keel/tenant.json');
  assert.equal(values['tenant-ref'], undefined);
  assert.equal(values.reason, undefined);
  assert.deepEqual(values.target, ['a', 'b']);
  assert.equal(values.enforce, true);
  assert.equal(values.help, false);
  assert.equal(parse('-h').values.help, true);
  assert.equal(parse('--config=/etc/keel/x.json').values.config, '/etc/keel/x.json');
});

test('parseCliArgs refuses a value that looks like a flag, never reading it as the flag', () => {
  assert.throws(() => parse('--target', '--enforce'), /^Error: keel-x: Option '--target' argument is ambiguous/);
  assert.throws(() => parse('--config', '-x'), /argument is ambiguous/);
  assert.throws(() => parse('--target=--enforce'), /--target needs a value that does not start with "-"/);
  assert.throws(() => parse('--config='), /--config needs a value/);
  assert.throws(() => parse('--config'), /argument missing/);
});

test('parseCliArgs refuses unknown flags, extra positionals and repeats', () => {
  assert.throws(() => parse('--reinstate'), /keel-x: Unknown option '--reinstate'/);
  assert.throws(() => parse('-x'), /Unknown option '-x'/);
  assert.throws(() => parse('run', 'extra'), /keel-x: Unexpected argument 'extra'/);
  assert.throws(() => parse('--config', 'a', '--config', 'b'), /--config may be given only once/);
  assert.throws(() => parse('--enforce', '--enforce'), /--enforce may be given only once/);
  assert.throws(() => parse('--enforce=yes'), /does not take an argument/);
});

test('free text may start with "-" only when it holds whitespace', () => {
  assert.equal(parse('--reason', '- copied from prod').values.reason, '- copied from prod');
  assert.equal(parse('--reason=- copied from prod').values.reason, '- copied from prod');
  assert.equal(parse('--reason', 'rollback after review').values.reason, 'rollback after review');
  assert.throws(() => parse('--reason', '--enforce'), /argument is ambiguous/);
  assert.throws(() => parse('--reason=--enforce'), /--reason needs a value that does not start with "-"/);
  // Only free-text options get this: a target with a space is still refused.
  assert.throws(() => parse('--target', '- x'), /argument is ambiguous/);
});

// The guard: a CLI must not go back to reading flags by hand. argv.includes('--x')
// matches a value that equals "--x"; argv[argv.indexOf('--x') + 1] reads the next word
// whatever it is. Both are how audit finding 4 turned a restore target into a flag.
const HAND_PARSING = [
  [/\b(?:argv|args)\s*\.\s*(?:includes|indexOf|lastIndexOf|findIndex|find|flatMap|some)\s*\(/, 'argv.includes/indexOf'],
  [/\b(?:argv|args)\s*\[\s*[^\]]*\+\s*1\s*\]/, 'argv[i + 1]'],
  [/process\.argv\s*\[\s*[2-9]\s*\]/, 'process.argv[2]'],
  [/process\.argv\s*\.\s*(?:includes|indexOf|lastIndexOf|findIndex|find|some)\s*\(/, 'process.argv.includes/indexOf'],
];

function handParsingIn(source) {
  const found = [];
  for (const [index, line] of source.split('\n').entries()) {
    if (/^\s*(?:\/\/|\*)/.test(line)) continue;
    for (const [pattern, label] of HAND_PARSING) if (pattern.test(line)) found.push(`${index + 1}: ${label}`);
  }
  return found;
}

const cliFiles = () => readdirSync(CLI).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs') && name !== 'args.mjs');

test('no CLI parses flags by hand', () => {
  const found = [];
  for (const file of cliFiles()) {
    for (const hit of handParsingIn(readFileSync(join(CLI, file), 'utf8'))) found.push(`${file}:${hit}`);
  }
  assert.deepEqual(found, []);
});

test('the guard catches the hand-rolled forms it is meant to block', () => {
  for (const source of [
    "if (argv.includes('--enforce')) {}",
    "const i = process.argv.indexOf(`--${name}`);",
    'return i > -1 ? argv[i + 1] : fallback;',
    "const command = process.argv[2];",
    "argv.flatMap((value, i) => (value === `--${name}` ? [argv[i + 1]] : []))",
  ]) assert.notDeepEqual(handParsingIn(source), [], source);
  assert.deepEqual(handParsingIn("const { values } = parseCliArgs(argv.slice(2), ARGS);"), []);
});

test('every CLI that reads argv parses it with cli/args.mjs', () => {
  const missing = cliFiles().filter((file) => {
    const source = readFileSync(join(CLI, file), 'utf8');
    return /process\.argv\.slice\(2\)|\bargv\b/.test(source) && !/from '\.\/args\.mjs'/.test(source);
  });
  assert.deepEqual(missing, []);
});

// Every job the worker runs must still parse under its CLI's strict parser: a flag the
// worker sends that the CLI does not declare would now fail the job.
const run = promisify(execFile);
const JOB = { requested_by: 'p-1' };
const CONFIG = '/etc/keel/tenant.json';
const WORKER_JOBS = [
  ['collect', { tier: 'tier2', config: CONFIG }],
  ['backup', {}],
  ['prune', { config: CONFIG }],
  ['prune', { config: CONFIG, dryRun: true }],
  ['drift-detect', { snapshotId: 's-1', tenantRef: 't-1', config: CONFIG }],
  ['workload-collect', { config: CONFIG, scope: '/etc/keel/workload-scope.json', tenantRef: 't-1' }],
  ['content-collect', { config: CONFIG, reader: '/etc/keel/content-reader.json', scope: '/etc/keel/content-scope.json', tenantRef: 't-1' }],
  ['discover', { config: CONFIG, tenantRef: 't-1' }],
  ['baseline-create', { snapshotId: 's-1', label: 'Weekly', description: '- copied from prod', tenantRef: 't-1' }],
  ['baseline-create', { snapshotId: 's-1', supersedesBaselineId: 'b-1', label: 'Weekly (v2)' }],
  ['baseline-activate', { baselineId: 'b-1', tenantRef: 't-1' }],
  ['baseline-activate', { baselineId: 'b-1', reinstate: true, version: 2, reason: 'live gate done', tenantRef: 't-1' }],
  ['policy-evaluate', { tenantRef: 't-1' }],
  ['notify', { deliveryId: 'd-1' }],
];

for (const [kind, params] of WORKER_JOBS) {
  test(`the ${kind} job's arguments parse under its CLI (${Object.keys(params).join(', ') || 'no params'})`, async () => {
    const handler = JOB_HANDLERS[kind];
    const args = handler.argsFor(params, JOB);
    // --help stops each of these CLIs right after parsing, so only a parse error fails.
    const { stdout } = await run(process.execPath, [handler.script, ...args, '--help'], {
      env: { ...process.env, KEEL_DB_URL: '' },
    });
    assert.match(stdout, /usage/);
  });
}

test('the restore and remediate jobs\' arguments parse under their CLIs', async () => {
  const restoreArgs = [
    { mode: 'enforce', artifactId: 'a-1' },
    { snapshotId: 's-1', selection: ['k-1'], collectorConfig: CONFIG, targetConfig: '/etc/keel/restorer.json', artifactId: 'a-1', incidentId: 'i-1', acceptDegradation: true },
    { workloadRestore: { workload: 'teams-org-policies', collectionId: 'c-1', targets: ['messaging-policy:global'] }, artifactId: 'a-1' },
  ].map((params) => JOB_HANDLERS.restore.argsFor(params, JOB));
  for (const args of restoreArgs) parseRestoreArgs(['node', 'keel-restore.mjs', ...args]);

  const args = JOB_HANDLERS.remediate.argsFor({
    driftIds: ['d-1', 'd-2'], collectorConfig: CONFIG, targetConfig: '/etc/keel/restorer.json', mode: 'enforce',
  }, JOB);
  const reads = [];
  // The first settings-file read comes only after the arguments are parsed.
  await assert.rejects(remediateMain({
    argv: ['node', 'keel-remediate.mjs', ...args],
    readFile: (path) => { reads.push(path); throw new Error('stop after parsing'); },
    logger: { log() {}, error() {} },
  }), /can't read the restorer settings file/);
  assert.deepEqual(reads, ['/etc/keel/restorer.json']);
});
