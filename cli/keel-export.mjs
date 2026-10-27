#!/usr/bin/env node
// /opt/keel/cli/keel-export.mjs
//
// node keel-export.mjs --export-root PATH [--snapshot-id ID] [--tenant-ref REF] [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
// node keel-export.mjs --bundle FILE --as EMAIL [--content none|refs|bytes] [--reader /etc/keel/content-reader.json]
//                      [--snapshot-id ID] [--tenant-ref REF] [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
//
// Publishes an atomic, redacted configuration export of one snapshot to the
// local filesystem (engine/export/configExport.mjs). Read-side only: it reads
// the local keel database and writes local files — no Graph token, no tenant
// write, no credentials beyond the database URL. Storage/offsite policy
// belongs to WS10; this command only publishes locally.
//
// --bundle writes one signed Keel bundle v1 archive instead (engine/export/bundle.mjs,
// docs/format/keel-bundle-v1.md). It needs a principal holding the `export` capability
// and the signing key from the git-ignored /etc/keel/bundle.env (KEEL_BUNDLE_SIGNING_KEY).
// --content bytes also carries content item bytes, read through the content store the
// content-reader file names; the default, refs, names each item by natural key and sha256.
import { readFileSync } from 'node:fs';
import { readConfigFile } from '../engine/config/configFile.mjs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { exportSnapshot } from '../engine/export/configExport.mjs';
import { connect } from '../engine/store/db.mjs';
import { can } from '../engine/authz/can.mjs';
import { findPrincipalByEmail } from '../engine/authz/principals.mjs';
import { bundleKeysFromEnv, exportBundle, requireBundleCapability } from '../engine/export/bundle.mjs';
import { contentStoreFromReader } from './keel-import.mjs';

function arg(name, fallback, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

// The tenant ref is the hash of the tenant id in the config file, exactly as
// keel-collect.mjs and keel-baseline-create.mjs derive it; an explicit
// --tenant-ref wins.
function resolveTenantRef({ argv, readFile }) {
  const explicit = arg('tenant-ref', undefined, argv);
  if (explicit) return explicit;
  const config = readConfigFile(arg('config', '/etc/keel/tenant.json', argv), { readFile, what: 'collector settings' });
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

export async function runExport({
  tenantRef,
  snapshotId,
  exportRoot,
  dbUrl = process.env.KEEL_DB_URL,
  dependencies = {},
  logger = console,
}) {
  const {
    connect: connectFn = connect,
    exportSnapshot: exportSnapshotFn = exportSnapshot,
  } = dependencies;
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  if (typeof exportRoot !== 'string' || exportRoot.length === 0) {
    throw new Error('--export-root (or KEEL_EXPORT_ROOT) is required');
  }

  const client = await connectFn(dbUrl);
  try {
    const result = await exportSnapshotFn(client, { tenantRef, snapshotId, exportRoot });
    logger.log(`snapshot ${result.snapshotId} exported to ${result.exportDir}`);
    logger.log(`latest -> ${result.snapshotId}`);
    return { ...result, exitCode: 0 };
  } finally {
    await client.end();
  }
}

export async function runBundleExport({
  tenantRef,
  snapshotId,
  out,
  as,
  content = 'refs',
  readerPath,
  dbUrl = process.env.KEEL_DB_URL,
  env = process.env,
  readFile = readFileSync,
  dependencies = {},
  logger = console,
}) {
  const {
    connect: connectFn = connect,
    can: canFn = can,
    resolvePrincipal = findPrincipalByEmail,
    contentStoreFor = (client, path) => contentStoreFromReader(client, path, readFile),
  } = dependencies;
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const { signingKey } = bundleKeysFromEnv(env);
  if (!signingKey) throw new Error('KEEL_BUNDLE_SIGNING_KEY not set (source /etc/keel/bundle.env)');
  if (content === 'bytes' && !readerPath) throw new Error('--content bytes needs --reader (the content-reader file)');

  const client = await connectFn(dbUrl);
  try {
    await requireBundleCapability(client, as, { resolve: resolvePrincipal, can: canFn });
    const contentStore = content === 'bytes' ? await contentStoreFor(client, readerPath) : null;
    const result = await exportBundle(client, { tenantRef, snapshotId, out, signingKey, content, contentStore });
    logger.log(`snapshot ${result.snapshotId} bundled to ${result.out}: ${result.objects} objects, ${result.content.items} content items (${result.content.mode}), signed with key ${result.keyId}`);
    return { ...result, exitCode: 0 };
  } finally {
    await client.end();
  }
}

export async function main({
  argv = process.argv,
  readFile = readFileSync,
  env = process.env,
  dependencies,
  logger = console,
} = {}) {
  if (argv.includes('--help')) {
    logger.log('usage: keel-export.mjs --export-root PATH [--snapshot-id ID] [--tenant-ref REF] [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]');
    logger.log('       keel-export.mjs --bundle FILE --as EMAIL [--content none|refs|bytes] [--reader FILE] [--snapshot-id ID] [--tenant-ref REF] [--config FILE] [--db-url URL]');
    return 0;
  }
  const bundle = arg('bundle', undefined, argv);
  if (bundle !== undefined) {
    const { exitCode } = await runBundleExport({
      tenantRef: resolveTenantRef({ argv, readFile }),
      snapshotId: arg('snapshot-id', undefined, argv),
      out: bundle,
      as: arg('as', undefined, argv),
      content: arg('content', 'refs', argv),
      readerPath: arg('reader', undefined, argv),
      dbUrl: arg('db-url', env.KEEL_DB_URL, argv),
      env,
      readFile,
      dependencies,
      logger,
    });
    return exitCode;
  }
  const { exitCode } = await runExport({
    tenantRef: resolveTenantRef({ argv, readFile }),
    snapshotId: arg('snapshot-id', undefined, argv),
    exportRoot: arg('export-root', process.env.KEEL_EXPORT_ROOT, argv),
    dbUrl: arg('db-url', process.env.KEEL_DB_URL, argv),
    dependencies,
    logger,
  });
  return exitCode;
}

export async function runCli(options = {}) {
  try {
    return await main(options);
  } catch (err) {
    (options.logger ?? console).error(err);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((exitCode) => { process.exitCode = exitCode; });
}
