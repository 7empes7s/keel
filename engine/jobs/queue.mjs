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

// Security audit run 2, finding 11: one person cannot fill the queue. Portal routes pass
// this as maxQueuedForRequester; scheduled and approval-minted jobs carry no cap.
export const PORTAL_QUEUED_JOBS_PER_PRINCIPAL = 20;

export class QueueFullError extends Error {
  constructor(limit) {
    super(`you already have ${limit} jobs waiting to run; try again when some have finished`);
    this.name = 'QueueFullError';
    this.limit = limit;
  }
}

// Priority 1 jobs are claimed before priority 0 ones. Approvals mint priority 1: a second
// person already signed off and is waiting on the result.
export const APPROVED_JOB_PRIORITY = 1;

/**
 * @param {any} client
 * @param {{ kind: string, params?: any, requestedBy: string, idempotencyKey?: string | null,
 *   notBefore?: any, priority?: number, maxQueuedForRequester?: number | null,
 *   reuseActive?: { kinds: string[], params: Record<string, unknown> } | null }} job
 *
 * reuseActive: when a job of one of these kinds whose params contain these params is
 * still queued or running, that job is returned (marked `reused: true`) and no new job
 * is added. "Back up Tier 3" pressed twice, from two places or by two people, runs once.
 */
export async function enqueue(client, {
  kind, params, requestedBy, idempotencyKey, notBefore, priority = 0, maxQueuedForRequester = null,
  reuseActive = null,
}) {
  // Offsite has no portal route: enforce admission here as well as at execution.
  if (kind === 'offsite') {
    const principal = await findPrincipalById(client, requestedBy);
    const capability = capabilityForJobKind(kind);
    if (!principal || !capability || !(await can(client, principal, capability))) {
      throw new Error('not authorized to enqueue offsite');
    }
  }
  const insert = async () => {
    if (reuseActive) {
      // Held to the end of the transaction, so two parallel requests cannot both miss
      // each other's job.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('job-active:' || $1, 0))",
        [JSON.stringify([[...reuseActive.kinds].sort(), reuseActive.params])]);
      const { rows: active } = await client.query(
        `SELECT *, started_at::text AS event_started_at FROM job
          WHERE kind = ANY($1::text[]) AND status IN ('queued', 'running') AND params @> $2::jsonb
          ORDER BY created_at LIMIT 1`,
        [reuseActive.kinds, reuseActive.params],
      );
      // A replay of the request that queued it is not a second press.
      if (active[0]) return active[0].idempotency_key === idempotencyKey ? active[0] : { ...active[0], reused: true };
    }
    const { rows } = await client.query(
      `INSERT INTO job (kind, params, requested_by, idempotency_key, not_before, priority)
       SELECT $1, $2, $3, $4, COALESCE($5, now()), $6
       WHERE $7::int IS NULL
          OR (SELECT count(*) FROM job WHERE requested_by = $3 AND status = 'queued') < $7
       ON CONFLICT (kind, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING *, started_at::text AS event_started_at`,
      [kind, params ?? {}, requestedBy, idempotencyKey ?? null, notBefore ?? null, priority,
        maxQueuedForRequester],
    );
    if (rows[0]) return rows[0];
    // A job with this kind and key already exists (or won a concurrent insert) — return it
    // rather than starting a second one.
    const { rows: existing } = await client.query(
      `SELECT *, started_at::text AS event_started_at FROM job WHERE kind = $1 AND idempotency_key = $2`,
      [kind, idempotencyKey],
    );
    if (!existing[0] && maxQueuedForRequester !== null) throw new QueueFullError(maxQueuedForRequester);
    return existing[0];
  };
  if (maxQueuedForRequester === null && !reuseActive) return insert();
  // A capped enqueue runs in its own transaction holding a per-person lock, so parallel
  // requests from one person count each other and cannot pass the cap together. Callers
  // must not already be inside a transaction (the portal routes never are). The person
  // lock is always taken before the reuseActive lock, so the two never deadlock.
  await client.query('BEGIN');
  try {
    if (maxQueuedForRequester !== null) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('job-queue-cap:' || $1, 0))", [requestedBy]);
    }
    const job = await insert();
    await client.query('COMMIT');
    return job;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** How many of this person's jobs are waiting to run. */
export async function queuedJobCount(client, { requestedBy }) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM job WHERE requested_by = $1 AND status = 'queued'`,
    [requestedBy],
  );
  return rows[0].n;
}

export async function claimNext(client, { workerId, eventSink = createEventSink() }) {
  const { rows } = await client.query(
    `UPDATE job
     SET status = 'running', started_at = now(), heartbeat_at = now(), worker_id = $1
     WHERE id = (
       SELECT id FROM job
       WHERE status = 'queued' AND not_before <= now()
       ORDER BY priority DESC, created_at
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

// Withdraws a job that has not started. Only a queued job can be cancelled: a running one
// belongs to a live worker, and a finished one is history. The reason is kept in `error`
// so the job list shows who cancelled it and why.
export async function cancelQueued(client, { id, reason, eventSink = createEventSink() }) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new TypeError('a cancel reason is required');
  }
  const { rows } = await client.query(
    `UPDATE job
     SET status = 'cancelled', error = $2, finished_at = now(), heartbeat_at = NULL
     WHERE id = $1 AND status = 'queued'
     RETURNING *, started_at::text AS event_started_at`,
    [id, `cancelled: ${reason.trim()}`],
  );
  if (rows[0]) emitJobEvent(rows[0], 'job.cancelled', eventSink);
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

// kinds narrows the list in the query, so a page about one kind (restores) never loses
// its rows to a busier kind (scheduled backups) crowding the newest-N window.
// statuses narrows the same way, so "every failed job" is found past the newest-N window
// of jobs that finished.
/**
 * @param {any} client
 * @param {{ limit?: number, kinds?: string[] | null, statuses?: string[] | null }} [options]
 */
export async function listJobs(client, { limit = 50, kinds = null, statuses = null } = {}) {
  const { rows } = await client.query(
    `SELECT *, started_at::text AS event_started_at FROM job
      WHERE ($2::text[] IS NULL OR kind = ANY($2))
        AND ($3::text[] IS NULL OR status = ANY($3))
      ORDER BY created_at DESC LIMIT $1`,
    [limit, kinds, statuses],
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
