import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../export/manifest.mjs';
import { describeShipment, loadStorageTargets, storageTargetEnvKey, probeTargets, recordShipment, shipArtifact } from '../storage/targets.mjs';

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

const DUMP_NAME = /^keel-db-(\d{4}-\d{2}-\d{2})\.sql\.gz$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Object name of a dump on every storage target: keel-db/keel-db-<dump date>.sql.gz. */
export function dumpObjectName(manifest) {
  const date = basename(dirname(manifest.path));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`dump directory ${date} is not a date`);
  return `keel-db/keel-db-${date}.sql.gz`;
}

/**
 * Removes dump copies older than `keepDays` (by the date in the name) from a
 * local-disk target's keel-db/ directory. Only names this module writes are
 * touched. Returns the removed names.
 */
export async function pruneLocalDumps(dir, keepDays, { now = () => new Date() } = {}) {
  const cutoff = now().getTime() - keepDays * DAY_MS;
  let entries;
  try { entries = await readdir(join(dir, 'keel-db')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const removed = [];
  for (const entry of entries.sort()) {
    const match = DUMP_NAME.exec(entry);
    if (match && Date.parse(`${match[1]}T00:00:00Z`) < cutoff) {
      await rm(join(dir, 'keel-db', entry));
      removed.push(entry);
    }
  }
  return removed;
}

/**
 * Ships the verified dump to every configured storage target
 * (engine/storage/targets.mjs) and verifies each copy. The shipped manifest is
 * recorded only when every target holds a verified copy, so a partial
 * shipment is retried on the next run (targets that already hold a verified
 * copy report it as already present). Returns { report, pruned } or, for a
 * dry run, { probes } without writing anything.
 */
export async function shipDumpToTargets(manifestPath, shippedPath, {
  env = process.env, targets = loadStorageTargets(env), dryRun = false, recordDb = null, now = () => new Date(),
} = {}) {
  if (!targets) throw new Error('KEEL_STORAGE_TARGETS is not set: no storage targets configured');
  const manifest = await verifyFreshManifest(manifestPath, shippedPath);
  const name = dumpObjectName(manifest);
  if (dryRun) return { name, probes: await probeTargets(targets) };
  const bytes = await readFile(manifest.path);
  if (sha256Hex(bytes) !== manifest.checksum) throw new Error('dump changed after manifest verification');
  const report = await shipArtifact(targets, { name, bytes, now });
  if (recordDb) await recordDb(report);
  const pruned = {};
  if (report.status === 'complete') {
    await recordShippedManifest(manifestPath, shippedPath);
    for (const target of targets) {
      if (target.adapter.capabilities.provider !== 'local-disk') continue;
      const keepDays = Number(env[storageTargetEnvKey(target.id, 'KEEP_DAYS')] ?? 30);
      if (!Number.isSafeInteger(keepDays) || keepDays < 1) {
        throw new Error(`${storageTargetEnvKey(target.id, 'KEEP_DAYS')} must be a whole number of days >= 1`);
      }
      pruned[target.id] = await pruneLocalDumps(env[storageTargetEnvKey(target.id, 'DIR')], keepDays, { now });
    }
  }
  return { report, pruned };
}

async function recordInDatabase(report) {
  if (!process.env.KEEL_DB_URL) return;
  const { connect } = await import('../store/db.mjs');
  const client = await connect(process.env.KEEL_DB_URL);
  try { await recordShipment(client, report); } finally { await client.end(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const [command, manifestPath, shippedPath] = args.filter((arg) => arg !== '--dry-run');
  try {
    if (command === 'verify') console.log((await verifyFreshManifest(manifestPath, shippedPath)).path);
    else if (command === 'record') await recordShippedManifest(manifestPath, shippedPath);
    else if (command === 'ship' && dryRun) {
      const { name, probes } = await shipDumpToTargets(manifestPath, shippedPath, { dryRun });
      for (const probe of probes) console.log(`DRY RUN: ${probe.targetId} ${probe.usable ? 'usable' : `NOT usable — ${probe.reason}`}`);
      console.log(`DRY RUN: would ship ${name}; transferring nothing`);
      if (probes.some((probe) => !probe.usable)) process.exitCode = 1;
    } else if (command === 'ship') {
      const { report, pruned } = await shipDumpToTargets(manifestPath, shippedPath, { recordDb: recordInDatabase });
      console.log(describeShipment(report));
      for (const [id, names] of Object.entries(pruned)) {
        for (const entry of names) console.log(`pruned from ${id}: ${entry}`);
      }
      // partial exits 3 so the unit fails loudly while the good copies stand.
      if (report.status === 'partial') process.exitCode = 3;
      if (report.status === 'failed') process.exitCode = 1;
    } else throw new Error('usage: offsite.mjs verify|record|ship [--dry-run] MANIFEST SHIPPED');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
