import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { writeDumpManifest } from '../../ops/keel-dump-manifest.mjs';

const directory = await mkdtemp(join(tmpdir(), 'keel-manifest-'));
try {
  const dump = join(directory, 'keel-db.sql.gz');
  const path = join(directory, 'keel-db-manifest.json');
  const bytes = gzipSync('COPY public.fixture (id) FROM stdin;\n');
  await writeFile(dump, bytes);
  const before = new Date();
  const manifest = await writeDumpManifest(dump, path);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), manifest);
  assert.equal(manifest.path, dump);
  assert.equal(manifest.checksum, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(new Date(manifest.timestamp) >= before);
  assert.ok(new Date(manifest.timestamp) <= new Date());
  await assert.rejects(() => writeDumpManifest(join(directory, 'missing'), path), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), manifest, 'failure preserves previous manifest');
  const backup = await readFile('/opt/mimoun/backup.sh', 'utf8');
  assert.match(backup, /if \[ "\$KEEL_BACKUP_FAILED" -eq 0 \]; then\s+if ! node \/opt\/keel\/ops\/keel-dump-manifest.mjs "\$BACKUP_PATH\/keel-db.sql.gz"; then/);
  console.log('dumpManifest.test.mjs — all assertions passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}
