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

// ---------------------------------------------------------------------------
// Roadmap task-105: one cmdlet as a structured job.
//
// A cmdlet job carries the cmdlet name and its parameters as JSON DATA. There
// is no script field: the container (ops/powershell/run-cmdlet.ps1) checks the
// cmdlet against its own allowlist and calls it by splatting the parameter
// table, so every value stays exactly one argument however it is quoted. A
// mailbox identity like `o'brien'; Remove-Mailbox x` is passed, compared and
// written back as that literal string, never parsed as PowerShell.
//
// The container answers one envelope: { ok: true, output: [...] } or
// { ok: false, error: { message, category, errorId } } with exit code 1. A
// failed cmdlet is a CmdletError carrying a structured `detail`; it is never
// read as an empty successful result.

const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const CMDLET_NAME = /^[A-Z][a-z]+-[A-Za-z]+$/;
const MAX_PARAMETER_LENGTH = 1024;
const MAX_DETAIL_TEXT = 2000;

export class CmdletError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CmdletError';
    this.detail = Object.freeze(detail);
  }
}

function parameterValueProblem(name, value) {
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${name} is not a finite number`;
  if (typeof value === 'string') {
    if (value.length > MAX_PARAMETER_LENGTH) return `${name} is longer than ${MAX_PARAMETER_LENGTH} characters`;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) return `${name} contains a control character`;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') return `${name} may only list strings`;
      const problem = parameterValueProblem(name, item);
      if (problem) return problem;
    }
    return null;
  }
  return `${name} must be a string, number, boolean, null or list of strings, never an object or script`;
}

/**
 * The job descriptor for one cmdlet call. Throws on a cmdlet outside
 * `allowedCmdlets`, an invalid parameter name or a non-scalar value. The
 * descriptor never contains PowerShell source.
 */
export function cmdletJob({ module, cmdlet, parameters = {}, tenantConfigPath = null }, { allowedCmdlets }) {
  if (!(allowedCmdlets instanceof Set) || allowedCmdlets.size === 0) throw new TypeError('a cmdlet job needs an explicit allowlist');
  if (typeof cmdlet !== 'string' || !CMDLET_NAME.test(cmdlet) || !allowedCmdlets.has(cmdlet)) {
    throw new TypeError(`${cmdlet} is not an allowed cmdlet`);
  }
  if (typeof module !== 'string' || !module) throw new TypeError('a cmdlet job names its module');
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new TypeError('parameters must be a plain object');
  const clean = {};
  for (const [name, value] of Object.entries(parameters)) {
    if (!PARAMETER_NAME.test(name)) throw new TypeError(`${name} is not a parameter name`);
    const problem = parameterValueProblem(name, value);
    if (problem) throw new TypeError(problem);
    clean[name] = Array.isArray(value) ? [...value] : value;
  }
  return {
    adapter: 'powershell/cmdlet',
    mode: 'cmdlet',
    module,
    cmdlet,
    parameters: clean,
    ...(tenantConfigPath ? { tenantConfigPath } : {}),
  };
}

const clip = (text) => (typeof text === 'string' ? text.slice(0, MAX_DETAIL_TEXT) : null);

function envelopeOf(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.ok === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Runs one cmdlet through runJob. Resolves { jobId, output } on success; throws a
 * CmdletError whose `detail` is
 *   { code, cmdlet, message, category, errorId, exitCode, stderr, jobId }
 * for a cmdlet error, a non-zero exit, a timeout or a malformed answer.
 */
export async function runCmdlet(call, { allowedCmdlets, ...options } = {}) {
  const job = cmdletJob(call, { allowedCmdlets });
  const fail = (code, message, extra = {}) => new CmdletError(`${call.cmdlet}: ${message}`, {
    code, cmdlet: call.cmdlet, message: clip(message), category: null, errorId: null, exitCode: null, stderr: null, jobId: null, ...extra,
  });
  let ran;
  try {
    ran = await runJob(job, options);
  } catch (error) {
    if (!(error instanceof JobQueueError)) throw error;
    const envelope = envelopeOf(error.stdout ?? '');
    if (error.code === 'NONZERO_EXIT' && envelope?.ok === false) {
      throw fail('CMDLET_ERROR', String(envelope.error?.message ?? 'the cmdlet failed'), {
        category: clip(envelope.error?.category ?? null), errorId: clip(envelope.error?.errorId ?? null),
        exitCode: 1, stderr: clip(error.stderr), jobId: error.jobId,
      });
    }
    throw fail(error.code ?? 'JOB_ERROR', error.message, { stderr: clip(error.stderr), jobId: error.jobId ?? null });
  }
  const envelope = ran.result && typeof ran.result === 'object' && !Array.isArray(ran.result) && typeof ran.result.ok === 'boolean' ? ran.result : null;
  if (!envelope) throw fail('BAD_ENVELOPE', 'the container did not answer with a cmdlet envelope', { jobId: ran.jobId, stderr: clip(ran.stderr) });
  if (envelope.ok !== true) {
    throw fail('CMDLET_ERROR', String(envelope.error?.message ?? 'the cmdlet failed'), {
      category: clip(envelope.error?.category ?? null), errorId: clip(envelope.error?.errorId ?? null), exitCode: 0, jobId: ran.jobId, stderr: clip(ran.stderr),
    });
  }
  const output = envelope.output === null || envelope.output === undefined ? [] : (Array.isArray(envelope.output) ? envelope.output : [envelope.output]);
  return { jobId: ran.jobId, output };
}
