import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createIsolatedTestDatabase, requireTestDatabaseUrl,
} from './dbTestHelper.mjs';

test('database test URL guard rejects missing and production URLs before SQL', () => {
  const savedTestUrl = process.env.KEEL_DB_TEST_URL;
  const savedProductionUrl = process.env.KEEL_DB_URL;
  try {
    delete process.env.KEEL_DB_TEST_URL;
    assert.throws(() => requireTestDatabaseUrl(), /KEEL_DB_TEST_URL not set/);

    process.env.KEEL_DB_TEST_URL = 'postgresql://test.example/keel_test';
    process.env.KEEL_DB_URL = 'postgresql://production.example/keel';
    assert.throws(
      () => requireTestDatabaseUrl(process.env.KEEL_DB_URL),
      /KEEL_DB_TEST_URL only/,
    );
  } finally {
    if (savedTestUrl === undefined) delete process.env.KEEL_DB_TEST_URL;
    else process.env.KEEL_DB_TEST_URL = savedTestUrl;
    if (savedProductionUrl === undefined) delete process.env.KEEL_DB_URL;
    else process.env.KEEL_DB_URL = savedProductionUrl;
  }
});

test('isolated database connections use their own schema', async () => {
  const database = await createIsolatedTestDatabase(import.meta.url);
  let client;
  try {
    client = await database.connect();
    const { rows } = await client.query('SELECT current_schema() AS schema');
    assert.equal(rows[0].schema, database.schema);
  } finally {
    await client?.end();
    await database.cleanup();
  }
});

test('baseline and disposition tests pass under default concurrency', () => {
  const url = requireTestDatabaseUrl();
  const result = spawnSync(process.execPath, [
    '--test',
    fileURLToPath(new URL('../govern/baseline.test.mjs', import.meta.url)),
    fileURLToPath(new URL('../govern/disposition.test.mjs', import.meta.url)),
  ], {
    encoding: 'utf8',
    env: { ...process.env, KEEL_DB_TEST_URL: url },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
