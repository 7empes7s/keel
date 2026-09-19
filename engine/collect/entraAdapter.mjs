import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { redactSecrets } from '../../tools/tenant-probe/graph.mjs';
import { DESCRIPTORS } from './descriptors.mjs';
import { register, get } from './registry.mjs';

export const M1_TYPES = DESCRIPTORS.map((d) => d.type);

const byType = new Map(CATALOG.map((entry) => [entry.type, entry]));

// The graph-native adapter: serves a descriptor's type by reading the
// tenant-probe CATALOG entry for that type. Read-side only for now — apply /
// verify join the adapter contract with the restore milestone.
function graphNativeAdapter(type) {
  // collectRaw performs the read and returns structured evidence instead of
  // throwing: the coverage digest needs the HTTP status, Graph code, endpoint,
  // observation window and pagination state even when the enumeration fails
  // partway. Only precondition violations (unknown type, missing tenantId)
  // throw here; Graph failures are reported, never hidden.
  async function collectRaw(reader, { tenantId } = {}) {
    const entry = byType.get(type);
    if (!entry) throw new Error(`M1 type ${type} not found in tenant-probe CATALOG`);
    if (entry.needsOrgId && !tenantId) throw new Error(`collecting ${type} failed: tenantId required`);
    const basePath = entry.needsOrgId ? entry.path.replace('{org}', encodeURIComponent(tenantId)) : entry.path;
    // Do not append $top: directoryRoleTemplates rejects it. The reader
    // follows Graph's nextLink verbatim and handles singleton responses too.
    const path = entry.select ? `${basePath}?$select=${entry.select}` : basePath;
    const startedAt = new Date();
    const result = await reader.collect(entry.version, path, {
      pageCap: entry.pageCap ?? Infinity,
    });
    const completedAt = new Date();
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
      if (error) throw new Error(`collecting ${type} failed: ${redactSecrets(error.error ?? error.message ?? error.status)}`);
      if (capped) throw new Error(`collecting ${type} failed: pagination incomplete`);
      if (!Array.isArray(items)) throw new Error(`collecting ${type} failed: missing items`);
      return items;
    },
  };
}

for (const descriptor of DESCRIPTORS) {
  register(descriptor, graphNativeAdapter(descriptor.type));
}

export async function collectM1(reader, scope = {}) {
  const collected = [];
  const context = { ...scope };
  for (const type of M1_TYPES) {
    const { adapter } = get(type);
    const items = await adapter.collect(reader, context);
    collected.push([type, items]);
    if (type === 'organization') context.tenantId ??= items[0]?.id;
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

/**
 * Snapshot collection keeps an explicit outcome for every attempted type.
 * Only completed enumerations enter `collected`; a failed/partial read has
 * unknown cardinality, never an invented zero. Keep collectM1 fail-fast for
 * planning and restore callers that require a complete input set.
 */
export async function collectWithOutcomes(reader, scope = {}) {
  const collected = [];
  const coverageDigest = {};
  const context = { ...scope };
  for (const type of M1_TYPES) {
    const attemptStartedAt = new Date();
    try {
      const raw = await get(type).adapter.collectRaw(reader, context);
      coverageDigest[type] = outcomeEntry(raw);
      if (raw.error === null && !raw.capped && Array.isArray(raw.items)) {
        collected.push([type, raw.items]);
        if (type === 'organization') context.tenantId ??= raw.items[0]?.id;
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
      };
    }
  }
  return { collected, coverageDigest };
}
