// engine/govern/references.mjs
//
// Roadmap task-130 (portal experience contract, "References resolve to names"): the
// one place a page's cross-object identifiers become names. Callers collect every id
// a page shows, then resolve each kind in ONE tenant-scoped query (never one per row).
// An id that does not resolve is returned as unreadable — never silently dropped,
// never shown as a bare id: the portal renders it as "<kind> <short id> (no longer
// readable)".

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

export function unreadable(kind, id) {
  return { kind, id, name: null, readable: false };
}

/**
 * People by principal id. A requester that is not a principal id (a system actor such
 * as "scheduler" or "policy-automation") is named by its own value.
 * @returns {Promise<Map<string, { kind: 'person', id: string, name: string | null, email: string | null, readable: boolean, system: boolean }>>}
 */
export async function resolvePrincipals(client, ids) {
  const wanted = unique(ids);
  const result = new Map();
  const uuids = wanted.filter((id) => UUID.test(id));
  if (uuids.length) {
    const { rows } = await client.query(
      'SELECT id::text AS id, email, display_name, system_kind FROM principal WHERE id::text = ANY($1::text[])',
      [uuids],
    );
    for (const row of rows) {
      result.set(row.id, {
        kind: 'person', id: row.id, name: row.display_name ?? row.email, email: row.email,
        readable: true, system: row.system_kind != null,
      });
    }
  }
  for (const id of wanted) {
    if (result.has(id)) continue;
    result.set(id, UUID.test(id)
      ? { ...unreadable('person', id), email: null, system: false }
      : { kind: 'person', id, name: id, email: null, readable: true, system: true });
  }
  return result;
}

/** Baselines by id, scoped to the tenant. */
export async function resolveBaselines(client, { tenantRef, ids }) {
  const wanted = unique(ids).filter((id) => UUID.test(id));
  const result = new Map();
  if (wanted.length) {
    const { rows } = await client.query(
      `SELECT id::text AS id, label, set_at, active FROM baseline WHERE tenant_ref = $1 AND id::text = ANY($2::text[])`,
      [tenantRef, wanted],
    );
    for (const row of rows) {
      result.set(row.id, { kind: 'baseline', id: row.id, name: row.label, setAt: row.set_at, active: row.active, readable: true });
    }
  }
  for (const id of unique(ids)) if (!result.has(id)) result.set(id, unreadable('baseline', id));
  return result;
}

/**
 * Restore dry runs (plans) by artifact id, scoped to the tenant: when the snapshot
 * was taken, how many resources the plan covers, whether it is an undo, its status,
 * and the job that computed it (the page a reviewer opens).
 */
export async function resolveDryRuns(client, { tenantRef, ids }) {
  const wanted = unique(ids).filter((id) => UUID.test(id));
  const result = new Map();
  if (wanted.length) {
    const { rows } = await client.query(
      `SELECT d.id::text AS id, d.status, d.compensation IS NOT NULL AS is_undo,
              jsonb_array_length(d.closure_keys) AS resources, s.completed_at AS snapshot_at,
              (SELECT j.id::text FROM job j
                WHERE j.kind = 'restore' AND j.params->>'artifactId' = d.id::text
                  AND (j.params->>'mode') IS NULL
                ORDER BY j.created_at DESC LIMIT 1) AS dry_run_job_id
         FROM restore_dry_run d JOIN snapshot s ON s.id = d.snapshot_id
        WHERE d.tenant_ref = $1 AND d.id::text = ANY($2::text[])`,
      [tenantRef, wanted],
    );
    for (const row of rows) {
      result.set(row.id, {
        kind: 'dry-run', id: row.id, name: null, readable: true, status: row.status, undo: row.is_undo,
        resources: Number(row.resources), snapshotAt: row.snapshot_at, dryRunJobId: row.dry_run_job_id,
      });
    }
  }
  for (const id of unique(ids)) if (!result.has(id)) result.set(id, unreadable('dry-run', id));
  return result;
}

/** Open or closed drift records by id, scoped to the tenant: the resource and its impact. */
export async function resolveDrifts(client, { tenantRef, ids }) {
  const wanted = unique(ids).filter((id) => UUID.test(id));
  const result = new Map();
  if (wanted.length) {
    const { rows } = await client.query(
      `SELECT id::text AS id, natural_key, resource_type, change_type, blast_radius
         FROM drift WHERE tenant_ref = $1 AND id::text = ANY($2::text[])`,
      [tenantRef, wanted],
    );
    for (const row of rows) {
      result.set(row.id, {
        kind: 'change', id: row.id, name: null, readable: true, naturalKey: row.natural_key,
        resourceType: row.resource_type, changeType: row.change_type, blastRadius: row.blast_radius,
      });
    }
  }
  for (const id of unique(ids)) if (!result.has(id)) result.set(id, unreadable('change', id));
  return result;
}

/** The ids a request or job's params point at, by kind. */
export function referencedIds(params) {
  const p = params && typeof params === 'object' ? params : {};
  return {
    baselines: typeof p.baselineId === 'string' ? [p.baselineId] : [],
    dryRuns: [p.artifactId, p.compensates].filter((id) => typeof id === 'string'),
    drifts: Array.isArray(p.driftIds) ? p.driftIds.filter((id) => typeof id === 'string') : [],
    snapshots: typeof p.snapshotId === 'string' ? [p.snapshotId] : [],
  };
}

/** Snapshots by id, scoped to the tenant: when each was taken. */
export async function resolveSnapshots(client, { tenantRef, ids }) {
  const wanted = unique(ids).filter((id) => UUID.test(id));
  const result = new Map();
  if (wanted.length) {
    const { rows } = await client.query(
      `SELECT id::text AS id, started_at, completed_at FROM snapshot WHERE tenant_ref = $1 AND id::text = ANY($2::text[])`,
      [tenantRef, wanted],
    );
    for (const row of rows) {
      result.set(row.id, { kind: 'snapshot', id: row.id, name: null, readable: true, takenAt: row.completed_at ?? row.started_at });
    }
  }
  for (const id of unique(ids)) if (!result.has(id)) result.set(id, unreadable('snapshot', id));
  return result;
}

/**
 * Resolve every reference in a list of { params, requested_by, decided_by } rows: one
 * query per kind for the whole list. Returns per-row `references`.
 */
export async function resolveRowReferences(client, { tenantRef, rows, people = ['requested_by'] }) {
  const ids = rows.map((row) => referencedIds(row.params));
  // Sequential: one client runs one query at a time.
  const principals = await resolvePrincipals(client, rows.flatMap((row) => people.map((field) => row[field])));
  const baselines = await resolveBaselines(client, { tenantRef, ids: ids.flatMap((entry) => entry.baselines) });
  const dryRuns = await resolveDryRuns(client, { tenantRef, ids: ids.flatMap((entry) => entry.dryRuns) });
  const drifts = await resolveDrifts(client, { tenantRef, ids: ids.flatMap((entry) => entry.drifts) });
  const snapshots = await resolveSnapshots(client, { tenantRef, ids: ids.flatMap((entry) => entry.snapshots) });
  return rows.map((row, index) => ({
    ...row,
    references: {
      people: Object.fromEntries(people.filter((field) => row[field]).map((field) => [field, principals.get(row[field])])),
      baseline: ids[index].baselines.map((id) => baselines.get(id))[0] ?? null,
      plan: typeof row.params?.artifactId === 'string' ? dryRuns.get(row.params.artifactId) : null,
      undoes: typeof row.params?.compensates === 'string' ? dryRuns.get(row.params.compensates) : null,
      changes: ids[index].drifts.map((id) => drifts.get(id)),
      snapshot: ids[index].snapshots.map((id) => snapshots.get(id))[0] ?? null,
    },
  }));
}
