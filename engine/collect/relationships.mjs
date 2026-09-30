/**
 * Task 57: first-class relationship (edge) observations.
 *
 * Group members and owners are collected as SEPARATE paginated child reads —
 * a parent payload never proves its edges (the group $select carries no
 * membership, and a `members` field smuggled into a parent is ignored). Each
 * child read yields one observation with its own outcome vocabulary shared
 * with the per-type digest (complete / complete-empty / partial / failed),
 * pagination evidence, endpoint/API version and window. Edge types are kept
 * apart: `member` and `owner` are direct edges; `transitiveMember` is a
 * derived (nested/dynamic-expanded) result and is never merged into the
 * direct set.
 *
 * Persistence and read-back keep three guarantees:
 *  - a failed or partial child read is never an empty edge set: the last
 *    complete set stays visible, labeled stale, and never authorizes removal;
 *  - an edge whose target was not collected in this run is kept (target
 *    identity unresolved), never dropped;
 *  - every row is tenant-qualified, and an observation carrying another
 *    tenant's ref is rejected before anything is written.
 */
import { redactSecrets } from '../../tools/tenant-probe/graph.mjs';

export const RELATIONSHIP_FAMILIES = Object.freeze({
  member: Object.freeze({
    family: 'member', edgeType: 'member', direction: 'direct', parentType: 'group', version: 'v1.0',
    pathFor: (id) => `/groups/${encodeURIComponent(id)}/members?$select=id`,
  }),
  owner: Object.freeze({
    family: 'owner', edgeType: 'owner', direction: 'direct', parentType: 'group', version: 'v1.0',
    pathFor: (id) => `/groups/${encodeURIComponent(id)}/owners?$select=id`,
  }),
  transitiveMember: Object.freeze({
    family: 'transitiveMember', edgeType: 'transitiveMember', direction: 'transitive', parentType: 'group', version: 'v1.0',
    pathFor: (id) => `/groups/${encodeURIComponent(id)}/transitiveMembers?$select=id`,
  }),
});

/** Direct families only by default; the derived transitive read is opt-in. */
export const DEFAULT_RELATIONSHIP_FAMILIES = Object.freeze(['member', 'owner']);

export class CrossTenantRelationshipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CrossTenantRelationshipError';
  }
}

const normalizeId = (id) => (typeof id === 'string' && id.length > 0 ? id.toLowerCase() : null);

function targetTypeOf(item) {
  const odata = item?.['@odata.type'];
  return typeof odata === 'string' ? odata.replace(/^#?microsoft\.graph\./, '') : null;
}

function classify(result) {
  const items = Array.isArray(result?.items) ? result.items : null;
  const pages = Number.isSafeInteger(result?.pages) ? result.pages : null;
  const status = Number.isInteger(result?.status) ? result.status : null;
  const targets = new Map();
  let malformed = 0;
  for (const item of items ?? []) {
    const id = normalizeId(item?.id);
    if (!id) { malformed += 1; continue; }
    if (!targets.has(id)) targets.set(id, { targetId: id, targetType: targetTypeOf(item) });
  }
  const targetList = [...targets.values()];
  if (result?.error) {
    const partial = (pages ?? 0) > 0 || targetList.length > 0;
    return {
      outcome: partial ? 'partial' : 'failed',
      targets: partial ? targetList : [],
      itemCount: partial ? targetList.length : null,
      pagesCompleted: pages,
      httpStatus: Number.isInteger(result.error?.status) ? result.error.status : null,
      graphCode: typeof result.error?.code === 'string' ? result.error.code : null,
      error: redactSecrets(result.error?.error ?? result.error?.message ?? `HTTP ${result.error?.status ?? 'unknown'}`),
    };
  }
  if (result?.capped === true) {
    return { outcome: 'partial', targets: targetList, itemCount: targetList.length, pagesCompleted: pages, httpStatus: status, graphCode: null, error: 'pagination incomplete' };
  }
  if (!items) {
    return { outcome: 'failed', targets: [], itemCount: null, pagesCompleted: pages, httpStatus: status, graphCode: null, error: 'missing items' };
  }
  if (malformed > 0) {
    // An item with no usable id cannot be an edge; the enumeration cannot be
    // called complete when part of it could not be read.
    return { outcome: 'partial', targets: targetList, itemCount: targetList.length, pagesCompleted: pages, httpStatus: status, graphCode: null, error: `${malformed} item(s) without an id` };
  }
  return {
    outcome: targetList.length === 0 ? 'complete-empty' : 'complete',
    targets: targetList, itemCount: targetList.length, pagesCompleted: pages, httpStatus: status, graphCode: null, error: null,
  };
}

/**
 * Read the child edge collections for each parent. `parents` are
 * { sourceId, naturalKey } group records from a successful type enumeration.
 * The reader is the same injected Graph reader collection uses; a thrown read
 * is recorded as a failed observation, never propagated as an empty set.
 */
export async function collectRelationships(reader, { tenantRef, parents, families = DEFAULT_RELATIONSHIP_FAMILIES, pageCap = Infinity } = {}) {
  if (typeof tenantRef !== 'string' || tenantRef.length === 0) throw new Error('collectRelationships requires tenantRef');
  const selected = families.map((name) => {
    const spec = RELATIONSHIP_FAMILIES[name];
    if (!spec) throw new Error(`unknown relationship family ${name}`);
    return spec;
  });
  const observations = [];
  for (const parent of parents ?? []) {
    const parentSourceId = normalizeId(parent?.sourceId);
    if (!parentSourceId) continue;
    for (const spec of selected) {
      const endpoint = spec.pathFor(parent.sourceId);
      const startedAt = new Date();
      let result;
      try {
        result = await reader.collect(spec.version, endpoint, { pageCap });
      } catch (error) {
        result = { items: undefined, error: { error: error?.message ?? String(error) } };
      }
      const completedAt = new Date();
      observations.push({
        tenantRef,
        parentType: spec.parentType,
        parentSourceId,
        parentNaturalKey: parent.naturalKey ?? null,
        family: spec.family,
        edgeType: spec.edgeType,
        direction: spec.direction,
        endpoint,
        apiVersion: spec.version,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        ...classify(result),
      });
    }
  }
  return observations;
}

/**
 * Persist observations under a snapshot. Rejects (before any write) an
 * observation for another tenant and a snapshot that is not this tenant's.
 * `context` (task-48's Map<lowercase id, { symbol, type }>) only resolves the
 * TARGET's natural key for display; an unresolved target keeps the edge.
 */
export async function recordRelationships(client, { snapshotId, tenantRef, observations, context }) {
  const { rows } = await client.query(`SELECT tenant_ref FROM snapshot WHERE id = $1`, [snapshotId]);
  if (rows.length === 0 || rows[0].tenant_ref !== tenantRef) {
    throw new CrossTenantRelationshipError('snapshot does not belong to this tenant');
  }
  for (const obs of observations) {
    if (obs.tenantRef !== tenantRef) {
      throw new CrossTenantRelationshipError(`relationship observation for ${obs.parentSourceId} carries another tenant`);
    }
  }
  let sets = 0;
  let edges = 0;
  for (const obs of observations) {
    const set = await client.query(
      `INSERT INTO relationship_edge_set
         (snapshot_id, tenant_ref, parent_type, parent_source_id, parent_natural_key, family, edge_type, direction,
          outcome, item_count, pages_completed, endpoint, api_version, started_at, completed_at, http_status, graph_code, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [snapshotId, tenantRef, obs.parentType, obs.parentSourceId, obs.parentNaturalKey, obs.family, obs.edgeType, obs.direction,
        obs.outcome, obs.itemCount, obs.pagesCompleted, obs.endpoint, obs.apiVersion, obs.startedAt, obs.completedAt,
        obs.httpStatus, obs.graphCode, obs.error],
    );
    sets += 1;
    for (const target of obs.targets) {
      const resolved = context?.get(target.targetId) ?? null;
      await client.query(
        `INSERT INTO relationship_edge (set_id, tenant_ref, target_source_id, target_type, target_natural_key)
         VALUES ($1,$2,$3,$4,$5)`,
        [set.rows[0].id, tenantRef, target.targetId, target.targetType ?? resolved?.type ?? null, resolved?.symbol ?? null],
      );
      edges += 1;
    }
  }
  return { sets, edges };
}

const isComplete = (outcome) => outcome === 'complete' || outcome === 'complete-empty';

/**
 * Current edge state per (parent, family) for one tenant, from completed
 * snapshots only. `state`:
 *   current — the newest read was complete; targets are authoritative
 *   stale   — the newest read failed/was partial; targets are the LAST
 *             complete read (labeled with when), never authority to remove
 *   unknown — no complete read has ever existed; targets is null
 */
export async function loadRelationshipState(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT s.id, s.parent_type, s.parent_source_id, s.parent_natural_key, s.family, s.edge_type, s.direction,
            s.outcome, s.completed_at, s.snapshot_id, s.graph_code, s.http_status, s.error, s.pages_completed, s.item_count,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('targetId', e.target_source_id, 'targetType', e.target_type,
                                                            'targetNaturalKey', e.target_natural_key)
                                       ORDER BY e.target_source_id)
                        FROM relationship_edge e WHERE e.set_id = s.id AND e.tenant_ref = $1), '[]'::jsonb) AS targets
       FROM relationship_edge_set s
       JOIN snapshot sn ON sn.id = s.snapshot_id
      WHERE s.tenant_ref = $1 AND sn.tenant_ref = $1 AND sn.status = 'complete'
      ORDER BY s.completed_at DESC NULLS LAST, s.id DESC`,
    [tenantRef],
  );
  const entries = new Map();
  for (const row of rows) {
    const key = `${row.parent_type}:${row.parent_source_id}|${row.family}`;
    const existing = entries.get(key);
    const base = {
      parentType: row.parent_type, parentSourceId: row.parent_source_id, parentNaturalKey: row.parent_natural_key,
      family: row.family, edgeType: row.edge_type, direction: row.direction,
    };
    if (!existing) {
      if (isComplete(row.outcome)) {
        entries.set(key, { ...base, state: 'current', latestOutcome: row.outcome, observedAt: row.completed_at, snapshotId: row.snapshot_id, targets: row.targets, failure: null });
      } else {
        entries.set(key, {
          ...base, state: 'unknown', latestOutcome: row.outcome, observedAt: null, snapshotId: null, targets: null,
          failure: { outcome: row.outcome, graphCode: row.graph_code, httpStatus: row.http_status, error: row.error, at: row.completed_at },
        });
      }
    } else if (existing.state === 'unknown' && isComplete(row.outcome)) {
      // Newest read failed but an older complete read exists: last-known, stale.
      entries.set(key, { ...existing, state: 'stale', observedAt: row.completed_at, snapshotId: row.snapshot_id, targets: row.targets });
    }
  }
  return { tenantRef, entries };
}

/** Compact per-parent completeness for reports: never claims more than observed. */
export function summarizeRelationshipState(state) {
  const families = {};
  for (const entry of state.entries.values()) {
    const bucket = (families[entry.family] ??= { current: 0, stale: 0, unknown: 0 });
    bucket[entry.state] += 1;
  }
  return families;
}
