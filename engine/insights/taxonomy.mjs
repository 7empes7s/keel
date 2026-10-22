/**
 * One taxonomy for every catalogued type and workload read (insights track, IN-TYPES).
 *
 * Each entry gives what a reader sees instead of a stored code: a plain singular name
 * ("Conditional Access policy"), the service it belongs to, and a default priority with
 * the reason for it, and the group of kinds it sits in within its service ("Users and
 * contacts", "Admin roles"…). Pages, reports and the change feed group and rank by these fields.
 *
 * Entries live in taxonomy.d/, one file per service, so services can change in parallel.
 * A catalogue type takes its priority from the catalogue's blast radius and criticality
 * unless its entry sets `priority` and `reason`; a workload read has no catalogue tier, so
 * its entry must set both. taxonomy.test.mjs fails on any catalogued type or workload
 * without an entry, so a new CAT or READ type has to be mapped here.
 */
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import defender from './taxonomy.d/defender.mjs';
import entra from './taxonomy.d/entra.mjs';
import exchange from './taxonomy.d/exchange.mjs';
import intune from './taxonomy.d/intune.mjs';
import powerPlatform from './taxonomy.d/power-platform.mjs';
import purview from './taxonomy.d/purview.mjs';
import sharepoint from './taxonomy.d/sharepoint.mjs';
import teams from './taxonomy.d/teams.mjs';

export const SERVICE_FILES = Object.freeze([defender, entra, exchange, intune, powerPlatform, purview, sharepoint, teams]);

export const SERVICES = Object.freeze([
  'Entra', 'Intune', 'Exchange', 'Teams', 'SharePoint', 'Purview', 'Power Platform', 'Defender',
]);

/** Most urgent first; sort by index. */
export const PRIORITIES = Object.freeze(['critical', 'high', 'normal', 'low']);

const CATALOG_PRIORITY = Object.freeze({
  lockout: Object.freeze({ priority: 'critical', reason: 'A wrong change can lock admins or users out of the whole tenant.' }),
  tier1: Object.freeze({ priority: 'high', reason: 'Changes who can sign in or reach data across the tenant.' }),
  access: Object.freeze({ priority: 'normal', reason: 'Changes who can reach some apps, devices or data.' }),
  cosmetic: Object.freeze({ priority: 'low', reason: 'Changes labels, templates or records, not who has access.' }),
});

function catalogPriority(entry) {
  if (entry.blastRadius === 'tenant-lockout') return CATALOG_PRIORITY.lockout;
  if (entry.blastRadius === 'cosmetic') return CATALOG_PRIORITY.cosmetic;
  return entry.criticality === 'tier1' ? CATALOG_PRIORITY.tier1 : CATALOG_PRIORITY.access;
}

// A type no service file places in a group (or an unmapped code) sorts after every group.
export const OTHER_CATEGORY = Object.freeze({ key: 'other', name: 'Other settings', rank: 99 });

function placements(categories) {
  const placed = new Map();
  (categories ?? []).forEach((category, rank) => {
    category.types.forEach((type, typeRank) => placed.set(type, { category: category.key, categoryName: category.name, categoryRank: rank, typeRank }));
  });
  return placed;
}

function build(field) {
  const catalog = new Map(CATALOG.map((entry) => [entry.type, entry]));
  const taxonomy = {};
  for (const { service, categories, ...file } of SERVICE_FILES) {
    const placed = placements(categories);
    for (const [type, entry] of Object.entries(file[field] ?? {})) {
      if (taxonomy[type]) throw new Error(`taxonomy: ${type} is mapped by both ${taxonomy[type].service} and ${service}`);
      const fallback = catalog.has(type) ? catalogPriority(catalog.get(type)) : null;
      taxonomy[type] = Object.freeze({
        type,
        name: entry.name,
        service,
        priority: entry.priority ?? fallback?.priority ?? null,
        priorityReason: entry.reason ?? fallback?.reason ?? null,
        ...(placed.get(type) ?? { category: OTHER_CATEGORY.key, categoryName: OTHER_CATEGORY.name, categoryRank: OTHER_CATEGORY.rank, typeRank: 0 }),
      });
    }
  }
  return Object.freeze(taxonomy);
}

export const TAXONOMY = build('entries');

/** Links between objects (group members and owners, app owners, policy assignments),
 * by the type edge changes store them under. Kept apart from TAXONOMY, which maps the
 * catalogue and workload reads one for one. */
export const EDGE_TAXONOMY = build('edges');

const words = (code) => String(code).replace(/[-_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();

/**
 * The taxonomy entry for a stored type or workload code. An unmapped code still reads as
 * words ("someNewType" becomes "Some new type") with no service and normal priority, and
 * `known: false` so callers can show that it is not classified yet.
 */
export function typeInfo(type) {
  const entry = TAXONOMY[type] ?? EDGE_TAXONOMY[type];
  if (entry) return { ...entry, known: true };
  const name = words(type);
  return {
    type,
    name: name ? name[0].toUpperCase() + name.slice(1) : 'Unknown type',
    service: null,
    priority: 'normal',
    priorityReason: 'Not classified yet.',
    category: OTHER_CATEGORY.key,
    categoryName: OTHER_CATEGORY.name,
    categoryRank: OTHER_CATEGORY.rank,
    typeRank: 0,
    known: false,
  };
}

/**
 * List order inside one service: by the service file's groups (people and objects,
 * then roles, then policies, then settings), then the type's place in its group, then
 * the name. Pages that group a service's settings by kind sort with this.
 */
export function compareInService(a, b) {
  const left = typeInfo(a);
  const right = typeInfo(b);
  return left.categoryRank - right.categoryRank || left.typeRank - right.typeRank || left.name.localeCompare(right.name);
}

/** Sort comparator: most urgent priority first, then service order, then name. */
export function compareTypes(a, b) {
  const left = typeInfo(a);
  const right = typeInfo(b);
  const service = (info) => (info.service ? SERVICES.indexOf(info.service) : SERVICES.length);
  return PRIORITIES.indexOf(left.priority) - PRIORITIES.indexOf(right.priority)
    || service(left) - service(right)
    || left.name.localeCompare(right.name);
}
