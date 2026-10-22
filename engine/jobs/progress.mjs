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
    async done(key, { outcome, itemCount = null, startedAt, completedAt = now(), error = null }) {
      types[key] = {
        outcome,
        itemCount: Number.isSafeInteger(itemCount) ? itemCount : null,
        startedAt: startedAt ? new Date(startedAt).toISOString() : types[key]?.startedAt ?? null,
        completedAt: new Date(completedAt).toISOString(),
        httpStatus: null,
        error: typeof error === 'string' ? error.slice(0, 500) : null,
      };
      await report();
    },
  };
}
