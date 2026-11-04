/**
 * Insights in words (insights track A7 and A8): what changed in a period and where to
 * start. Moved here from the portal (portal/lib/insights-view.ts) so the Insights page and
 * the weekly summary (summary.mjs) say the same thing from the same code. Pure and free of
 * Node built-ins, so the portal's client code can use it too.
 */
import { groupChangeFeed } from './feedGroups.mjs';
import { SERVICES } from './taxonomy.mjs';
import { ago } from './words.mjs';

export { ago };

/**
 * The object as a reader names it: never an id.
 * @param {{ object: { name: string | null }, typeName: string }} row
 * @returns {string}
 */
export function feedObjectName(row) {
  if (row.object.name) return row.object.name;
  // "Unnamed group", but "Unnamed Conditional Access policy": a name that starts with a
  // proper noun keeps its capitals.
  const [head, next] = row.typeName.split(' ');
  const common = /^[A-Z][a-z]+$/.test(head ?? '') && !/^[A-Z]/.test(next ?? '');
  return `Unnamed ${common ? row.typeName.charAt(0).toLowerCase() + row.typeName.slice(1) : row.typeName}`;
}

/**
 * The person or app as a reader names them (a code name when names are hidden).
 * @param {{ person: { kind: string, name: string | null } | null }} row
 * @returns {string}
 */
export function feedPersonName(row) {
  if (!row.person) return 'Not known';
  return row.person.name ?? (row.person.kind === 'servicePrincipal' ? 'Unnamed app' : 'Unnamed person');
}

/**
 * The row's flags, most severe first (the engine sends them so).
 * @param {{ flags?: { key: string, severity: 'critical' | 'high', sentence: string }[] }} row
 */
export function feedFlags(row) {
  return Array.isArray(row.flags) ? row.flags : [];
}

/** @param {{ flags?: unknown[] }} row */
export const isFlagged = (row) => feedFlags(row).length > 0;

const plural = (count, one, many) => `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`;

/**
 * The page's one sentence: how many changes, and how many need a look.
 * "143 changes in the last 7 days; 4 need a look." / "…; none flagged." When the feed
 * hit its limit the count is a floor, so it says "At least".
 * @param {{ rows: object[], truncated: boolean }} feed
 * @param {string} period days, as text ("7")
 * @returns {{ text: string, tone: 'urgent' | 'soon' | 'fine' }}
 */
export function insightsVerdict(feed, period) {
  const span = `in the last ${period} days`;
  if (!feed.rows.length) return { text: `No changes ${span}.`, tone: 'fine' };
  const flagged = feed.rows.filter(isFlagged);
  const total = `${feed.truncated ? 'At least ' : ''}${plural(feed.rows.length, 'change', 'changes')}`;
  const sentence = (rest) => `${total.charAt(0).toUpperCase()}${total.slice(1)} ${span}; ${rest}.`;
  if (!flagged.length) return { text: sentence('none flagged'), tone: 'fine' };
  const critical = flagged.some((row) => feedFlags(row).some((flag) => flag.severity === 'critical'));
  return { text: sentence(`${flagged.length.toLocaleString('en-GB')} ${flagged.length === 1 ? 'needs' : 'need'} a look`), tone: critical ? 'urgent' : 'soon' };
}

const SEVERITY_RANK = Object.freeze({ critical: 0, high: 1 });
const PRIORITY_RANK = Object.freeze({ critical: 0, high: 1, normal: 2, low: 3 });
const worstFlag = (row) => Math.min(...feedFlags(row).map((flag) => SEVERITY_RANK[flag.severity] ?? 2));
const newestFirst = (a, b) => b.occurredAt.localeCompare(a.occurredAt);

const VERBS = Object.freeze({ added: 'added', modified: 'changed', removed: 'removed' });

function kindWords(typeName) {
  // "a Conditional Access policy", "an app registration": a name that starts with a proper
  // noun keeps its capitals, as feedObjectName does.
  const [head, next] = typeName.split(' ');
  const common = /^[A-Z][a-z]+$/.test(head ?? '') && !/^[A-Z]/.test(next ?? '');
  const words = common ? typeName.charAt(0).toLowerCase() + typeName.slice(1) : typeName;
  return `${/^[aeiou]/i.test(words) ? 'an' : 'a'} ${words}`;
}

// "Sharing settings (SharePoint sharing settings)": a plural kind takes no article.
const objectWithKind = (name, typeName) => (/settings$/i.test(typeName) ? `${name} (${typeName})` : `${name}, ${kindWords(typeName)},`);

/**
 * Where a change is listed: Every change, for the same period, found by its name.
 * @returns {string}
 */
export function changeHref(row, period) {
  const params = new URLSearchParams({ view: 'feed' });
  if (period !== '30') params.set('days', period);
  params.set('q', feedObjectName(row).toLowerCase());
  return `/changes?${params.toString()}`;
}

/**
 * One change as a sentence: who did what to which object, and when. Never an id.
 * "Amara Okafor changed Block legacy auth, a Conditional Access policy, 2 hours ago."
 * @returns {string}
 */
export function startSentence(row, now) {
  const name = feedObjectName(row);
  const who = row.person ? feedPersonName(row) : 'Someone Keel could not name';
  return `${who} ${VERBS[row.change]} ${objectWithKind(name, row.typeName)} ${ago(row.occurredAt, now)}.`;
}

function startItem(row, reason, period, now) {
  const flags = feedFlags(row);
  const critical = reason === 'flagged' ? flags.some((flag) => flag.severity === 'critical') : row.priority === 'critical';
  return {
    id: row.id, reason, tone: critical ? 'urgent' : 'soon', sentence: startSentence(row, now), flags,
    objectName: feedObjectName(row), who: feedPersonName(row), when: ago(row.occurredAt, now), occurredAt: row.occurredAt,
    href: changeHref(row, period),
  };
}

/**
 * Where to start: flagged changes first, most severe then newest; then changes to
 * critical or high kinds that no rule flagged, most urgent then newest.
 */
export function whereToStart(rows, period, now) {
  const flagged = rows.filter(isFlagged).sort((a, b) => worstFlag(a) - worstFlag(b) || newestFirst(a, b));
  const watch = rows
    .filter((row) => !isFlagged(row) && (row.priority === 'critical' || row.priority === 'high'))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || newestFirst(a, b));
  return {
    flagged: flagged.map((row) => startItem(row, 'flagged', period, now)),
    watch: watch.map((row) => startItem(row, 'watch', period, now)),
  };
}

/** Changes by service, the busiest first; each opens Every change for the period, by service. */
export function changesByService(rows, period) {
  return groupChangeFeed(rows, 'service')
    .map((group) => ({
      key: group.key,
      label: group.label,
      count: group.count,
      flagged: group.rows.filter(isFlagged).length,
      href: `/changes?${new URLSearchParams({ view: 'feed', ...(period !== '30' ? { days: period } : {}), group: 'service' }).toString()}`,
    }))
    .sort((a, b) => b.count - a.count);
}

/** Services Keel reads that had no change in the period. */
export function quietServices(rows) {
  const busy = new Set(rows.map((row) => row.service).filter(Boolean));
  return SERVICES.filter((service) => !busy.has(service));
}
