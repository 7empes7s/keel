#!/usr/bin/env node
// /opt/keel/cli/keel-insights-summary.mjs
//
// node keel-insights-summary.mjs --tenant-ref REF --requested-by PRINCIPAL_ID [--db-url $KEEL_DB_URL]
//
// Issue #980: the scheduled `insights-summary` job. Reads the last 7 days of the change
// feed (read-only, the same read as the Insights page) and queues the weekly summary to
// every channel with a "Weekly summary" rule, once per channel and week. The sends
// themselves are notify jobs, retried like alerts. The link to Insights uses
// KEEL_PORTAL_URL, the portal's public address.
import { pathToFileURL } from 'node:url';
import { sendWeeklySummary } from '../engine/notify/weeklySummary.mjs';
import { connect } from '../engine/store/db.mjs';
import { parseCliArgs } from './args.mjs';

const USAGE = 'usage: keel-insights-summary.mjs --tenant-ref REF --requested-by PRINCIPAL_ID [--db-url $KEEL_DB_URL]';
const ARGS = { name: 'keel-insights-summary', strings: ['tenant-ref', 'requested-by', 'db-url'], booleans: ['help'] };

export async function main({ argv = process.argv, dbUrl = process.env.KEEL_DB_URL, dependencies = {}, logger = console } = {}) {
  const opts = parseCliArgs(argv.slice(2), ARGS).values;
  if (opts.help) {
    logger.log(USAGE);
    return;
  }
  const tenantRef = opts['tenant-ref'];
  const requestedBy = opts['requested-by'];
  if (!tenantRef || !requestedBy) {
    logger.log(USAGE);
    throw new Error('--tenant-ref and --requested-by are required');
  }
  const resolvedDbUrl = opts['db-url'] ?? dbUrl;
  if (!resolvedDbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  const client = await (dependencies.connect ?? connect)(resolvedDbUrl);
  try {
    const { event, deliveries } = await (dependencies.sendWeeklySummary ?? sendWeeklySummary)(client, { tenantRef, requestedBy });
    logger.log(`insights-summary: ${event.week}: ${event.verdict} Queued ${deliveries.length} ${deliveries.length === 1 ? 'delivery' : 'deliveries'}.`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
