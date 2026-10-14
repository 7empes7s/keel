/**
 * Wave 1 DISC: persist and read the discovery inventory
 * (engine/store/schema.d/10-discovery.sql).
 */
import { assertTenantRef } from '../store/tenantRef.mjs';

const ITEM_COLUMNS = ['run_id', 'source', 'name', 'kind', 'entity_type', 'status', 'catalog_types', 'objects', 'objects_exact',
  'http_status', 'reason', 'message', 'missing_grant', 'grant_source'];
const BATCH = 200;

/** Stores one run and its items in one transaction. Returns the run id. */
export async function saveDiscoveryRun(client, { tenantRef, run }) {
  assertTenantRef(tenantRef);
  await client.query('BEGIN');
  try {
    const { rows } = await client.query(
      `INSERT INTO discovery_run (tenant_ref, started_at, finished_at, sources, summary, catalogue)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantRef, run.startedAt, run.finishedAt, JSON.stringify(run.sources), JSON.stringify(run.summary), JSON.stringify(run.catalogue)],
    );
    const runId = rows[0].id;
    for (let start = 0; start < run.items.length; start += BATCH) {
      const slice = run.items.slice(start, start + BATCH);
      const values = [];
      const tuples = slice.map((item, index) => {
        values.push(runId, item.source, item.name, item.kind, item.entityType, item.status, item.catalogTypes, item.objects,
          item.objectsExact, item.httpStatus, item.reason, item.message, item.missingGrant, item.grantSource);
        const base = index * ITEM_COLUMNS.length;
        return `(${ITEM_COLUMNS.map((_, column) => `$${base + column + 1}`).join(', ')})`;
      });
      await client.query(`INSERT INTO discovery_item (${ITEM_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`, values);
    }
    await client.query('COMMIT');
    return runId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

const itemFromRow = (row) => ({
  source: row.source, name: row.name, kind: row.kind, entityType: row.entity_type, status: row.status,
  catalogTypes: row.catalog_types ?? [], objects: row.objects, objectsExact: row.objects_exact, httpStatus: row.http_status,
  reason: row.reason, message: row.message, missingGrant: row.missing_grant, grantSource: row.grant_source,
});

/**
 * The latest run for a tenant with its items, or null when discovery never ran.
 * `statuses` limits the items returned (the run's summary always covers all of them).
 *
 * @param {{ query: Function }} client
 * @param {{ tenantRef: string, statuses?: string[] | null }} options
 */
export async function loadLatestDiscovery(client, { tenantRef, statuses = null }) {
  assertTenantRef(tenantRef);
  const { rows } = await client.query(
    `SELECT id, started_at, finished_at, sources, summary, catalogue FROM discovery_run
      WHERE tenant_ref = $1 ORDER BY finished_at DESC, id DESC LIMIT 1`,
    [tenantRef],
  );
  if (!rows.length) return null;
  const run = rows[0];
  const items = await client.query(
    `SELECT * FROM discovery_item WHERE run_id = $1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))
      ORDER BY source, name`,
    [run.id, statuses],
  );
  return {
    id: String(run.id),
    startedAt: new Date(run.started_at).toISOString(),
    finishedAt: new Date(run.finished_at).toISOString(),
    sources: run.sources, summary: run.summary, catalogue: run.catalogue,
    items: items.rows.map(itemFromRow),
  };
}
