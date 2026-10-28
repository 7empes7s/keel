import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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

/**
 * Records the shipped dump. `shipped`, when given, is { name, sha256 } of the
 * encrypted copy that left the host, so the ciphertext hash is on record next to
 * the plaintext dump's own.
 */
export async function recordShippedManifest(manifestPath, shippedPath, shipped = null) {
  const temporary = `${shippedPath}.${randomUUID()}.tmp`;
  const manifest = await readFile(manifestPath);
  const body = shipped ? JSON.stringify({ ...JSON.parse(manifest), shipped }) : manifest;
  try {
    await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
    await rename(temporary, shippedPath);
  } finally { await rm(temporary, { force: true }); }
}

// --- Encryption before a dump leaves the host (security audit run 2, finding 9) ----
// Every offsite copy is encrypted with age to recipients whose private identities
// are kept OFF this host, so a leaked copy is unreadable and a lost host does not
// take the means to decrypt with it. There is no plaintext fallback: with no
// recipient configured nothing ships.

export const DEFAULT_AGE_RECIPIENTS = '/etc/keel/offsite-age-recipients.txt';
export const ENCRYPTED_SUFFIX = '.age';
const AGE_RECIPIENT = /^age1[0-9a-z]{20,}$/;

/** The age recipients the dump is encrypted to. Refuses a missing or empty file, and any private key in it. */
export async function readAgeRecipients(path = DEFAULT_AGE_RECIPIENTS) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`no encryption recipient: ${path} does not exist; shipping nothing`);
    throw error;
  }
  if (/AGE-SECRET-KEY-/i.test(text)) {
    throw new Error(`${path} holds a private age key; keep the identity off this host and list only its public recipient (age1...)`);
  }
  const recipients = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  for (const recipient of recipients) {
    if (!AGE_RECIPIENT.test(recipient)) throw new Error(`${path}: ${recipient.slice(0, 12)}... is not an age recipient (age1...)`);
  }
  if (!recipients.length) throw new Error(`no encryption recipient: ${path} lists none; shipping nothing`);
  return recipients;
}

/** Encrypts `bytes` with the age CLI to the recipients in `recipientsPath`. */
export async function encryptForOffsite(bytes, { recipientsPath = DEFAULT_AGE_RECIPIENTS, ageBin = 'age' } = {}) {
  const recipients = await readAgeRecipients(recipientsPath);
  const args = recipients.flatMap((recipient) => ['-r', recipient]);
  const ciphertext = await new Promise((resolve, reject) => {
    const child = execFile(ageBin, args, { encoding: 'buffer', maxBuffer: Infinity }, (error, stdout, stderr) => {
      if (error) reject(new Error(`age could not encrypt the dump: ${String(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
    child.stdin.end(bytes);
  });
  if (!ciphertext.length || !ciphertext.subarray(0, 21).toString('latin1').startsWith('age-encryption.org/v1')) {
    throw new Error('age produced no encrypted output; shipping nothing');
  }
  return ciphertext;
}

/**
 * Encrypts a dump file into `outPath` (created new, root-only); returns the ciphertext
 * sha256. With `expectedSha256`, a dump whose bytes no longer hash to it is refused.
 */
export async function encryptDumpFile(dumpPath, outPath, { expectedSha256 = null, ...options } = {}) {
  const plain = await readFile(dumpPath);
  if (expectedSha256 && sha256Hex(plain) !== expectedSha256) throw new Error('dump changed after manifest verification');
  const ciphertext = await encryptForOffsite(plain, options);
  await writeFile(outPath, ciphertext, { mode: 0o600, flag: 'wx' });
  return sha256Hex(ciphertext);
}

/**
 * The encrypted dump, kept beside the plaintext one (DUMP.age, with DUMP.age.json naming
 * both hashes). age output is randomised, so a retry after a partial shipment must ship
 * the same ciphertext the first run did, or a target that already holds it could never
 * verify; the kept copy is reused only when both hashes still match.
 */
async function encryptedCopy(manifest, plain, { recipientsPath, ageBin }) {
  const path = `${manifest.path}${ENCRYPTED_SUFFIX}`;
  try {
    const record = JSON.parse(await readFile(`${path}.json`, 'utf8'));
    const kept = await readFile(path);
    if (record.plainSha256 === manifest.checksum && record.sha256 === sha256Hex(kept)) return kept;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const bytes = await encryptForOffsite(plain, { recipientsPath, ageBin });
  for (const [target, body] of [[path, bytes], [`${path}.json`, JSON.stringify({ plainSha256: manifest.checksum, sha256: sha256Hex(bytes) })]]) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  return bytes;
}

const DUMP_NAME = /^keel-db-(\d{4}-\d{2}-\d{2})\.sql\.gz(?:\.age)?$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Object name of a dump on every storage target: keel-db/keel-db-<dump date>.sql.gz.age (age-encrypted). */
export function dumpObjectName(manifest) {
  const date = basename(dirname(manifest.path));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`dump directory ${date} is not a date`);
  return `keel-db/keel-db-${date}.sql.gz${ENCRYPTED_SUFFIX}`;
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
  ageBin = 'age',
} = {}) {
  if (!targets) throw new Error('KEEL_STORAGE_TARGETS is not set: no storage targets configured');
  const recipientsPath = env.KEEL_OFFSITE_AGE_RECIPIENTS || DEFAULT_AGE_RECIPIENTS;
  const manifest = await verifyFreshManifest(manifestPath, shippedPath);
  const name = dumpObjectName(manifest);
  if (dryRun) {
    await readAgeRecipients(recipientsPath);
    return { name, probes: await probeTargets(targets) };
  }
  const plain = await readFile(manifest.path);
  if (sha256Hex(plain) !== manifest.checksum) throw new Error('dump changed after manifest verification');
  const bytes = await encryptedCopy(manifest, plain, { recipientsPath, ageBin });
  const report = await shipArtifact(targets, { name, bytes, now });
  if (recordDb) await recordDb(report);
  const pruned = {};
  if (report.status === 'complete') {
    await recordShippedManifest(manifestPath, shippedPath, { name, sha256: report.sha256 });
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
    else if (command === 'recipients') await readAgeRecipients(process.env.KEEL_OFFSITE_AGE_RECIPIENTS || DEFAULT_AGE_RECIPIENTS);
    // encrypt DUMP OUT [EXPECTED_SHA256]: prints the ciphertext sha256.
    else if (command === 'encrypt') {
      const [, dumpPath, outPath, expectedSha256] = args;
      console.log(await encryptDumpFile(dumpPath, outPath, {
        expectedSha256, recipientsPath: process.env.KEEL_OFFSITE_AGE_RECIPIENTS || DEFAULT_AGE_RECIPIENTS,
      }));
    } else if (command === 'record') {
      const [, , , shippedName, shippedSha] = args.filter((arg) => arg !== '--dry-run');
      await recordShippedManifest(manifestPath, shippedPath, shippedName ? { name: shippedName, sha256: shippedSha } : null);
    }
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
    } else throw new Error('usage: offsite.mjs verify|record|ship [--dry-run] MANIFEST SHIPPED | encrypt DUMP OUT | recipients');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
