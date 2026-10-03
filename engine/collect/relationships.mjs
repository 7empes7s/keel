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
import { createHash } from 'node:crypto';
import { redactSecrets } from '../../tools/tenant-probe/graph.mjs';

/**
 * Family registry. Every family is EXPLICIT: endpoint, API version, page cap,
 * the Graph application permission a collector needs, and how an item becomes
 * an edge (`project`). Nothing is discovered or inferred from the tenant-probe
 * CATALOG; a parent type with no registered family is never read through a
 * generic endpoint. Permissions/paths below are declared (fixture-tested), not
 * live-qualified; `source` records where the declaration comes from.
 *
 * No family implies a write capability: these are read observations only.
 */
const DOCS = 'https://learn.microsoft.com/en-us/graph/api/overview?view=graph-rest-1.0';

const stripGraph = (odata) => (typeof odata === 'string' ? odata.replace(/^#?microsoft\.graph\./, '') : null);
const normalizeId = (id) => (typeof id === 'string' && id.length > 0 ? id.toLowerCase() : null);

function idProject(item) {
  const id = normalizeId(item?.id);
  return id ? { edgeKey: id, targetId: id, targetType: stripGraph(item?.['@odata.type']), attributes: null } : null;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// An application permission granted to a service principal: the edge is
// (resource API, appRoleId). createdDateTime is volatile and deliberately not
// part of the edge, so re-reading never manufactures drift.
function appRoleGrantProject(item) {
  const resourceId = normalizeId(item?.resourceId);
  const appRoleId = normalizeId(item?.appRoleId);
  if (!resourceId || !appRoleId) return null;
  return { edgeKey: `${resourceId}:${appRoleId}`, targetId: resourceId, targetType: 'servicePrincipal', attributes: null };
}

const ASSIGNMENT_KINDS = {
  groupAssignmentTarget: { kind: 'group', mode: 'include' },
  exclusionGroupAssignmentTarget: { kind: 'group', mode: 'exclude' },
  allLicensedUsersAssignmentTarget: { kind: 'allUsers', mode: 'include', constant: 'all-licensed-users' },
  allDevicesAssignmentTarget: { kind: 'allDevices', mode: 'include', constant: 'all-devices' },
};

// An Intune assignment. The EDGE is what it targets (kind + group/collection);
// the assignment FILTER, intent and settings are attributes of that edge, so
// a filter change is a modification of the same edge, not a lost and a new
// one. An unrecognized target type is kept with kind 'unknown' — never
// dropped — and an item with no target at all is malformed.
function assignmentProject(item) {
  const target = item?.target;
  if (!target || typeof target !== 'object') return null;
  const odata = stripGraph(target['@odata.type']) ?? 'unknown';
  const known = ASSIGNMENT_KINDS[odata] ?? null;
  const targetId = known?.constant ?? normalizeId(target.groupId) ?? normalizeId(target.collectionId) ?? `unknown:${odata}`;
  return {
    edgeKey: `${odata}|${targetId}`,
    targetId,
    targetType: known?.kind === 'group' ? 'group' : (known?.kind ?? 'unknown'),
    attributes: {
      targetType: odata,
      mode: known?.mode ?? 'unknown',
      filterId: target.deviceAndAppManagementAssignmentFilterId ?? null,
      filterType: target.deviceAndAppManagementAssignmentFilterType ?? null,
      intent: item.intent ?? null,
      settingsDigest: item.settings && typeof item.settings === 'object'
        ? createHash('sha256').update(stableStringify(item.settings)).digest('hex')
        : null,
    },
  };
}

const simple = (spec) => Object.freeze({ direction: 'direct', version: 'v1.0', source: DOCS, ...spec });

export const RELATIONSHIP_FAMILIES = Object.freeze({
  member: simple({
    family: 'member', edgeType: 'member', parentType: 'group', project: idProject,
    pathFor: (id) => `/groups/${encodeURIComponent(id)}/members?$select=id`,
    requires: ['GroupMember.Read.All'],
  }),
  owner: simple({
    family: 'owner', edgeType: 'owner', parentType: 'group', project: idProject,
    pathFor: (id) => `/groups/${encodeURIComponent(id)}/owners?$select=id`,
    requires: ['Group.Read.All'],
  }),
  transitiveMember: simple({
    family: 'transitiveMember', edgeType: 'transitiveMember', direction: 'transitive', parentType: 'group', project: idProject,
    pathFor: (id) => `/groups/${encodeURIComponent(id)}/transitiveMembers?$select=id`,
    requires: ['GroupMember.Read.All'],
  }),
  appOwner: simple({
    family: 'appOwner', edgeType: 'owner', parentType: 'application', project: idProject,
    pathFor: (id) => `/applications/${encodeURIComponent(id)}/owners?$select=id`,
    requires: ['Application.Read.All'],
  }),
  servicePrincipalOwner: simple({
    family: 'servicePrincipalOwner', edgeType: 'owner', parentType: 'servicePrincipal', project: idProject,
    pathFor: (id) => `/servicePrincipals/${encodeURIComponent(id)}/owners?$select=id`,
    requires: ['Application.Read.All'],
  }),
  appRoleGrant: simple({
    family: 'appRoleGrant', edgeType: 'appRoleGrant', parentType: 'servicePrincipal', project: appRoleGrantProject,
    pathFor: (id) => `/servicePrincipals/${encodeURIComponent(id)}/appRoleAssignments`,
    requires: ['Application.Read.All'],
  }),
});

/**
 * Intune assignments are ONE family routed by parent type: only these parent
 * types have a registered, pinned endpoint. Any other Intune type (enrollment
 * configurations, intents, autopilot profiles, ...) yields an `unsupported`
 * observation and is never read through a guessed generic endpoint.
 */
const ASSIGNMENT_ROUTES = Object.freeze({
  deviceConfiguration: { version: 'v1.0', base: '/deviceManagement/deviceConfigurations', requires: ['DeviceManagementConfiguration.Read.All'] },
  deviceCompliancePolicy: { version: 'v1.0', base: '/deviceManagement/deviceCompliancePolicies', requires: ['DeviceManagementConfiguration.Read.All'] },
  configurationPolicy: { version: 'beta', base: '/deviceManagement/configurationPolicies', requires: ['DeviceManagementConfiguration.Read.All'] },
  mobileApp: { version: 'v1.0', base: '/deviceAppManagement/mobileApps', requires: ['DeviceManagementApps.Read.All'] },
});

export const ASSIGNMENT_PARENT_TYPES = Object.freeze(Object.keys(ASSIGNMENT_ROUTES));

const ASSIGNMENT_FAMILY = Object.freeze({
  family: 'assignment', edgeType: 'assignment', direction: 'direct', project: assignmentProject, source: DOCS,
});

/** The concrete read spec for (family, parent type): a spec, 'unsupported', or null (not applicable). */
function resolveSpec(familyName, parentType) {
  if (familyName === 'assignment') {
    const route = ASSIGNMENT_ROUTES[parentType];
    if (!route) return 'unsupported';
    return { ...ASSIGNMENT_FAMILY, parentType, version: route.version, requires: route.requires,
      pathFor: (id) => `${route.base}/${encodeURIComponent(id)}/assignments` };
  }
  const spec = RELATIONSHIP_FAMILIES[familyName];
  if (!spec) throw new Error(`unknown relationship family ${familyName}`);
  return spec.parentType === parentType ? spec : null;
}

/** Parent resource types a family list reads (excluding explicitly requested unsupported ones). */
export function parentTypesForFamilies(families) {
  const types = new Set();
  for (const name of families) {
    if (name === 'assignment') ASSIGNMENT_PARENT_TYPES.forEach((t) => types.add(t));
    else if (RELATIONSHIP_FAMILIES[name]) types.add(RELATIONSHIP_FAMILIES[name].parentType);
    else throw new Error(`unknown relationship family ${name}`);
  }
  return types;
}

/** Direct group families only by default; the derived transitive read is opt-in. */
export const DEFAULT_RELATIONSHIP_FAMILIES = Object.freeze(['member', 'owner']);

export class CrossTenantRelationshipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CrossTenantRelationshipError';
  }
}

function classify(result, project) {
  const items = Array.isArray(result?.items) ? result.items : null;
  const pages = Number.isSafeInteger(result?.pages) ? result.pages : null;
  const status = Number.isInteger(result?.status) ? result.status : null;
  const targets = new Map();
  let malformed = 0;
  for (const item of items ?? []) {
    const edge = project(item);
    if (!edge) { malformed += 1; continue; }
    if (!targets.has(edge.edgeKey)) targets.set(edge.edgeKey, edge);
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
    return { outcome: 'partial', targets: targetList, itemCount: targetList.length, pagesCompleted: pages, httpStatus: status, graphCode: null, error: `${malformed} item(s) that are not a usable edge` };
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
  for (const name of families) parentTypesForFamilies([name]); // rejects an unknown family up front
  const observations = [];
  for (const parent of parents ?? []) {
    const parentSourceId = normalizeId(parent?.sourceId);
    if (!parentSourceId) continue;
    const parentType = parent.type ?? 'group';
    for (const name of families) {
      const spec = resolveSpec(name, parentType);
      if (spec === null) continue; // family does not apply to this parent type
      const base = {
        tenantRef, parentType, parentSourceId, parentNaturalKey: parent.naturalKey ?? null,
      };
      if (spec === 'unsupported') {
        // No registered endpoint: nothing is read, and the absence of a read
        // is recorded as unknown — never as an empty or complete edge set.
        const at = new Date().toISOString();
        observations.push({
          ...base, family: name, edgeType: ASSIGNMENT_FAMILY.edgeType, direction: 'direct', endpoint: null, apiVersion: null,
          startedAt: at, completedAt: at, outcome: 'unsupported', targets: [], itemCount: null, pagesCompleted: null,
          httpStatus: null, graphCode: null, error: `no registered ${name} endpoint for ${parentType}`,
        });
        continue;
      }
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
        ...base,
        family: spec.family,
        edgeType: spec.edgeType,
        direction: spec.direction,
        endpoint,
        apiVersion: spec.version,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        ...classify(result, spec.project),
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
        `INSERT INTO relationship_edge (set_id, tenant_ref, edge_key, target_source_id, target_type, target_natural_key, attributes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [set.rows[0].id, tenantRef, target.edgeKey, target.targetId, target.targetType ?? resolved?.type ?? null,
          resolved?.symbol ?? null, target.attributes ?? null],
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
            COALESCE((SELECT jsonb_agg(jsonb_build_object('edgeKey', e.edge_key, 'targetId', e.target_source_id, 'targetType', e.target_type,
                                                            'targetNaturalKey', e.target_natural_key, 'attributes', e.attributes)
                                       ORDER BY e.edge_key)
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

/**
 * Compact per-family completeness for reports: never claims more than
 * observed. `unsupported` (no registered endpoint) is counted apart from
 * `unknown` (a read that never completed) and only appears when present.
 */
export function summarizeRelationshipState(state, { parentType } = {}) {
  const families = {};
  for (const entry of state.entries.values()) {
    if (parentType && entry.parentType !== parentType) continue;
    const bucket = (families[entry.family] ??= { current: 0, stale: 0, unknown: 0 });
    if (entry.state === 'unknown' && entry.failure?.outcome === 'unsupported') bucket.unsupported = (bucket.unsupported ?? 0) + 1;
    else bucket[entry.state] += 1;
  }
  return families;
}

/**
 * Roadmap task-61: the edge sets ONE snapshot observed, keyed
 * `${parentNaturalKey}|${family}` — the desired state a restore reconciles
 * edges toward. Unlike loadRelationshipState (newest-per-parent across
 * snapshots), this never substitutes another snapshot's read: a family this
 * snapshot did not observe is simply absent (a legacy snapshot, collected
 * before task-57 or without `relationships`, yields an empty map), and a
 * failed/partial observation is returned with its own outcome so the caller
 * can refuse to treat it as a complete desired set.
 */
export async function loadSnapshotRelationships(client, { snapshotId, families = DEFAULT_RELATIONSHIP_FAMILIES, parentNaturalKeys = null } = {}) {
  const { rows } = await client.query(
    `SELECT s.id, s.parent_type, s.parent_source_id, s.parent_natural_key, s.family, s.outcome,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('edgeKey', e.edge_key, 'targetId', e.target_source_id,
                                                          'targetType', e.target_type, 'targetNaturalKey', e.target_natural_key)
                                       ORDER BY e.edge_key)
                        FROM relationship_edge e WHERE e.set_id = s.id AND e.tenant_ref = s.tenant_ref), '[]'::jsonb) AS targets
       FROM relationship_edge_set s
       JOIN snapshot sn ON sn.id = s.snapshot_id AND sn.tenant_ref = s.tenant_ref
      WHERE s.snapshot_id = $1 AND s.family = ANY($2::text[])
      ORDER BY s.id`,
    [snapshotId, [...families]],
  );
  const wanted = parentNaturalKeys ? new Set(parentNaturalKeys) : null;
  const sets = new Map();
  for (const row of rows) {
    if (!row.parent_natural_key) continue; // an unkeyed parent cannot be matched to a restore resource
    if (wanted && !wanted.has(row.parent_natural_key)) continue;
    const key = `${row.parent_natural_key}|${row.family}`;
    if (sets.has(key)) {
      // Two observations of the same parent/family in one snapshot disagree on
      // nothing we can prove; treat the desired set as not authoritative.
      sets.set(key, { ...sets.get(key), outcome: 'partial', duplicate: true });
      continue;
    }
    sets.set(key, {
      parentType: row.parent_type,
      parentSourceId: row.parent_source_id,
      parentNaturalKey: row.parent_natural_key,
      family: row.family,
      outcome: row.outcome,
      targets: row.targets,
    });
  }
  return sets;
}
