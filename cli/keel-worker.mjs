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
import { drainDueDestinations } from '../engine/telemetry/outbox.mjs';
import { createSentinelAdapter, SENTINEL_DESTINATION_KIND } from '../engine/telemetry/adapters/sentinel.mjs';
import { createWebhookAdapter } from '../engine/telemetry/adapters/webhook.mjs';
import { createCefAdapter } from '../engine/telemetry/adapters/cef.mjs';
import { credentialPaths } from '../engine/restore/credentialPaths.mjs';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { ingestAudit, migrateAuditIngestion, readAuditEvidence, createFixtureAuditAdapter } from '../engine/identity/auditIngest.mjs';
import { resolveOwnership, readOwnership } from '../engine/identity/ownership.mjs';
import { createFixtureCmdbAdapter } from '../engine/identity/adapters/cmdb.mjs';
import { connect } from '../engine/store/db.mjs';
import { INCOMPLETE_TYPES_PREFIX, PARTIAL_EXIT_CODE } from '../engine/collect/incomplete.mjs';
import { can } from '../engine/authz/can.mjs';
import { capabilityForJobKind } from '../engine/authz/jobCapabilities.mjs';
import { findPrincipalById } from '../engine/authz/principals.mjs';
import { recordAutoRemediationTerminalOutcome } from '../engine/policy/execute.mjs';
import { sweepEscalations } from '../engine/notify/escalation.mjs';
import { sweepBreakGlassCanaries } from '../engine/safety/breakGlassReadiness.mjs';
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
  // Wave 1 CONT: a night's content delta (mail, files, sites) streams through throttled
  // Graph reads; the run resumes from its delta state, so the ceiling only bounds a hang.
  'content-collect': 6 * 60 * 60 * 1000,
  // Wave 1 DISC: up to 5000 Graph paths, a few pages each, at four at a time with every
  // throttle waited out in full.
  discover: 3 * 60 * 60 * 1000,
});
const PROCESS_GROUP_TERM_GRACE_MS = 5 * 1000;
const PROCESS_GROUP_POLL_MS = 25;
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;

// Roadmap task-79: SIEM export destination kinds resolve to delivery adapters here.
// Roadmap task-81 registers the generic webhook and CEF sinks below with production
// defaults (global fetch, node:dgram, env: credential references). The Azure Monitor
// adapter is registered by task-80 in this same map; until a kind has an
// adapter here a destination of that kind drains as `no-adapter` — its events stay
// durably pending instead of being dropped or falsely acknowledged.
export const SIEM_ADAPTERS = Object.freeze({
  [SENTINEL_DESTINATION_KIND]: createSentinelAdapter(),
  webhook: createWebhookAdapter(),
  cef: createCefAdapter(),
});

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

/**
 * Issue #447: the result of a child that exited with its handler's partial exit
 * code and named, on one stdout line, the types it did not read in full. Any
 * other exit, or a partial exit without a readable list, stays a failure.
 */
export function partialResult(handler, err, durationMs) {
  if (handler?.partialExitCode === undefined || err?.code !== handler.partialExitCode || err.signal) return null;
  const line = String(err.stdout ?? '').split('\n').reverse().find((text) => text.startsWith(INCOMPLETE_TYPES_PREFIX));
  if (!line) return null;
  let incompleteTypes;
  try {
    incompleteTypes = JSON.parse(line.slice(INCOMPLETE_TYPES_PREFIX.length));
  } catch {
    return null;
  }
  if (!Array.isArray(incompleteTypes) || incompleteTypes.length === 0
      || !incompleteTypes.every((entry) => typeof entry?.type === 'string' && entry.type && typeof entry.outcome === 'string')) return null;
  return { stdout: err.stdout, stderr: err.stderr ?? '', durationMs, partial: true, incompleteTypes };
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

// Issue #411: the config, scope and reader params are file paths the child reads as root.
// Anything that can enqueue a job can set them, so they must name a file under /etc/keel,
// where only the operator writes. The path is resolved first, so `..` cannot step out.
const KEEL_CONFIG_DIR = '/etc/keel/';

export function requireKeelConfigPath(value, label) {
  const path = requireString(value, label);
  const resolved = resolve('/', path);
  if (path.includes('\0') || !resolved.startsWith(KEEL_CONFIG_DIR)) {
    throw new Error(`${label} must be a file under ${KEEL_CONFIG_DIR}`);
  }
  return resolved;
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
          || Object.keys(params).some((key) => !['dryRun', 'tenantRef'].includes(key))
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
    partialExitCode: PARTIAL_EXIT_CODE,
    argsFor(params = {}) {
      const args = [];
      if (params.tier !== undefined) {
        if (!['tier1', 'tier2', 'tier3'].includes(params.tier)) {
          throw new Error(`invalid params.tier: ${params.tier}`);
        }
        args.push('--tier', params.tier);
      }
      if (params.config !== undefined) {
        args.push('--config', requireKeelConfigPath(params.config, 'params.config'));
      }
      return args;
    },
  },
  prune: {
    script: join(__dirname, 'keel-prune.mjs'),
    argsFor(params = {}) {
      const args = [];
      if (params.config !== undefined) {
        args.push('--config', requireKeelConfigPath(params.config, 'params.config'));
      }
      // Retention go (2026-10-15): a scheduled prune deletes what its own report lists.
      // dryRun: true keeps it to the report.
      args.push(params.dryRun ? '--dry-run' : '--apply');
      return args;
    },
  },
  'drift-detect': {
    script: join(__dirname, 'keel-drift.mjs'),
    argsFor(params = {}) {
      const args = ['detect'];
      if (params.snapshotId !== undefined) args.push('--snapshot-id', requireString(params.snapshotId, 'params.snapshotId'));
      if (params.tenantRef !== undefined) args.push('--tenant-ref', requireString(params.tenantRef, 'params.tenantRef'));
      if (params.config !== undefined) {
        args.push('--config', requireKeelConfigPath(params.config, 'params.config'));
      }
      return args;
    },
  },
  // Plan task 62: scheduled Microsoft API/catalog metadata comparison. Read-only,
  // anonymous HTTPS fetches of the configured official metadata sources; findings
  // persist as review candidates only. The script enforces its own per-source
  // timeout and size bounds; the whitelisted params can only steer it at an
  // operator-written tenant config or source list, never at an arbitrary flag.
  'api-drift': {
    script: join(__dirname, '../tools/qualification/apiDrift.mjs'),
    argsFor(params = {}) {
      const args = [];
      if (params.config !== undefined) {
        args.push('--config', requireKeelConfigPath(params.config, 'params.config'));
      }
      if (params.sources !== undefined) {
        args.push('--sources', requireString(params.sources, 'params.sources'));
      }
      return args;
    },
  },
  // Gap W1: scheduled workload settings collection. Read-only: the script rebuilds the
  // workload ledger from stored live proof and runs only the workloads it enables; the
  // rest record a `disabled` run and send nothing. Params can only point it at an
  // operator-written tenant config or workload scope file; tenantRef is what the
  // scheduler always sends and is checked against the config by the script.
  'workload-collect': {
    script: join(__dirname, 'keel-workload-collect.mjs'),
    argsFor(params = {}) {
      if (params === null || typeof params !== 'object' || Array.isArray(params)
          || Object.keys(params).some((key) => !['config', 'scope', 'tenantRef'].includes(key))) {
        throw new Error('workload-collect params may contain only config, scope and tenantRef');
      }
      const args = ['run'];
      if (params.config !== undefined) args.push('--config', requireKeelConfigPath(params.config, 'params.config'));
      if (params.scope !== undefined) args.push('--scope', requireKeelConfigPath(params.scope, 'params.scope'));
      if (params.tenantRef !== undefined) args.push('--tenant-ref', requireString(params.tenantRef, 'params.tenantRef'));
      return args;
    },
  },
  // Wave 1 CONT: scheduled content backup as the content-reader identity. Read-only: the
  // script reads through a GET-only Graph transport and writes encrypted chunks and the
  // item index. Params can only point it at operator-written files under /etc/keel;
  // tenantRef is what the scheduler sends and is checked against the config.
  'content-collect': {
    script: join(__dirname, 'keel-content-collect.mjs'),
    // A run where no workload failed but some were read only in part (locked OneDrives,
    // one refused mailbox) is partly done, not failed, like a settings backup (#447).
    partialExitCode: PARTIAL_EXIT_CODE,
    argsFor(params = {}) {
      if (params === null || typeof params !== 'object' || Array.isArray(params)
          || Object.keys(params).some((key) => !['config', 'reader', 'scope', 'tenantRef'].includes(key))) {
        throw new Error('content-collect params may contain only config, reader, scope and tenantRef');
      }
      const args = ['run'];
      if (params.config !== undefined) args.push('--config', requireKeelConfigPath(params.config, 'params.config'));
      if (params.reader !== undefined) args.push('--reader', requireKeelConfigPath(params.reader, 'params.reader'));
      if (params.scope !== undefined) args.push('--scope', requireKeelConfigPath(params.scope, 'params.scope'));
      if (params.tenantRef !== undefined) args.push('--tenant-ref', requireString(params.tenantRef, 'params.tenantRef'));
      return args;
    },
  },
  // Wave 1 DISC: scheduled tenant discovery. Read-only: every request goes through a
  // GET-only Graph transport and the run is stored in the database. Params can only point
  // it at an operator-written tenant config; tenantRef is what the scheduler sends and is
  // checked against the config.
  discover: {
    script: join(__dirname, 'keel-discover.mjs'),
    argsFor(params = {}) {
      if (params === null || typeof params !== 'object' || Array.isArray(params)
          || Object.keys(params).some((key) => !['config', 'tenantRef'].includes(key))) {
        throw new Error('discover params may contain only config and tenantRef');
      }
      const args = ['run'];
      if (params.config !== undefined) args.push('--config', requireKeelConfigPath(params.config, 'params.config'));
      if (params.tenantRef !== undefined) args.push('--tenant-ref', requireString(params.tenantRef, 'params.tenantRef'));
      return args;
    },
  },
  // Plan task 16: a backup IS a tiered collection — the tiered systemd units run
  // keel-collect.mjs --tier tierN, so the job dispatches to that exact script rather
  // than reimplementing any of its logic. The tier is whitelisted here even though
  // no shell is involved: job params are never trusted.
  backup: {
    script: join(__dirname, 'keel-collect.mjs'),
    partialExitCode: PARTIAL_EXIT_CODE,
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
      const args = ['--snapshot-id', requireString(params.snapshotId, 'params.snapshotId')];
      // Task-87: a re-snapshot names the baseline it supersedes and may keep its
      // derived "(vN)" label; a new baseline always needs a label.
      if (params.supersedesBaselineId !== undefined) {
        args.push('--supersedes', requireString(params.supersedesBaselineId, 'params.supersedesBaselineId'));
        if (params.label !== undefined) args.push('--label', requireString(params.label, 'params.label'));
      } else {
        args.push('--label', requireString(params.label, 'params.label'));
      }
      args.push('--set-by', requireString(job.requested_by, 'job.requested_by'));
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
    argsFor(params = {}, job = {}) {
      const args = ['--baseline-id', requireString(params.baselineId, 'params.baselineId')];
      // Live gate #148 (Q43): reinstating a superseded version is the same approval and
      // capability as an activation; the job requester is the recorded actor.
      if (params.reinstate === true) {
        args.push('--reinstate');
        if (params.version !== undefined) {
          if (!Number.isInteger(params.version) || params.version < 1) {
            throw new Error('params.version must be a positive integer');
          }
          args.push('--version', String(params.version));
        }
        args.push('--actor', requireString(job.requested_by, 'job.requested_by'));
        if (params.reason !== undefined) {
          args.push('--reason', requireString(params.reason, 'params.reason'));
        }
      }
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

      // Roadmap task-70: a compensation dry run carries only the promoted restore it
      // undoes and the id to persist the result under. Its configs, scope and
      // journal all come from that restore's own artifact inside the CLI.
      if (params.compensates !== undefined) {
        const extra = paramKeys.filter((key) => key !== 'compensates' && key !== 'artifactId');
        if (extra.length > 0) {
          throw new Error(`a compensation dry run carries only params.compensates and params.artifactId (unexpected: ${extra.join(', ')})`);
        }
        return [
          '--compensate', requireString(params.compensates, 'params.compensates'),
          '--persist-artifact', requireString(params.artifactId, 'params.artifactId'),
          '--requested-by', requireString(job.requested_by, 'job.requested_by'),
        ];
      }

      // CoreView gap 6: "Make it pass" from the Compliance page. One control and one
      // object; the source backup and the setting come from the CLI, never the job.
      if (params.complianceFix !== undefined) {
        const extra = paramKeys.filter((key) => !['complianceFix', 'artifactId', 'collectorConfig', 'targetConfig'].includes(key));
        if (extra.length > 0) {
          throw new Error(`a compliance fix dry run carries only params.complianceFix, the two config paths and params.artifactId (unexpected: ${extra.join(', ')})`);
        }
        const request = params.complianceFix ?? {};
        const fields = Object.keys(request).filter((key) => key !== 'controlId' && key !== 'naturalKey');
        if (fields.length > 0) throw new Error(`params.complianceFix may carry only controlId and naturalKey (unexpected: ${fields.join(', ')})`);
        return [
          '--compliance-fix', requireString(request.controlId, 'params.complianceFix.controlId'),
          '--object', requireString(request.naturalKey, 'params.complianceFix.naturalKey'),
          '--collector-config', requireString(params.collectorConfig, 'params.collectorConfig'),
          '--target-config', requireString(params.targetConfig, 'params.targetConfig'),
          '--persist-artifact', requireString(params.artifactId, 'params.artifactId'),
          '--requested-by', requireString(job.requested_by, 'job.requested_by'),
        ];
      }

      // A workload restore dry run from the Restore page (Exchange, Teams, Purview):
      // one recorded workload collection and the objects chosen from it. The CLI reads
      // with the server's collector file; promotion is the artifact path above.
      if (params.workloadRestore !== undefined) {
        const extra = paramKeys.filter((key) => key !== 'workloadRestore' && key !== 'artifactId');
        if (extra.length > 0) {
          throw new Error(`a workload restore dry run carries only params.workloadRestore and params.artifactId (unexpected: ${extra.join(', ')})`);
        }
        // One mailbox or one team is its own dry run (mailbox / teamId instead of
        // targets); the organization-wide Exchange settings ride along with a mailbox,
        // and only then may the tenant-wide option be set.
        const request = params.workloadRestore ?? {};
        const allowed = ['workload', 'collectionId', 'targets', 'mailbox', 'teamId', 'includeOrganization', 'allowTenantWide'];
        const fields = Object.keys(request).filter((key) => !allowed.includes(key));
        if (fields.length > 0) throw new Error(`params.workloadRestore may carry only ${allowed.join(', ')} (unexpected: ${fields.join(', ')})`);
        const scopes = ['targets', 'mailbox', 'teamId'].filter((key) => request[key] !== undefined);
        if (scopes.length !== 1) throw new Error('params.workloadRestore carries exactly one of targets, mailbox or teamId');
        const args = [
          '--workload', requireString(request.workload, 'params.workloadRestore.workload'),
          '--collection', requireString(request.collectionId, 'params.workloadRestore.collectionId'),
        ];
        if (request.targets !== undefined) {
          if (!Array.isArray(request.targets) || request.targets.length === 0) {
            throw new Error('params.workloadRestore.targets must name at least one object');
          }
          args.push(...request.targets.flatMap((key) => ['--target', requireString(key, 'params.workloadRestore.targets entry')]));
        } else if (request.mailbox !== undefined) {
          args.push('--mailbox', requireString(request.mailbox, 'params.workloadRestore.mailbox'));
        } else {
          args.push('--team', requireString(request.teamId, 'params.workloadRestore.teamId'));
        }
        for (const key of ['includeOrganization', 'allowTenantWide']) {
          if (request[key] !== undefined && request[key] !== true) throw new Error(`params.workloadRestore.${key} may only be true`);
        }
        if (request.includeOrganization === true) {
          if (request.mailbox === undefined) throw new Error('params.workloadRestore.includeOrganization needs a mailbox');
          args.push('--include-organization');
        }
        if (request.allowTenantWide === true) {
          if (request.includeOrganization !== true) throw new Error('params.workloadRestore.allowTenantWide is only set with includeOrganization');
          args.push('--allow-tenant-wide-test-writes');
        }
        args.push(
          '--persist-artifact', requireString(params.artifactId, 'params.artifactId'),
          '--requested-by', requireString(job.requested_by, 'job.requested_by'),
        );
        return args;
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
      // Roadmap task-71: a selection dry run may be planned under an incident. Only
      // the id travels; qualification, exclusions and any override are re-derived
      // from the database inside the CLI.
      if (params.incidentId !== undefined) {
        if (hasPlan) throw new Error('params.incidentId requires the snapshot/selection scope');
        args.push('--incident', requireString(params.incidentId, 'params.incidentId'));
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
      const defaults = credentialPaths();
      for (const id of params.driftIds) args.push('--drift-id', requireString(id, 'params.driftIds entry'));
      args.push(
        '--collector-config', requireString(
          params.collectorConfig ?? defaults.collectorConfig, 'params.collectorConfig',
        ),
        '--target-config', requireString(
          params.targetConfig ?? defaults.targetConfig, 'params.targetConfig',
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

  // Both entry points run the same collection. Hold the session lock until
  // the child exits, even if a stale heartbeat requeues its job in the meantime.
  // Advisory locks are database-wide, so the key names the schema the job store
  // lives in: one collection per store, and separate stores (each test file's
  // schema) never contend.
  const collection = ['collect', 'backup'].includes(job.kind);
  if (collection) {
    const { rows: [lock] } = await client.query(
      "SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext('keel:collection:' || current_schema())) AS acquired",
    );
    if (!lock.acquired) {
      await client.query(
        `UPDATE job SET status = 'queued', started_at = NULL, heartbeat_at = NULL,
         worker_id = NULL, not_before = now() + interval '5 seconds' WHERE id = $1`, [job.id],
      );
      return;
    }
  }
  try {
    const startedAt = Date.now();
    emitJobEvent(job, 'job.running', eventSink);
    const timeoutMs = JOB_TIMEOUT_MS[job.kind] ?? JOB_TIMEOUT_MS.default;
    const execution = startJobChild(handler.script, args, { timeoutMs, executable: handler.executable,
      // The requester is passed on so a collection reads the audit logs as them, and the
      // job's id so a backup can report each type's progress onto its own job row.
      env: { ...process.env, KEEL_EVENT_CORRELATION_ID: jobCorrelationId(job), KEEL_JOB_REQUESTED_BY: String(job.requested_by ?? ''), KEEL_JOB_ID: String(job.id) },
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
      // Issue #447: a collect that saved its snapshot (or a content backup that saved
      // every workload) but could not read some types in full ends as a finished job
      // that names those types, not as a failure.
      const partial = partialResult(handler, err, Date.now() - startedAt);
      if (partial) {
        const completed = await complete(client, { id: job.id, result: partial });
        emitJobEvent(completed ?? job, 'job.succeeded', eventSink);
        await recordAutoRemediationTerminalOutcome(client, { job, status: 'succeeded' });
        console.log(`job ${job.id}: partly done (${partial.durationMs}ms), not read in full: ${partial.incompleteTypes.map((entry) => entry.type).join(', ')}`);
        return;
      }
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
  } finally {
    if (collection) await client.query(
      "SELECT pg_advisory_unlock(hashtext(current_database()), hashtext('keel:collection:' || current_schema()))",
    );
  }
}

// Roadmap task-79: drain due SIEM outbox events between job polls. The outbox is
// durable, so a drain failure must not kill the worker: it is logged redacted and the
// next poll retries. Exported so the task-79 boundary tests drive this exact isolation
// seam with injected adapters and a failing client.
export async function drainSiemOutbox(client, { workerId, adapters = SIEM_ADAPTERS, now, log = console.error } = {}) {
  try {
    return await drainDueDestinations(client, { adapters, now });
  } catch (err) {
    log(`worker ${workerId}: SIEM outbox drain failed — ${redactPayload(err instanceof Error ? err.message : String(err))}`);
    return null;
  }
}

// Task 83: between job polls, escalate alerts whose acknowledgement deadline passed.
// Deadlines live on the alert rows, so a restarted worker finds every overdue alert;
// the claim is atomic per occurrence, so several workers never escalate it twice.
export async function sweepAlertEscalations(client, { workerId, now, log = console.error } = {}) {
  try {
    return await sweepEscalations(client, { now, log });
  } catch (err) {
    log(`worker ${workerId}: alert escalation sweep failed — ${redactPayload(err instanceof Error ? err.message : String(err))}`);
    return null;
  }
}

// Task 94: between job polls, at most once per interval, raise emergency-account
// usage alerts from the ingested audit facts and the validation / credential
// reminders. It reads KEEL's own tables only; it never calls Microsoft, rotates a
// credential or changes a policy. Idempotent per audit event, so a restart re-sweeps
// safely.
export const BREAKGLASS_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastBreakGlassSweep = -Infinity;
export async function sweepBreakGlassCanary(client, {
  workerId, now = new Date(), log = console.error, intervalMs = BREAKGLASS_SWEEP_INTERVAL_MS, force = false,
} = {}) {
  if (!force && now.getTime() - lastBreakGlassSweep < intervalMs) return null;
  lastBreakGlassSweep = now.getTime();
  try {
    return await sweepBreakGlassCanaries(client, { now, log });
  } catch (err) {
    log(`worker ${workerId}: break-glass canary sweep failed — ${redactPayload(err instanceof Error ? err.message : String(err))}`);
    return null;
  }
}

// Optional one-shot collection seam. The normal queue loop stays disabled for
// audit ingestion unless a trusted caller explicitly invokes this bounded worker.
export async function runAuditIngestion(client, options) {
  return ingestAudit(client, options);
}

export async function runAuditCommand(client, config, { report = false } = {}) {
  if (report) return readAuditEvidence(client, config);
  const adapter = config.fixturePages === undefined ? undefined
    : createFixtureAuditAdapter({ tenantRef: config.managedTenantRef, pages: config.fixturePages });
  return runAuditIngestion(client, { ...config, adapter });
}

// Task 89: one-shot ownership resolution or report. Only the synthetic fixture
// CMDB adapter is wired here; a real CMDB provider must be qualified first.
export async function runOwnershipCommand(client, config, { report = false } = {}) {
  if (report) return readOwnership(client, config);
  if (!Array.isArray(config.fixtureRecords)) throw new Error('ownership command needs fixtureRecords (no live CMDB adapter is configured)');
  const adapter = createFixtureCmdbAdapter({ tenantRef: config.managedTenantRef, records: config.fixtureRecords });
  return resolveOwnership(client, { ...config, adapter, config: config.ownership });
}

// Issue #448: how the worker leaves. drain() lets the running job finish and claims nothing
// new; stop() also terminates the running job. A stop during a drain still terminates it.
export function createShutdownControl({ workerId, log = console.log, logError = console.error } = {}) {
  let draining = false;
  let stopping = false;
  let inFlight = null;
  return {
    get done() { return draining || stopping; },
    get draining() { return draining && !stopping; },
    setInFlight(execution) { inFlight = execution; },
    drain(signal) {
      if (draining || stopping) return;
      draining = true;
      log(`worker ${workerId}: received ${signal} — finishing current job, then exiting`);
    },
    stop(signal) {
      if (stopping) return;
      stopping = true;
      log(`worker ${workerId}: received ${signal} — stopping now`);
      if (inFlight) {
        const { job, terminate } = inFlight;
        log(`worker ${workerId}: terminating in-flight job ${job.id}`);
        void terminate().catch((err) => {
          logError(`worker ${workerId}: could not terminate job ${job.id}: ${err.message}`);
        });
      }
    },
  };
}

// SIGUSR2 (`systemctl reload keel-worker`) drains: the running job finishes, nothing new is
// claimed, and the worker exits 0 so systemd starts it again on the new tree. Deploys use it
// so they never kill a long job (issue #448). SIGTERM and SIGINT still stop now.
export function installShutdownSignals(shutdown, proc = process) {
  proc.on('SIGUSR2', () => shutdown.drain('SIGUSR2'));
  proc.on('SIGTERM', () => shutdown.stop('SIGTERM'));
  proc.on('SIGINT', () => shutdown.stop('SIGINT'));
}

export async function runWorkerLoop({
  shutdown, pollIntervalMs, claim, idle, run, requeue, failUnrun, wait = sleep,
}) {
  while (!shutdown.done) {
    const job = await claim();
    if (!job) {
      await idle();
      if (!shutdown.done) await wait(pollIntervalMs);
      continue;
    }
    if (shutdown.done) {
      if (shutdown.draining) await requeue(job);
      else await failUnrun(job);
      continue;
    }
    await run(job);
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: keel-worker.mjs [--worker-id ID] [--db-url $KEEL_DB_URL] [--poll-interval-ms 2000] [--audit-config FILE [--audit-report] | --audit-migrate | --ownership-config FILE [--ownership-report]]');
    return;
  }

  const dbUrl = arg('db-url', process.env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');
  // Stable across restarts of the SAME service instance (not random per-process) so
  // startup crash-recovery can find and requeue only the jobs this instance abandoned.
  const workerId = arg('worker-id', process.env.KEEL_WORKER_ID || hostname());
  const pollIntervalMs = Number(arg('poll-interval-ms', 2000));

  const client = await connect(dbUrl);

  // Explicit local migration, archive reference or synthetic fixture execution.
  // No Graph route or restorer credential is loaded by this command.
  if (process.argv.includes('--audit-migrate') || process.argv.includes('--audit-config')) {
    try {
      if (process.argv.includes('--audit-migrate')) await migrateAuditIngestion(client);
      else {
        const config = JSON.parse(await readFile(arg('audit-config'), 'utf8'));
        const result = await runAuditCommand(client, config, { report: process.argv.includes('--audit-report') });
        console.log(JSON.stringify(result));
      }
    } finally { await client.end(); }
    return;
  }

  if (process.argv.includes('--ownership-config')) {
    try {
      const config = JSON.parse(await readFile(arg('ownership-config'), 'utf8'));
      console.log(JSON.stringify(await runOwnershipCommand(client, config, { report: process.argv.includes('--ownership-report') })));
    } finally { await client.end(); }
    return;
  }

  const reclaimed = await resetOrphaned(client);
  if (reclaimed.length > 0) {
    console.log(
      `worker ${workerId}: reclaimed ${reclaimed.length} stale job(s): ` +
      reclaimed.map((j) => j.id).join(', '),
    );
  }

  const shutdown = createShutdownControl({ workerId });
  installShutdownSignals(shutdown);

  console.log(`worker ${workerId}: polling for jobs every ${pollIntervalMs}ms`);
  await runWorkerLoop({
    shutdown,
    pollIntervalMs,
    claim: () => claimNext(client, { workerId }),
    idle: async () => {
      // Between job polls, drain any due SIEM outbox events (task-79). The outbox is
      // durable, so a drain failure must not kill the worker: the next poll retries.
      await drainSiemOutbox(client, { workerId });
      await sweepAlertEscalations(client, { workerId });
      await sweepBreakGlassCanary(client, { workerId });
    },
    run: (job) => runJob(client, job, {
      dbUrl,
      onInFlightChange: (execution) => shutdown.setInFlight(execution),
    }),
    // A job claimed while a drain began goes back to the queue for the next worker; a job
    // claimed while stopping fails, as before.
    requeue: (job) => client.query(
      `UPDATE job SET status = 'queued', started_at = NULL, heartbeat_at = NULL, worker_id = NULL
       WHERE id = $1 AND status = 'running'`, [job.id],
    ),
    failUnrun: (job) => fail(client, { id: job.id, error: 'worker stopped before job execution' }),
  });

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
