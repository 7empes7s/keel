// Node side of the KEEL DSC profile (design §4.3 "DSC loads as a separate profile").
//
// One job drives one allowlisted Microsoft365DSC resource through a list of calls
// (Get, Test, Set), in the keel-dsc image (ops/powershell/Dockerfile.dsc), with its own
// memory cap. The job carries property values as JSON DATA: there is no script field,
// and the container (ops/powershell/run-dsc.ps1) checks the resource, every property name
// and every value against its own allowlist before anything loads or connects.
//
// A Set must carry Ensure = 'Present': KEEL never removes an object through DSC.
//
// The container answers { ok: true, moduleVersion, results: [...] } with one result per
// call, or { ok: false, error } for the whole job (exit 1). A whole-job failure is a
// DscError carrying a structured `detail`; it is never read as an empty answer.
import { JobQueueError, parseJobStdout, runJob } from './jobQueue.mjs';

export const DSC_IMAGE = 'keel-dsc:latest';
// Q182 measured 951 MB at peak for 7 calls; the cap leaves headroom and stays bounded.
export const DSC_MEMORY = '1536m';
export const DSC_TIMEOUT_MS = 10 * 60 * 1000;
export const DSC_MODULE = 'Microsoft365DSC';
export const DSC_MODULE_VERSION = '2.26.1021.1';
export const DSC_METHODS = Object.freeze(['Get', 'Test', 'Set']);
export const MAX_DSC_CALLS = 200;
const MAX_VALUE_LENGTH = 1024;
const MAX_DETAIL_TEXT = 2000;
const PROPERTY_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

export class DscError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'DscError';
    this.detail = Object.freeze(detail);
  }
}

/** Refused before anything is sent: an undeclared resource, method, property or value. */
export class DscScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DscScopeError';
  }
}

function valueProblem(name, value) {
  if (value === null) return `${name} is null; KEEL leaves a property out instead of sending null`;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${name} is not a finite number`;
  if (typeof value === 'string') {
    if (value.length > MAX_VALUE_LENGTH) return `${name} is longer than ${MAX_VALUE_LENGTH} characters`;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) return `${name} contains a control character`;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') return `${name} may only list strings`;
      const problem = valueProblem(name, item);
      if (problem) return problem;
    }
    return null;
  }
  return `${name} must be a string, number, boolean or list of strings, never an object or script`;
}

/**
 * The job descriptor for one resource and its calls. `resources` is the allowlist:
 * { [resource]: { properties: [...], writable: [...] } }. Throws DscScopeError on anything
 * outside it. The descriptor never contains PowerShell source.
 */
export function dscJob({ resource, calls, tenantConfigPath = null }, { resources }) {
  const allowed = resources && Object.hasOwn(resources, resource) ? resources[resource] : null;
  if (!allowed) throw new DscScopeError(`${resource} is not a DSC resource KEEL drives`);
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_DSC_CALLS) throw new DscScopeError(`a DSC job carries 1 to ${MAX_DSC_CALLS} calls`);
  const clean = calls.map(({ method, properties } = {}) => {
    if (!DSC_METHODS.includes(method)) throw new DscScopeError(`${method} is not a DSC method KEEL calls`);
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw new DscScopeError('properties must be a plain object');
    const permitted = method === 'Set' ? allowed.writable : allowed.properties;
    const out = {};
    for (const [name, value] of Object.entries(properties)) {
      if (!PROPERTY_NAME.test(name) || !permitted.includes(name)) throw new DscScopeError(`${resource} does not take ${name} from KEEL in a ${method}`);
      const problem = valueProblem(name, value);
      if (problem) throw new DscScopeError(problem);
      out[name] = Array.isArray(value) ? [...value] : value;
    }
    for (const key of ['Identity', 'Name']) {
      if (typeof out[key] !== 'string' || !out[key]) throw new DscScopeError(`every DSC call names the object by Identity and Name (${key} is missing)`);
    }
    if (method === 'Set' && out.Ensure !== 'Present') throw new DscScopeError('a DSC Set must carry Ensure = Present: KEEL never removes an object through DSC');
    return { method, properties: out };
  });
  return {
    adapter: 'powershell/dsc',
    mode: 'dsc',
    resource,
    moduleVersion: DSC_MODULE_VERSION,
    calls: clean,
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
 * Runs one DSC job in the keel-dsc image. Resolves { jobId, moduleVersion, results }
 * with one { method, ok, state?, missing?, inDesiredState?, error? } per call. Throws a
 * DscError for a job-level failure (refused descriptor, no connection, non-zero exit,
 * timeout, malformed answer) and a DscScopeError, unsent, for anything outside the
 * allowlist. `options` are runJob's; the image and memory default to the DSC profile's.
 */
export async function runDsc(request, { resources, ...options } = {}) {
  const job = dscJob(request, { resources });
  const fail = (code, message, extra = {}) => new DscError(`${request.resource}: ${message}`, {
    code, resource: request.resource, message: clip(message), category: null, errorId: null, stderr: null, jobId: null, ...extra,
  });
  const { image, memory, timeoutMs, ...rest } = options;
  let ran;
  try {
    ran = await runJob(job, { image: image ?? DSC_IMAGE, memory: memory ?? DSC_MEMORY, timeoutMs: timeoutMs ?? DSC_TIMEOUT_MS, ...rest });
  } catch (error) {
    if (!(error instanceof JobQueueError)) throw error;
    const envelope = envelopeOf(error.stdout ?? '');
    if (error.code === 'NONZERO_EXIT' && envelope?.ok === false) {
      throw fail('DSC_JOB_REFUSED', String(envelope.error?.message ?? 'the DSC job failed'), {
        category: clip(envelope.error?.category ?? null), errorId: clip(envelope.error?.errorId ?? null), stderr: clip(error.stderr), jobId: error.jobId,
      });
    }
    throw fail(error.code ?? 'JOB_ERROR', error.message, { stderr: clip(error.stderr), jobId: error.jobId ?? null });
  }
  const envelope = ran.result && typeof ran.result === 'object' && !Array.isArray(ran.result) ? ran.result : null;
  if (envelope?.ok === false) {
    throw fail('DSC_JOB_REFUSED', String(envelope.error?.message ?? 'the DSC job failed'), {
      category: clip(envelope.error?.category ?? null), errorId: clip(envelope.error?.errorId ?? null), jobId: ran.jobId, stderr: clip(ran.stderr),
    });
  }
  if (envelope?.ok !== true || !Array.isArray(envelope.results) || envelope.results.length !== job.calls.length) {
    throw fail('BAD_ENVELOPE', 'the container did not answer one result per DSC call', { jobId: ran.jobId, stderr: clip(ran.stderr) });
  }
  if (envelope.moduleVersion !== DSC_MODULE_VERSION) {
    throw fail('MODULE_VERSION', `the container ran Microsoft365DSC ${envelope.moduleVersion ?? 'unknown'}, not ${DSC_MODULE_VERSION}`, { jobId: ran.jobId });
  }
  const results = envelope.results.map((row, index) => ({
    method: job.calls[index].method,
    ok: row?.ok === true,
    ...(row?.state && typeof row.state === 'object' ? { state: row.state } : {}),
    ...(Array.isArray(row?.missing) ? { missing: row.missing.map(String) } : {}),
    ...(typeof row?.inDesiredState === 'boolean' ? { inDesiredState: row.inDesiredState } : {}),
    ...(row?.ok === true ? {} : { error: { message: clip(String(row?.error?.message ?? 'the call failed')), category: clip(row?.error?.category ?? null), errorId: clip(row?.error?.errorId ?? null) } }),
  }));
  return { jobId: ran.jobId, moduleVersion: envelope.moduleVersion, results };
}
