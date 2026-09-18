#!/usr/bin/env node
// /opt/keel/cli/keel-worker.mjs
//
// node keel-worker.mjs [--worker-id ID] [--db-url $KEEL_DB_URL] [--poll-interval-ms 2000]
//
// Long-running job worker for the operator portal's job queue (§3.3,
// docs/superpowers/specs/2026-09-08-keel-operator-portal-design.md). Claims queued jobs
// and executes them by invoking the EXISTING CLIs as child processes, so collection and
// pruning safety guards stay on the one code path those CLIs already implement — this
// worker never reimplements collection or pruning logic. Every claimed job is
// re-authorized at execution time against its requester's current grants (plan task
// 25); the enqueue-time check is never trusted here.
import { createEventSink, jobCorrelationId, redactPayload } from '../engine/telemetry/events.mjs';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../engine/store/db.mjs';
import { can } from '../engine/authz/can.mjs';
import { capabilityForJobKind } from '../engine/authz/jobCapabilities.mjs';
import { findPrincipalById } from '../engine/authz/principals.mjs';
import { recordAutoRemediationTerminalOutcome } from '../engine/policy/execute.mjs';
import {
  emitJobEvent, claimNext, complete, fail, JOB_HEARTBEAT_INTERVAL_MS, resetOrphaned, touchHeartbeat,
} from '../engine/jobs/queue.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Individual job kinds can override this default without putting timeout literals in the
// child-process invocation. Thirty minutes is the safe default for every current kind.
// A restore replays whole dependency waves against a throttled Graph write path and can
// legitimately take hours; killing it early is safe (applies are idempotent, spec §9.3)
// but pointless, so it gets its own ceiling. remediate dispatches through the identical
// apply path (plan task 19), so it gets the identical ceiling.
export const JOB_TIMEOUT_MS = Object.freeze({
  default: 30 * 60 * 1000,
  restore: 6 * 60 * 60 * 1000,
  remediate: 6 * 60 * 60 * 1000,
});
const PROCESS_GROUP_TERM_GRACE_MS = 5 * 1000;
const PROCESS_GROUP_POLL_MS = 25;
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
}

export function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
}

export async function terminateProcessGroup(pid) {
  signalProcessGroup(pid, 'SIGTERM');
  const deadline = Date.now() + PROCESS_GROUP_TERM_GRACE_MS;
  while (isProcessGroupAlive(pid) && Date.now() < deadline) {
    await sleep(PROCESS_GROUP_POLL_MS);
  }
  if (isProcessGroupAlive(pid)) signalProcessGroup(pid, 'SIGKILL');
  while (isProcessGroupAlive(pid)) {
    await sleep(PROCESS_GROUP_POLL_MS);
  }
}

// The child is a process-group leader. This is essential: the collection and pruning CLIs
// may themselves start descendants, all of which must die with the job on timeout or shutdown.
export function startJobChild(file, args, { env = process.env, timeoutMs, executable = 'node' }) {
  let child;
  let timeout;
  let timedOut = false;
  let termination;
  let outputError;
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;

  const terminate = () => {
    if (!termination) termination = terminateProcessGroup(child.pid);
    return termination;
  };

  const collectOutput = (chunks, chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_CHILD_OUTPUT_BYTES) {
      outputError = new Error(`child output exceeded ${MAX_CHILD_OUTPUT_BYTES} bytes`);
      void terminate();
      return;
    }
    chunks.push(chunk);
  };

  const completed = new Promise((resolve, reject) => {
    child = spawn(executable, [file, ...args], {
      detached: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => collectOutput(stdout, chunk));
    child.stderr.on('data', (chunk) => collectOutput(stderr, chunk));
    child.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      const output = {
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      };
      Promise.resolve(termination).then(() => {
        if (timedOut) {
          const timeoutError = new Error(`execution timed out after ${timeoutMs}ms`);
          timeoutError.code = 'ETIMEDOUT';
          timeoutError.stdout = output.stdout;
          timeoutError.stderr = output.stderr;
          reject(timeoutError);
          return;
        }
        if (outputError) {
          outputError.stdout = output.stdout;
          outputError.stderr = output.stderr;
          reject(outputError);
          return;
        }
        if (code !== 0) {
          const exitError = new Error(signal ? `terminated by ${signal}` : `exit code ${code}`);
          exitError.code = code;
          exitError.signal = signal;
          exitError.stdout = output.stdout;
          exitError.stderr = output.stderr;
          reject(exitError);
          return;
        }
        resolve(output);
      }, reject);
    });
    timeout = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, timeoutMs);
  });

  return { child, completed, terminate };
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
// Exported so a test can assert every registered kind has a capability mapping.
export const JOB_HANDLERS = {
  offsite: {
    script: join(__dirname, '../ops/keel-offsite.sh'),
    executable: 'bash',
    acceptsDbUrl: false,
    argsFor(params = {}) {
      if (params === null || typeof params !== 'object' || Array.isArray(params)
          || Object.keys(params).some((key) => key !== 'dryRun')
          || (params.dryRun !== undefined && typeof params.dryRun !== 'boolean')) {
        throw new Error('offsite params must contain only an optional boolean dryRun');
      }
      return params.dryRun ? ['--dry-run'] : [];
    },
    // Result schema: captured output, elapsed milliseconds, and transfer/dry-run outcome.
    resultFor({ stdout, stderr, durationMs }, params = {}) {
      if (typeof stdout !== 'string' || typeof stderr !== 'string'
          || !Number.isFinite(durationMs) || durationMs < 0) {
        throw new Error('invalid offsite result');
      }
      return { stdout, stderr, durationMs, dryRun: params.dryRun === true,
        shipped: params.dryRun !== true };
    },
  },
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
  // Plan task 16: a backup IS a tiered collection — the tiered systemd units run
  // keel-collect.mjs --tier tierN, so the job dispatches to that exact script rather
  // than reimplementing any of its logic. The tier is whitelisted here even though
  // no shell is involved: job params are never trusted.
  backup: {
    script: join(__dirname, 'keel-collect.mjs'),
    argsFor(params = {}) {
      const tier = params.tier ?? 'tier1';
      if (!['tier1', 'tier2', 'tier3'].includes(tier)) {
        throw new Error(`invalid params.tier: ${params.tier}`);
      }
      return ['--tier', tier];
    },
  },
  // Baseline create/activate are in-DB governance writes, not tenant-touching scripts,
  // so they dispatch to thin CLI wrappers around engine/govern/baseline.mjs — keeping
  // the child-process dispatch shape and its timeout/process-group guarantees.
  'baseline-create': {
    script: join(__dirname, 'keel-baseline-create.mjs'),
    argsFor(params = {}, job = {}) {
      const args = [
        '--snapshot-id', requireString(params.snapshotId, 'params.snapshotId'),
        '--label', requireString(params.label, 'params.label'),
        '--set-by', requireString(job.requested_by, 'job.requested_by'),
      ];
      if (params.description !== undefined) {
        args.push('--description', requireString(params.description, 'params.description'));
      }
      if (params.tenantRef !== undefined) {
        args.push('--tenant-ref', requireString(params.tenantRef, 'params.tenantRef'));
      }
      return args;
    },
  },
  'baseline-activate': {
    script: join(__dirname, 'keel-baseline-activate.mjs'),
    argsFor(params = {}) {
      const args = ['--baseline-id', requireString(params.baselineId, 'params.baselineId')];
      if (params.tenantRef !== undefined) {
        args.push('--tenant-ref', requireString(params.tenantRef, 'params.tenantRef'));
      }
      return args;
    },
  },
  // A policy may have been enabled after its matching drift was recorded. This
  // database-only pass re-evaluates the tenant's open drift against current policies;
  // the wrapper owns no policy decisions and accepts no params besides its tenant scope.
  'policy-evaluate': {
    script: join(__dirname, 'keel-policy-evaluate.mjs'),
    argsFor(params = {}) {
      return ['--tenant-ref', requireString(params.tenantRef, 'params.tenantRef')];
    },
  },
  // Plan task 17: restore dispatches to the existing restore CLI, so every safety gate
  // (synced-object and unsafe-deletion guards, report-only Conditional Access, rollback
  // journal, §10.3 sign-in-path gate) stays on the one apply path. The params carry the
  // operator's RAW selection — the dependency closure is recomputed by the CLI from the
  // snapshot (§4.1), never trusted from the job payload. Both credential configs are
  // required strings because the read/write separation (assertSeparateRestorer) needs
  // each; both are part of what the approver approved.
  //
  // Plan task 8: EVERY enforce run is reached ONLY by promoting a completed dry-run
  // artifact. This includes a legacy plan scope: plan-cleanliness is not a substitute
  // for a rendered immutable review. A dry-run-creation job (no params.mode) may
  // optionally carry params.artifactId too — there it means "persist this dry run's
  // result under this id" (job.requested_by becomes the artifact's provenance), the
  // opposite direction of the same identifier.
  restore: {
    script: join(__dirname, 'keel-restore.mjs'),
    argsFor(params = {}, job = {}) {
      const hasPlan = params.planId !== undefined;
      const hasSelection = params.snapshotId !== undefined || params.selection !== undefined;
      if (hasPlan && hasSelection) {
        throw new Error('params.planId is mutually exclusive with params.snapshotId/params.selection');
      }

      if (params.mode !== undefined && params.mode !== 'enforce') {
        throw new Error(`invalid params.mode: ${params.mode}`);
      }

      // An approval-minted job contains an artifact-derived audit projection
      // (snapshot, selection, closure, and target) alongside artifactId. Those fields
      // are never trusted here: the child gets only --artifact, and runRestore loads
      // and validates the frozen artifact itself. The one-field form is retained for
      // already-queued promotions from the first Task 8 implementation; it is equally
      // safe because it follows that same artifact-only CLI path.
      const paramKeys = Object.keys(params);
      const hasArtifactId = typeof params.artifactId === 'string' && params.artifactId.length > 0;
      const isLegacyArtifactPromotion = hasArtifactId
        && paramKeys.length === 1 && paramKeys[0] === 'artifactId';
      if (params.mode === 'enforce' || isLegacyArtifactPromotion) {
        if (!hasArtifactId) {
          throw new Error('params.artifactId is required to enforce a restore (a completed dry-run artifact must be promoted; a direct enforce is refused)');
        }
        return ['--artifact', params.artifactId, '--enforce'];
      }

      const args = [
        '--collector-config', requireString(params.collectorConfig, 'params.collectorConfig'),
        '--target-config', requireString(params.targetConfig, 'params.targetConfig'),
      ];
      if (hasPlan) {
        args.push('--plan', requireString(params.planId, 'params.planId'));
      } else {
        args.push('--snapshot-id', requireString(params.snapshotId, 'params.snapshotId'));
        if (!Array.isArray(params.selection) || params.selection.length === 0) {
          throw new Error('params.selection must be a non-empty array of natural keys');
        }
        for (const key of params.selection) {
          args.push('--select', requireString(key, 'params.selection entry'));
        }
      }
      if (params.artifactId !== undefined) {
        args.push('--persist-artifact', requireString(params.artifactId, 'params.artifactId'));
        args.push('--requested-by', requireString(job.requested_by, 'job.requested_by'));
      }
      if (params.acceptDegradation !== undefined) {
        if (params.acceptDegradation !== true) throw new Error('params.acceptDegradation must be true when present');
        args.push('--accept-degradation');
      }
      return args;
    },
  },
  // Plan task 19: remediate — whether minted by an approved operator request (task 15)
  // or by policy automation (engine/policy/execute.mjs) — carries only drift ids.
  // keel-remediate.mjs resolves those to a restore scope and dispatches through
  // runRestore itself, so remediation inherits every restore safety gate, the §10.3
  // sign-in path gate included. There is no separate "automatic" code path here: an
  // automation-triggered remediate job and an operator-approved one run through this
  // exact same handler and script. Credential config paths default to the tenant's one
  // standing collector/restorer registration (§2.2: this portal manages exactly one
  // tenant) so an automatic action never needs a human to supply them, but an explicit
  // params value always wins.
  remediate: {
    script: join(__dirname, 'keel-remediate.mjs'),
    argsFor(params = {}, job = {}) {
      if (!Array.isArray(params.driftIds) || params.driftIds.length === 0) {
        throw new Error('params.driftIds must be a non-empty array of drift ids');
      }
      const args = [];
      for (const id of params.driftIds) args.push('--drift-id', requireString(id, 'params.driftIds entry'));
      args.push(
        '--collector-config', requireString(
          params.collectorConfig ?? '/etc/keel/tenant-target.json', 'params.collectorConfig',
        ),
        '--target-config', requireString(
          params.targetConfig ?? '/etc/keel/restorer-target.json', 'params.targetConfig',
        ),
      );
      if (params.mode !== undefined) {
        if (params.mode !== 'enforce') throw new Error(`invalid params.mode: ${params.mode}`);
        args.push('--enforce');
      }
      // An enforcement-mode remediation persists its automatic dry run under the
      // immutable artifact flow. Its provenance is the already-authorized job
      // requester, never a value supplied in mutable job params.
      if (job.requested_by !== undefined) {
        args.push('--requested-by', requireString(job.requested_by, 'job.requested_by'));
      }
      return args;
    },
  },
  // Plan task 20: notification delivery has its own job kind. The payload is only a
  // delivery id; channel config and the event are read from the durable delivery log,
  // never accepted as arbitrary worker arguments. keel-notify records failed attempts
  // and enqueues their backoff retries before exiting non-zero.
  notify: {
    script: join(__dirname, 'keel-notify.mjs'),
    argsFor(params = {}) {
      return ['--delivery-id', requireString(params.deliveryId, 'params.deliveryId')];
    },
  },
};

export async function runJob(client, job, { dbUrl, onInFlightChange, handlers = JOB_HANDLERS, eventSink = createEventSink() }) {
  const failJob = async (error) => {
    const failed = await fail(client, { id: job.id, error: redactPayload(error) });
    emitJobEvent(failed ?? job, 'job.failed', eventSink);
    await recordAutoRemediationTerminalOutcome(client, { job, status: 'failed', error });
  };

  const handler = handlers[job.kind];
  if (!handler) {
    await failJob(`no worker handler registered for kind: ${job.kind}`);
    console.error(`job ${job.id}: no handler for kind ${job.kind}`);
    return;
  }

  // Plan task 25: authorization at enqueue is never trusted at execution (§2.3). Re-check
  // the REQUESTER — never the approver — against the capability this kind requires,
  // evaluated now, immediately before dispatching to the handler. A job whose requester
  // lost the grant, was disabled, or no longer resolves to a principal fails, un-run;
  // it must not complete and it must not silently skip.
  const capability = capabilityForJobKind(job.kind);
  if (capability === null) {
    await failJob(`no capability mapping for kind: ${job.kind}`);
    console.error(`job ${job.id}: no capability mapping for kind ${job.kind}`);
    return;
  }
  const principal = await findPrincipalById(client, job.requested_by);
  if (!principal) {
    await failJob(`requester no longer resolves to a principal: ${job.requested_by}`);
    console.error(`job ${job.id}: requester ${job.requested_by} resolves to no principal`);
    return;
  }
  if (!(await can(client, principal, capability, new Date()))) {
    await failJob(`requester no longer authorized for kind: ${job.kind}`);
    console.error(`job ${job.id}: requester ${job.requested_by} no longer authorized for ${job.kind}`);
    return;
  }

  let args;
  try {
    // Handlers that need job context beyond params (baseline-create records the
    // requester as set_by) receive the whole job as a second argument.
    args = handler.argsFor(job.params ?? {}, job);
    if (handler.acceptsDbUrl !== false) args = [...args, '--db-url', dbUrl];
  } catch (err) {
    await failJob(`invalid params: ${err.message}`);
    console.error(`job ${job.id}: invalid params — ${err.message}`);
    return;
  }

  const startedAt = Date.now();
  emitJobEvent(job, 'job.running', eventSink);
  const timeoutMs = JOB_TIMEOUT_MS[job.kind] ?? JOB_TIMEOUT_MS.default;
  const execution = startJobChild(handler.script, args, { timeoutMs, executable: handler.executable,
    env: { ...process.env, KEEL_EVENT_CORRELATION_ID: jobCorrelationId(job) },
  });
  onInFlightChange({ job, terminate: execution.terminate });
  const heartbeat = setInterval(() => {
    touchHeartbeat(client, { id: job.id, workerId: job.worker_id }).catch((err) => {
      console.error(`job ${job.id}: heartbeat failed — ${err.message}`);
    });
  }, JOB_HEARTBEAT_INTERVAL_MS);
  try {
    const { stdout, stderr } = await execution.completed;
    const output = { stdout, stderr, durationMs: Date.now() - startedAt };
    const completed = await complete(client, {
      id: job.id,
      result: handler.resultFor ? handler.resultFor(output, job.params ?? {}) : output,
    });
    emitJobEvent(completed ?? job, 'job.succeeded', eventSink);
    await recordAutoRemediationTerminalOutcome(client, { job, status: 'succeeded' });
    console.log(`job ${job.id}: succeeded (${Date.now() - startedAt}ms)`);
  } catch (err) {
    const message = [
      err.code !== undefined ? `exit code ${err.code}` : err.message,
      err.stderr ? `stderr: ${err.stderr}` : null,
      err.stdout ? `stdout: ${err.stdout}` : null,
    ].filter(Boolean).join('\n');
    await failJob(message);
    console.error(`job ${job.id}: failed (${Date.now() - startedAt}ms) — ${redactPayload(message)}`);
  } finally {
    clearInterval(heartbeat);
    onInFlightChange(null);
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

  const reclaimed = await resetOrphaned(client);
  if (reclaimed.length > 0) {
    console.log(
      `worker ${workerId}: reclaimed ${reclaimed.length} stale job(s): ` +
      reclaimed.map((j) => j.id).join(', '),
    );
  }

  let shuttingDown = false;
  let inFlight = null;
  const stop = (signal) => {
    if (shuttingDown) return;
    console.log(`worker ${workerId}: received ${signal} — finishing current job, then exiting`);
    shuttingDown = true;
    if (inFlight) {
      console.log(`worker ${workerId}: terminating in-flight job ${inFlight.job.id}`);
      void inFlight.terminate().catch((err) => {
        console.error(`worker ${workerId}: could not terminate job ${inFlight.job.id}: ${err.message}`);
      });
    }
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
    if (shuttingDown) {
      await fail(client, { id: job.id, error: 'worker stopped before job execution' });
      continue;
    }
    await runJob(client, job, {
      dbUrl,
      onInFlightChange: (execution) => { inFlight = execution; },
    });
  }

  await client.end();
  console.log(`worker ${workerId}: exited cleanly`);
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
