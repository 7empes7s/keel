import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { DESCRIPTORS } from './descriptors.mjs';
import { register, get } from './registry.mjs';

export const M1_TYPES = DESCRIPTORS.map((d) => d.type);

const byType = new Map(CATALOG.map((entry) => [entry.type, entry]));

// The graph-native adapter: serves a descriptor's type by reading the
// tenant-probe CATALOG entry for that type. Read-side only for now — apply /
// verify join the adapter contract with the restore milestone.
function graphNativeAdapter(type) {
  return {
    async collect(reader, { tenantId } = {}) {
      const entry = byType.get(type);
      if (!entry) throw new Error(`M1 type ${type} not found in tenant-probe CATALOG`);
      if (entry.needsOrgId && !tenantId) throw new Error(`collecting ${type} failed: tenantId required`);
      const basePath = entry.needsOrgId ? entry.path.replace('{org}', encodeURIComponent(tenantId)) : entry.path;
      // Do not append $top: directoryRoleTemplates rejects it. The reader
      // follows Graph's nextLink verbatim and handles singleton responses too.
      const path = entry.select ? `${basePath}?$select=${entry.select}` : basePath;
      const { items, error, capped } = await reader.collect(entry.version, path, {
        pageCap: entry.pageCap ?? Infinity,
      });
      if (error) throw new Error(`collecting ${type} failed: ${error.error ?? error.status}`);
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
    try {
      const items = await get(type).adapter.collect(reader, context);
      collected.push([type, items]);
      coverageDigest[type] = { outcome: 'complete', itemCount: items.length };
      if (type === 'organization') context.tenantId ??= items[0]?.id;
    } catch (error) {
      coverageDigest[type] = { outcome: 'failed', itemCount: null, error: error.message };
    }
  }
  return { collected, coverageDigest };
}
