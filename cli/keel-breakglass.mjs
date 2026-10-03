#!/usr/bin/env node
// /opt/keel/cli/keel-breakglass.mjs
//
// Roadmap task-94: emergency (break-glass) account readiness and usage canary.
//
//   node keel-breakglass.mjs report [--tenant-ref REF | --config /etc/keel/tenant.json]
//       Prints the readiness report as JSON: each account's five dimensions, the policy
//       surfaces KEEL evaluated or cannot evaluate, the canary's audit coverage and the
//       emergency-account alerts.
//
//   node keel-breakglass.mjs register --actor PRINCIPAL_ID --account-id OBJECT_ID --label NAME
//       [--validation-days 90] [--rotation-days DAYS]
//   node keel-breakglass.mjs retire --actor PRINCIPAL_ID --account-id OBJECT_ID --reason TEXT
//   node keel-breakglass.mjs record --actor PRINCIPAL_ID --account-id OBJECT_ID
//       --kind validated|credential-rotated|methods-attested [--at ISO] [--note TEXT]
//       [--methods fido2,password]
//       Records what a person did or vouches for. KEEL never performs the sign-in test
//       or the credential change itself.
//
//   node keel-breakglass.mjs canary [--tenant-ref REF | --config PATH]
//       One canary sweep for the tenant, sending alerts as the scheduler principal.
//
// Every command takes [--db-url $KEEL_DB_URL]. No Graph token, no tenant write.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  loadBreakGlassReadiness, recordBreakGlassLifecycle, registerBreakGlassAccount, retireBreakGlassAccount, runBreakGlassCanary,
} from '../engine/safety/breakGlassReadiness.mjs';
import { connect } from '../engine/store/db.mjs';

const COMMANDS = ['report', 'register', 'retire', 'record', 'canary'];
const USAGE = 'usage: keel-breakglass.mjs report | canary | register --actor ID --account-id ID --label NAME [--validation-days N] [--rotation-days N] | retire --actor ID --account-id ID --reason TEXT | record --actor ID --account-id ID --kind validated|credential-rotated|methods-attested [--at ISO] [--note TEXT] [--methods a,b] [--tenant-ref REF | --config PATH] [--db-url URL]';

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
}

function required(argv, name) {
  const value = arg(argv, name);
  if (value === undefined || value === '') throw new Error(`--${name} is required`);
  return value;
}

function integer(argv, name) {
  const value = arg(argv, name);
  return value === undefined ? undefined : Number(value);
}

function resolveTenantRef(argv, readFile) {
  const explicit = arg(argv, 'tenant-ref');
  if (explicit) return explicit;
  const config = JSON.parse(readFile(arg(argv, 'config') ?? '/etc/keel/tenant.json', 'utf8'));
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

export async function main({
  argv = process.argv.slice(2),
  readFile = readFileSync,
  connectFn = connect,
  logger = console,
  now = () => new Date(),
} = {}) {
  const [command] = argv;
  if (!COMMANDS.includes(command) || argv.includes('--help')) {
    logger.log(USAGE);
    return command === undefined || argv.includes('--help') ? 0 : 2;
  }
  const dbUrl = arg(argv, 'db-url') ?? process.env.KEEL_DB_URL;
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const tenantRef = resolveTenantRef(argv, readFile);
  const client = await connectFn(dbUrl);
  try {
    let result;
    if (command === 'report') {
      result = await loadBreakGlassReadiness(client, { tenantRef, now: now() });
    } else if (command === 'canary') {
      const { rows: [scheduler] } = await client.query(
        "SELECT id FROM principal WHERE system_kind = 'scheduler' AND disabled_at IS NULL",
      );
      result = await runBreakGlassCanary(client, { tenantRef, now: now(), notify: scheduler ? { requestedBy: scheduler.id } : null });
    } else if (command === 'register') {
      const options = {
        tenantRef, actor: required(argv, 'actor'), accountId: required(argv, 'account-id'), label: required(argv, 'label'),
      };
      if (arg(argv, 'validation-days') !== undefined) options.validationIntervalDays = integer(argv, 'validation-days');
      if (arg(argv, 'rotation-days') !== undefined) options.rotationIntervalDays = integer(argv, 'rotation-days');
      result = await registerBreakGlassAccount(client, options);
    } else if (command === 'retire') {
      result = await retireBreakGlassAccount(client, {
        tenantRef, actor: required(argv, 'actor'), accountId: required(argv, 'account-id'), reason: required(argv, 'reason'),
      });
    } else {
      const methods = arg(argv, 'methods');
      result = await recordBreakGlassLifecycle(client, {
        tenantRef,
        actor: required(argv, 'actor'),
        accountId: required(argv, 'account-id'),
        kind: required(argv, 'kind'),
        occurredAt: arg(argv, 'at') ?? now(),
        note: arg(argv, 'note') ?? null,
        methods: methods === undefined ? null : methods.split(',').map((method) => method.trim()).filter(Boolean),
        now: now(),
      });
    }
    logger.log(JSON.stringify(result, null, 2));
    // A report that is not ready exits 1, so a scheduled check can alert on it.
    return command === 'report' && result.overall !== 'ready' ? 1 : 0;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
