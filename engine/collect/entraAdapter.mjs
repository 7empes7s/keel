import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';

export const M1_TYPES = [
  'user', 'authenticationStrengthPolicy', 'group', 'roleAssignment',
  'namedLocation', 'conditionalAccessPolicy',
];

const byType = new Map(CATALOG.map((entry) => [entry.type, entry]));

export async function collectM1(reader) {
  const collected = [];
  for (const type of M1_TYPES) {
    const entry = byType.get(type);
    if (!entry) throw new Error(`M1 type ${type} not found in tenant-probe CATALOG`);
    const path = entry.select ? `${entry.path}?$select=${entry.select}` : entry.path;
    const { items, error } = await reader.collect(entry.version, path, {
      pageCap: entry.pageCap ?? Infinity,
    });
    if (error) throw new Error(`collecting ${type} failed: ${error.error ?? error.status}`);
    collected.push([type, items]);
  }
  return collected;
}
