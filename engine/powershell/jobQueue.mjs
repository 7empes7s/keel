// Node side of the KEEL PowerShell collection-plane boundary (design §4.3).
//
// The boundary is a job queue, not a per-resource shell-out: this module
// writes one job descriptor, invokes the container once with a hard
// `--memory` cap, reads back one canonical JSON result, and surfaces errors
// with the container's real stderr attached. It never spawns a container per
// resource — pwsh module load is slow enough that would destroy throughput.
//
// Credentials never enter the image. The container no longer sees /etc/keel:
// runJob reads the job's own connection settings on the host (they must sit
// under /etc/keel), copies that one settings file, certificate and key into a
// private per-job directory, mounts only that directory read-only, and removes
// it when the job ends. The container runs with `--rm` as a non-root user, on
// a read-only root filesystem with every capability dropped, on the default
// bridge network rather than the host's (security audit run 2, finding 8).
//
// It also mounts this checkout's ops/powershell read-only over /app, so the
// entrypoint and the cmdlet allowlist are always the deployed ones, never the
// copy baked in when the image was last built (#339: a stale image refused
// Set-QuarantinePolicy). The image supplies only pwsh and the pinned modules.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chown, lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_IMAGE = 'keel-powershell:latest';
export const DEFAULT_MEMORY = '1g';
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Every job's connection settings, certificate and key must resolve inside this directory. */
export const DEFAULT_CREDENTIAL_ROOT = '/etc/keel';
export const DEFAULT_TENANT_CONFIG = '/etc/keel/tenant.json';
/** Where the job's own settings, certificate and key appear inside the container. */
export const CONTAINER_CREDENTIAL_DIR = '/run/keel-job';
/** The unprivileged user the container runs as when the worker itself is root. */
export const CONTAINER_USER = '10001:10001';
export const DEFAULT_PIDS_LIMIT = 512;
/** How long the `docker rm -f` that follows a timed-out job may take before it is abandoned. */
export const CONTAINER_REMOVE_TIMEOUT_MS = 30 * 1000;
/**
 * The deployed container scripts (run-job.sh, run-cmdlet.ps1, list-commands.ps1, probe-workloads.ps1).
 * A function, as catalogue.mjs does: a `new URL(literal, import.meta.url)` makes the
 * portal's bundler resolve the directory as a module.
 */
export const defaultScriptMount = () => join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ops', 'powershell');
export const CONTAINER_SCRIPT_DIR = '/app';

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

// Strips ANSI colour sequences (pwsh colours its warning stream).
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * The container answers with one JSON document on stdout. pwsh can print warning-stream
 * lines ahead of it (2026-10-05: Get-LabelPolicy's "WARNING: Force Validate not set"),
 * so when the whole of stdout is not JSON, `WARNING:` lines are set aside as `noise` and the
 * rest parsed; failing that, the last non-empty line is taken as the answer and the lines
 * before it are returned as `noise`. Anything else still fails to parse.
 */
export function parseJobStdout(stdout) {
  try {
    return { value: JSON.parse(stdout), noise: [] };
  } catch (error) {
    const lines = String(stdout).replace(ANSI, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    // pwsh warning-stream lines can also sit around a multi-line answer (2026-10-28, the probe's
    // Get-Mailbox -ResultSize 1: "WARNING: There are more results available ..."). Without them,
    // the rest must still be one JSON document.
    const warnings = lines.filter((line) => /^WARNING:/.test(line));
    if (warnings.length) {
      try {
        return { value: JSON.parse(lines.filter((line) => !/^WARNING:/.test(line)).join('\n')), noise: warnings };
      } catch { /* fall through to the last-line answer */ }
    }
    const last = lines.at(-1);
    if (lines.length < 2 || !last.startsWith('{')) throw error;
    return { value: JSON.parse(last), noise: lines.slice(0, -1) };
  }
}

const inside = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

async function resolvedUnder(root, path, what) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new JobQueueError(`the ${what} path must be absolute; nothing was run`, { code: 'CREDENTIALS_INVALID', stderr: '', stdout: '' });
  }
  const real = await realpath(path);
  if (!inside(await realpath(root), real)) {
    throw new JobQueueError(`the ${what} must be under ${root}; nothing was run`, { code: 'CREDENTIALS_INVALID', stderr: '', stdout: '' });
  }
  return real;
}

/**
 * Copies the job's connection settings, certificate and key (and nothing else) into a
 * new private directory, with the settings rewritten to point at the in-container
 * copies. Returns null when the settings file does not exist on this host: then
 * nothing is mounted, and the container answers that it cannot read the connection
 * settings. Any other problem (a path outside the credential root, unreadable JSON, a
 * missing certificate or key) refuses the job before a container starts.
 */
export async function stageJobCredentials(configPath, { credentialRoot = DEFAULT_CREDENTIAL_ROOT, stagingRoot, owner = null } = {}) {
  let realConfig;
  try {
    realConfig = await resolvedUnder(credentialRoot, configPath, 'connection settings file');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let config;
  try {
    config = JSON.parse(await readFile(realConfig, 'utf8'));
  } catch (error) {
    throw new JobQueueError(`the connection settings could not be read: ${error.message}; nothing was run`, { code: 'CREDENTIALS_INVALID', stderr: '', stdout: '' });
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new JobQueueError('the connection settings are not a JSON object; nothing was run', { code: 'CREDENTIALS_INVALID', stderr: '', stdout: '' });
  }
  const files = {};
  for (const [field, name] of [['certPath', 'cert.pem'], ['keyPath', 'key.pem']]) {
    if (config[field] === undefined || config[field] === null) continue;
    let real;
    try {
      real = await resolvedUnder(credentialRoot, config[field], field);
    } catch (error) {
      if (error instanceof JobQueueError) throw error;
      throw new JobQueueError(`${field} could not be read: ${error.message}; nothing was run`, { code: 'CREDENTIALS_INVALID', stderr: '', stdout: '' });
    }
    files[name] = await readFile(real);
    config[field] = `${CONTAINER_CREDENTIAL_DIR}/${name}`;
  }
  const root = stagingRoot ?? defaultStagingRoot();
  await sweepOnce(root);
  const dir = await mkdtemp(join(root, `${STAGING_PREFIX}${process.pid}-`));
  try {
    files['tenant.json'] = Buffer.from(JSON.stringify(config));
    for (const [name, bytes] of Object.entries(files)) {
      const path = join(dir, name);
      await writeFile(path, bytes, { mode: 0o400, flag: 'wx' });
      if (owner) await chown(path, owner.uid, owner.gid);
    }
    if (owner) await chown(dir, owner.uid, owner.gid);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, configPath: `${CONTAINER_CREDENTIAL_DIR}/tenant.json` };
}

// /run is a tmpfs on the deploy host, so the copies never reach a disk.
const defaultStagingRoot = () => (process.getuid?.() === 0 && existsSync('/run') ? '/run' : tmpdir());

/**
 * Staged copies are named keel-ps-<pid>-<random>, after the process that made them.
 * runJob removes its copy when the job ends, but a worker killed mid-job (SIGKILL, OOM,
 * a host crash) leaves it behind. The first job a process stages first sweeps the
 * staging root: a copy is removed when the process named in it is gone, or is this very
 * process (nothing has been staged here yet, so it is a dead earlier worker's pid).
 * Copies in the older keel-ps-<random> form carry no pid; they are removed once older
 * than LEGACY_STAGING_MAX_AGE_MS, far beyond any job's time budget.
 */
export const STAGING_PREFIX = 'keel-ps-';
export const LEGACY_STAGING_MAX_AGE_MS = 60 * 60 * 1000;
const STAGED_WITH_PID = /^keel-ps-(\d+)-[A-Za-z0-9]{6}$/;
const STAGED_LEGACY = /^keel-ps-[A-Za-z0-9]{6}$/;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user.
    return error.code !== 'ESRCH';
  }
}

/**
 * Removes staged copies left behind by dead workers under `stagingRoot`. Only
 * directories whose names match a staged copy are considered; links and anything else
 * are left alone. Returns the names removed. A copy that cannot be removed is skipped.
 */
export async function sweepStaleStaging(stagingRoot, { selfPid = process.pid, isAlive = processAlive, now = Date.now() } = {}) {
  let names;
  try {
    names = await readdir(stagingRoot);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const withPid = STAGED_WITH_PID.exec(name);
    if (!withPid && !STAGED_LEGACY.test(name)) continue;
    const path = join(stagingRoot, name);
    try {
      const info = await lstat(path);
      if (!info.isDirectory()) continue;
      if (withPid) {
        const pid = Number(withPid[1]);
        if (pid !== selfPid && isAlive(pid)) continue;
      } else if (now - info.mtimeMs < LEGACY_STAGING_MAX_AGE_MS) {
        continue;
      }
      await rm(path, { recursive: true, force: true });
      removed.push(name);
    } catch { /* gone already, or not ours to remove: leave it */ }
  }
  return removed;
}

// One sweep per staging root per process, before that process stages its first copy.
const sweeps = new Map();
// Keyed on the resolved path, so /tmp and /tmp/ never sweep twice (a second sweep would
// take this process's own live copy for a dead worker's).
function sweepOnce(stagingRoot) {
  const key = resolve(stagingRoot);
  if (!sweeps.has(key)) sweeps.set(key, sweepStaleStaging(key).catch(() => []));
  return sweeps.get(key);
}

/**
 * The user the container runs as: the worker's own user when it is not root (so the
 * staged files stay readable), otherwise the fixed unprivileged CONTAINER_USER, to
 * which the staged files are handed.
 */
function containerUser() {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) {
    const [u, g] = CONTAINER_USER.split(':').map(Number);
    return { user: CONTAINER_USER, owner: uid === 0 ? { uid: u, gid: g } : null };
  }
  return { user: `${uid}:${process.getgid()}`, owner: null };
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
 *   SIGKILLed, its container is force-removed (`docker rm -f`) and the call rejects.
 * @param {number} [options.removeTimeoutMs] - How long that `docker rm -f` may take.
 * @param {string} [options.credentialRoot] - Host directory the job's connection
 *   settings, certificate and key must resolve inside. Only those three files are
 *   copied into the container, never the directory.
 * @param {string} [options.stagingRoot] - Host directory for the private per-job copy.
 * @param {string|null} [options.scriptMount] - Host directory holding the container
 *   scripts, bind-mounted read-only over /app. null keeps the image's own copy.
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
    removeTimeoutMs = CONTAINER_REMOVE_TIMEOUT_MS,
    credentialRoot = DEFAULT_CREDENTIAL_ROOT,
    stagingRoot,
    scriptMount = defaultScriptMount(),
    dockerBin = 'docker',
    spawnFn = spawn,
  } = options;

  if (scriptMount !== null && !existsSync(`${scriptMount}/run-job.sh`)) {
    throw new JobQueueError(`the container scripts are not at ${scriptMount}; nothing was run`, { code: 'SCRIPTS_MISSING', stderr: '', stdout: '' });
  }
  const jobId = job.jobId ?? randomUUID();
  const { user, owner } = containerUser();
  const staged = await stageJobCredentials(job.tenantConfigPath ?? DEFAULT_TENANT_CONFIG, { credentialRoot, stagingRoot, owner });
  const payload = JSON.stringify({ ...job, jobId, ...(staged ? { tenantConfigPath: staged.configPath } : {}) });

  // Killing the docker client on a timeout does not stop the container, so every
  // container gets a name the timeout path can remove it by.
  const containerName = jobContainerName(jobId);
  const args = [
    'run',
    '--rm',
    '-i',
    '--name', containerName,
    '--memory', memory,
    '--memory-swap', memory,
    '--pids-limit', String(DEFAULT_PIDS_LIMIT),
    '--network', 'bridge',
    '--user', user,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    // pwsh, the Exchange module (its temporary tmpEXO module) and the restore template need a writable temp and home.
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
    '-e', 'HOME=/tmp',
    ...(staged ? ['-v', `${staged.dir}:${CONTAINER_CREDENTIAL_DIR}:ro`] : []),
    ...(scriptMount === null ? [] : ['-v', `${scriptMount}:${CONTAINER_SCRIPT_DIR}:ro`]),
    image,
  ];

  try {
    return await spawnContainer({ dockerBin, args, spawnFn, timeoutMs, removeTimeoutMs, payload, jobId, containerName });
  } finally {
    if (staged) await rm(staged.dir, { recursive: true, force: true });
  }
}

/**
 * A docker container name for one job: `keel-job-` plus the job id reduced to the
 * characters docker accepts, plus a random suffix so two runs that reuse a job id
 * never collide.
 */
export function jobContainerName(jobId) {
  const safe = String(jobId).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64);
  return `keel-job-${safe ? `${safe}-` : ''}${randomUUID().slice(0, 8)}`;
}

/**
 * Force-removes a job's container after a timeout (`docker rm -f` stops it first).
 * Best effort: it never throws, and gives up after CONTAINER_REMOVE_TIMEOUT_MS so a
 * hung daemon cannot hold the job. Resolves to null when the container is gone (or
 * never started), otherwise to a one-line reason.
 */
function removeContainer({ dockerBin, spawnFn, containerName, timeoutMs }) {
  return new Promise((done) => {
    let child;
    try {
      child = spawnFn(dockerBin, ['rm', '-f', containerName], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      done(`could not run ${dockerBin} rm: ${err.message}`);
      return;
    }
    let stderr = '';
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(reason);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(`${dockerBin} rm did not finish within ${timeoutMs}ms`);
    }, timeoutMs);
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => finish(`could not run ${dockerBin} rm: ${err.message}`));
    child.on('close', (code) => {
      // A container that was never created (or already removed by --rm) is not a failure.
      if (code === 0 || /no such container/i.test(stderr)) finish(null);
      else finish(`${dockerBin} rm exited ${code}: ${stderr.trim() || '(no stderr)'}`);
    });
  });
}

function spawnContainer({ dockerBin, args, spawnFn, timeoutMs, removeTimeoutMs, payload, jobId, containerName }) {
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
      finish(async () => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        // Wait for the container to go before rejecting, so runJob only removes the
        // staged credentials once nothing can still read them.
        const failed = await removeContainer({ dockerBin, spawnFn, containerName, timeoutMs: removeTimeoutMs });
        const note = failed ? `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}keel: container ${containerName} may still be running: ${failed}\n` : stderr;
        reject(new JobQueueError(`job ${jobId} timed out after ${timeoutMs}ms`, {
          code: 'TIMEOUT', stderr: note, stdout, jobId,
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
          parsed = parseJobStdout(stdout);
        } catch (err) {
          reject(new JobQueueError(
            `job ${jobId} produced non-JSON stdout: ${err.message}`,
            { code: 'BAD_JSON', stderr, stdout, jobId },
          ));
          return;
        }

        // Lines pwsh printed before the answer (warnings) are kept as diagnostics.
        const noise = parsed.noise.length ? `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}${parsed.noise.join('\n')}\n` : stderr;
        resolve({ jobId, result: parsed.value, stderr: noise });
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
// Letters, then digits allowed after the first (Get-AtpPolicyForO365). Nothing else.
const CMDLET_NAME = /^[A-Z][a-z]+-[A-Za-z][A-Za-z0-9]*$/;
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
    const parsed = parseJobStdout(stdout).value;
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
