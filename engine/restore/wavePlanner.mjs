import { buildGraph, topoWaves } from '../graph/dependencyGraph.mjs';

function parseFieldPath(path) {
  const segments = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let match;
  while ((match = re.exec(path))) {
    segments.push(match[2] !== undefined ? Number(match[2]) : match[1]);
  }
  return segments;
}

function valueAtPath(value, path) {
  return parseFieldPath(path).reduce((current, segment) => current?.[segment], value);
}

function formatFieldPath(segments) {
  return segments.map((segment, index) => (typeof segment === 'number'
    ? `[${segment}]`
    : index === 0 ? segment : `.${segment}`)).join('');
}

/** Array omission compacts the array. Preserve every non-deferred reference by
 * moving its path to the index it occupies in the compacted phase-one payload. */
function phaseOneFieldPath(path, omittedPaths) {
  const segments = parseFieldPath(path);
  const omittedArrayPaths = new Map();
  for (const omittedPath of omittedPaths) {
    const omitted = parseFieldPath(omittedPath);
    const omittedIndex = omitted.at(-1);
    if (typeof omittedIndex !== 'number') continue;
    const arrayPath = formatFieldPath(omitted.slice(0, -1));
    if (!omittedArrayPaths.has(arrayPath)) omittedArrayPaths.set(arrayPath, new Set());
    omittedArrayPaths.get(arrayPath).add(omittedIndex);
  }

  const phaseOne = segments.map((segment, index) => {
    if (typeof segment !== 'number') return segment;
    const arrayPath = formatFieldPath(segments.slice(0, index));
    const omitted = omittedArrayPaths.get(arrayPath) ?? new Set();
    return segment - [...omitted].filter((omittedIndex) => omittedIndex < segment).length;
  });
  return formatFieldPath(phaseOne);
}

/** Build an omission tree so several selected array elements can be removed
 * together without shifting an index before the next selected edge is read. */
function omissionTree(paths) {
  const root = { children: new Map() };
  for (const path of paths) {
    let node = root;
    for (const segment of parseFieldPath(path)) {
      if (!node.children.has(segment)) node.children.set(segment, { children: new Map() });
      node = node.children.get(segment);
    }
    node.omit = true;
  }
  return root;
}

const OMIT = Symbol('omit deferred reference');

/** Return a new payload with only the selected deferred paths absent. Object
 * siblings and non-selected array items are retained, and the source payload
 * is never mutated. */
function omitPaths(value, tree) {
  if (tree.omit) return OMIT;
  if (Array.isArray(value)) {
    let changed = false;
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      const child = tree.children.get(index);
      const next = child ? omitPaths(value[index], child) : value[index];
      if (next === OMIT) {
        changed = true;
        continue;
      }
      copy.push(next);
    }
    return changed ? copy : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const copy = { ...value };
    for (const [key, child] of tree.children) {
      if (!Object.hasOwn(value, key)) continue;
      const next = omitPaths(value[key], child);
      if (next === OMIT) {
        delete copy[key];
        changed = true;
      } else if (next !== value[key]) {
        copy[key] = next;
        changed = true;
      }
    }
    return changed ? copy : value;
  }
  return value;
}

/** Task-103: workload configuration (SharePoint tenant settings, sites) restores
 * through its own qualified path (restore/workloads/), never as an Entra wave.
 * Task-104 adds Teams settings and Teams membership; task-105 adds Exchange;
 * task-106 adds OneDrive and Purview. */
export const WORKLOAD_RESOURCE_TYPES = Object.freeze([
  'sharepointTenantSettings', 'sharepointSite', 'teamsTeam', 'teamsTeamSettings', 'teamsMembership',
  // Task-105: Exchange mailbox and organization configuration.
  'exchangeMailbox', 'exchangeMailboxSettings', 'exchangeClientAccess', 'exchangeMailboxRetention', 'exchangeOrganizationConfig',
  // Task-106: OneDrive site settings and Purview label configuration.
  'onedriveSite', 'purviewLabel', 'purviewLabelPolicy',
  // Issue #153: Exchange mail flow and protection settings (read-only for now).
  'exchangeMailFlow',
  // Issue #154: Teams org-wide policies and tenant configuration (read-only for now).
  'teamsOrgPolicy',
]);

function assertNoWorkloadTypes(resources) {
  const found = [...new Set((resources ?? [])
    .map((resource) => resource?.resourceType)
    .filter((type) => WORKLOAD_RESOURCE_TYPES.includes(type)))];
  if (found.length) {
    throw new Error(`${found.join(', ')} restore through the workload restore path, not Entra waves`);
  }
}

/** Spec §9.1–§9.2, §8.4. Cyclic references are excluded from wave ordering
 * (dependencyGraph.mjs already breaks them deterministically) and instead
 * returned as `patches` — resources created without that one field in their
 * own wave, patched once every node they depend on exists. */
export function planWaves(resources) {
  assertNoWorkloadTypes(resources);
  const graph = buildGraph(resources);
  const waves = topoWaves(graph);

  const patches = [];
  for (const cycle of graph.cycles) {
    const sorted = [...cycle].sort();
    const from = sorted[0];
    const to = cycle[(cycle.indexOf(from) + 1) % cycle.length];
    const resource = graph.nodes.get(from);
    const ref = resource.references.find((r) => r.symbol === to);
    if (ref) {
      // This is immutable phase metadata, not a transformed snapshot. The
      // original resource payload remains available for the second phase.
      patches.push(Object.freeze({
        naturalKey: from,
        resourceType: resource.resourceType,
        field: ref.field,
        symbol: to,
        sourceValue: valueAtPath(resource.payload, ref.field),
        reference: Object.freeze({ ...ref }),
      }));
    }
  }

  return { waves, patches };
}

/** Produce the first-phase form of a wave. A deferred reference is removed
 * from both the payload and the rewrite list, while every sibling reference
 * and the original source resource stay intact for phase two. */
export function phaseOneResources(resources, patches) {
  const patchesByResource = new Map();
  for (const patch of patches) {
    if (!patchesByResource.has(patch.naturalKey)) patchesByResource.set(patch.naturalKey, []);
    patchesByResource.get(patch.naturalKey).push(patch);
  }

  return resources.map((resource) => {
    const deferred = patchesByResource.get(resource.naturalKey);
    if (!deferred?.length) return resource;

    return {
      ...resource,
      payload: omitPaths(resource.payload, omissionTree(deferred.map((patch) => patch.field))),
      references: (resource.references ?? [])
        .filter((reference) => !deferred.some((patch) =>
          patch.field === reference.field && patch.symbol === reference.symbol))
        .map((reference) => ({
          ...reference,
          field: phaseOneFieldPath(reference.field, deferred.map((patch) => patch.field)),
        })),
    };
  });
}

/** Spec M2.5. Deletions run after every create/update wave, in REVERSE dependency order:
 * a group cannot be deleted while a role assignment still references it. */
export function planDeletionWaves(resourcesToDelete) {
  assertNoWorkloadTypes(resourcesToDelete);
  const graph = buildGraph(resourcesToDelete);
  const waves = topoWaves(graph).reverse();
  return { waves };
}
