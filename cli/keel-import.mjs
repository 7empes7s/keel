#!/usr/bin/env node
// /opt/keel/cli/keel-import.mjs
//
// node keel-import.mjs --bundle FILE --verify-only
// node keel-import.mjs --bundle FILE --as EMAIL [--reader /etc/keel/content-reader.json] [--db-url $KEEL_DB_URL]
// node keel-import.mjs --public-key
//
// Wave 2 FMT: verifies a Keel bundle v1 (docs/format/keel-bundle-v1.md) and imports it
// into this Keel's database (engine/export/bundle.mjs). --verify-only needs no database
// and no principal: only the archive and the verify key. An import needs a principal
// holding the `export` capability. Keys come from the git-ignored /etc/keel/bundle.env
// (KEEL_BUNDLE_SIGNING_KEY, or KEEL_BUNDLE_VERIFY_KEY on a Keel that only imports).
// --public-key prints the verify key to give another Keel. Writes the local database
// and, for a bundle that carries content bytes, the content store; never a tenant.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { connect } from '../engine/store/db.mjs';
import { can } from '../engine/authz/can.mjs';
import { findPrincipalByEmail } from '../engine/authz/principals.mjs';
import { createPgContentIndex } from '../engine/content/index.mjs';
import { createContentStore, parseContentKey } from '../engine/content/store.mjs';
import { createLocalStorageAdapter } from '../engine/storage/local.mjs';
import { bundleKeysFromEnv, importBundle, requireBundleCapability, verifyBundle } from '../engine/export/bundle.mjs';

export function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : fallback;
}

/** The content store the content-reader file names (see keel-content-collect.mjs). */
export function contentStoreFromReader(client, readerPath, readFile = readFileSync) {
  const reader = JSON.parse(readFile(readerPath, 'utf8'));
  if (reader?.storage?.kind !== 'local' || typeof reader.storage.root !== 'string') {
    throw new Error(`${readerPath}: storage must be { "kind": "local", "root": "<absolute path>" }`);
  }
  return createContentStore({
    index: createPgContentIndex(client),
    storage: createLocalStorageAdapter({ root: reader.storage.root }),
    key: parseContentKey(readFile(reader.contentKeyFile, 'utf8')),
  });
}

export async function main({
  argv = process.argv, env = process.env, readFile = readFileSync, dependencies = {}, logger = console,
} = {}) {
  const {
    connect: connectFn = connect, can: canFn = can, resolvePrincipal = findPrincipalByEmail,
    contentStoreFor = (client, readerPath) => contentStoreFromReader(client, readerPath, readFile),
  } = dependencies;
  if (argv.includes('--help')) {
    logger.log('usage: keel-import.mjs --bundle FILE (--verify-only | --as EMAIL [--reader FILE] [--db-url URL]) | --public-key');
    return 0;
  }
  const { signingKey, verifyKey } = bundleKeysFromEnv(env);
  if (argv.includes('--public-key')) {
    if (!signingKey) throw new Error('KEEL_BUNDLE_SIGNING_KEY not set (source /etc/keel/bundle.env)');
    logger.log(`KEEL_BUNDLE_VERIFY_KEY=${signingKey.publicKeyHex}`);
    return 0;
  }
  const bundle = arg(argv, 'bundle');
  if (!bundle) throw new Error('--bundle FILE is required');
  if (!verifyKey) throw new Error('KEEL_BUNDLE_VERIFY_KEY or KEEL_BUNDLE_SIGNING_KEY not set (source /etc/keel/bundle.env)');

  if (argv.includes('--verify-only')) {
    const result = await verifyBundle(bundle, { verifyKey });
    if (!result.ok) {
      logger.error(`bundle ${bundle} FAILED verification:\n  ${result.failures.join('\n  ')}`);
      return 1;
    }
    logger.log(`bundle ${bundle} verified with key ${verifyKey.keyId}: ${result.manifest.objects} objects, ${result.manifest.content.items} content items (${result.manifest.content.mode})`);
    return 0;
  }

  const dbUrl = arg(argv, 'db-url', env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const client = await connectFn(dbUrl);
  try {
    await requireBundleCapability(client, arg(argv, 'as'), { resolve: resolvePrincipal, can: canFn });
    const readerPath = arg(argv, 'reader');
    const contentStore = readerPath ? await contentStoreFor(client, readerPath) : null;
    const result = await importBundle(client, bundle, { verifyKey, contentStore });
    logger.log(`bundle ${bundle} imported as snapshot ${result.snapshotId}: ${result.objects} objects, ${result.content.stored} content items stored, ${result.content.referenced} by reference`);
    return 0;
  } finally {
    await client.end();
  }
}

export async function runCli(options = {}) {
  try {
    return await main(options);
  } catch (err) {
    (options.logger ?? console).error(err?.message ?? err);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((exitCode) => { process.exitCode = exitCode; });
}
