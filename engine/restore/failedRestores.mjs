/**
 * Failed restores: one definition, counted once, for every page that shows it.
 *
 * A failed restore is an enforced restore job (it was sent to write, not a check)
 * of this tenant's restore plan that ended `failed`. Undo runs are restores too and
 * are counted. Cancelled jobs were stopped by someone and are not failures. Checks
 * (dry runs) never count.
 *
 * The count and the list use the same WHERE clause, so the list a page links to
 * always holds the rows the number counts.
 */
import { assertTenantRef } from '../store/tenantRef.mjs';

/** Days in the "recent" window every page shows next to the all-time total. */
export const FAILED_RESTORE_RECENT_DAYS = 30;

/** Where the list of failed restores lives in the portal. */
export const FAILED_RESTORES_HREF = '/restore?jobs=failed#restore-jobs-heading';

const DAY_MS = 24 * 60 * 60 * 1000;

const FAILED_RESTORE_WHERE = `
      j.kind = 'restore' AND j.status = 'failed' AND rd.tenant_ref = $1
  AND (j.params ->> 'mode' = 'enforce'
       OR (j.params ? 'artifactId' AND (SELECT count(*) FROM jsonb_object_keys(j.params)) = 1))`;

const FAILED_RESTORE_FROM = `
       FROM job j
       JOIN restore_dry_run rd ON rd.id::text = j.params ->> 'artifactId'`;

function instant(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * How many restores failed: in all, in the last 30 days before `now`, and (when a
 * period is given) in that period. A job belongs to the moment it finished.
 *
 * @param {any} client
 * @param {{ tenantRef: string, now?: Date | string, from?: Date | string | null, to?: Date | string | null }} options
 */
export async function countFailedRestores(client, { tenantRef, now = new Date(), from = null, to = null }) {
  assertTenantRef(tenantRef);
  const end = instant(now) ?? new Date();
  const recentFrom = new Date(end.getTime() - FAILED_RESTORE_RECENT_DAYS * DAY_MS);
  const periodFrom = instant(from);
  const periodTo = instant(to) ?? end;
  const { rows: [row] } = await client.query(
    `SELECT count(*) FILTER (WHERE COALESCE(j.finished_at, j.created_at) <= $2)::int AS total,
            count(*) FILTER (WHERE COALESCE(j.finished_at, j.created_at) > $3
                               AND COALESCE(j.finished_at, j.created_at) <= $2)::int AS recent,
            count(*) FILTER (WHERE $4::timestamptz IS NOT NULL
                               AND COALESCE(j.finished_at, j.created_at) >= $4
                               AND COALESCE(j.finished_at, j.created_at) < $5)::int AS in_period,
            (array_agg(j.id::text ORDER BY COALESCE(j.finished_at, j.created_at) DESC, j.id DESC)
               FILTER (WHERE COALESCE(j.finished_at, j.created_at) <= $2))[1] AS newest_id,
            max(COALESCE(j.finished_at, j.created_at)) FILTER (WHERE COALESCE(j.finished_at, j.created_at) <= $2) AS newest_at
     ${FAILED_RESTORE_FROM}
      WHERE ${FAILED_RESTORE_WHERE}`,
    [tenantRef, end, recentFrom, periodFrom, periodTo],
  );
  return {
    total: row.total,
    recent: { days: FAILED_RESTORE_RECENT_DAYS, count: row.recent },
    period: periodFrom ? { from: periodFrom.toISOString(), to: periodTo.toISOString(), count: row.in_period } : null,
    newest: row.newest_id ? { jobId: row.newest_id, at: instant(row.newest_at).toISOString() } : null,
    href: FAILED_RESTORES_HREF,
  };
}

/**
 * The failed restores themselves, newest first: the list the count links to. The page
 * shows the first `limit` and takes its total from countFailedRestores.
 *
 * @param {any} client
 * @param {{ tenantRef: string, now?: Date | string, limit?: number }} options
 */
export async function listFailedRestores(client, { tenantRef, now = new Date(), limit = 25 }) {
  assertTenantRef(tenantRef);
  const end = instant(now) ?? new Date();
  const { rows } = await client.query(
    `SELECT j.*, j.started_at::text AS event_started_at
     ${FAILED_RESTORE_FROM}
      WHERE ${FAILED_RESTORE_WHERE} AND COALESCE(j.finished_at, j.created_at) <= $3
      ORDER BY COALESCE(j.finished_at, j.created_at) DESC, j.id DESC
      LIMIT $2`,
    [tenantRef, limit, end],
  );
  return rows;
}
