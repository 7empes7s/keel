#!/usr/bin/env node
// One-time migration, run by the orchestrator against the configured local store.
// Apply the schema first (node engine/store/loadSchema.mjs | psql). No service units are changed or restarted.
//
// node keel-schedules-migrate.mjs --tenant-ref REF [--kinds collect,api-drift]
// --kinds seeds only those job kinds; re-running with more kinds adds the rest and keeps
// every row already there.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from '../engine/store/db.mjs';
import { seedSchedules } from '../engine/store/scheduleSeed.mjs';
import { parseCliArgs } from './args.mjs';

const USAGE = 'usage: keel-schedules-migrate.mjs --tenant-ref REF [--kinds KIND,...] (with KEEL_DB_URL set)';
let options;
try {
  ({ values: options } = parseCliArgs(process.argv.slice(2), { name: 'keel-schedules-migrate', strings: ['tenant-ref', 'kinds'] }));
} catch {
  throw new Error(USAGE);
}
if (!options['tenant-ref']?.trim() || (options.kinds !== undefined && !options.kinds.trim())) throw new Error(USAGE);
const jobKinds = options.kinds?.split(',').map((kind) => kind.trim());
if (!process.env.KEEL_DB_URL) throw new Error('KEEL_DB_URL is required');
const client = await connect(process.env.KEEL_DB_URL);
try {
  await seedSchedules(client, { tenantRef: options['tenant-ref'], jobKinds });
} finally {
  await client.end();
}
// Retire only the old timers of the kinds just seeded: a kind still left out keeps its timer.
const disableArgs = jobKinds ? [jobKinds.join(',')] : [];
execFileSync('bash', [fileURLToPath(new URL('../ops/keel-schedules-disable-timers.sh', import.meta.url)), ...disableArgs], { stdio: 'inherit' });
