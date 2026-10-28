#!/usr/bin/env node
// /opt/keel/cli/keel-baseline-create.mjs
//
// node keel-baseline-create.mjs --snapshot-id ID --label LABEL --set-by PRINCIPAL
//   [--description TEXT] [--tenant-ref REF] [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
// node keel-baseline-create.mjs --snapshot-id ID --supersedes BASELINE_ID --set-by PRINCIPAL
//   [--label LABEL] [--description TEXT] [--tenant-ref REF] ...
//
// With --supersedes (roadmap task-87) the snapshot becomes a new version of that
// baseline; the previous version and its resources are preserved, and the requester
// must hold baseline-create at the moment of the write (replaceBaseline).
//
// Thin worker-dispatch wrapper around engine/govern/baseline.mjs seedFromSnapshot(): the
// worker spawns this so baseline creation gets the same child-process timeout and
// process-group teardown as every other job kind. All governance logic stays in the
// engine module — this file only parses argv and connects.
import { readFileSync } from 'node:fs';
import { readConfigFile } from '../engine/config/configFile.mjs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { replaceBaseline, seedFromSnapshot } from '../engine/govern/baseline.mjs';
import { connect } from '../engine/store/db.mjs';
import { parseCliArgs } from './args.mjs';

// A label or description is free text a person types, so it may start with "-" when it
// holds whitespace ("- copied from prod"); see cli/args.mjs.
const ARGS = {
  name: 'keel-baseline-create',
  strings: ['snapshot-id', 'supersedes', 'set-by', 'tenant-ref', 'config', 'db-url'],
  text: ['label', 'description'],
  booleans: ['help'],
};

function requireArg(name, opts) {
  const value = opts[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

// The tenant ref is the hash of the tenant id in the config file, exactly as
// keel-collect.mjs and keel-prune.mjs derive it; an explicit --tenant-ref wins.
function resolveTenantRef({ opts, readFile }) {
  const explicit = opts['tenant-ref'];
  if (explicit) return explicit;
  const config = readConfigFile(opts.config ?? '/etc/keel/tenant.json', { readFile, what: 'collector settings' });
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

export async function main({
  argv = process.argv,
  readFile = readFileSync,
  dbUrl = process.env.KEEL_DB_URL,
  dependencies = {},
  logger = console,
} = {}) {
  const opts = parseCliArgs(argv.slice(2), ARGS).values;
  if (opts.help) {
    logger.log('usage: keel-baseline-create.mjs --snapshot-id ID (--label LABEL | --supersedes BASELINE_ID) --set-by PRINCIPAL [--description TEXT] [--tenant-ref REF] [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]');
    return;
  }

  const selectedDbUrl = opts['db-url'] ?? dbUrl;
  if (!selectedDbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const {
    connect: connectFn = connect,
    seedFromSnapshot: seedFromSnapshotFn = seedFromSnapshot,
    replaceBaseline: replaceBaselineFn = replaceBaseline,
  } = dependencies;

  const supersedes = opts.supersedes;
  const client = await connectFn(selectedDbUrl);
  try {
    if (supersedes) {
      const created = await replaceBaselineFn(client, {
        tenantRef: resolveTenantRef({ opts, readFile }),
        baselineId: supersedes,
        snapshotId: requireArg('snapshot-id', opts),
        principalId: requireArg('set-by', opts),
        label: opts.label,
        description: opts.description,
      });
      logger.log(`baseline ${created.id} created as version ${created.version}; ${supersedes} preserved`);
      return created.id;
    }
    const baselineId = await seedFromSnapshotFn(client, {
      tenantRef: resolveTenantRef({ opts, readFile }),
      snapshotId: requireArg('snapshot-id', opts),
      setBy: requireArg('set-by', opts),
      label: requireArg('label', opts),
      description: opts.description ?? null,
    });
    logger.log(`baseline ${baselineId} created and active`);
    return baselineId;
  } finally {
    await client.end();
  }
}

export async function runCli(options = {}) {
  try {
    await main(options);
    return 0;
  } catch (err) {
    (options.logger ?? console).error(err);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((exitCode) => { process.exitCode = exitCode; });
}
