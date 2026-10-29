// Issue #681: Viva Engage writes sign in as the Engage writer, a small app of its
// own, because Engage's front proxy refuses the Restorer's large token. Fixtures only.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GraphWriter } from './graphWriter.mjs';
import {
  DEFAULT_ENGAGE_WRITER_CONFIG_PATH, engageWriterConfigPath, isEngageUrl, needsEngageWriter, readEngageWriterConfig,
  restoreWriterTokens,
} from './engageWriter.mjs';

const TENANT = '00000000-0000-4000-8000-0000000000c1';
const collectorConfig = { tenantId: TENANT, clientId: 'collector', certPath: 'c.pem', keyPath: 'c.key' };
const targetConfig = { tenantId: TENANT, clientId: 'restorer', certPath: 'r.pem', keyPath: 'r.key' };
const engageConfig = { tenantId: TENANT, clientId: 'engage', certPath: 'e.pem', keyPath: 'e.key' };
const PATH = '/etc/keel/engage-writer.json';

const filesOf = (files) => (path) => {
  if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return files[path];
};
const getTokenFn = async (config) => ({ accessToken: `token:${config.clientId}` });
const logger = () => { const lines = []; return { lines, log: (line) => lines.push(line) }; };

test('only Graph /employeeExperience URLs are Viva Engage', () => {
  assert.equal(isEngageUrl('https://graph.microsoft.com/v1.0/employeeExperience/communities/c-1'), true);
  assert.equal(isEngageUrl('https://graph.microsoft.com/beta/employeeExperience/engagementAsyncOperations'), true);
  assert.equal(isEngageUrl('https://graph.microsoft.com/v1.0/employeeExperience'), true);
  assert.equal(isEngageUrl('https://graph.microsoft.com/v1.0/groups/g-1'), false);
  assert.equal(isEngageUrl('https://graph.microsoft.com/v1.0/employeeExperienceX/communities'), false);
  assert.equal(isEngageUrl('https://example.com/v1.0/employeeExperience/communities'), false);
  assert.equal(isEngageUrl('not a url'), false);
  assert.equal(needsEngageWriter(['group', 'engageCommunity']), true);
  assert.equal(needsEngageWriter(['group']), false);
});

test('the settings path defaults to /etc/keel/engage-writer.json and can be moved', () => {
  assert.equal(engageWriterConfigPath({}), DEFAULT_ENGAGE_WRITER_CONFIG_PATH);
  assert.equal(engageWriterConfigPath({ KEEL_ENGAGE_WRITER_CONFIG_PATH: '/etc/keel/other.json' }), '/etc/keel/other.json');
});

test('a missing file is null; a broken, shared or other-tenant file stops the run', () => {
  const read = (files) => readEngageWriterConfig({ path: PATH, readFile: filesOf(files), collectorConfig, targetConfig });
  assert.equal(read({}), null);
  assert.deepEqual(read({ [PATH]: JSON.stringify(engageConfig) }), engageConfig);
  assert.throws(() => read({ [PATH]: '{not json' }), /Engage writer settings file .*not valid JSON/);
  assert.throws(() => read({ [PATH]: JSON.stringify({ ...engageConfig, clientId: '' }) }), /names no clientId/);
  assert.throws(() => read({ [PATH]: JSON.stringify({ ...engageConfig, tenantId: 'other' }) }), /another tenant/);
  assert.throws(() => read({ [PATH]: JSON.stringify({ ...engageConfig, clientId: 'restorer' }) }), /its own app and certificate/);
  assert.throws(() => read({ [PATH]: JSON.stringify({ ...engageConfig, certPath: 'c.pem' }) }), /its own app and certificate/);
  assert.throws(() => read({ [PATH]: JSON.stringify({ ...engageConfig, keyPath: 'r.key' }) }), /its own app and certificate/);
});

test('with an Engage writer, only Viva Engage requests use its token', async () => {
  const log = logger();
  const { tokenFor, engage } = await restoreWriterTokens({
    getTokenFn, targetConfig, collectorConfig, resourceTypes: ['group', 'engageCommunity'],
    readFile: filesOf({ [PATH]: JSON.stringify(engageConfig) }), path: PATH, logger: log,
  });
  assert.equal(engage, 'engage-writer');
  assert.equal(await tokenFor('https://graph.microsoft.com/v1.0/employeeExperience/communities/c-1'), 'token:engage');
  assert.equal(await tokenFor('https://graph.microsoft.com/v1.0/groups/g-1'), 'token:restorer');
  assert.equal(await tokenFor(undefined), 'token:restorer');
  assert.deepEqual(log.lines, ['Viva Engage writes: signed in as the Engage writer']);
});

test('without an Engage writer file, Viva Engage writes keep the Restorer and the run says so', async () => {
  const log = logger();
  const { tokenFor, engage } = await restoreWriterTokens({
    getTokenFn, targetConfig, collectorConfig, resourceTypes: ['engageCommunity'], readFile: filesOf({}), path: PATH, logger: log,
  });
  assert.equal(engage, 'restorer');
  assert.equal(await tokenFor('https://graph.microsoft.com/v1.0/employeeExperience/communities/c-1'), 'token:restorer');
  assert.match(log.lines[0], /no Engage writer settings file .*use the Restorer/);
});

test('a restore with no Viva Engage write never opens the Engage writer file', async () => {
  const opened = [];
  const { tokenFor, engage } = await restoreWriterTokens({
    getTokenFn, targetConfig, collectorConfig, resourceTypes: ['group'], path: PATH,
    readFile: (path) => { opened.push(path); return '{not json'; },
  });
  assert.equal(engage, 'not-needed');
  assert.deepEqual(opened, []);
  assert.equal(await tokenFor('https://graph.microsoft.com/v1.0/employeeExperience/communities/c-1'), 'token:restorer');
});

test('a broken Engage writer credential stops the run before any write', async () => {
  const failing = async (config) => { if (config.clientId === 'engage') throw new Error('certificate rejected'); return getTokenFn(config); };
  await assert.rejects(restoreWriterTokens({
    getTokenFn: failing, targetConfig, collectorConfig, resourceTypes: ['engageCommunity'],
    readFile: filesOf({ [PATH]: JSON.stringify(engageConfig) }), path: PATH,
  }), /certificate rejected/);
});

test('GraphWriter tells its token function the URL of every request', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push([url, init.headers.Authorization]);
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { tokenFor } = await restoreWriterTokens({
    getTokenFn, targetConfig, collectorConfig, resourceTypes: ['engageCommunity'],
    readFile: filesOf({ [PATH]: JSON.stringify(engageConfig) }), path: PATH,
  });
  const writer = new GraphWriter(tokenFor);
  await writer.write('v1.0', '/employeeExperience/communities/c-1', { method: 'PATCH', body: { description: 'x' } });
  await writer.read('v1.0', '/employeeExperience/communities/c-1');
  await writer.write('v1.0', '/groups/g-1', { method: 'PATCH', body: { description: 'x' } });
  assert.deepEqual(sent, [
    ['https://graph.microsoft.com/v1.0/employeeExperience/communities/c-1', 'Bearer token:engage'],
    ['https://graph.microsoft.com/v1.0/employeeExperience/communities/c-1', 'Bearer token:engage'],
    ['https://graph.microsoft.com/v1.0/groups/g-1', 'Bearer token:restorer'],
  ]);
});
