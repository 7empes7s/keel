#!/usr/bin/env node
// One-time migration, run by the orchestrator against the configured local store.
// Apply schema.sql first. No service units are changed or restarted.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from '../engine/store/db.mjs';
import { seedSchedules } from '../engine/store/scheduleSeed.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--tenant-ref' || !args[1].trim()) {
  throw new Error('usage: keel-schedules-migrate.mjs --tenant-ref REF (with KEEL_DB_URL set)');
}
if (!process.env.KEEL_DB_URL) throw new Error('KEEL_DB_URL is required');
const client = await connect(process.env.KEEL_DB_URL);
try {
  await seedSchedules(client, { tenantRef: args[1] });
} finally {
  await client.end();
}
execFileSync('bash', [fileURLToPath(new URL('../ops/keel-schedules-disable-timers.sh', import.meta.url))], { stdio: 'inherit' });
