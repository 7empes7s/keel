/**
 * The rules of the approved setup's match percentage, with no database or Node APIs, so
 * the portal's pages (also in the browser) and the stored history use the same ones
 * (baselineScore.mjs stores the history; portal/lib/baselines-view.ts shows it live).
 *
 * - A kind the approved setup holds: it holds `held` settings. Each one changed or
 *   removed since no longer matches, and each one added is a setting it does not hold.
 * - A service read (Exchange, SharePoint and OneDrive, Teams, Purview, Power Platform):
 *   the latest read found `held` settings. Each one added or changed since does not
 *   match, and each one removed is a setting that is missing.
 * - Kinds not covered or not read are left out: nothing is known about them.
 * The percentage is matching ÷ judged, rounded down, so it never reads 100% while a
 * change is left (the Compliance score's rule).
 */
import { typeInfo } from '../insights/taxonomy.mjs';

const NO_CHANGES = Object.freeze({ added: 0, modified: 0, removed: 0 });

/** Matching ÷ judged as a whole percentage, rounded down; null when nothing is judged. */
export function matchPercent({ matching, judged }) {
  return judged ? Math.floor((matching / judged) * 100) : null;
}

/** How many settings of one kind match: `basis` is 'approved-setup' or 'previous-backup'. */
export function kindMatch(held, changes, basis) {
  if (basis === 'approved-setup') {
    return { judged: held + changes.added, matching: Math.max(0, held - changes.modified - changes.removed) };
  }
  return { judged: held + changes.removed, matching: Math.max(0, held - changes.added - changes.modified) };
}

const defaultServiceOf = (type) => typeInfo(type).service ?? 'other';

/**
 * Every kind scored on its own, then added up per service code.
 *  - captured: kinds the approved setup holds (its capture scope);
 *  - held: settings it holds, per kind;
 *  - changes: open changes to approved-setup kinds, per kind ({added, modified, removed});
 *  - reads: service reads [{type, read, itemCount, open}]: whether the latest read
 *    could be used, how many settings it found and its open changes. A read with no
 *    count or no open changes known is left out.
 * Returns Map(service code → {matching, judged}).
 * @param {{ captured?: string[], held?: Record<string, number>,
 *   changes?: Record<string, {added: number, modified: number, removed: number}>,
 *   reads?: {type: string, read: boolean, itemCount?: number | null, open?: {added: number, modified: number, removed: number} | null}[],
 *   serviceOf?: (type: string) => string }} input
 * @returns {Map<string, {matching: number, judged: number}>}
 */
export function scoreByService({ captured = [], held = {}, changes = {}, reads = [], serviceOf = defaultServiceOf }) {
  const readTypes = new Set(reads.map((read) => read.type));
  const readBy = new Map(reads.map((read) => [read.type, read]));
  const scored = new Set([...captured, ...Object.keys(changes), ...reads.filter((read) => read.read).map((read) => read.type)]);
  const counts = new Map();
  for (const type of scored) {
    const basis = readTypes.has(type) ? 'previous-backup' : 'approved-setup';
    let count;
    let tally;
    if (basis === 'approved-setup') {
      count = held[type] ?? 0;
      tally = changes[type] ?? NO_CHANGES;
    } else {
      const read = readBy.get(type);
      // A service read whose size or open changes are not known cannot be scored.
      if (!read?.read || !read.open || read.itemCount === null || read.itemCount === undefined) continue;
      count = read.itemCount;
      tally = read.open;
    }
    const match = kindMatch(count, tally, basis);
    if (!match.judged) continue;
    const code = serviceOf(type);
    const sum = counts.get(code) ?? { matching: 0, judged: 0 };
    counts.set(code, { matching: sum.matching + match.matching, judged: sum.judged + match.judged });
  }
  return counts;
}

/** Every service's counts added up; null when no service has one. */
export function overallCount(counts) {
  const list = [...counts.values()];
  if (!list.length) return null;
  return list.reduce((sum, count) => ({ matching: sum.matching + count.matching, judged: sum.judged + count.judged }), { matching: 0, judged: 0 });
}
