import { enqueue, fail } from '../jobs/queue.mjs';

export function snapshotHasFullCoverage(snapshot) {
  const digest = snapshot?.coverage_digest;
  // Current collectors explicitly mark out-of-tier types as not-requested.
  // Require at least one successful read, and no failed/partial/unknown entry.
  return snapshot?.status === 'complete' && digest && typeof digest === 'object'
    && !Array.isArray(digest) && Object.keys(digest).length > 0
    && Object.values(digest).some((entry) => ['complete', 'complete-empty'].includes(entry?.outcome))
    && Object.values(digest).every((entry) => ['complete', 'complete-empty', 'not-requested'].includes(entry?.outcome));
}

// Scan terminal collect jobs, including exit-1 partial collections. The collection CLI
// prints its persisted snapshot ID before reporting coverage failures. Never guess latest.
export async function processCollectionCompletions(client, requestedBy) {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query(
      `SELECT * FROM job WHERE kind = 'collect' AND status IN ('succeeded', 'failed')
       AND NOT (COALESCE(result, '{}'::jsonb) ? 'driftTrigger')
       ORDER BY finished_at, id FOR UPDATE SKIP LOCKED`,
    );
    for (const job of rows) {
      const snapshotId = job.result?.snapshotId
        ?? /snapshot ([0-9a-f-]{36}) complete/i.exec(job.result?.stdout ?? job.error ?? '')?.[1];
      const snapshot = snapshotId ? (await client.query('SELECT * FROM snapshot WHERE id = $1', [snapshotId])).rows[0] : null;
      const ready = snapshotHasFullCoverage(snapshot)
        && (!job.params.tenantRef || snapshot.tenant_ref === job.params.tenantRef);
      const tenantRef = snapshot?.tenant_ref ?? job.params.tenantRef;
      const driftJob = await enqueue(client, {
        kind: 'drift-detect', requestedBy,
        params: { snapshotId, tenantRef, sourceCollectionId: job.id },
        idempotencyKey: `collect-completion:${job.id}`,
        // Deferred jobs must not be claimable between admission and failure recording.
        ...(ready ? {} : { notBefore: '9999-01-01T00:00:00Z' }),
      });
      const error = ready ? null : 'drift-detect deferred: collection snapshot has failed or missing per-type coverage; retry on next successful collect';
      if (!ready) await fail(client, { id: driftJob.id, error });
      await client.query(
        `UPDATE job SET result = COALESCE(result, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [job.id, JSON.stringify({ driftTrigger: { status: ready ? 'queued' : 'deferred', jobId: driftJob.id, error } })],
      );
      if (ready) await client.query(
        `UPDATE job SET result = COALESCE(result, '{}'::jsonb) || $2::jsonb
         WHERE kind = 'drift-detect' AND status = 'failed'
         AND error LIKE 'drift-detect deferred:%' AND params->>'tenantRef' = $1
         AND NOT (COALESCE(result, '{}'::jsonb) ? 'retriedByJobId')`,
        [tenantRef, JSON.stringify({ retriedByJobId: driftJob.id })],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
