// A missing or broken settings file (tenant.json, restorer.json, the content reader
// file) stops every Keel command with one plain sentence that names the file, what is
// wrong and what to do. Never a raw ENOENT or SyntaxError, and never the file's content.
// keel-restore and the collectors are covered by keel-restore-config-files.test.mjs.
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

import { main as baselineCreate } from './keel-baseline-create.mjs';
import { main as breakglass } from './keel-breakglass.mjs';
import { main as exportMain } from './keel-export.mjs';
import { contentStoreFromReader } from './keel-import.mjs';
import { main as plan } from './keel-plan.mjs';
import { main as policyScenario } from './keel-policy-scenario.mjs';
import { main as recoveryMetrics } from './keel-recovery-metrics.mjs';
import { main as schedulesHost } from './keel-schedules-host.mjs';
import { main as valueReport } from './keel-value-report.mjs';
import { main as apiDrift } from '../tools/qualification/apiDrift.mjs';
import { configuredTenantRef } from '../tools/release/qualification.mjs';
import { validateDrillPlan } from '../tools/rehearsal/qualification.mjs';

const CLI = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(CLI, '..', 'tools');
const dir = mkdtempSync(join(tmpdir(), 'keel-settings-files-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const tenant = join(dir, 'tenant.json');
const missing = join(dir, 'gone.json');
const broken = join(dir, 'broken.json');
const proposal = join(dir, 'proposal.json');
writeFileSync(tenant, JSON.stringify({ tenantId: '0a1b2c3d-0000-4000-8000-000000000001', clientId: 'collector' }));
writeFileSync(broken, '{"tenantId": "x", "clientSecret": "do-not-print-me",');
writeFileSync(proposal, '{}');

const RAW = /ENOENT|SyntaxError|Unexpected token|at position|do-not-print-me/;
const plain = (what, path, problem) => ({
  name: 'ConfigFileError',
  message: `Keel can't read the ${what} file (${path}): ${problem}. Fix the file on the Keel server, then try again.`,
});
const quiet = { log() {}, error() {} };
// Nothing here may reach the database or the tenant.
const refuseConnect = () => { throw new Error('connected'); };
const fakeClient = { end: async () => {} };

test('baseline create, export and plan name the broken or missing tenant file', async () => {
  await assert.rejects(baselineCreate({
    argv: ['node', 'x', '--snapshot-id', 's', '--label', 'L', '--set-by', 'p', '--config', broken],
    dbUrl: 'postgres://unused', dependencies: { connect: async () => fakeClient }, logger: quiet,
  }), plain('collector settings', broken, 'it is not valid JSON'));
  await assert.rejects(exportMain({ argv: ['node', 'x', '--export-root', dir, '--config', missing], logger: quiet }),
    plain('collector settings', missing, 'the file is missing'));
  await assert.rejects(plan({ argv: ['node', 'x', '--source-config', broken, '--target-config', tenant], dbUrl: 'postgres://unused', logger: quiet }),
    plain('source tenant settings', broken, 'it is not valid JSON'));
  await assert.rejects(plan({ argv: ['node', 'x', '--source-config', tenant, '--target-config', missing], dbUrl: 'postgres://unused', logger: quiet }),
    plain('target tenant settings', missing, 'the file is missing'));
  await assert.rejects(plan({ argv: ['node', 'x', '--source-config', tenant], dbUrl: 'postgres://unused', logger: quiet }),
    { message: '--target-config is required (the target tenant settings file)' });
});

test('break-glass, policy scenario, recovery metrics, value report and schedules name the tenant file', async () => {
  const common = { connectFn: refuseConnect, logger: quiet };
  await assert.rejects(breakglass({ ...common, argv: ['report', '--db-url', 'postgres://unused', '--config', missing] }),
    plain('collector settings', missing, 'the file is missing'));
  await assert.rejects(policyScenario({ ...common, argv: ['evaluate', '--proposal', proposal, '--db-url', 'postgres://unused', '--config', broken] }),
    plain('collector settings', broken, 'it is not valid JSON'));
  await assert.rejects(recoveryMetrics({ ...common, argv: ['report', '--db-url', 'postgres://unused', '--config', broken] }),
    plain('collector settings', broken, 'it is not valid JSON'));
  await assert.rejects(valueReport({ ...common, env: {}, argv: ['--db-url', 'postgres://unused', '--config', missing] }),
    plain('collector settings', missing, 'the file is missing'));
  await assert.rejects(schedulesHost(['health', '--tenant-config', broken, '--db-url', 'postgres://unused']),
    plain('collector settings', broken, 'it is not valid JSON'));
});

test('a bundle export or import names the broken content reader file', () => {
  assert.throws(() => contentStoreFromReader(fakeClient, broken),
    plain('content backup reader settings', broken, 'it is not valid JSON'));
});

test('operator tools name the broken or missing settings file', async () => {
  await assert.rejects(apiDrift({ argv: ['node', 'x', '--config', broken], logger: quiet }),
    plain('collector settings', broken, 'it is not valid JSON'));
  assert.throws(() => validateDrillPlan({ manifest: {}, collectorConfigPath: tenant, restorerConfigPath: missing }),
    plain('restorer settings', missing, 'the file is missing'));
  // The release gate only asks which tenant it runs for; an unreadable file still means "none".
  assert.equal(configuredTenantRef(broken), null);
});

// These scripts run on import, so they are started the way the job runner starts them.
const run = promisify(execFile);
for (const [script, args] of [
  ['keel-prune.mjs', ['--dry-run']],
  ['keel-drift.mjs', ['detect']],
  ['keel-drift.mjs', ['list']],
  ['keel-govern.mjs', ['baseline', 'set', '--snapshot', 's', '--by', 'p']],
]) {
  test(`${script} ${args[0]} stops with the plain sentence and never quotes the file`, async () => {
    for (const [path, problem] of [[missing, 'the file is missing'], [broken, 'it is not valid JSON']]) {
      const failure = await run(process.execPath, [join(CLI, script), ...args, '--config', path],
        { env: { ...process.env, KEEL_DB_URL: 'postgres://unused' } }).then(() => null, (error) => error);
      assert.ok(failure, 'the run must fail');
      assert.equal(failure.code, 1);
      // The first line is the plain sentence; the stack and error code below it are details.
      assert.equal(failure.stderr.split('\n')[0], `ConfigFileError: ${plain('collector settings', path, problem).message}`);
      assert.doesNotMatch(failure.stderr, /SyntaxError|Unexpected token|at position|do-not-print-me/);
    }
  });
}

// Every settings file goes through readConfigFile. Only the input files a person names
// on the command line (fixtures, proposals, evidence) may still be parsed directly.
test('no command parses a settings file with a bare JSON.parse', () => {
  const allowed = new Set([
    "keel-bootstrap.mjs: JSON.parse(readFileSync(flags.get('--fixture')",
    'keel-discover.mjs: JSON.parse(readFile(commandsPath)',
    'keel-policy-scenario.mjs: JSON.parse(readFile(proposalPath',
    'keel-policy-scenario.mjs: JSON.parse(readFile(whatIfPath',
    'keel-recovery-metrics.mjs: JSON.parse(readFile(manifestPath',
    'keel-value-report.mjs: JSON.parse(readFile(estimatePath',
    'keel-workload-collect.mjs: JSON.parse(readFile(path)',
  ]);
  const found = [];
  for (const file of readdirSync(CLI).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))) {
    for (const [match] of readFileSync(join(CLI, file), 'utf8').matchAll(/JSON\.parse\(readFile(?:Sync)?\([^,)]*\)?/g)) {
      found.push(`${file}: ${match}`);
    }
  }
  assert.deepEqual(found.filter((entry) => !allowed.has(entry)), []);
});

// The same rule for the operator tools under tools/: every /etc/keel settings file goes
// through readConfigFile. Only input files (named on the command line, or evidence,
// fixtures and documentation read from a folder) may still be parsed directly.
test('no operator tool parses a settings file with a bare JSON.parse', () => {
  const allowed = new Set([
    'coverage-fixtures/fixtures.mjs: JSON.parse(readFileSync(MANIFEST',
    'qualification/apiDrift.mjs: JSON.parse(readFile(sourcesPath',
    "qualification/benchmarkLicense.mjs: JSON.parse(readFileSync(new URL('../../docs/roadmap/benchmark-content/nist-sp800-53-rev5-pin.json'",
    'qualification/benchmarkLicense.mjs: JSON.parse(readFileSync(process.argv[2]',
    'qualification/conditionalAccess.mjs: JSON.parse(readFile(file',
    'qualification/dynamicGroups.mjs: JSON.parse(readFile(file',
    'qualification/entraLive.mjs: JSON.parse(readFileSync(join(dir',
    'qualification/exchangeAcceptance.mjs: JSON.parse(readFileSync(join(evidenceDir ?? process.cwd()',
    'qualification/exchangeLive.mjs: JSON.parse(readFile(teamsPath)',
    'qualification/exchangeLive.mjs: JSON.parse(readFile(options.grants)',
    'qualification/exchangeLive.mjs: JSON.parse(readFile(options.docs)',
    'qualification/liveRecords.mjs: JSON.parse(readFileSync(path',
    'qualification/onedrivePurviewAcceptance.mjs: JSON.parse(readFileSync(join(evidenceDir ?? process.cwd()',
    'qualification/onedrivePurviewLive.mjs: JSON.parse(readFile(join(dir',
    'qualification/onedrivePurviewLive.mjs: JSON.parse(readFile(exchangePath)',
    'qualification/onedrivePurviewLive.mjs: JSON.parse(readFile(options.grants)',
    'qualification/onedrivePurviewLive.mjs: JSON.parse(readFile(options.docs)',
    // The Sentinel and ServiceNow adapter configs are files a person names on the command line, not /etc/keel files.
    'qualification/sentinel.mjs: JSON.parse(readFileSync(configPath',
    'qualification/sentinelLive.mjs: JSON.parse(readFile(options.roles)',
    'qualification/sentinelLive.mjs: JSON.parse(readFile(options.docs)',
    'qualification/servicenow.mjs: JSON.parse(readFileSync(configPath',
    'qualification/servicenowLive.mjs: JSON.parse(readFile(options.config)',
    'qualification/servicenowLive.mjs: JSON.parse(readFile(options.testUsers)',
    'qualification/servicenowLive.mjs: JSON.parse(readFile(options.recordTemplate)',
    'qualification/servicenowLive.mjs: JSON.parse(readFile(options.docs)',
    'qualification/sharepointLive.mjs: JSON.parse(readFile(options.grants)',
    'qualification/sharepointLive.mjs: JSON.parse(readFile(options.docs)',
    'qualification/sharepointSiteGrantsLive.mjs: JSON.parse(readFile(options.grants)',
    'qualification/sharepointSiteGrantsLive.mjs: JSON.parse(readFile(options.docs)',
    'qualification/sharepointSitePermissionsLive.mjs: JSON.parse(readFile(options.grants)',
    'qualification/sharepointSitePermissionsLive.mjs: JSON.parse(readFile(options.docs)',
    'qualification/teamsAcceptance.mjs: JSON.parse(readFileSync(join(evidenceDir ?? process.cwd()',
    'qualification/teamsLive.mjs: JSON.parse(readFile(sharePointPath)',
    'qualification/teamsLive.mjs: JSON.parse(readFile(options.grants)',
    'qualification/teamsLive.mjs: JSON.parse(readFile(options.docs)',
    'qualification/workloadWritesLive.mjs: JSON.parse(readFile(options.grants)',
    'qualification/workloads.mjs: JSON.parse(readFile(options.grants)',
    // The drill manifest (--manifest); the two settings files go through readSettings.
    'rehearsal/qualification.mjs: JSON.parse(readFileSync(path',
    'release/acceptanceLedger.mjs: JSON.parse(readFileSync(join(dir',
    'release/acceptanceLedger.mjs: JSON.parse(readFileSync(path',
    'release/acceptanceLedger.mjs: JSON.parse(readFileSync(fixturePath',
    'release/qualification.mjs: JSON.parse(readFileSync(pinPath',
    'release/qualification.mjs: JSON.parse(readFileSync(resolve(evidenceDir',
    'release/qualification.mjs: JSON.parse(readFileSync(evidencePath',
    'release/qualification.mjs: JSON.parse(readFileSync(path',
    'tenant-probe/delegated-probe.mjs: JSON.parse(readFileSync(file',
  ]);
  const scripts = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return scripts(path);
    return entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs') ? [path] : [];
  });
  const found = [];
  for (const file of scripts(TOOLS)) {
    for (const [match] of readFileSync(file, 'utf8').matchAll(/JSON\.parse\(readFile(?:Sync)?\([^,)]*\)?/g)) {
      found.push(`${relative(TOOLS, file).split(sep).join('/')}: ${match}`);
    }
  }
  assert.deepEqual(found.filter((entry) => !allowed.has(entry)), []);
});
