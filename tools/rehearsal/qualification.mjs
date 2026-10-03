#!/usr/bin/env node
/**
 * Task 72: offline drill-plan validation and the bounded same-tenant drill
 * manifest. A drill touches only the disposable objects its plan allowlists,
 * in the one tenant the plan pins, and records what the run itself observed:
 * timestamps read from the run's clock, the writes it issued and whether its
 * cleanup was verified. Offline validation issues no write and never counts
 * as a recovery drill. No cloned tenant and no tenant-wide policy rehearsal:
 * the only drillable object is a disposable group.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DRILL_MANIFEST_VERSION = 1;
export const DRILL_PLAN_VERSION = 1;
export const DISPOSABLE_PREFIX = 'group:keel-rehearsal-';
// The round trip drills exactly one disposable group per run.
export const MAX_DRILL_OBJECTS = 1;
export const DRILL_OUTCOMES = Object.freeze(['validated', 'invalid', 'passed', 'failed', 'cleanup-failed']);
export const CLEANUP_STATES = Object.freeze(['not-needed', 'verified', 'failed']);

const NATURAL_KEY = /^group:keel-rehearsal-[A-Za-z0-9-]{1,48}$/;

export function tenantRefFor(tenantId) {
  if (typeof tenantId !== 'string' || tenantId.length === 0) throw new Error('drill: tenantId required');
  return `sha256:${createHash('sha256').update(tenantId).digest('hex').slice(0, 16)}`;
}

export function isDisposableTarget(naturalKey) {
  return typeof naturalKey === 'string' && naturalKey.startsWith(DISPOSABLE_PREFIX) && NATURAL_KEY.test(naturalKey);
}

/** Every drill mutation passes through here: disposable and allowlisted, or refused. */
export function assertDrillTarget(naturalKey, allowlist) {
  if (!isDisposableTarget(naturalKey)) {
    throw new Error(`drill: refusing non-disposable target ${naturalKey}`);
  }
  if (allowlist && !allowlist.includes(naturalKey)) {
    throw new Error(`drill: refusing target outside the plan allowlist: ${naturalKey}`);
  }
  return naturalKey;
}

/**
 * Offline plan validation: checks the plan against the collector's tenant and
 * the drill bounds without reading or writing anything. Returns the problems
 * instead of throwing so an operator sees all of them at once.
 */
export function validateDrillPlan(plan, { collectorTenantId } = {}) {
  const problems = [];
  if (!plan || typeof plan !== 'object') return { valid: false, problems: ['plan must be an object'] };
  if (plan.version !== DRILL_PLAN_VERSION) problems.push(`plan version must be ${DRILL_PLAN_VERSION}`);
  const extra = Object.keys(plan).filter((key) => !['version', 'tenantPin', 'objects'].includes(key));
  if (extra.length) problems.push(`unknown plan fields: ${extra.join(', ')}`);
  if (typeof plan.tenantPin !== 'string' || !/^sha256:[0-9a-f]{16}$/.test(plan.tenantPin)) {
    problems.push('tenantPin must be the tenant reference sha256:<16 hex>');
  } else if (collectorTenantId === undefined) {
    problems.push('the collector tenant is required to check the tenant pin');
  } else if (plan.tenantPin !== tenantRefFor(collectorTenantId)) {
    problems.push('tenantPin names a different tenant than the configured collector');
  }
  if (!Array.isArray(plan.objects) || plan.objects.length === 0) {
    problems.push('objects must list the disposable objects the drill may touch');
  } else {
    if (plan.objects.length > MAX_DRILL_OBJECTS) problems.push(`a drill touches at most ${MAX_DRILL_OBJECTS} object`);
    if (new Set(plan.objects).size !== plan.objects.length) problems.push('objects must be unique');
    for (const object of plan.objects) {
      if (!isDisposableTarget(object)) problems.push(`not a disposable target: ${object}`);
    }
  }
  return { valid: problems.length === 0, problems };
}

const canonical = (value) => (Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value);
const digestOf = (body) => `sha256:${createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex')}`;

function iso(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`drill: ${name} must be an observed timestamp`);
  return date.toISOString();
}

/**
 * Builds the drill manifest from what the run observed. Elapsed time is never
 * an input: it is computed from the run's own start and finish readings.
 */
export function buildDrillManifest({
  mode, tenantRef, objects, startedAt, finishedAt, outcome, writes, steps = [], cleanup, problems = [], ...rest
}) {
  if ('elapsedMs' in rest) throw new Error('drill: elapsed time is computed from the observed run, never supplied');
  if (Object.keys(rest).length) throw new Error(`drill: unknown manifest fields: ${Object.keys(rest).join(', ')}`);
  if (!['offline', 'live'].includes(mode)) throw new Error('drill: mode must be offline or live');
  if (!DRILL_OUTCOMES.includes(outcome)) throw new Error(`drill: unknown outcome ${outcome}`);
  if (!CLEANUP_STATES.includes(cleanup?.status)) throw new Error('drill: cleanup status required');
  if (!Number.isInteger(writes) || writes < 0) throw new Error('drill: writes must be the observed write count');
  if (mode === 'offline' && (writes !== 0 || !['validated', 'invalid'].includes(outcome))) {
    throw new Error('drill: an offline validation issues no writes and is never a drill outcome');
  }
  const started = iso(startedAt, 'startedAt');
  const finished = iso(finishedAt, 'finishedAt');
  const elapsedMs = Date.parse(finished) - Date.parse(started);
  if (elapsedMs < 0) throw new Error('drill: finish precedes start');
  const body = {
    version: DRILL_MANIFEST_VERSION,
    kind: 'keel-same-tenant-drill',
    mode,
    tenantRef,
    objects: [...objects],
    startedAt: started,
    finishedAt: finished,
    elapsedMs,
    writes,
    outcome,
    // Only a live run that restored its object and verified its cleanup is a
    // recovery drill. Offline validation never is.
    countsAsRecoveryDrill: mode === 'live' && outcome === 'passed' && cleanup.status === 'verified',
    cleanup: { status: cleanup.status, ...(cleanup.detail ? { detail: String(cleanup.detail) } : {}) },
    steps: steps.map(({ step, at }) => ({ step: String(step), at: iso(at, `step ${step}`) })),
    problems: problems.map(String),
  };
  return { ...body, digest: digestOf(body) };
}

/** Re-checks a manifest read back from disk; nothing in it is trusted as written. */
export function verifyDrillManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return { ok: false, problems: ['manifest must be an object'] };
  const { digest, ...body } = manifest;
  if (digest !== digestOf(body)) problems.push('digest does not match the manifest content');
  if (body.version !== DRILL_MANIFEST_VERSION || body.kind !== 'keel-same-tenant-drill') problems.push('unknown manifest version or kind');
  if (Date.parse(body.finishedAt) - Date.parse(body.startedAt) !== body.elapsedMs) {
    problems.push('elapsed time does not match the observed start and finish');
  }
  if (!Array.isArray(body.objects) || body.objects.length === 0 || body.objects.length > MAX_DRILL_OBJECTS
    || body.objects.some((object) => !isDisposableTarget(object))) {
    problems.push('objects must be allowlisted disposable targets');
  }
  if (body.mode === 'offline' && (body.writes !== 0 || body.countsAsRecoveryDrill !== false)) {
    problems.push('an offline validation cannot write or count as a recovery drill');
  }
  const counts = body.mode === 'live' && body.outcome === 'passed' && body.cleanup?.status === 'verified';
  if (body.countsAsRecoveryDrill !== counts) problems.push('recovery-drill claim does not follow from outcome and cleanup');
  if (!CLEANUP_STATES.includes(body.cleanup?.status)) problems.push('cleanup status missing');
  if (body.outcome === 'cleanup-failed' && body.cleanup?.status !== 'failed') problems.push('cleanup failure must be recorded as failed');
  return { ok: problems.length === 0, problems };
}

function usage() {
  return 'Usage: qualification.mjs verify MANIFEST...  |  qualification.mjs validate-plan PLAN --config COLLECTOR_CONFIG';
}

export async function main(argv = process.argv.slice(2), out = console) {
  const [command, ...rest] = argv;
  if (command === 'verify' && rest.length) {
    let ok = true;
    for (const path of rest) {
      const result = verifyDrillManifest(JSON.parse(readFileSync(path, 'utf8')));
      ok &&= result.ok;
      out.log(JSON.stringify({ path, ...result }));
    }
    return ok;
  }
  if (command === 'validate-plan' && rest.length === 3 && rest[1] === '--config') {
    const collector = JSON.parse(readFileSync(rest[2], 'utf8'));
    const result = validateDrillPlan(JSON.parse(readFileSync(rest[0], 'utf8')), { collectorTenantId: collector.tenantId });
    out.log(JSON.stringify(result));
    return result.valid;
  }
  throw new Error(usage());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((ok) => { process.exitCode = ok ? 0 : 1; }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
