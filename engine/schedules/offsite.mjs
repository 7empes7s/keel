import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, writeFile, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyFreshManifest(manifestPath, shippedPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isAbsolute(manifest.path ?? '') || !/^[a-f0-9]{64}$/.test(manifest.checksum ?? '')
      || !Number.isFinite(Date.parse(manifest.timestamp))) throw new Error('invalid dump manifest');
  let shipped;
  try { shipped = JSON.parse(await readFile(shippedPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (shipped && !(Date.parse(manifest.timestamp) > Date.parse(shipped.timestamp))) {
    throw new Error('offsite refused: dump manifest is not newer than last shipped manifest');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(manifest.path)) hash.update(chunk);
  if (hash.digest('hex') !== manifest.checksum) throw new Error('dump manifest checksum mismatch');
  return manifest;
}

export async function recordShippedManifest(manifestPath, shippedPath) {
  const temporary = `${shippedPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, await readFile(manifestPath), { mode: 0o600, flag: 'wx' });
    await rename(temporary, shippedPath);
  } finally { await rm(temporary, { force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, manifestPath, shippedPath] = process.argv.slice(2);
  try {
    if (command === 'verify') console.log((await verifyFreshManifest(manifestPath, shippedPath)).path);
    else if (command === 'record') await recordShippedManifest(manifestPath, shippedPath);
    else throw new Error('usage: offsite.mjs verify|record MANIFEST SHIPPED');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
