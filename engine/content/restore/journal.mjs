/**
 * The content restore journal (Wave 2 MAILR; tables in
 * engine/store/schema.d/72-content-restore.sql). Mail restore writes it and file restore
 * (FILER) uses the same shape. A run's id is its plan digest, so asking for the same
 * restore again opens the same run and resumes it: what was restored or deliberately
 * left alone is never written again.
 *
 * Two implementations with one shape:
 *   openRun({ id, tenantRef, workload, plan, label, requestedBy, approvedBy }) -> run
 *     (the existing run when that id was opened before; its label is kept)
 *   entry(runId, sourceKey) -> { sourceKey, kind, status, targetId, reason, attempts } | null
 *   mark(runId, sourceKey, { kind, status, targetId, reason }) -> entry
 *     status 'pending' counts an attempt; a later mark keeps the count.
 *   entries(runId) -> every entry of the run, in source key order
 *   finishRun(runId, { status, report })
 */
export const ENTRY_STATUSES = Object.freeze(['pending', 'restored', 'skipped', 'failed']);
export const RUN_STATUSES = Object.freeze(['running', 'completed', 'partial', 'failed']);

function requireText(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`the content restore journal needs a ${name}`);
}

function checkMark(runId, sourceKey, { kind, status }) {
  requireText(runId, 'run id');
  requireText(sourceKey, 'source key');
  requireText(kind, 'kind');
  if (!ENTRY_STATUSES.includes(status)) throw new TypeError(`entry status must be one of ${ENTRY_STATUSES.join(', ')}`);
}

function checkRun({ id, tenantRef, workload, plan, label }) {
  requireText(id, 'run id');
  requireText(tenantRef, 'tenantRef');
  requireText(workload, 'workload');
  requireText(label, 'label');
  if (!plan || typeof plan !== 'object') throw new TypeError('the content restore journal needs the plan');
}

const fromEntry = (row) => (row ? {
  sourceKey: row.source_key, kind: row.kind, status: row.status, targetId: row.target_id, reason: row.reason, attempts: row.attempts,
} : null);

const fromRun = (row) => (row ? {
  id: row.id, tenantRef: row.tenant_ref, workload: row.workload, plan: row.plan, label: row.label,
  requestedBy: row.requested_by, approvedBy: row.approved_by, status: row.status, report: row.report,
} : null);

/** The Postgres journal. `client` is a pg client or pool on a database with the full schema. */
export function createPgRestoreJournal(client) {
  if (typeof client?.query !== 'function') throw new TypeError('the content restore journal needs a database client');
  return Object.freeze({
    async openRun(run) {
      checkRun(run);
      await client.query(
        `INSERT INTO content_restore_run (id, tenant_ref, workload, plan, label, requested_by, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [run.id, run.tenantRef, run.workload, JSON.stringify(run.plan), run.label, run.requestedBy ?? null, run.approvedBy ?? null],
      );
      // A resumed run is running again, whatever the last attempt ended as.
      const { rows } = await client.query(
        `UPDATE content_restore_run SET status = 'running', updated_at = now() WHERE id = $1 RETURNING *`,
        [run.id],
      );
      const held = fromRun(rows[0]);
      if (held.tenantRef !== run.tenantRef || held.workload !== run.workload) throw new Error(`restore run ${run.id} belongs to another tenant or workload`);
      return held;
    },
    async entry(runId, sourceKey) {
      const { rows } = await client.query('SELECT * FROM content_restore_entry WHERE run_id = $1 AND source_key = $2', [runId, sourceKey]);
      return fromEntry(rows[0]);
    },
    async mark(runId, sourceKey, { kind, status, targetId = null, reason = null }) {
      checkMark(runId, sourceKey, { kind, status });
      const { rows } = await client.query(
        `INSERT INTO content_restore_entry (run_id, source_key, kind, status, target_id, reason, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 = 'pending' THEN 1 ELSE 0 END)
         ON CONFLICT (run_id, source_key) DO UPDATE SET
           kind = EXCLUDED.kind, status = EXCLUDED.status,
           target_id = COALESCE(EXCLUDED.target_id, content_restore_entry.target_id), reason = EXCLUDED.reason,
           attempts = content_restore_entry.attempts + CASE WHEN EXCLUDED.status = 'pending' THEN 1 ELSE 0 END,
           updated_at = now()
         RETURNING *`,
        [runId, sourceKey, kind, status, targetId, reason],
      );
      return fromEntry(rows[0]);
    },
    async entries(runId) {
      const { rows } = await client.query('SELECT * FROM content_restore_entry WHERE run_id = $1 ORDER BY source_key', [runId]);
      return rows.map(fromEntry);
    },
    async finishRun(runId, { status, report = null }) {
      if (!RUN_STATUSES.includes(status)) throw new TypeError(`run status must be one of ${RUN_STATUSES.join(', ')}`);
      await client.query(
        'UPDATE content_restore_run SET status = $2, report = $3, updated_at = now() WHERE id = $1',
        [runId, status, report === null ? null : JSON.stringify(report)],
      );
    },
  });
}

/** The same journal in memory, for fixtures. */
export function createMemoryRestoreJournal() {
  const runs = new Map();
  const rows = new Map();
  const keyOf = (runId, sourceKey) => JSON.stringify([runId, sourceKey]);
  return Object.freeze({
    runs,
    rows,
    async openRun(run) {
      checkRun(run);
      if (!runs.has(run.id)) {
        runs.set(run.id, {
          id: run.id, tenantRef: run.tenantRef, workload: run.workload, plan: structuredClone(run.plan), label: run.label,
          requestedBy: run.requestedBy ?? null, approvedBy: run.approvedBy ?? null, status: 'running', report: null,
        });
      }
      const held = runs.get(run.id);
      if (held.tenantRef !== run.tenantRef || held.workload !== run.workload) throw new Error(`restore run ${run.id} belongs to another tenant or workload`);
      held.status = 'running';
      return structuredClone(held);
    },
    async entry(runId, sourceKey) {
      const row = rows.get(keyOf(runId, sourceKey));
      return row ? { ...row } : null;
    },
    async mark(runId, sourceKey, { kind, status, targetId = null, reason = null }) {
      checkMark(runId, sourceKey, { kind, status });
      if (!runs.has(runId)) throw new Error(`no restore run ${runId}`);
      const held = rows.get(keyOf(runId, sourceKey));
      const row = {
        sourceKey, kind, status, targetId: targetId ?? held?.targetId ?? null, reason,
        attempts: (held?.attempts ?? 0) + (status === 'pending' ? 1 : 0),
      };
      rows.set(keyOf(runId, sourceKey), row);
      return { ...row };
    },
    async entries(runId) {
      return [...rows.entries()]
        .filter(([key]) => JSON.parse(key)[0] === runId)
        .map(([, row]) => ({ ...row }))
        .sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));
    },
    async finishRun(runId, { status, report = null }) {
      if (!RUN_STATUSES.includes(status)) throw new TypeError(`run status must be one of ${RUN_STATUSES.join(', ')}`);
      const run = runs.get(runId);
      if (!run) throw new Error(`no restore run ${runId}`);
      Object.assign(run, { status, report: report === null ? null : structuredClone(report) });
    },
  });
}
