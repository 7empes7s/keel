#!/usr/bin/env node
// /opt/keel/cli/keel-worker.mjs
//
// node keel-worker.mjs [--worker-id ID] [--db-url $KEEL_DB_URL] [--poll-interval-ms 2000]
//
// Long-running job worker for the operator portal's job queue (§3.3,
// docs/superpowers/specs/2026-09-08-keel-operator-portal-design.md). Claims queued jobs
// and executes them by invoking the EXISTING CLIs as child processes, so collection and
// pruning safety guards stay on the one code path those CLIs already implement — this
// worker never reimplements collection or pruning logic.
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connect } from '../engine/store/db.mjs';
import { claimNext, complete, fail, resetOrphaned } from '../engine/jobs/queue.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

// Whitelisted params -> CLI flags, one entry per job kind. Deliberately explicit rather
// than a generic pass-through: job params can be written by anything that can enqueue a
// job (the portal, an operator, a schedule), and must never be able to smuggle an
// arbitrary flag — such as a different --db-url — into the child process invocation.
const JOB_HANDLERS = {
  collect: {
    script: join(__dirname, 'keel-collect.mjs'),
    argsFor(params = {}) {
      const args = [];
      if (params.tier !== undefined) {
        if (!['tier1', 'tier2', 'tier3'].includes(params.tier)) {
          throw new Error(`invalid params.tier: ${params.tier}`);
        }
        args.push('--tier', params.tier);
      }
      if (params.config !== undefined) {
        args.push('--config', requireString(params.config, 'params.config'));
      }
      return args;
    },
  },
  prune: {
    script: join(__dirname, 'keel-prune.mjs'),
    argsFor(params = {}) {
      const args = [];
      if (params.config !== undefined) {
        args.push('--config', requireString(params.config, 'params.config'));
      }
      if (params.dryRun) args.push('--dry-run');
      return args;
    },
  },
  'drift-detect': {
    script: join(__dirname, 'keel-drift.mjs'),
    argsFor(params = {}) {
      const args = ['detect'];
      if (params.config !== undefined) {
        args.push('--config', requireString(params.config, 'params.config'));
      }
      return args;
    },
  },
};

async function runJob(client, job, { dbUrl }) {
  const handler = JOB_HANDLERS[job.kind];
  if (!handler) {
    await fail(client, { id: job.id, error: `no worker handler registered for kind: ${job.kind}` });
    console.error(`job ${job.id}: no handler for kind ${job.kind}`);
    return;
  }

  let args;
  try {
    args = [...handler.argsFor(job.params ?? {}), '--db-url', dbUrl];
  } catch (err) {
    await fail(client, { id: job.id, error: `invalid params: ${err.message}` });
    console.error(`job ${job.id}: invalid params — ${err.message}`);
    return;
  }

  const startedAt = Date.now();
  console.log(`job ${job.id}: running ${job.kind} ${handler.script} ${args.join(' ')}`);
  try {
    const { stdout, stderr } = await execFileAsync('node', [handler.script, ...args], {
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    await complete(client, {
      id: job.id,
      result: { stdout, stderr, durationMs: Date.now() - startedAt },
    });
    console.log(`job ${job.id}: succeeded (${Date.now() - startedAt}ms)`);
  } catch (err) {
    const message = [
      err.code !== undefined ? `exit code ${err.code}` : err.message,
      err.stderr ? `stderr: ${err.stderr}` : null,
      err.stdout ? `stdout: ${err.stdout}` : null,
    ].filter(Boolean).join('\n');
    await fail(client, { id: job.id, error: message });
    console.error(`job ${job.id}: failed (${Date.now() - startedAt}ms) — ${message}`);
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: keel-worker.mjs [--worker-id ID] [--db-url $KEEL_DB_URL] [--poll-interval-ms 2000]');
    return;
  }

  const dbUrl = arg('db-url', process.env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  // Stable across restarts of the SAME service instance (not random per-process) so
  // startup crash-recovery can find and requeue only the jobs this instance abandoned.
  const workerId = arg('worker-id', process.env.KEEL_WORKER_ID || hostname());
  const pollIntervalMs = Number(arg('poll-interval-ms', 2000));

  const client = await connect(dbUrl);

  const reclaimed = await resetOrphaned(client, { workerId });
  if (reclaimed.length > 0) {
    console.log(
      `worker ${workerId}: reclaimed ${reclaimed.length} orphaned job(s) from a previous ` +
      `instance of this worker: ${reclaimed.map((j) => j.id).join(', ')}`,
    );
  }

  let shuttingDown = false;
  const stop = (signal) => {
    console.log(`worker ${workerId}: received ${signal} — finishing current job, then exiting`);
    shuttingDown = true;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  console.log(`worker ${workerId}: polling for jobs every ${pollIntervalMs}ms`);
  while (!shuttingDown) {
    const job = await claimNext(client, { workerId });
    if (!job) {
      await sleep(pollIntervalMs);
      continue;
    }
    await runJob(client, job, { dbUrl });
  }

  await client.end();
  console.log(`worker ${workerId}: exited cleanly`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
