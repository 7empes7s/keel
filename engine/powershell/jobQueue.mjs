// Node side of the KEEL PowerShell collection-plane boundary (design §4.3).
//
// The boundary is a job queue, not a per-resource shell-out: this module
// writes one job descriptor, invokes the container once with a hard
// `--memory` cap, reads back one canonical JSON result, and surfaces errors
// with the container's real stderr attached. It never spawns a container per
// resource — pwsh module load is slow enough that would destroy throughput.
//
// The container mounts /etc/keel read-only (credentials never enter the
// image) and is invoked with `--rm` so no state survives between jobs.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const DEFAULT_IMAGE = 'keel-powershell:latest';
export const DEFAULT_MEMORY = '1g';
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_CREDENTIAL_MOUNT = '/etc/keel';

export class JobQueueError extends Error {
  constructor(message, { code, stderr, stdout, jobId } = {}) {
    super(message);
    this.name = 'JobQueueError';
    this.code = code;
    this.stderr = stderr;
    this.stdout = stdout;
    this.jobId = jobId;
  }
}

/**
 * Run one job descriptor against the PowerShell collection container.
 *
 * @param {object} job - Job descriptor, e.g. { adapter, mode, workload }.
 *   A `jobId` is generated if not supplied.
 * @param {object} [options]
 * @param {string} [options.image] - Container image tag.
 * @param {string} [options.memory] - Hard memory cap passed to `docker run --memory`.
 *   `--memory-swap` is set to the same value so the container gets no extra
 *   swap headroom beyond the hard cap — required on a host that is already
 *   swap-constrained.
 * @param {number} [options.timeoutMs] - Wall-clock budget before the child is
 *   SIGKILLed and the call rejects.
 * @param {string} [options.credentialMount] - Host path bind-mounted read-only
 *   into the container at the same path.
 * @param {string} [options.dockerBin] - Override for the docker binary.
 * @param {Function} [options.spawnFn] - Injectable replacement for
 *   node:child_process.spawn, so this can be unit-tested offline without
 *   Docker (see jobQueue.test.mjs).
 * @returns {Promise<{jobId: string, result: any, stderr: string}>}
 */
export async function runJob(job, options = {}) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new TypeError('job must be a plain object descriptor');
  }

  const {
    image = DEFAULT_IMAGE,
    memory = DEFAULT_MEMORY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    credentialMount = DEFAULT_CREDENTIAL_MOUNT,
    dockerBin = 'docker',
    spawnFn = spawn,
  } = options;

  const jobId = job.jobId ?? randomUUID();
  const payload = JSON.stringify({ ...job, jobId });

  const args = [
    'run',
    '--rm',
    '-i',
    '--memory', memory,
    '--memory-swap', memory,
    '--network', 'host',
    '-v', `${credentialMount}:${credentialMount}:ro`,
    image,
  ];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(dockerBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new JobQueueError(`failed to spawn ${dockerBin}: ${err.message}`, {
        code: 'SPAWN_ERROR', stderr: '', stdout: '', jobId,
      }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        reject(new JobQueueError(`job ${jobId} timed out after ${timeoutMs}ms`, {
          code: 'TIMEOUT', stderr, stdout, jobId,
        }));
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      finish(() => {
        reject(new JobQueueError(`failed to run ${dockerBin}: ${err.message}`, {
          code: 'SPAWN_ERROR', stderr, stdout, jobId,
        }));
      });
    });

    child.on('close', (exitCode) => {
      finish(() => {
        if (exitCode !== 0) {
          reject(new JobQueueError(
            `job ${jobId} exited ${exitCode}: ${stderr.trim() || '(no stderr)'}`,
            { code: 'NONZERO_EXIT', stderr, stdout, jobId },
          ));
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch (err) {
          reject(new JobQueueError(
            `job ${jobId} produced non-JSON stdout: ${err.message}`,
            { code: 'BAD_JSON', stderr, stdout, jobId },
          ));
          return;
        }

        resolve({ jobId, result: parsed, stderr });
      });
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}
