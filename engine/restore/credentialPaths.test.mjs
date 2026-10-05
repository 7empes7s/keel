import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  credentialPaths, DEFAULT_COLLECTOR_CONFIG_PATH, DEFAULT_RESTORER_CONFIG_PATH,
} from './credentialPaths.mjs';

test('the Restorer default is the file the deployment host carries', () => {
  assert.equal(DEFAULT_RESTORER_CONFIG_PATH, '/etc/keel/restorer.json');
  assert.equal(DEFAULT_COLLECTOR_CONFIG_PATH, '/etc/keel/tenant-target.json');
  assert.deepEqual(credentialPaths({}), {
    collectorConfig: '/etc/keel/tenant-target.json', targetConfig: '/etc/keel/restorer.json',
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
