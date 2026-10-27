// A missing or broken settings file stops the run with a plain sentence, never a raw
// ENOENT or JSON error, and never quotes the file's content.
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { ConfigFileError, readConfigFile, SCOPE_LISTED_FIX } from './configFile.mjs';

const dir = mkdtempSync(join(tmpdir(), 'keel-config-file-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name, text) => {
  const path = join(dir, name);
  if (text !== undefined) writeFileSync(path, text);
  return path;
};
const read = (path, options = {}) => readConfigFile(path, { readFile: readFileSync, what: 'Exchange collector settings', ...options });
const RAW = /ENOENT|EACCES|EISDIR|SyntaxError|Unexpected token|JSON\.parse|at position/;

function refuses(path, problem, options) {
  assert.throws(() => read(path, options), (error) => {
    assert.ok(error instanceof ConfigFileError);
    assert.equal(error.path, path);
    assert.equal(error.problem, problem);
    assert.ok(error.message.startsWith(`Keel can't read the Exchange collector settings file (${path}): ${problem}. `), error.message);
    assert.doesNotMatch(error.message, RAW);
    return true;
  });
}

test('a good file gives its settings', () => {
  assert.deepEqual(read(file('good.json', '{"tenantId":"t","organization":"contoso.onmicrosoft.com"}')), {
    tenantId: 't', organization: 'contoso.onmicrosoft.com',
  });
});

test('a missing file says so and keeps the error code for logs', () => {
  const path = file('missing.json');
  refuses(path, 'the file is missing');
  assert.throws(() => read(path), { code: 'ENOENT' });
});

test('a file that is not JSON says so and never quotes the file', () => {
  const path = file('broken.json', '{"clientSecret": "hunter2-very-secret", oops');
  refuses(path, 'it is not valid JSON');
  assert.throws(() => read(path), (error) => !error.message.includes('hunter2') && error.cause === undefined);
});

test('an empty file, a folder and a file without an object each get their own words', () => {
  refuses(file('empty.json', '  \n'), 'the file is empty');
  const folder = join(dir, 'folder.json');
  mkdirSync(folder);
  refuses(folder, 'it is a folder, not a file');
  refuses(file('null.json', 'null'), 'it does not hold settings (a JSON object)');
  refuses(file('list.json', '[{"tenantId":"t"}]'), 'it does not hold settings (a JSON object)');
});

test('a file Keel may not open says so', () => {
  const readFile = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
  refuses('/etc/keel/exchange-collector.json', 'Keel is not allowed to open it', { readFile });
});

test('the next step defaults to fixing the file and can name the scope file', () => {
  assert.throws(() => read(file('gone.json')), { message: /: the file is missing\. Fix the file on the Keel server, then try again\.$/ });
  assert.throws(() => read(file('gone.json'), { fix: SCOPE_LISTED_FIX }), {
    message: /: the file is missing\. Fix the file on the Keel server, or remove it from workload-scope\.json\.$/,
  });
});
