/**
 * What a partial service backup (a workload run) could not read, as short lines the
 * Job page lists: "what: why". Read from the run's stored digest, so it works for
 * every collector: failed or refused families, families not licensed or not switched
 * on, more objects than one run reads, objects without an identity, settings Microsoft
 * did not return. Never a payload: each line holds a name, a count or a short error,
 * and never a family's raw key or a parent's object id.
 */

/** "transportRule" as "Transport rule"; a family key is never shown raw. */
export function familyWords(family) {
  const words = String(family ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words ? words.replace(/^./, (letter) => letter.toUpperCase()) : 'Part of this backup';
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** A failed family read's short error: its HTTP status or code, then its message. */
function failureText(failure) {
  const error = failure?.error ?? {};
  const http = Number.isInteger(error.httpStatus) ? `HTTP ${error.httpStatus}` : null;
  const denied = failure?.status === 'denied' ? 'access denied' : null;
  const message = typeof error.message === 'string' ? error.message.replace(/\s+/g, ' ').trim() : '';
  return [denied, http, message].filter(Boolean).join(': ') || String(failure?.status ?? 'failed');
}

/** The lines for one run's digest; empty when the digest names nothing specific. */
export function workloadGapReasons(digest) {
  if (!digest || typeof digest !== 'object') return [];
  const lines = [];
  for (const failure of Array.isArray(digest.failures) ? digest.failures : []) {
    const where = failure?.family ?? failure?.group;
    lines.push(`${familyWords(where)}: ${failureText(failure)}`);
  }
  for (const entry of Array.isArray(digest.unavailable) ? digest.unavailable : []) {
    lines.push(`${familyWords(entry?.family)}: not licensed in this tenant${entry?.license ? ` (${entry.license})` : ''}`);
  }
  for (const entry of Array.isArray(digest.skipped) ? digest.skipped : []) {
    const family = typeof entry === 'string' ? entry : entry?.family;
    lines.push(`${familyWords(family)}: not switched on yet, so it was not read`);
  }
  const discovery = digest.discovery ?? {};
  for (const family of Array.isArray(discovery.empty) ? discovery.empty : []) {
    lines.push(`${familyWords(family)}: Microsoft returned nothing, though a working tenant always has some`);
  }
  if (discovery.capped) {
    const limit = discovery.maxObjects ?? discovery.maxMailboxes ?? discovery.maxSites;
    lines.push(`More objects than one run reads${Number.isInteger(limit) ? ` (the limit is ${limit})` : ''}`);
  }
  const unidentified = Number(discovery.unidentified) || 0;
  if (unidentified > 0) lines.push(`${plural(unidentified, 'object', 'objects')}: returned without an identity, so ${unidentified === 1 ? 'it' : 'they'} could not be kept`);
  const unparented = Number(discovery.unparented) || 0;
  if (unparented > 0) lines.push(`${plural(unparented, 'object', 'objects')}: ${unparented === 1 ? 'its parent was' : 'their parents were'} not read`);
  const conflicts = Array.isArray(discovery.conflicts) ? discovery.conflicts.length : Number(discovery.conflicts) || 0;
  if (conflicts > 0) lines.push(`${plural(conflicts, 'object', 'objects')}: two answers with the same identity`);
  for (const entry of Array.isArray(digest.outOfScope) ? digest.outOfScope : []) {
    const name = typeof entry === 'string' ? entry : entry?.identity ?? entry?.site ?? entry?.url;
    if (name) lines.push(`${name}: ${typeof entry?.reason === 'string' && entry.reason ? entry.reason : 'outside the backup scope'}`);
  }
  for (const [status, count] of Object.entries(digest.fieldCounts ?? {})) {
    if (status !== 'observed' && Number(count) > 0) lines.push(`${plural(Number(count), 'setting', 'settings')}: not read (${status.replaceAll('-', ' ')})`);
  }
  for (const reason of Array.isArray(digest.reasons) ? digest.reasons : []) {
    lines.push(typeof reason === 'string' ? reason : JSON.stringify(reason));
  }
  // One line per gap: a family refused for each of its parents is listed once, with a count.
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return [...counts].map(([line, count]) => (count > 1 ? `${line} (${count} times)` : line));
}
