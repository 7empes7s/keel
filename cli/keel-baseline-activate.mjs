#!/usr/bin/env node
// /opt/keel/cli/keel-baseline-activate.mjs
//
// node keel-baseline-activate.mjs --baseline-id ID
//   [--tenant-ref REF] [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
// node keel-baseline-activate.mjs --baseline-id ID --reinstate [--version N] --actor PRINCIPAL [--reason TEXT]
//
// Thin worker-dispatch wrapper around engine/govern/baseline.mjs activateBaseline():
// activation stays on the one atomic, row-locking implementation — this file only
// parses argv and connects. --reinstate is the rollback path (live gate #148, Q43): a
// superseded version is never activated again, so reinstateBaseline copies it into a
// new latest version of the same baseline and activates that one.
import { readFileSync } from 'node:fs';
import { readConfigFile } from '../engine/config/configFile.mjs';
import { createHash } from 'node:crypto';
import { activateBaseline, reinstateBaseline } from '../engine/govern/baseline.mjs';
import { connect } from '../engine/store/db.mjs';
import { parseCliArgs } from './args.mjs';

const ARGS = {
  name: 'keel-baseline-activate',
  strings: ['baseline-id', 'version', 'actor', 'tenant-ref', 'config', 'db-url'],
  text: ['reason'],
  booleans: ['help', 'reinstate'],
};
let parsed;
function arg(name, fallback) {
  parsed ??= parseCliArgs(process.argv.slice(2), ARGS).values;
  return parsed[name] ?? fallback;
}

function requireArg(name) {
  const value = arg(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

// The tenant ref is the hash of the tenant id in the config file, exactly as
// keel-collect.mjs and keel-prune.mjs derive it; an explicit --tenant-ref wins.
function resolveTenantRef() {
  const explicit = arg('tenant-ref');
  if (explicit) return explicit;
  const config = readConfigFile(arg('config', '/etc/keel/tenant.json'), { readFile: readFileSync, what: 'collector settings' });
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

async function main() {
  if (arg('help')) {
    console.log('usage: keel-baseline-activate.mjs --baseline-id ID [--reinstate [--version N] --actor PRINCIPAL [--reason TEXT]] [--tenant-ref REF] [--config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]');
    return;
  }

  const dbUrl = arg('db-url', process.env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');

  const client = await connect(dbUrl);
  try {
    if (arg('reinstate')) {
      const versionArg = arg('version');
      const version = versionArg === undefined ? undefined : Number(versionArg);
      if (version !== undefined && !Number.isInteger(version)) throw new Error('--version must be an integer');
      const created = await reinstateBaseline(client, {
        tenantRef: resolveTenantRef(),
        baselineId: requireArg('baseline-id'),
        version,
        actor: requireArg('actor'),
        reason: arg('reason'),
      });
      console.log(`baseline ${created.reinstatedId} (v${created.reinstatedVersion}) reinstated as ${created.id} (v${created.version}) and activated`);
      return;
    }
    await activateBaseline(client, {
      tenantRef: resolveTenantRef(),
      baselineId: requireArg('baseline-id'),
    });
    console.log(`baseline ${arg('baseline-id')} activated`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
