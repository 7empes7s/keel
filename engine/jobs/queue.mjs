import { envelopeForJob, createEventSink } from '../telemetry/events.mjs';
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { capabilityForJobKind } from '../authz/jobCapabilities.mjs';
import { resolveRowReferences } from '../govern/references.mjs';

// engine/jobs/queue.mjs
//
// The job queue backing long-running work triggered by the operator portal (§3.3,
// docs/superpowers/specs/2026-09-08-keel-operator-portal-design.md): a collection takes
// ~30s and a restore can take minutes to hours, so neither may run inside an HTTP request.
// The portal enqueues a `job` row; a `keel-worker` process claims and executes it.
//
// claimNext() MUST stay a single atomic statement — `UPDATE ... WHERE id = (SELECT ...
// FOR UPDATE SKIP LOCKED) RETURNING *, started_at::text AS event_started_at`. Do not "optimize" this into a SELECT followed by
// an UPDATE; that reintroduces the exact race two workers claiming the same job.

// A worker updates its heartbeat this often while it owns a running job. Reclamation waits
// much longer than one missed pulse, so a momentary scheduler or database delay cannot cause
// a live job to be run a second time.
export const JOB_HEARTBEAT_INTERVAL_MS = 15 * 1000;
export const ORPHANED_HEARTBEAT_STALE_MS = JOB_HEARTBEAT_INTERVAL_MS * 8;

export async function enqueue(client, {
  kind, params, requestedBy, idempotencyKey, notBefore,
}) {
  // Offsite has no portal route: enforce admission here as well as at execution.
  if (kind === 'offsite') {
    const principal = await findPrincipalById(client, requestedBy);
    const capability = capabilityForJobKind(kind);
    if (!principal || !capability || !(await can(client, principal, capability))) {
      throw new Error('not authorized to enqueue offsite');
    }
  }
  const { rows } = await client.query(
    `INSERT INTO job (kind, params, requested_by, idempotency_key, not_before)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()))
     ON CONFLICT (kind, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING *, started_at::text AS event_started_at`,
    [kind, params ?? {}, requestedBy, idempotencyKey ?? null, notBefore ?? null],
  );
  if (rows[0]) return rows[0];
  // A job with this kind and key already exists (or won a concurrent insert) — return it
  // rather than starting a second one.
  const { rows: existing } = await client.query(
    `SELECT *, started_at::text AS event_started_at FROM job WHERE kind = $1 AND idempotency_key = $2`,
    [kind, idempotencyKey],
  );
  return existing[0];
}

export async function claimNext(client, { workerId, eventSink = createEventSink() }) {
  const { rows } = await client.query(
    `UPDATE job
     SET status = 'running', started_at = now(), heartbeat_at = now(), worker_id = $1
     WHERE id = (
       SELECT id FROM job
       WHERE status = 'queued' AND not_before <= now()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *, started_at::text AS event_started_at`,
    [workerId],
  );
  if (rows[0]) emitJobEvent(rows[0], 'job.claimed', eventSink);
  return rows[0] ?? null;
}

export async function complete(client, { id, result }) {
  const { rows } = await client.query(
    `UPDATE job
     SET status = 'succeeded', result = $2, finished_at = now(), heartbeat_at = NULL
     WHERE id = $1
     RETURNING *, started_at::text AS event_started_at`,
    [id, result ?? null],
  );
  return rows[0] ?? null;
}

export async function fail(client, { id, error }) {
  const { rows } = await client.query(
    `UPDATE job
     SET status = 'failed', error = $2, finished_at = now(), heartbeat_at = NULL
     WHERE id = $1
     RETURNING *, started_at::text AS event_started_at`,
    [id, error ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Roadmap task-130: job summary fields — the requester resolved to a name, and the
 * baseline, plan (dry run), undone restore, changes and snapshot a job's params point
 * at — in one query per kind for the whole list.
 */
export async function summarizeJobs(client, { tenantRef, jobs }) {
  return resolveRowReferences(client, { tenantRef, rows: jobs, people: ['requested_by'] });
}

export async function listJobs(client, { limit = 50 } = {}) {
  const { rows } = await client.query(
    `SELECT *, started_at::text AS event_started_at FROM job ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function touchHeartbeat(client, { id, workerId }) {
  const { rows } = await client.query(
    `UPDATE job
     SET heartbeat_at = now()
     WHERE id = $1 AND status = 'running' AND worker_id = $2
     RETURNING *, started_at::text AS event_started_at`,
    [id, workerId],
  );
  return rows[0] ?? null;
}

// Crash recovery: a worker killed mid-job leaves that job stuck in 'running' forever.
// A worker calls this on startup to reclaim only jobs whose heartbeat is stale. A fresh
// heartbeat always belongs to a live worker, including one with the same stable worker_id.
export async function resetOrphaned(client) {
  const { rows } = await client.query(
    `UPDATE job
     SET status = 'queued', started_at = NULL, heartbeat_at = NULL, worker_id = NULL
     WHERE status = 'running'
       AND (heartbeat_at IS NULL OR heartbeat_at < now() - ($1 * interval '1 millisecond'))
     RETURNING *, started_at::text AS event_started_at`,
    [ORPHANED_HEARTBEAT_STALE_MS],
  );
  return rows;
}

// Internal projection only; callers keep their existing admission/execution gates.
export function emitJobEvent(job, eventType, sink = createEventSink(), options = {}) {
  try { sink(envelopeForJob(job, { ...options, eventType })); } catch { /* logs are not audit authority */ }
}

// Task 62: scheduled Microsoft API/catalog drift detection. One job per tenant per
// cadence period: the idempotency key folds tenant and period together, so a scheduler
// (or an operator) firing the same period twice gets the existing job back instead of
// queuing a duplicate comparison. The kind is a normal queued job — admission and
// execution authorization stay on the existing capabilityForJobKind inventory.
export function apiDriftIdempotencyKey(tenantRef, periodKey) {
  if (typeof tenantRef !== 'string' || tenantRef.length === 0) {
    throw new TypeError('tenantRef is required for an api-drift idempotency key');
  }
  if (typeof periodKey !== 'string' || periodKey.length === 0) {
    throw new TypeError('periodKey is required for an api-drift idempotency key');
  }
  return `api-drift:${tenantRef}:${periodKey}`;
}

export async function enqueueApiDriftRun(client, { tenantRef, requestedBy, periodKey, params = {} }) {
  return enqueue(client, {
    kind: 'api-drift',
    params,
    requestedBy,
    idempotencyKey: apiDriftIdempotencyKey(tenantRef, periodKey),
  });
}
