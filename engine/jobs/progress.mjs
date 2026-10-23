// Live progress on a running job (Job page). The worker passes the job's id to the child
// process as KEEL_JOB_ID; the child writes what it is reading onto that job's `progress`
// column so the portal can show it while the job runs. Without a job id (a timer or an
// operator run) nothing is written. A failed write never changes the run.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A writer that stores { types, updatedAt } on the running job, or undefined without a job id. */
export function progressWriter(client, jobId) {
  if (typeof jobId !== 'string' || !UUID.test(jobId)) return undefined;
  return async (types) => {
    await client.query(
      `UPDATE job SET progress = $2 WHERE id = $1 AND status = 'running'`,
      [jobId, JSON.stringify({ types, updatedAt: new Date().toISOString() })],
    );
  };
}

// The items a partial content workload could not read, as the Job page lists them: at
// most this many, each cut to this length. The full list stays in the run's log.
export const MAX_LISTED_REASONS = 50;
export const MAX_REASON_LENGTH = 300;

/** A run's reasons as a short list for the job's result and progress. */
export function listedReasons(reasons) {
  if (!Array.isArray(reasons)) return [];
  return reasons.slice(0, MAX_LISTED_REASONS).map((reason) => (typeof reason === 'string' ? reason : JSON.stringify(reason)).slice(0, MAX_REASON_LENGTH));
}

/** A short error line from a run's reasons: never a payload, at most 500 characters. */
export function reasonsLine(reasons) {
  if (!Array.isArray(reasons) || !reasons.length) return null;
  return reasons.map((reason) => (typeof reason === 'string' ? reason : JSON.stringify(reason))).join('\n').slice(0, 500);
}

/**
 * Tracks one job's items (service workloads or content workloads) as waiting, then
 * reading, then their outcome, and reports the whole picture after each change.
 * `write` is a progressWriter result or undefined; reports are best effort.
 */
export function progressTracker(keys, write, now = () => new Date()) {
  const types = Object.fromEntries(keys.map((key) => [key, { outcome: 'waiting' }]));
  const report = async () => {
    if (typeof write !== 'function') return;
    try { await write({ ...types }); } catch { /* progress is best effort */ }
  };
  return {
    enabled: typeof write === 'function',
    start: report,
    async reading(key, startedAt = now()) {
      types[key] = { outcome: 'reading', startedAt: startedAt.toISOString() };
      await report();
    },
    async done(key, { outcome, itemCount = null, startedAt, completedAt = now(), error = null, reasons = null }) {
      types[key] = {
        outcome,
        itemCount: Number.isSafeInteger(itemCount) ? itemCount : null,
        startedAt: startedAt ? new Date(startedAt).toISOString() : types[key]?.startedAt ?? null,
        completedAt: new Date(completedAt).toISOString(),
        httpStatus: null,
        error: typeof error === 'string' ? error.slice(0, 500) : null,
        // Content workloads: each item not read (at most 50, each cut to 300 characters),
        // and how many there were, so the Job page can list them.
        ...(Array.isArray(reasons) && reasons.length ? {
          reasons: listedReasons(reasons),
          reasonCount: reasons.length,
        } : {}),
      };
      await report();
    },
  };
}
