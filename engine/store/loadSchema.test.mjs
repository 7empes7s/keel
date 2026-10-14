import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { schemaBytes, schemaFiles, schemaSql } from './loadSchema.mjs';
import { currentSchemaPin } from '../storage/recoveryManifest.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const STORE_DIR = fileURLToPath(new URL('.', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'keel-load-schema-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A copy of engine/store with schema.sql and the given fragments only. */
function storeWith(name, fragments) {
  const dir = join(tmp, name);
  mkdirSync(join(dir, 'schema.d'), { recursive: true });
  cpSync(join(STORE_DIR, 'schema.sql'), join(dir, 'schema.sql'));
  writeFileSync(join(dir, 'schema.d', 'README.md'), 'not SQL\n');
  for (const [file, sql] of Object.entries(fragments)) writeFileSync(join(dir, 'schema.d', file), sql);
  return dir;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('schema.sql comes first, then the .sql fragments in file-name order', () => {
  const dir = storeWith('order', { '20-b.sql': '-- b\n', '10-a.sql': '-- a\n', '.hidden.sql': '-- hidden\n' });
  assert.deepEqual(schemaFiles({ storeDir: dir }).map((path) => basename(path)), ['schema.sql', '10-a.sql', '20-b.sql']);
  const sql = schemaSql({ storeDir: dir });
  assert.ok(sql.startsWith(readFileSync(join(dir, 'schema.sql'), 'utf8')));
  assert.ok(sql.endsWith('\n-- a\n\n-- b\n'));
});

test('without fragments the schema is exactly schema.sql, so existing schema pins still match', async () => {
  const dir = storeWith('bare', {});
  assert.deepEqual(schemaBytes({ storeDir: dir }), readFileSync(join(dir, 'schema.sql')));
  assert.equal(await currentSchemaPin({ storeDir: dir }), sha256(readFileSync(join(dir, 'schema.sql'))));
  // A store with no schema.d directory at all loads too.
  const noDir = join(tmp, 'no-fragments-dir');
  mkdirSync(noDir);
  cpSync(join(STORE_DIR, 'schema.sql'), join(noDir, 'schema.sql'));
  assert.equal(await currentSchemaPin({ storeDir: noDir }), await currentSchemaPin({ storeDir: dir }));
});

test('the schema pin covers the fragments: adding or changing one changes the pin', async () => {
  const bare = await currentSchemaPin({ storeDir: storeWith('pin-bare', {}) });
  const one = await currentSchemaPin({ storeDir: storeWith('pin-one', { '50-x.sql': 'SELECT 1;\n' }) });
  const changed = await currentSchemaPin({ storeDir: storeWith('pin-changed', { '50-x.sql': 'SELECT 2;\n' }) });
  assert.notEqual(one, bare);
  assert.notEqual(changed, one);
  assert.equal(await currentSchemaPin(), sha256(schemaBytes()), 'the build pin hashes the full schema');
});

test('a fragment adds its table, and the whole schema re-applies cleanly', async () => {
  const dir = storeWith('apply', {
    '90-wave0-fixture.sql': `CREATE TABLE IF NOT EXISTS wave0_fixture (
  id bigserial PRIMARY KEY,
  snapshot_id uuid REFERENCES snapshot(id)
);\n`,
  });
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  try {
    await client.query(schemaSql({ storeDir: dir }));
    await client.query(schemaSql({ storeDir: dir }));
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'wave0_fixture'",
    );
    assert.equal(rows[0].n, 1);
  } finally {
    await client.end();
    await database.cleanup();
  }
});

test('the repository schema loads through the helper', () => {
  assert.equal(schemaFiles()[0], join(STORE_DIR, 'schema.sql'));
  for (const path of schemaFiles().slice(1)) assert.match(basename(path), /^\d{2}-[a-z0-9-]+\.sql$/, `${path} is named NN-topic.sql`);
});
