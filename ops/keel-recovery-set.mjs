#!/usr/bin/env node
// Assembles a task-114-ready recovery set from one existing, verified dump
// (roadmap task-114, gate storage-live-acceptance).
//
//   node ops/keel-recovery-set.mjs --dump /opt/backups/<date>/keel-db.sql.gz --out DIR \
//     (--dump-manifest /opt/backups/keel-db-manifest.json | --dump-sha256 HEX) \
//     (--key-metadata FILE | --key-instructions TEXT --key-held-by WHO --key-location WHERE) \
//     [--build REV] [--checkout DIR] [--tenant-config PATH] [--db-url URL] [--snapshot-id ID] \
//     [--residency-region R --residency-boundary B --credential-boundary C] [--dry-run]
//
// DIR receives, and nothing else is written anywhere:
//
//   DIR/<dump basename>               byte copy of the dump (checksum re-read)
//   DIR/config-export/manifest.json   task-56 configuration export of the
//   DIR/config-export/<type>/<hash>     tenant's latest (or --snapshot-id) snapshot
//   DIR/recovery-manifest.json        task-67 recovery manifest (buildRecoveryManifest)
//   DIR/recovery-set.json             summary: pins, evidence head, digests (no secrets)
//
// The recovery manifest records the dump and export by names relative to DIR,
// so the set verifies wherever it is copied (pass --dump / --config-export-dir
// to keel-dump-manifest.mjs --verify, or --copy-root to the capture tool).
//
// Read-only towards everything outside DIR: the source dump and any existing
// backup are only read; the KEEL database is read inside one READ ONLY
// transaction. DIR must not exist or be empty. Key metadata is references
// only (who holds the recovery key, where, which runbook) — anything that
// looks like key material or a secret is refused.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile, constants as fsConstants, lstat, mkdir, readdir, readFile, rename, rm, writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

import { exportSnapshot } from '../engine/export/configExport.mjs';
import { sha256Hex } from '../engine/export/manifest.mjs';
import { assertNoEmbeddedCredential } from '../engine/storage/adapter.mjs';
import { LOCAL_PROVIDER } from '../engine/storage/local.mjs';
import {
  buildRecoveryManifest, currentBuildRevision, currentSchemaPin, verifyRecoveryManifest,
} from '../engine/storage/recoveryManifest.mjs';
import { connect } from '../engine/store/db.mjs';
import { tenantRefFor } from '../engine/store/tenantRef.mjs';

export const RECOVERY_SET_VERSION = 1;
export const RECOVERY_SET_NAMES = Object.freeze({
  manifest: 'recovery-manifest.json',
  export: 'config-export',
  summary: 'recovery-set.json',
});

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_FIELDS = Object.freeze(['instructions', 'heldBy', 'location']);
const KEY_FLAGS = Object.freeze({ instructions: 'key-instructions', heldBy: 'key-held-by', location: 'key-location' });
const KEY_METADATA_MAX_BYTES = 16 * 1024;

// Beyond the storage adapter's credential patterns: shapes of key material
// and secrets that have no business in a reference.
const SECRET_PATTERNS = Object.freeze([
  [/-----BEGIN [A-Z0-9 ]+-----/, 'a PEM block'],
  [/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/, 'a URL with an embedded password'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, 'a JSON web token'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'a cloud access key id'],
  [/\b(private[_ -]?key|passphrase|client[_-]?secret|access[_-]?key)\s*[:=]\s*\S+/i, 'an assigned secret'],
  [/(?:^|[^0-9A-Fa-f])[0-9A-Fa-f]{32,}(?:$|[^0-9A-Fa-f])/, 'a long hex key'],
]);

// A long run of base64 alphabet mixing upper case, lower case and digits is
// how key material and tokens look; references are words, paths and ids.
function looksLikeOpaqueToken(value) {
  return (value.match(/[A-Za-z0-9+/=_]{32,}/g) ?? [])
    .some((run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run));
}

/**
 * Refuses a key metadata value that is empty or looks like a secret. The
 * recovery manifest stores WHERE the key is and WHO holds it, never the key.
 */
export function assertKeyReference(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} is required and must be a non-empty reference`);
  }
  assertNoEmbeddedCredential(value, name);
  for (const [pattern, what] of SECRET_PATTERNS) {
    if (pattern.test(value)) {
      throw new TypeError(`${name} looks like ${what}; give a reference to where the key is held, never key material`);
    }
  }
  if (looksLikeOpaqueToken(value)) {
    throw new TypeError(`${name} looks like a long opaque token; give a reference to where the key is held, never key material`);
  }
  return value.trim();
}

/**
 * Key metadata from flags or from a small operator JSON file
 * ({ instructions, heldBy, location }), never both.
 */
export async function resolveKeyMetadata({ file, flags = {}, readFileFn = readFile }) {
  const flagged = KEY_FIELDS.filter((field) => flags[field] !== undefined);
  let source;
  if (file !== undefined) {
    if (flagged.length) throw new Error('give key metadata either with --key-metadata or with --key-* flags, not both');
    const bytes = await readFileFn(file);
    if (bytes.length > KEY_METADATA_MAX_BYTES) throw new Error(`--key-metadata file is larger than ${KEY_METADATA_MAX_BYTES} bytes`);
    try {
      source = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('--key-metadata file is not valid JSON');
    }
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('--key-metadata file must hold a JSON object');
    const unknown = Object.keys(source).filter((key) => !KEY_FIELDS.includes(key));
    if (unknown.length) throw new Error(`--key-metadata file has unknown fields: ${unknown.join(', ')} (allowed: ${KEY_FIELDS.join(', ')})`);
  } else {
    source = flags;
  }
  const out = {};
  for (const field of KEY_FIELDS) {
    out[field] = assertKeyReference(source[field], file !== undefined ? `key metadata ${field}` : `--${KEY_FLAGS[field]}`);
  }
  return out;
}

/**
 * The build revision and the schema pin of the deployed checkout. The schema
 * pin is derived exactly as the verifiers derive theirs (currentSchemaPin:
 * sha256 of engine/store/schema.sql), from the checkout's own schema file. An
 * explicit --build must agree with the checkout when the checkout is a git
 * repository: a pin from one build recorded against another is refused.
 */
const quietGit = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

export async function resolveBuild({ build, checkout = REPO_ROOT, execFn = quietGit, readFileFn = readFile }) {
  const head = currentBuildRevision({ repoPath: checkout, execFn });
  if (build !== undefined) {
    if (typeof build !== 'string' || !/^\S+$/.test(build)) throw new Error('--build must be a single revision token');
    assertNoEmbeddedCredential(build, '--build');
    if (head && head !== build) {
      throw new Error(`--build ${build} is not the checkout's revision (${head} at ${checkout}); `
        + 'run from the checkout the backup was made with, or point --checkout at it');
    }
  }
  const revision = build ?? head;
  if (!revision) throw new Error(`no build revision: ${checkout} is not a git checkout and --build was not given`);
  const schemaPath = join(resolve(checkout), 'engine', 'store', 'schema.sql');
  let schemaPin;
  try {
    schemaPin = await currentSchemaPin({ readFileFn: () => readFileFn(schemaPath) });
  } catch {
    throw new Error(`cannot read the schema to pin at ${schemaPath}`);
  }
  return { revision, schemaPin, checkout: resolve(checkout), schemaPath };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** A complete gzip stream end to end; a truncated or corrupt dump throws. */
async function assertGzipIntact(path) {
  try {
    await pipeline(createReadStream(path), createGunzip(), new Writable({ write(_c, _e, cb) { cb(); } }));
  } catch (error) {
    throw new Error(`dump ${path} is not an intact gzip stream: ${error.message}`);
  }
}

/**
 * The dump must already be verified by the backup job: its sha256 must equal
 * the legacy dump manifest's checksum (for this exact path) or --dump-sha256,
 * and the gzip stream must be intact. Only reads the dump.
 */
export async function verifySourceDump({ dumpPath, dumpManifestPath, dumpSha256, readFileFn = readFile }) {
  if (dumpManifestPath === undefined && dumpSha256 === undefined) {
    throw new Error('refused: give --dump-manifest (the backup job\'s manifest) or --dump-sha256 so the dump is a verified one');
  }
  const path = resolve(dumpPath);
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile()) throw new Error(`dump ${path} is not a regular file`);
  const actual = await sha256File(path);
  const expected = [];
  if (dumpManifestPath !== undefined) {
    let legacy;
    try {
      legacy = JSON.parse(await readFileFn(dumpManifestPath, 'utf8'));
    } catch {
      throw new Error(`dump manifest ${dumpManifestPath} is unreadable or not JSON`);
    }
    if (resolve(String(legacy?.path ?? '')) !== path) {
      throw new Error(`dump manifest ${dumpManifestPath} is for ${legacy?.path}, not ${path}`);
    }
    expected.push(['dump manifest', legacy.checksum]);
  }
  if (dumpSha256 !== undefined) expected.push(['--dump-sha256', dumpSha256]);
  for (const [what, digest] of expected) {
    if (!HEX64.test(String(digest))) throw new Error(`${what} checksum is not a sha256 hex digest`);
    if (digest !== actual.sha256) throw new Error(`dump checksum mismatch against ${what}: the dump is not the verified one`);
  }
  await assertGzipIntact(path);
  return { path, ...actual };
}

/**
 * Reads, inside one REPEATABLE READ READ ONLY transaction, the snapshot to
 * export, its observation ids (`<snapshotId>:<resourceType>` for every type in
 * the coverage digest or the persisted rows — the ids the configuration export
 * backs) and the tenant's evidence head; and exports that snapshot into
 * exportRoot. The transaction is always rolled back: nothing is written to
 * the database.
 */
export async function readDatabase(client, { tenantRef, snapshotId, exportRoot, exportFn = exportSnapshot }) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const exported = await exportFn(client, { tenantRef, snapshotId, exportRoot });
    const { rows: snapshotRows } = await client.query(
      'SELECT id, coverage_digest FROM snapshot WHERE id = $1 AND tenant_ref = $2',
      [exported.snapshotId, tenantRef],
    );
    if (!snapshotRows[0]) throw new Error(`snapshot ${exported.snapshotId} is not this tenant's`);
    const { rows: typeRows } = await client.query(
      'SELECT DISTINCT resource_type FROM resource_version WHERE snapshot_id = $1',
      [exported.snapshotId],
    );
    const types = new Set([
      ...Object.keys(snapshotRows[0].coverage_digest ?? {}),
      ...typeRows.map((row) => row.resource_type),
    ]);
    const observationIds = [...types].sort().map((type) => `${exported.snapshotId}:${type}`);
    const { rows: headRows } = await client.query(
      'SELECT head_seq, head_hash, record_count FROM evidence_head WHERE tenant_ref = $1',
      [tenantRef],
    );
    if (!headRows[0]) throw new Error(`no evidence head for tenant ${tenantRef}: recovery would be incomplete`);
    const evidenceHead = {
      headSeq: Number(headRows[0].head_seq),
      headHash: headRows[0].head_hash,
      recordCount: Number(headRows[0].record_count),
    };
    return { exported, observationIds, evidenceHead };
  } finally {
    await client.query('ROLLBACK');
  }
}

function redactDbUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<unparseable database url>';
  }
}

export function formatEvidenceHead({ headSeq, headHash, recordCount }) {
  return `${headSeq}:${headHash}:${recordCount}`;
}

async function assertEmptyOutDir(outDir) {
  const stat = await lstat(outDir).catch(() => null);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`--out ${outDir} exists and is not a plain directory`);
  if ((await readdir(outDir)).length) throw new Error(`--out ${outDir} is not empty; the set is only ever written into a new or empty directory`);
  return true;
}

function within(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

/**
 * Builds the recovery set. Returns { summary } on success; throws on any
 * refusal, after removing what it wrote (never anything else).
 */
export async function buildRecoverySet({
  dumpPath, outDir, dumpManifestPath, dumpSha256, keyMetadataFile, keyFlags = {},
  build, checkout, tenantConfigPath, dbUrl, snapshotId, residency = {}, dryRun = false,
  logger = console, dependencies = {}, now = () => new Date(),
}) {
  const { connect: connectFn = connect, execFn, exportFn } = dependencies;
  if (!dumpPath) throw new Error('--dump is required');
  if (!outDir) throw new Error('--out is required');
  const out = resolve(outDir);
  const dump = resolve(dumpPath);
  const dumpName = basename(dump);
  if (dumpName.startsWith('.') || Object.values(RECOVERY_SET_NAMES).includes(dumpName)) {
    throw new Error(`dump name ${dumpName} cannot be used inside the set`);
  }
  if (within(out, dump) || within(out, dirname(dump)) || (dumpManifestPath && within(out, resolve(dumpManifestPath)))) {
    throw new Error(`--out ${out} must not be, or contain, the source backup directory`);
  }
  if (!tenantConfigPath) throw new Error('--tenant-config (or KEEL_TENANT_CONFIG_PATH) is required');

  // Cheap checks first, so a bad flag is refused before anything is read in bulk.
  const keyRecovery = await resolveKeyMetadata({ file: keyMetadataFile, flags: keyFlags });
  const buildPin = await resolveBuild({ build, checkout, execFn });
  let tenantId;
  try {
    ({ tenantId } = JSON.parse(await readFile(tenantConfigPath, 'utf8')));
  } catch {
    throw new Error(`tenant config ${tenantConfigPath} is unreadable or not JSON`);
  }
  const tenantRef = tenantRefFor(tenantId);
  const residencyOut = {
    provider: LOCAL_PROVIDER,
    region: residency.region ?? 'local',
    boundary: residency.boundary ?? 'separate local volume',
    ...(residency.credentialBoundary ? { credentialBoundary: residency.credentialBoundary } : {}),
  };
  for (const [field, value] of Object.entries(residencyOut)) assertKeyReference(value, `residency.${field}`);

  const exportDir = join(out, RECOVERY_SET_NAMES.export);
  const writes = [
    join(out, dumpName),
    `${exportDir}/manifest.json (+ ${RECOVERY_SET_NAMES.export}/<type>/<sha256>.json)`,
    join(out, RECOVERY_SET_NAMES.manifest),
    join(out, RECOVERY_SET_NAMES.summary),
  ];
  if (dryRun) {
    logger.log('dry run: nothing is read from the dump or database and nothing is written');
    logger.log('would read:');
    logger.log(`  dump (sha256, gzip integrity, byte copy): ${dump}`);
    if (dumpManifestPath) logger.log(`  dump manifest: ${resolve(dumpManifestPath)}`);
    if (dumpSha256) logger.log(`  expected dump sha256: ${dumpSha256}`);
    logger.log(`  tenant config: ${resolve(tenantConfigPath)} -> ${tenantRef}`);
    logger.log(`  build: ${buildPin.revision} (checkout ${buildPin.checkout})`);
    logger.log(`  schema pin: ${buildPin.schemaPin} (${buildPin.schemaPath})`);
    if (keyMetadataFile) logger.log(`  key metadata: ${resolve(keyMetadataFile)}`);
    logger.log(`  database (READ ONLY transaction, rolled back): ${dbUrl ? redactDbUrl(dbUrl) : '<KEEL_DB_URL not set>'}`);
    logger.log(`    snapshot ${snapshotId ?? '<latest completed>'}, its resource versions and coverage digest; evidence_head for ${tenantRef}`);
    logger.log(`would write (only inside ${out}, which must be new or empty):`);
    for (const path of writes) logger.log(`  ${path}`);
    return { dryRun: true, tenantRef, build: buildPin, writes };
  }
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');

  const sourceDump = await verifySourceDump({ dumpPath: dump, dumpManifestPath, dumpSha256 });
  const existed = await assertEmptyOutDir(out);
  await mkdir(out, { recursive: true, mode: 0o750 });
  const exportStaging = join(out, `.export-staging`);
  try {
    // 1. The dump, byte for byte; the copy is re-read and must match.
    await copyFile(dump, join(out, dumpName), fsConstants.COPYFILE_EXCL);
    const copied = await sha256File(join(out, dumpName));
    if (copied.sha256 !== sourceDump.sha256 || copied.bytes !== sourceDump.bytes) {
      throw new Error('the dump copy does not match the source dump');
    }

    // 2. Database reads and the configuration export (read-only transaction).
    const client = await connectFn(dbUrl);
    let db;
    try {
      db = await readDatabase(client, { tenantRef, snapshotId, exportRoot: exportStaging, exportFn });
    } finally {
      await client.end();
    }
    await rename(db.exported.exportDir, exportDir);
    await rm(exportStaging, { recursive: true, force: true });
    const exportManifestSha256 = sha256Hex(await readFile(join(exportDir, 'manifest.json')));

    // 3. The task-67 recovery manifest, through the production builder.
    const manifest = buildRecoveryManifest({
      tenantRef,
      build: { revision: buildPin.revision, schemaPin: buildPin.schemaPin },
      dump: { path: dumpName, sha256: copied.sha256, bytes: copied.bytes },
      observationIds: db.observationIds,
      configExport: { manifestPath: `${RECOVERY_SET_NAMES.export}/manifest.json`, manifestSha256: exportManifestSha256 },
      evidenceCheckpoint: db.evidenceHead,
      residency: residencyOut,
      keyRecovery,
      generatedAt: now().toISOString(),
    });
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(join(out, RECOVERY_SET_NAMES.manifest), manifestText, { flag: 'wx', mode: 0o640 });

    // 4. Self-check with the production verifier before calling it a set.
    const verification = await verifyRecoveryManifest(manifest, {
      expectedTenantRef: tenantRef,
      dumpPath: join(out, dumpName),
      expectedBuild: { revision: buildPin.revision, schemaPin: buildPin.schemaPin },
      configExportDir: exportDir,
      expectedCheckpoint: db.evidenceHead,
    });
    if (!verification.ok || !verification.recoveryComplete) {
      throw new Error(`the assembled set does not verify: ${[...verification.failures, ...verification.incomplete].join('; ')}`);
    }

    const summary = {
      recoverySetVersion: RECOVERY_SET_VERSION,
      createdAt: now().toISOString(),
      tenantRef,
      build: { revision: buildPin.revision, schemaPin: buildPin.schemaPin },
      snapshotId: db.exported.snapshotId,
      observationIds: db.observationIds,
      evidenceHead: formatEvidenceHead(db.evidenceHead),
      names: { manifest: RECOVERY_SET_NAMES.manifest, dump: dumpName, export: RECOVERY_SET_NAMES.export },
      sha256: { manifest: sha256Hex(manifestText), dump: copied.sha256, exportManifest: exportManifestSha256 },
      source: { dump: sourceDump.path, dumpManifest: dumpManifestPath ? resolve(dumpManifestPath) : null },
      keyRecovery: 'recorded in the recovery manifest (references only)',
    };
    await writeFile(join(out, RECOVERY_SET_NAMES.summary), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o640 });
    return { summary };
  } catch (error) {
    // Remove only what this run wrote: the directory was new or empty.
    if (existed) {
      for (const entry of await readdir(out).catch(() => [])) await rm(join(out, entry), { recursive: true, force: true });
    } else {
      await rm(out, { recursive: true, force: true });
    }
    throw error;
  }
}

function argValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
}

const USAGE = `usage: keel-recovery-set.mjs --dump DUMP.sql.gz --out DIR
  (--dump-manifest LEGACY.json | --dump-sha256 HEX)
  (--key-metadata FILE | --key-instructions TEXT --key-held-by WHO --key-location WHERE)
  [--build REV] [--checkout DIR] [--tenant-config PATH] [--db-url URL] [--snapshot-id ID]
  [--residency-region R --residency-boundary B --credential-boundary C] [--dry-run]`;

/** CLI entry, injectable for tests. 0 on success, 1 on any refusal. */
export async function runCli({ argv = process.argv, env = process.env, logger = console, dependencies = {}, now } = {}) {
  const args = argv.slice(2);
  if (args.includes('--help')) {
    logger.log(USAGE);
    return 0;
  }
  try {
    const result = await buildRecoverySet({
      dumpPath: argValue(args, 'dump'),
      outDir: argValue(args, 'out'),
      dumpManifestPath: argValue(args, 'dump-manifest'),
      dumpSha256: argValue(args, 'dump-sha256'),
      keyMetadataFile: argValue(args, 'key-metadata'),
      keyFlags: {
        instructions: argValue(args, 'key-instructions'),
        heldBy: argValue(args, 'key-held-by'),
        location: argValue(args, 'key-location'),
      },
      build: argValue(args, 'build'),
      checkout: argValue(args, 'checkout'),
      tenantConfigPath: argValue(args, 'tenant-config') ?? env.KEEL_TENANT_CONFIG_PATH,
      dbUrl: argValue(args, 'db-url') ?? env.KEEL_DB_URL,
      snapshotId: argValue(args, 'snapshot-id'),
      residency: {
        region: argValue(args, 'residency-region'),
        boundary: argValue(args, 'residency-boundary'),
        credentialBoundary: argValue(args, 'credential-boundary'),
      },
      dryRun: args.includes('--dry-run'),
      logger,
      dependencies,
      now,
    });
    if (result.dryRun) return 0;
    const { summary } = result;
    const out = resolve(argValue(args, 'out'));
    logger.log(`recovery set: ${out}`);
    logger.log(`tenant ${summary.tenantRef}, build ${summary.build.revision}, schema pin ${summary.build.schemaPin}`);
    logger.log(`snapshot ${summary.snapshotId}, ${summary.observationIds.length} observation ids, evidence head ${summary.evidenceHead}`);
    logger.log(`manifest sha256 ${summary.sha256.manifest}, dump sha256 ${summary.sha256.dump}`);
    logger.log('verify with: node ops/keel-dump-manifest.mjs --verify '
      + `${join(out, summary.names.manifest)} --dump ${join(out, summary.names.dump)} --tenant-ref ${summary.tenantRef} `
      + `--build-revision ${summary.build.revision} --schema-pin ${summary.build.schemaPin} `
      + `--config-export-dir ${join(out, summary.names.export)} --evidence-head ${summary.evidenceHead}`);
    return 0;
  } catch (error) {
    logger.error(`refused: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const exitCode = await runCli();
  if (exitCode !== 0) process.exitCode = exitCode;
}
