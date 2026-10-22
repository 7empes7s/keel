import { CATALOG, catalogReadPath } from '../../tools/tenant-probe/catalog.mjs';
import { redactSecrets } from '../../tools/tenant-probe/graph.mjs';
import { DESCRIPTORS } from './descriptors.mjs';
import { register, get } from './registry.mjs';
import { ID_KEY_TYPES } from '../cir/naturalKey.mjs';

export const M1_TYPES = DESCRIPTORS.map((d) => d.type);

const byType = new Map(CATALOG.map((entry) => [entry.type, entry]));
const DIRECTORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The graph-native adapter: serves a descriptor's type by reading the
// tenant-probe CATALOG entry for that type. Read-side only for now — apply /
// verify join the adapter contract with the restore milestone.
function graphNativeAdapter(type) {
  // collectRaw performs the read and returns structured evidence instead of
  // throwing: the coverage digest needs the HTTP status, Graph code, endpoint,
  // observation window and pagination state even when the enumeration fails
  // partway. Only precondition violations (unknown type, missing tenantId)
  // throw here; Graph failures are reported, never hidden.
  async function collectRaw(reader, { tenantId, organizationId } = {}) {
    const entry = byType.get(type);
    if (!entry) throw new Error(`M1 type ${type} not found in tenant-probe CATALOG`);
    if (entry.parent) {
      const startedAt = new Date();
      const result = await collectPerParent(reader, entry);
      return { entry, path: catalogReadPath(entry), startedAt, completedAt: new Date(), ...result };
    }
    // Issue #156: the organization id read in this run wins over the configured
    // tenant id, which may be a domain name rather than the directory's id.
    const orgId = organizationId ?? tenantId;
    if (entry.needsOrgId && !orgId) throw new Error(`collecting ${type} failed: tenantId required`);
    const basePath = entry.needsOrgId ? entry.path.replace('{org}', encodeURIComponent(orgId)) : entry.path;
    // Do not append $top: directoryRoleTemplates rejects it. The reader
    // follows Graph's nextLink verbatim and handles singleton responses too.
    const path = catalogReadPath(entry, basePath);
    const startedAt = new Date();
    const result = await reader.collect(entry.version, path, {
      pageCap: entry.pageCap ?? Infinity,
      ...(entry.acceptLanguage ? { acceptLanguage: entry.acceptLanguage } : {}),
    });
    // Issue #438: the beta Exchange role reads return the same object on more
    // than one page, and a different one each run. Exact repeats are dropped
    // here so they never reach the canonicalizer, whose natural-key collision
    // fails the whole collect. A repeat that differs from the first copy is
    // kept: for an id-keyed kind it would still collide, so only that kind
    // fails and the rest of the collect goes on.
    if (!result?.error && Array.isArray(result?.items)) {
      const { items, conflicts } = dropRepeatedIds(result.items);
      result.items = items;
      if (conflicts.length > 0 && ID_KEY_TYPES.has(type)) {
        return {
          entry, path, startedAt, completedAt: new Date(), items, pages: Number.isSafeInteger(result.pages) ? result.pages : null,
          status: Number.isInteger(result.status) ? result.status : null, capped: result.capped === true,
          error: { error: `the read returned different objects under one id: ${conflicts.join(', ')}` },
        };
      }
    }
    // Restore gaps batch 5: a kind whose objects hold children with one more
    // collection each (an administrative template's settings and their values)
    // reads that collection per child.
    if (entry.childReads && !result?.error && !result?.capped && Array.isArray(result?.items)) {
      const children = await withChildReads(reader, entry, result.items);
      if (children.error) return { entry, path, startedAt, completedAt: new Date(), items: [], pages: result.pages ?? null, status: children.error.status ?? null, capped: false, error: children.error };
      result.pages = (Number.isSafeInteger(result.pages) ? result.pages : 0) + children.pages;
    }
    // Restore gaps batch 13: a kind whose objects each hold one more collection
    // (the apps an app protection policy covers) reads it per object.
    if (entry.itemReads && !result?.error && !result?.capped && Array.isArray(result?.items)) {
      const extra = await withItemReads(reader, entry, result.items);
      if (extra.error) return { entry, path, startedAt, completedAt: new Date(), items: [], pages: result.pages ?? null, status: extra.error.status ?? null, capped: false, error: extra.error };
      result.pages = (Number.isSafeInteger(result.pages) ? result.pages : 0) + extra.pages;
    }
    const completedAt = new Date();
    // Issue #156: a type Graph answers with 404 when the tenant never set it
    // up (company branding) is an observed absence, not a failed read. Only a
    // 404 on the first page counts; any other status is still a failure. The
    // path must name the directory by its id: a 404 under a domain name or a
    // wrong value says nothing about the setting, so it stays a failure.
    if (entry.absentWhenNotFound && result?.error?.status === 404 && !(result.pages > 0) && (!entry.needsOrgId || DIRECTORY_ID.test(orgId))) {
      return {
        entry, path, startedAt, completedAt, items: [], pages: 0, status: 404, capped: false, error: null,
      };
    }
    return {
      entry,
      path,
      startedAt,
      completedAt,
      items: result?.items,
      pages: Number.isSafeInteger(result?.pages) ? result.pages : null,
      status: Number.isInteger(result?.status) ? result.status : null,
      capped: result?.capped === true,
      error: result?.error ?? null,
    };
  }

  return {
    collectRaw,
    async collect(reader, scope = {}) {
      const { items, error, capped } = await collectRaw(reader, scope);
      if (error) {
        const failure = new Error(`collecting ${type} failed: ${redactSecrets(error.error ?? error.message ?? error.status)}`);
        if (unavailableOnTenant(error)) failure.unavailableOnTenant = true;
        throw failure;
      }
      if (capped) throw new Error(`collecting ${type} failed: pagination incomplete`);
      if (!Array.isArray(items)) throw new Error(`collecting ${type} failed: missing items`);
      return items;
    },
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Drops a repeat of an object already in the list: same id, same content.
 * A repeat whose content differs is kept, and its id is returned in
 * `conflicts`. Objects without a string id are kept as they are.
 * Exported for tests.
 */
export function dropRepeatedIds(list) {
  const firstById = new Map();
  const items = [];
  const conflicts = new Set();
  for (const item of list) {
    const id = typeof item?.id === 'string' && item.id.length > 0 ? item.id : null;
    if (id === null) { items.push(item); continue; }
    const seen = firstById.get(id);
    if (seen === undefined) {
      firstById.set(id, stableStringify(item));
      items.push(item);
    } else if (seen !== stableStringify(item)) {
      conflicts.add(item.id);
      items.push(item);
    }
  }
  return { items, conflicts: [...conflicts] };
}

// Wave 1 CAT-ENTRA: objects that exist only under one parent (a partner's
// sync settings, a service principal's sync jobs, an access package's
// resource roles). The parent list is read first, then each parent's path,
// and each object is tagged with its parent's key. Any failed read fails the
// type, so a denied read is never reported as an empty one; only `pages` of
// child reads count, so a denial before any child was read is `failed`.
async function collectPerParent(reader, entry) {
  const { parent } = entry;
  const options = { pageCap: entry.pageCap ?? Infinity };
  const listed = await reader.collect(entry.version, catalogReadPath(parent), options);
  if (listed?.error || listed?.capped || !Array.isArray(listed?.items)) {
    return {
      items: [], pages: 0, status: listed?.error?.status ?? listed?.status ?? null, capped: listed?.capped === true,
      error: listed?.error ?? (listed?.capped ? null : { error: `listing the parents of ${entry.type} returned no items` }),
    };
  }
  const items = [];
  let pages = 0;
  let status = listed.status ?? null;
  const stop = (error, capped = false) => ({ items, pages, status, capped, error });
  for (const object of listed.items) {
    if (parent.requires && !object?.[parent.requires]) continue;
    const key = object?.[parent.key];
    if (typeof key !== 'string' || key.length === 0) return stop({ error: `a parent of ${entry.type} has no ${parent.key}` });
    const result = await reader.collect(entry.version, perParentReadPath(entry, key), options);
    if (entry.absentWhenNotFound && result?.error?.status === 404 && !(result.pages > 0)) continue;
    pages += Number.isSafeInteger(result?.pages) ? result.pages : 0;
    status = result?.error?.status ?? result?.status ?? status;
    if (result?.error) return stop(result.error);
    if (result?.capped) return stop(null, true);
    if (!Array.isArray(result?.items)) return stop({ error: `reading ${entry.type} under ${key} returned no items` });
    for (const found of result.items) {
      const children = entry.childField ? found?.[entry.childField] : [found];
      if (!Array.isArray(children)) return stop({ error: `reading ${entry.type} under ${key} returned no ${entry.childField}` });
      for (const child of children) items.push({ ...child, [parent.as]: key });
    }
  }
  return { items, pages, status, capped: false, error: null };
}

// The read for one parent: `{parent}` in the path is the key, encoded; in the
// query it is an OData string literal (remaining kinds batch 8: Graph lists
// some objects only through a filter, such as one role's assignments).
export function perParentReadPath(entry, key) {
  const path = entry.path.replace('{parent}', encodeURIComponent(key));
  const query = entry.query?.replaceAll('{parent}', encodeURIComponent(key.replaceAll("'", "''")));
  return catalogReadPath({ ...entry, query }, path);
}

/**
 * Restore gaps batch 5: for each object, each child in `childReads.field`
 * gets the collection at `childReads.path` ({item} and {child} filled with
 * their ids, `childReads.query` appended) as its `childReads.as`. Any failed
 * read fails the kind, so a backup never holds a setting without its values.
 */
async function withChildReads(reader, entry, items) {
  const { field, path, query, as } = entry.childReads;
  let pages = 0;
  for (const item of items) {
    const children = item?.[field] ?? [];
    if (!Array.isArray(children)) return { error: { error: `reading ${entry.type}: ${field} is not a list` } };
    for (const child of children) {
      if (typeof item?.id !== 'string' || typeof child?.id !== 'string') return { error: { error: `reading ${entry.type}: an object in ${field} has no id` } };
      const childPath = path.replace('{item}', encodeURIComponent(item.id)).replace('{child}', encodeURIComponent(child.id));
      const result = await reader.collect(entry.version, query ? `${childPath}?${query}` : childPath, { pageCap: Infinity });
      if (result?.error) return { error: result.error };
      if (result?.capped || !Array.isArray(result?.items)) return { error: { error: `reading ${entry.type}: ${as} under ${child.id} was incomplete` } };
      pages += Number.isSafeInteger(result.pages) ? result.pages : 0;
      child[as] = result.items;
    }
  }
  return { pages, error: null };
}

/**
 * Restore gaps batch 13: each object gets the collection at `itemReads.path`
 * (or at `itemReads.byType[its @odata.type]`; other kinds are left as they
 * are), with {item} filled with its id, as its `itemReads.as`. Any failed read
 * fails the kind, so a backup never holds a policy without the apps it covers.
 */
async function withItemReads(reader, entry, items) {
  const { as, path, byType } = entry.itemReads;
  let pages = 0;
  for (const item of items) {
    const template = byType ? byType[item?.['@odata.type']] : path;
    if (!template) continue;
    if (typeof item?.id !== 'string' || item.id.length === 0) return { error: { error: `reading ${entry.type}: an object has no id` } };
    const result = await reader.collect(entry.version, template.replace('{item}', encodeURIComponent(item.id)), { pageCap: Infinity });
    if (result?.error) return { error: result.error };
    if (result?.capped || !Array.isArray(result?.items)) return { error: { error: `reading ${entry.type}: ${as} of ${item.id} was incomplete` } };
    pages += Number.isSafeInteger(result.pages) ? result.pages : 0;
    item[as] = result.items;
  }
  return { pages, error: null };
}

for (const descriptor of DESCRIPTORS) {
  register(descriptor, graphNativeAdapter(descriptor.type));
}

/** The reason recorded on a type the tenant cannot have (issue #309). */
export const MISSING_PREREQUISITE = 'missing prerequisite (licence or tenant feature)';

// Issue #289: Graph answers some types with a refusal that says the tenant
// lacks the licence or feature for them, not that KEEL lacks a permission:
// 403 "Insufficient license" (lifecycle workflows need Entra ID Governance) and
// 400 AADB2C99039 (API connectors need self-service sign-up).
export function unavailableOnTenant(error) {
  if (!error) return false;
  const message = String(error.error ?? error.message ?? '');
  if (error.status === 403 && /insufficient licen[cs]e/i.test(message)) return true;
  return error.code === 'AADB2C99039' || /\bAADB2C99039\b/.test(message);
}

/**
 * The set of types a collectM1 caller needs, for `scope.needed`: every type in
 * `resources` (rows or canonical resources) plus `extra`.
 */
export function neededTypes(resources, extra = []) {
  const types = new Set(extra);
  for (const resource of resources ?? []) {
    const type = resource?.resourceType ?? resource?.resource_type;
    if (typeof type === 'string' && type) types.add(type);
  }
  return types;
}

/**
 * Reads every M1 type and fails on the first type it cannot read.
 * `scope.needed` (a set of types), when given, relaxes that for one case only:
 * a type the tenant has no licence or feature for, and that is not needed, is
 * left out of the result (not read, never an invented empty list). A needed
 * type that is unavailable still fails, naming the type.
 */
export async function collectM1(reader, scope = {}) {
  const { needed, ...rest } = scope;
  const collected = [];
  const context = { ...rest };
  for (const type of M1_TYPES) {
    const { adapter } = get(type);
    let items;
    try {
      items = await adapter.collect(reader, context);
    } catch (error) {
      if (needed instanceof Set && error?.unavailableOnTenant === true && !needed.has(type)) continue;
      throw error;
    }
    collected.push([type, items]);
    if (type === 'organization') {
      context.tenantId ??= items[0]?.id;
      context.organizationId = items[0]?.id ?? context.organizationId;
    }
  }
  return collected;
}

function errorDetail(error) {
  return {
    message: redactSecrets(error?.error ?? error?.message ?? `HTTP ${error?.status ?? 'unknown'}`),
    httpStatus: Number.isInteger(error?.status) ? error.status : null,
    graphCode: typeof error?.code === 'string' ? error.code : null,
  };
}

/**
 * Build the structured per-type digest entry. Outcome vocabulary:
 *   complete       — every page read, at least one item
 *   complete-empty — every page read, zero items (a success, never a failure)
 *   partial        — the walk stopped early (error after page one, or the
 *                    page cap cut it); the observed count is kept but the
 *                    entry fails completeness
 *   failed         — nothing was read; cardinality is unknown, never zero
 *   unavailable    — nothing was read because the tenant lacks the licence
 *                    or feature for the type; not a failure, never a zero
 * Evidence fields are null when they were not observed — nothing is invented.
 */
function outcomeEntry(raw) {
  const base = {
    endpoint: raw.path,
    apiVersion: raw.entry.version,
    startedAt: raw.startedAt.toISOString(),
    completedAt: raw.completedAt.toISOString(),
    pagesCompleted: raw.pages,
  };
  if (raw.error) {
    const detail = errorDetail(raw.error);
    const partial = (raw.pages ?? 0) > 0 || (Array.isArray(raw.items) && raw.items.length > 0);
    // Issue #309: a type the tenant has no licence or feature for is recorded
    // as unavailable, not failed, so the run can still succeed. Only a refusal
    // before any page was read counts; any other error still fails.
    if (!partial && unavailableOnTenant(raw.error)) {
      return {
        ...base,
        outcome: 'unavailable',
        itemCount: null,
        reason: MISSING_PREREQUISITE,
        error: detail.message,
        httpStatus: detail.httpStatus,
        graphCode: detail.graphCode,
      };
    }
    return {
      ...base,
      outcome: partial ? 'partial' : 'failed',
      itemCount: partial ? raw.items.length : null,
      error: detail.message,
      httpStatus: detail.httpStatus,
      graphCode: detail.graphCode,
    };
  }
  if (raw.capped) {
    return {
      ...base,
      outcome: 'partial',
      itemCount: Array.isArray(raw.items) ? raw.items.length : null,
      error: 'pagination incomplete',
      httpStatus: raw.status,
      graphCode: null,
    };
  }
  if (!Array.isArray(raw.items)) {
    return {
      ...base,
      outcome: 'failed',
      itemCount: null,
      error: 'missing items',
      httpStatus: raw.status,
      graphCode: null,
    };
  }
  return {
    ...base,
    outcome: raw.items.length === 0 ? 'complete-empty' : 'complete',
    itemCount: raw.items.length,
    error: null,
    httpStatus: raw.status,
    graphCode: null,
  };
}

// Roadmap task-110: the Graph reader counts every HTTP request it sends and every
// 429/503 it is told to back off on. The per-type delta is recorded beside the outcome
// so schedule forecasts aggregate measured requests, never the item count. A reader
// without counters (fakes, older readers) leaves the fields out: unmeasured, not zero.
function readerCounts(reader) {
  const requests = reader?.stats?.requests;
  const throttles = reader?.stats?.throttled;
  return Number.isSafeInteger(requests) && Number.isSafeInteger(throttles) ? { requests, throttles } : null;
}

function requestCounts(before, reader) {
  const after = readerCounts(reader);
  if (!before || !after || after.requests < before.requests || after.throttles < before.throttles) return {};
  return { requests: after.requests - before.requests, throttles: after.throttles - before.throttles };
}

/**
 * Snapshot collection keeps an explicit outcome for every attempted type.
 * Only completed enumerations enter `collected`; a failed/partial read has
 * unknown cardinality, never an invented zero. Keep collectM1 fail-fast for
 * planning and restore callers that require a complete input set.
 *
 * `scope.tier`, when set, selects adapters by descriptor criticality BEFORE
 * any HTTP read (task 49): an excluded type's endpoint is never called, and
 * its digest entry is the explicit not-requested marker, never a fetched-
 * then-discarded complete/complete-empty outcome. Cross-tier reference
 * resolution for excluded types falls back to the persisted historical
 * identity context (engine/store/resourceSymbols.mjs) at the snapshot layer
 * instead. An unset tier keeps full collection, unchanged.
 */
export async function collectWithOutcomes(reader, scope = {}) {
  const { tier, ...rest } = scope;
  const collected = [];
  const coverageDigest = {};
  const context = { ...rest };
  for (const type of M1_TYPES) {
    const { descriptor, adapter } = get(type);
    if (tier && descriptor.criticality !== tier) {
      coverageDigest[type] = { outcome: 'not-requested', itemCount: null };
      continue;
    }
    const attemptStartedAt = new Date();
    const before = readerCounts(reader);
    try {
      const raw = await adapter.collectRaw(reader, context);
      coverageDigest[type] = { ...outcomeEntry(raw), ...requestCounts(before, reader) };
      if (raw.error === null && !raw.capped && Array.isArray(raw.items)) {
        collected.push([type, raw.items]);
        if (type === 'organization') {
          context.tenantId ??= raw.items[0]?.id;
          context.organizationId = raw.items[0]?.id ?? context.organizationId;
        }
      }
    } catch (error) {
      coverageDigest[type] = {
        outcome: 'failed',
        itemCount: null,
        error: redactSecrets(error?.message ?? String(error)),
        httpStatus: null,
        graphCode: null,
        endpoint: null,
        apiVersion: byType.get(type)?.version ?? null,
        startedAt: attemptStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        pagesCompleted: null,
        ...requestCounts(before, reader),
      };
    }
  }
  return { collected, coverageDigest };
}
