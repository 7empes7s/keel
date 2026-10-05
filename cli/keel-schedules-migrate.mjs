#!/usr/bin/env node
// One-time migration, run by the orchestrator against the configured local store.
// Apply schema.sql first. No service units are changed or restarted.
//
// node keel-schedules-migrate.mjs --tenant-ref REF [--kinds collect,api-drift]
// --kinds seeds only those job kinds; re-running with more kinds adds the rest and keeps
// every row already there.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from '../engine/store/db.mjs';
import { seedSchedules } from '../engine/store/scheduleSeed.mjs';

const USAGE = 'usage: keel-schedules-migrate.mjs --tenant-ref REF [--kinds KIND,...] (with KEEL_DB_URL set)';
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--tenant-ref', '--kinds'].includes(args[i]) || options[args[i]] !== undefined
      || typeof args[i + 1] !== 'string' || !args[i + 1].trim()) throw new Error(USAGE);
  options[args[i]] = args[i + 1];
}
if (!options['--tenant-ref']) throw new Error(USAGE);
const jobKinds = options['--kinds']?.split(',').map((kind) => kind.trim());
if (!process.env.KEEL_DB_URL) throw new Error('KEEL_DB_URL is required');
const client = await connect(process.env.KEEL_DB_URL);
try {
  await seedSchedules(client, { tenantRef: options['--tenant-ref'], jobKinds });
} finally {
  await client.end();
}
// Retire only the old timers of the kinds just seeded: a kind still left out keeps its timer.
const disableArgs = jobKinds ? [jobKinds.join(',')] : [];
execFileSync('bash', [fileURLToPath(new URL('../ops/keel-schedules-disable-timers.sh', import.meta.url)), ...disableArgs], { stdio: 'inherit' });
