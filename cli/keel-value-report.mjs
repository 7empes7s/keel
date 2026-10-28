#!/usr/bin/env node
// /opt/keel/cli/keel-value-report.mjs
//
// Roadmap task-100: verified outcome and value report.
//
//   node keel-value-report.mjs [--from ISO] [--to ISO] [--days N] [--format json|csv]
//       [--entity CODE ...] [--estimate PATH]
//       [--tenant-ref REF | --config /etc/keel/tenant.json] [--db-url $KEEL_DB_URL]
//
// Prints the report for one period (default: the last 30 days). --entity narrows it to
// the outcomes owned by those entities (task-90); findings and recovery are tenant-wide
// and are then withheld. --estimate (or KEEL_VALUE_ESTIMATE_PATH) names a configured
// time-saving estimate; without one the report has no hours at all.
//
// Read-only: no Graph token, no tenant write, no evidence append.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readConfigFile } from '../engine/config/configFile.mjs';
import { pathToFileURL } from 'node:url';

import { loadValueReport, valueReportCsv } from '../engine/reports/value.mjs';
import { connect } from '../engine/store/db.mjs';
import { parseCliArgs } from './args.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

const ARGS = {
  name: 'keel-value-report',
  strings: ['from', 'to', 'days', 'format', 'estimate', 'tenant-ref', 'config', 'db-url'],
  repeatable: ['entity'],
  booleans: ['help'],
};

function arg(opts, name) {
  return opts[name];
}

function resolveTenantRef(opts, readFile) {
  const explicit = arg(opts, 'tenant-ref');
  if (explicit) return explicit;
  const config = readConfigFile(arg(opts, 'config') ?? '/etc/keel/tenant.json', { readFile, what: 'collector settings' });
  return `sha256:${createHash('sha256').update(config.tenantId).digest('hex').slice(0, 16)}`;
}

const USAGE = 'usage: keel-value-report.mjs [--from ISO] [--to ISO] [--days N] [--format json|csv] [--entity CODE ...] [--estimate PATH] [--tenant-ref REF | --config PATH] [--db-url URL]';

export async function main({
  argv = process.argv.slice(2),
  readFile = readFileSync,
  connectFn = connect,
  logger = console,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const opts = parseCliArgs(argv, ARGS).values;
  if (opts.help) {
    logger.log(USAGE);
    return 0;
  }
  const format = arg(opts, 'format') ?? 'json';
  if (!['json', 'csv'].includes(format)) {
    logger.log(USAGE);
    return 2;
  }
  const at = now();
  const to = arg(opts, 'to') ? new Date(arg(opts, 'to')) : at;
  const days = Number(arg(opts, 'days') ?? 30);
  const from = arg(opts, 'from') ? new Date(arg(opts, 'from')) : new Date(to.getTime() - days * DAY_MS);
  const entities = opts.entity;
  const estimatePath = arg(opts, 'estimate') ?? env.KEEL_VALUE_ESTIMATE_PATH;
  const estimate = estimatePath ? JSON.parse(readFile(estimatePath, 'utf8')) : null;
  const dbUrl = arg(opts, 'db-url') ?? env.KEEL_DB_URL;
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const tenantRef = resolveTenantRef(opts, readFile);
  const client = await connectFn(dbUrl);
  try {
    const report = await loadValueReport(client, {
      tenantRef,
      from,
      to,
      now: at,
      scope: entities.length ? { central: false, entities } : { central: true },
      estimate,
      estimateSource: estimatePath ?? null,
    });
    logger.log(format === 'csv' ? valueReportCsv(report).trimEnd() : JSON.stringify(report, null, 2));
    return 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
