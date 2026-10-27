import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  credentialPaths, DEFAULT_COLLECTOR_CONFIG_PATH, DEFAULT_RESTORER_CONFIG_PATH,
  isKeelConfigPath, queueableCredentialPaths, requireKeelConfigPath, RestoreSettingsPathError,
} from './credentialPaths.mjs';
import { JOB_HANDLERS, requireKeelConfigPath as workerRequireKeelConfigPath } from '../../cli/keel-worker.mjs';

test('the Restorer default is the file the deployment host carries', () => {
  assert.equal(DEFAULT_RESTORER_CONFIG_PATH, '/etc/keel/restorer.json');
  assert.equal(DEFAULT_COLLECTOR_CONFIG_PATH, '/etc/keel/tenant.json');
  assert.deepEqual(credentialPaths({}), {
    collectorConfig: '/etc/keel/tenant.json', targetConfig: '/etc/keel/restorer.json',
  });
});

test('a deployment may move either file through the environment; an empty value keeps the default', () => {
  assert.deepEqual(
    credentialPaths({ KEEL_COLLECTOR_CONFIG_PATH: '/srv/keel/c.json', KEEL_RESTORER_CONFIG_PATH: '/srv/keel/r.json' }),
    { collectorConfig: '/srv/keel/c.json', targetConfig: '/srv/keel/r.json' },
  );
  assert.equal(credentialPaths({ KEEL_RESTORER_CONFIG_PATH: '' }).targetConfig, '/etc/keel/restorer.json');
});

test('no source names the old Restorer path the host never had (issue #92)', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  let hits = '';
  try {
    hits = execFileSync('git', ['grep', '-l', 'restorer-target\\.json', '--', ':!engine/restore/credentialPaths.test.mjs'],
      { cwd: root, encoding: 'utf8' });
  } catch (error) {
    if (error.status !== 1) throw error; // 1 = no match
  }
  assert.equal(hits, '', `files still naming restorer-target.json:\n${hits}`);
});

test('the Collector default is the file every collect command reads by default', () => {
  // keel-operator (Q77): the old default, tenant-target.json, was never on the host, so a
  // workload restore needed KEEL_COLLECTOR_CONFIG_PATH set by hand.
  const source = readFileSync(fileURLToPath(new URL('../../cli/keel-collect.mjs', import.meta.url)), 'utf8');
  assert.match(source, /arg\('config', '\/etc\/keel\/tenant\.json', argv\)/);
  assert.equal(DEFAULT_COLLECTOR_CONFIG_PATH, '/etc/keel/tenant.json');
});

// Issue #411 follow-up: the portal checks the server's settings paths with the same rule
// the worker enforces, so it never queues a restore job the worker refuses.
const PATH_CASES = [
  ['/etc/keel/tenant.json', true],
  ['/etc/keel/restorer.json', true],
  ['/etc/keel/sub/restorer.json', true],
  ['etc/keel/restorer.json', true],
  ['/etc/keel/../keel/restorer.json', true],
  ['/srv/keel/restorer.json', false],
  ['/etc/keel/../shadow.json', false],
  ['/etc/keelx/restorer.json', false],
  ['/etc/keel/gh.env', false],
  ['/etc/keel/content.key', false],
  ['/etc/keel/', false],
  ['/etc/keel/restorer.json\0.env', false],
  ['', false],
];

test('the portal check and the worker accept and refuse the same settings paths', () => {
  assert.equal(workerRequireKeelConfigPath, requireKeelConfigPath, 'the worker uses the shared rule');
  for (const [path, ok] of PATH_CASES) {
    assert.equal(isKeelConfigPath(path), ok, `isKeelConfigPath(${JSON.stringify(path)})`);
    let workerAccepts = true;
    try { workerRequireKeelConfigPath(path, 'params.targetConfig'); } catch { workerAccepts = false; }
    assert.equal(workerAccepts, ok, `worker on ${JSON.stringify(path)}`);
    const env = { KEEL_RESTORER_CONFIG_PATH: path, KEEL_COLLECTOR_CONFIG_PATH: path };
    let portalAccepts = true;
    try { queueableCredentialPaths(env); } catch (error) {
      assert.ok(error instanceof RestoreSettingsPathError);
      portalAccepts = false;
    }
    // An empty value falls back to the /etc/keel default, which both sides accept.
    assert.equal(portalAccepts, path === '' ? true : ok, `portal on ${JSON.stringify(path)}`);
  }
});

test('paths the portal queues are ones the restore and remediate handler accepts', () => {
  for (const env of [{}, { KEEL_RESTORER_CONFIG_PATH: '/etc/keel/sub/restorer.json', KEEL_COLLECTOR_CONFIG_PATH: 'etc/keel/c.json' }]) {
    const paths = queueableCredentialPaths(env);
    assert.doesNotThrow(() => JOB_HANDLERS.restore.argsFor({ snapshotId: 's', selection: ['k'], ...paths, artifactId: 'a' }, { id: 'j', requested_by: 'p' }));
    assert.doesNotThrow(() => JOB_HANDLERS.restore.argsFor({ complianceFix: { controlId: 'c', naturalKey: 'k' }, ...paths, artifactId: 'a' }, { id: 'j', requested_by: 'p' }));
  }
});

test('a settings path outside /etc/keel is refused in plain words naming the setting, never the path', () => {
  assert.deepEqual(queueableCredentialPaths({}), { collectorConfig: '/etc/keel/tenant.json', targetConfig: '/etc/keel/restorer.json' });
  assert.throws(() => queueableCredentialPaths({ KEEL_RESTORER_CONFIG_PATH: '/srv/secret-place/r.json' }), (error) => {
    assert.ok(error instanceof RestoreSettingsPathError);
    assert.equal(error.message, "Keel's restore settings file must be a .json file in /etc/keel. Ask whoever runs the Keel server to fix KEEL_RESTORER_CONFIG_PATH.");
    assert.ok(!error.message.includes('secret-place'));
    return true;
  });
  assert.throws(() => queueableCredentialPaths({ KEEL_COLLECTOR_CONFIG_PATH: '/etc/keel/gh.env' }), /fix KEEL_COLLECTOR_CONFIG_PATH\.$/);
});
