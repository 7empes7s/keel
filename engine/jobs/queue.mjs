// engine/jobs/queue.mjs
//
// The job queue backing long-running work triggered by the operator portal (§3.3,
// docs/superpowers/specs/2026-09-08-keel-operator-portal-design.md): a collection takes
// ~30s and a restore can take minutes to hours, so neither may run inside an HTTP request.
// The portal enqueues a `job` row; a `keel-worker` process claims and executes it.
//
// claimNext() MUST stay a single atomic statement — `UPDATE ... WHERE id = (SELECT ...
// FOR UPDATE SKIP LOCKED) RETURNING *`. Do not "optimize" this into a SELECT followed by
// an UPDATE; that reintroduces the exact race two workers claiming the same job.

export async function enqueue(client, { kind, params, requestedBy }) {
  const { rows } = await client.query(
    `INSERT INTO job (kind, params, requested_by)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [kind, params ?? {}, requestedBy],
  );
  return rows[0];
}

export async function claimNext(client, { workerId }) {
  const { rows } = await client.query(
    `UPDATE job
     SET status = 'running', started_at = now(), worker_id = $1
     WHERE id = (
       SELECT id FROM job
       WHERE status = 'queued'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [workerId],
  );
  return rows[0] ?? null;
}

export async function complete(client, { id, result }) {
  const { rows } = await client.query(
    `UPDATE job
     SET status = 'succeeded', result = $2, finished_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, result ?? null],
  );
  return rows[0] ?? null;
}

export async function fail(client, { id, error }) {
  const { rows } = await client.query(
    `UPDATE job
     SET status = 'failed', error = $2, finished_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, error ?? null],
  );
  return rows[0] ?? null;
}

export async function listJobs(client, { limit = 50 } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM job ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

// Crash recovery: a worker killed mid-job leaves that job stuck in 'running' forever.
// A worker calls this on startup to reclaim only jobs it previously owned (same
// worker_id) — never a job whose worker_id belongs to a different, still-live worker.
export async function resetOrphaned(client, { workerId }) {
  const { rows } = await client.query(
    `UPDATE job
     SET status = 'queued', started_at = NULL, worker_id = NULL
     WHERE status = 'running' AND worker_id = $1
     RETURNING *`,
    [workerId],
  );
  return rows;
}
