/**
 * Grouping for the change feed (feed.mjs): by day, type, service, priority or person.
 * Pure and free of Node built-ins, so the portal's client code can use it too.
 */
import { PRIORITIES, SERVICES } from './taxonomy.mjs';

export const FEED_GROUPINGS = Object.freeze(['day', 'type', 'service', 'priority', 'person']);

const PRIORITY_LABELS = Object.freeze({ critical: 'Critical', high: 'High', normal: 'Normal', low: 'Low' });
const serviceRank = (service) => (service && SERVICES.includes(service) ? SERVICES.indexOf(service) : SERVICES.length);
const priorityRank = (priority) => (PRIORITIES.includes(priority) ? PRIORITIES.indexOf(priority) : PRIORITIES.length);
// The most urgent priority a group holds.
const worstRank = (group) => {
  const index = PRIORITIES.findIndex((priority) => group.priorities[priority] > 0);
  return index === -1 ? PRIORITIES.length : index;
};

/** The group one row falls in, for one grouping. Pure. */
export function feedGroupOf(entry, by) {
  switch (by) {
    case 'type': return { key: entry.type, label: entry.typeName };
    case 'service': return entry.service ? { key: entry.service, label: entry.service } : { key: 'other', label: 'Other' };
    case 'priority': return { key: entry.priority, label: PRIORITY_LABELS[entry.priority] ?? 'Normal' };
    case 'person': {
      if (!entry.person) return { key: 'unknown', label: 'Not known' };
      const fallback = entry.person.kind === 'servicePrincipal' ? 'Unnamed app' : 'Unnamed person';
      return { key: `${entry.person.kind}:${entry.person.id}`, label: entry.person.name ?? fallback };
    }
    case 'day': return { key: entry.day, label: entry.day };
    default: throw new RangeError(`unknown grouping: ${by}`);
  }
}

/**
 * Rows in groups, each with its count and how many rows of each priority it holds. Days
 * run newest first; types by their most urgent row, then service, then name; services in the usual
 * service order; priorities most urgent first; people by how many changes they made,
 * with "Not known" last. Rows keep their order inside a group. Pure.
 */
export function groupChangeFeed(rows, by = 'day') {
  if (!FEED_GROUPINGS.includes(by)) throw new RangeError(`unknown grouping: ${by}`);
  const groups = new Map();
  for (const entry of rows) {
    const { key, label } = feedGroupOf(entry, by);
    if (!groups.has(key)) groups.set(key, { key, label, count: 0, priorities: Object.fromEntries(PRIORITIES.map((priority) => [priority, 0])), rows: [], first: entry });
    const group = groups.get(key);
    group.count += 1;
    if (entry.priority in group.priorities) group.priorities[entry.priority] += 1;
    group.rows.push(entry);
  }
  const order = {
    day: (a, b) => b.key.localeCompare(a.key),
    type: (a, b) => worstRank(a) - worstRank(b) || serviceRank(a.first.service) - serviceRank(b.first.service) || a.label.localeCompare(b.label),
    service: (a, b) => serviceRank(a.first.service) - serviceRank(b.first.service),
    priority: (a, b) => priorityRank(a.key) - priorityRank(b.key),
    person: (a, b) => (a.key === 'unknown') - (b.key === 'unknown') || b.count - a.count || a.label.localeCompare(b.label),
  }[by];
  return [...groups.values()].sort(order).map(({ first, ...group }) => group);
}
