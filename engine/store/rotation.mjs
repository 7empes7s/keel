/**
 * Wave 2 RET: the pure rotation rules behind retention (no database here).
 *
 * A policy keeps, in a group of backups (one snapshot tier, or the versions of one
 * content item):
 * - the newest backup of each of the newest `daily` days that hold a backup, and the
 *   same for `weekly` (ISO weeks), `monthly` and `yearly` (all UTC);
 * - every backup newer than `keepWithinDays`;
 * - everything, when `keepForever` is set.
 * A period with no backup in it uses no slot, so a quiet item keeps its old versions.
 *
 * Policies and legal holds carry a scope: tenant-wide (no workload), a workload, a
 * container in it, or one item in that container. Snapshots use workload `config`,
 * their tier as the container and their id as the item. The most specific matching
 * policy wins; every matching hold applies.
 */
export const DEFAULT_ROTATION = Object.freeze({
  daily: 14, weekly: 8, monthly: 12, yearly: 7, keepWithinDays: 0, keepForever: false,
});

export const PERIODS = Object.freeze(['daily', 'weekly', 'monthly', 'yearly']);
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  return `${year}-W${pad(Math.ceil(((d - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7))}`;
}

export const PERIOD_KEYS = Object.freeze({
  daily: (date) => date.toISOString().slice(0, 10),
  weekly: isoWeek,
  monthly: (date) => date.toISOString().slice(0, 7),
  yearly: (date) => date.toISOString().slice(0, 4),
});

export function normalizePolicy(policy = {}) {
  const out = {};
  for (const key of [...PERIODS, 'keepWithinDays']) {
    const value = policy[key] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`retention ${key} must be a whole number of 0 or more`);
    out[key] = value;
  }
  if (policy.keepForever !== undefined && typeof policy.keepForever !== 'boolean') {
    throw new TypeError('retention keepForever must be true or false');
  }
  out.keepForever = policy.keepForever === true;
  if (!out.keepForever && !out.keepWithinDays && PERIODS.every((key) => out[key] === 0)) {
    throw new TypeError('a retention policy must keep something: a count, keepWithinDays or keepForever');
  }
  return Object.freeze(out);
}

export function describePolicy(policy) {
  if (policy.keepForever) return 'keep forever';
  const parts = PERIODS.filter((key) => policy[key]).map((key) => `${policy[key]} ${key}`);
  if (policy.keepWithinDays) parts.push(`all within ${policy.keepWithinDays} days`);
  return parts.join(', ');
}

/**
 * members: [{ id, at: Date, rotates }] where `rotates: false` means the member never
 * takes a period slot (an unfinished snapshot). Returns Map id -> reasons it is kept by
 * this policy (empty when the policy does not keep it).
 */
export function rotationReasons(members, policy, now) {
  const p = normalizePolicy(policy);
  const reasons = new Map(members.map((m) => [m.id, []]));
  if (p.keepForever) {
    for (const m of members) reasons.get(m.id).push('keep forever');
    return reasons;
  }
  if (p.keepWithinDays) {
    const cutoff = new Date(now).getTime() - p.keepWithinDays * DAY_MS;
    for (const m of members) if (m.at.getTime() >= cutoff) reasons.get(m.id).push(`within ${p.keepWithinDays} days`);
  }
  const slots = members.filter((m) => m.rotates !== false)
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  for (const period of PERIODS) {
    if (!p[period]) continue;
    const seen = new Set();
    for (const m of slots) {
      const key = PERIOD_KEYS[period](m.at);
      if (seen.has(key)) continue;
      if (seen.size >= p[period]) break;
      seen.add(key);
      reasons.get(m.id).push(`${period} ${key}`);
    }
  }
  return reasons;
}

const covers = (rule, { workload, container, itemKey }) =>
  (rule.workload == null || rule.workload === workload)
  && (rule.container == null || rule.container === container)
  && (rule.itemKey == null || rule.itemKey === itemKey);

const specificity = (rule) => [rule.workload, rule.container, rule.itemKey].filter((v) => v != null).length;

export function describeScope(rule) {
  if (rule.workload == null) return 'tenant';
  return [rule.workload, rule.container, rule.itemKey].filter((v) => v != null).join(' / ');
}

/** The most specific policy covering the scope, or the default. */
export function resolvePolicy(policies, scope) {
  let best = null;
  for (const rule of policies) {
    if (covers(rule, scope) && (!best || specificity(rule) > specificity(best))) best = rule;
  }
  const policy = normalizePolicy(best ?? DEFAULT_ROTATION);
  return { policy, rule: best, label: `${best ? describeScope(best) : 'default'}: ${describePolicy(policy)}` };
}

export function matchingHolds(holds, scope) {
  return holds.filter((hold) => covers(hold, scope));
}

/** A kept reason's family, for report totals: "daily 2026-10-14" -> "daily". */
export function reasonKind(reason) {
  if (reason.startsWith('legal hold')) return 'legal hold';
  if (reason.startsWith('referenced')) return 'referenced';
  if (reason.startsWith('within')) return 'within window';
  return reason.replace(/ \d{4}(-W?\d{2})?(-\d{2})?$/, '');
}
