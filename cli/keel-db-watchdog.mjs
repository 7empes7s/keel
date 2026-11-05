#!/usr/bin/env node
// /opt/keel-live/cli/keel-db-watchdog.mjs
//
// node keel-db-watchdog.mjs probe
// node keel-db-watchdog.mjs alert --action restarted|started|gave-up --at ISO --detail TEXT
//
// Issue #1010: the database half of ops/keel-db-watchdog.sh. `probe` opens a real
// connection with KEEL_DB_URL and runs `select 1` (exit 0 = the database answers, 2 = it
// can't be reached, 1 = any other error). It is also what the deploy's health check runs,
// so a deploy never reports healthy while the database is down; the portal's public
// /api/health stays free of state. `alert` sends what the watchdog did through Keel's
// notification channels (every channel with a rule that takes alerts); with none, the
// watchdog's own log is the record. Neither prints the database address.
import { pathToFileURL } from 'node:url';
import { schedulerPrincipal } from '../engine/authz/systemPrincipal.mjs';
import { dispatchAlert } from '../engine/notify/notifications.mjs';
import { connect } from '../engine/store/db.mjs';
import { databaseUnreachableReason } from '../engine/store/unreachable.mjs';
import { parseCliArgs } from './args.mjs';

const USAGE = `usage:
  keel-db-watchdog.mjs probe
  keel-db-watchdog.mjs alert --action restarted|started|gave-up --at ISO --detail TEXT`;
const ARGS = { name: 'keel-db-watchdog', strings: ['action', 'at'], text: ['detail'], booleans: ['help'], positionals: 1 };

export const WATCHDOG_EVENT_KIND = 'database.watchdog';
const ACTIONS = {
  restarted: { severity: 'warning', summary: "Keel's database stopped answering, so the watchdog restarted it and the portal" },
  started: { severity: 'warning', summary: "Keel's database container had stopped, so the watchdog started it and restarted the portal" },
  'gave-up': { severity: 'critical', summary: "Keel's database still doesn't answer after 3 restarts in an hour; the watchdog stopped trying and someone needs to look" },
};

/** The alert for one watchdog action. Pure. */
export function watchdogEvent({ action, at, detail }) {
  const known = ACTIONS[action];
  if (!known) throw new Error(`--action must be one of ${Object.keys(ACTIONS).join(', ')}`);
  if (Number.isNaN(Date.parse(at ?? ''))) throw new Error('--at must be a date and time');
  return {
    kind: WATCHDOG_EVENT_KIND, severity: known.severity, resourceKey: 'keel-postgres',
    action, occurredAt: new Date(at).toISOString(), summary: known.summary, ...(detail ? { detail } : {}),
  };
}

export async function runCli({ argv = process.argv, dbUrl = process.env.KEEL_DB_URL, dependencies = {}, logger = console } = {}) {
  let opts;
  let command;
  try {
    const parsed = parseCliArgs(argv.slice(2), ARGS);
    opts = parsed.values;
    [command] = parsed.positionals;
  } catch (error) {
    logger.error(error.message);
    return 1;
  }
  if (opts.help) { logger.log(USAGE); return 0; }
  if (command !== 'probe' && command !== 'alert') { logger.log(USAGE); return 1; }
  if (!dbUrl) { logger.error('KEEL_DB_URL not set (the unit reads /etc/keel/db.env)'); return 1; }
  let event;
  if (command === 'alert') {
    try { event = watchdogEvent({ action: opts.action, at: opts.at, detail: opts.detail }); } catch (error) {
      logger.error(error.message);
      return 1;
    }
  }
  let client;
  try {
    client = await (dependencies.connect ?? connect)(dbUrl);
    await client.query('select 1');
    if (command === 'probe') {
      logger.log('database answers');
      return 0;
    }
    const requestedBy = (await (dependencies.schedulerPrincipal ?? schedulerPrincipal)(client)).id;
    const deliveries = await (dependencies.dispatchAlert ?? dispatchAlert)(client, {
      event, requestedBy, dedupKey: `${WATCHDOG_EVENT_KIND}:${event.action}:${event.occurredAt}`,
    });
    logger.log(deliveries.length
      ? `alert queued to ${deliveries.length} ${deliveries.length === 1 ? 'channel' : 'channels'}`
      : 'no new delivery: no channel takes alerts, or this one was already queued; the watchdog log is the record');
    return 0;
  } catch (error) {
    const reason = databaseUnreachableReason(error);
    logger.error(reason ? `database unreachable (${reason})` : `database check failed: ${error.message}`);
    return reason ? 2 : 1;
  } finally {
    await client?.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
