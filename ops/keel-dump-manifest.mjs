#!/usr/bin/env node
// Called only after backup.sh has successfully produced and verified the dump.
// Task 43 reads /opt/backups/keel-db-manifest.json; timestamp is dump completion UTC,
// checksum is SHA-256 of the compressed bytes, path is the absolute dump filename.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function writeDumpManifest(dumpPath, manifestPath = '/opt/backups/keel-db-manifest.json') {
  const path = resolve(dumpPath);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const manifest = { path, checksum: hash.digest('hex'), timestamp: new Date().toISOString() };
  const temporary = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, manifestPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('usage: keel-dump-manifest.mjs /absolute/path/to/keel-db.sql.gz');
  await writeDumpManifest(process.argv[2]);
}
