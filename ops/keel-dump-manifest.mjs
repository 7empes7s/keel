#!/usr/bin/env node
// Called only after backup.sh has successfully produced and verified the dump.
// Task 43 reads /opt/backups/keel-db-manifest.json; timestamp is dump completion UTC,
// checksum is SHA-256 of the compressed bytes, path is the absolute dump filename.
//
// Task 67 extends this script with the recovery manifest link:
//
//   node keel-dump-manifest.mjs DUMP.sql.gz [--manifest PATH]
//       (unchanged legacy behavior: writes { path, checksum, timestamp })
//
//   node keel-dump-manifest.mjs DUMP.sql.gz --recovery OUT \
//     --tenant-ref REF --build-revision REV --schema-pin HEX \
//     --config-export-dir DIR --observation ID [--observation ID ...] \
//     [--evidence-head SEQ:HASH:COUNT] [--key-instructions TEXT
//       --key-held-by WHO --key-location WHERE] \
//     [--residency-provider P --residency-region R --credential-boundary B]
//
//   node keel-dump-manifest.mjs --verify RECOVERY.json [--dump DUMP.sql.gz] \
//     --tenant-ref REF --build-revision REV --schema-pin HEX \
//     --config-export-dir DIR [--evidence-head SEQ:HASH:COUNT]
//
// The recovery manifest records references only — no credentials, no key
// material. Local filesystem permissions do not count as immutable storage.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildRecoveryManifest, verifyRecoveryManifest,
} from '../engine/storage/recoveryManifest.mjs';

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeAtomic(manifestPath, document) {
  const temporary = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, manifestPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeDumpManifest(dumpPath, manifestPath = '/opt/backups/keel-db-manifest.json') {
  const path = resolve(dumpPath);
  const manifest = { path, checksum: await sha256File(path), timestamp: new Date().toISOString() };
  await writeAtomic(manifestPath, manifest);
  return manifest;
}

function parseEvidenceHead(value) {
  if (!value) return null;
  const [headSeq, headHash, recordCount] = value.split(':');
  return { headSeq: Number(headSeq), headHash, recordCount: Number(recordCount) };
}

/** Builds and atomically writes the recovery manifest for one dump. */
export async function writeRecoveryManifest({
  dumpPath,
  outPath,
  tenantRef,
  build,
  observationIds,
  configExport,
  evidenceCheckpoint,
  residency,
  keyRecovery = null,
}) {
  const path = resolve(dumpPath);
  const manifest = buildRecoveryManifest({
    tenantRef,
    build,
    dump: { path, sha256: await sha256File(path) },
    observationIds,
    configExport,
    evidenceCheckpoint,
    residency,
    keyRecovery,
  });
  await writeAtomic(outPath, manifest);
  return manifest;
}

function argValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
}

function argValues(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  }
  return out;
}

const USAGE = `usage:
  keel-dump-manifest.mjs DUMP [--manifest PATH]
  keel-dump-manifest.mjs DUMP --recovery OUT --tenant-ref REF --build-revision REV --schema-pin HEX
    --config-export-dir DIR --observation ID [--observation ID ...] [--evidence-head SEQ:HASH:COUNT]
    [--key-held-by WHO --key-location WHERE --key-instructions TEXT]
    [--residency-provider P --residency-region R --credential-boundary B]
  keel-dump-manifest.mjs --verify RECOVERY [--dump DUMP] --tenant-ref REF --build-revision REV
    --schema-pin HEX --config-export-dir DIR [--evidence-head SEQ:HASH:COUNT]`;

/**
 * CLI entry, injectable for tests. Exit code 0 on success, 1 on any refusal
 * or verification failure. Prints paths and verification verdicts only.
 */
export async function runCli({ argv, logger = console, dependencies = {} } = {}) {
  const args = argv.slice(2);
  if (args.includes('--help')) {
    logger.log(USAGE);
    return 0;
  }
  try {
    const verifyPath = argValue(args, 'verify');
    if (verifyPath !== undefined) {
      const { readFile } = await import('node:fs/promises');
      const manifest = JSON.parse(await readFile(verifyPath, 'utf8'));
      const result = await verifyRecoveryManifest(manifest, {
        expectedTenantRef: argValue(args, 'tenant-ref'),
        dumpPath: argValue(args, 'dump'),
        expectedBuild: {
          revision: argValue(args, 'build-revision'),
          schemaPin: argValue(args, 'schema-pin'),
        },
        configExportDir: argValue(args, 'config-export-dir'),
        expectedCheckpoint: parseEvidenceHead(argValue(args, 'evidence-head')) ?? undefined,
        dependencies,
      });
      for (const failure of result.failures) logger.error(`verify: ${failure}`);
      for (const gap of result.incomplete) logger.log(`recovery incomplete: ${gap}`);
      if (!result.ok) return 1;
      logger.log(`verified: ${verifyPath}${result.recoveryComplete ? ' (recovery complete)' : ''}`);
      return 0;
    }

    const dumpPath = args.find((a) => !a.startsWith('--'));
    if (!dumpPath) throw new Error(USAGE);
    const recoveryOut = argValue(args, 'recovery');
    if (recoveryOut === undefined) {
      // Legacy behavior, unchanged: { path, checksum, timestamp }.
      const manifestPath = argValue(args, 'manifest') ?? '/opt/backups/keel-db-manifest.json';
      const manifest = await writeDumpManifest(dumpPath, manifestPath);
      logger.log(`manifest: ${manifestPath}`);
      logger.log(`checksum: ${manifest.checksum}`);
      return 0;
    }

    const keyHeldBy = argValue(args, 'key-held-by');
    const keyLocation = argValue(args, 'key-location');
    const keyInstructions = argValue(args, 'key-instructions');
    const keyRecovery = keyHeldBy || keyLocation || keyInstructions
      ? { heldBy: keyHeldBy, location: keyLocation, instructions: keyInstructions }
      : null;
    const manifest = await writeRecoveryManifest({
      dumpPath,
      outPath: recoveryOut,
      tenantRef: argValue(args, 'tenant-ref'),
      build: { revision: argValue(args, 'build-revision'), schemaPin: argValue(args, 'schema-pin') },
      observationIds: argValues(args, 'observation'),
      configExport: {
        manifestPath: resolve(argValue(args, 'config-export-dir') ?? '', 'manifest.json'),
        manifestSha256: await sha256File(resolve(argValue(args, 'config-export-dir') ?? '', 'manifest.json')),
      },
      evidenceCheckpoint: parseEvidenceHead(argValue(args, 'evidence-head')),
      residency: {
        provider: argValue(args, 'residency-provider') ?? 'local-disk',
        region: argValue(args, 'residency-region'),
        boundary: argValue(args, 'residency-boundary'),
        credentialBoundary: argValue(args, 'credential-boundary'),
      },
      keyRecovery,
    });
    logger.log(`recovery manifest: ${recoveryOut}`);
    logger.log(`dump checksum: ${manifest.dump.sha256}`);
    return 0;
  } catch (error) {
    logger.error(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const exitCode = await runCli({ argv: process.argv });
  if (exitCode !== 0) process.exit(exitCode);
}
