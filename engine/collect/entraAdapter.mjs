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
    async collect(reader) {
      const entry = byType.get(type);
      if (!entry) throw new Error(`M1 type ${type} not found in tenant-probe CATALOG`);
      const path = entry.select ? `${entry.path}?$select=${entry.select}` : entry.path;
      const { items, error } = await reader.collect(entry.version, path, {
        pageCap: entry.pageCap ?? Infinity,
      });
      if (error) throw new Error(`collecting ${type} failed: ${error.error ?? error.status}`);
      return items;
    },
  };
}

for (const descriptor of DESCRIPTORS) {
  register(descriptor, graphNativeAdapter(descriptor.type));
}

export async function collectM1(reader) {
  const collected = [];
  for (const type of M1_TYPES) {
    const { adapter } = get(type);
    collected.push([type, await adapter.collect(reader)]);
  }
  return collected;
}
