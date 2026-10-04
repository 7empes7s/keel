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
import { pathToFileURL } from 'node:url';

import { loadValueReport, valueReportCsv } from '../engine/reports/value.mjs';
import { connect } from '../engine/store/db.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
}

function args(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === `--${name}` && argv[i + 1] !== undefined) values.push(argv[i + 1]);
  return values;
}

function resolveTenantRef(argv, readFile) {
  const explicit = arg(argv, 'tenant-ref');
  if (explicit) return explicit;
  const config = JSON.parse(readFile(arg(argv, 'config') ?? '/etc/keel/tenant.json', 'utf8'));
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
  if (argv.includes('--help')) {
    logger.log(USAGE);
    return 0;
  }
  const format = arg(argv, 'format') ?? 'json';
  if (!['json', 'csv'].includes(format)) {
    logger.log(USAGE);
    return 2;
  }
  const at = now();
  const to = arg(argv, 'to') ? new Date(arg(argv, 'to')) : at;
  const days = Number(arg(argv, 'days') ?? 30);
  const from = arg(argv, 'from') ? new Date(arg(argv, 'from')) : new Date(to.getTime() - days * DAY_MS);
  const entities = args(argv, 'entity');
  const estimatePath = arg(argv, 'estimate') ?? env.KEEL_VALUE_ESTIMATE_PATH;
  const estimate = estimatePath ? JSON.parse(readFile(estimatePath, 'utf8')) : null;
  const dbUrl = arg(argv, 'db-url') ?? env.KEEL_DB_URL;
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const tenantRef = resolveTenantRef(argv, readFile);
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
