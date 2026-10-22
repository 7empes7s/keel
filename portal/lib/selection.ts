import type { IconName } from "@/components/shell/icons";
import type { RiskTone } from "@/lib/menu-status";

// Shared list behaviour (handoff/redesign/CHOICE.md, "Lists, Restore and Baselines"):
// what is selected, the anchor a Shift+click range starts from, and the default order.
// Pure functions, so every list selects the same way and tests can drive them directly.
export interface Selection {
  ids: ReadonlySet<string>;
  // The last row clicked on its own; a Shift+click selects from here.
  anchor: string | null;
}

export const NO_SELECTION: Selection = Object.freeze({ ids: new Set<string>(), anchor: null });

export function toggleOne(selection: Selection, id: string): Selection {
  const ids = new Set(selection.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

/** Shift+click: every row from the anchor to this one is selected, added to what was
 * selected before. With no anchor it selects this row alone. */
export function selectRange(selection: Selection, order: readonly string[], id: string): Selection {
  const to = order.indexOf(id);
  const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  if (to === -1) return selection;
  if (from === -1) return { ids: new Set([...selection.ids, id]), anchor: id };
  const [start, end] = from <= to ? [from, to] : [to, from];
  return { ids: new Set([...selection.ids, ...order.slice(start, end + 1)]), anchor: selection.anchor };
}

/** Select (or clear) a set of rows at once: a group header, Select all, a drag. */
export function setMany(selection: Selection, ids: Iterable<string>, on: boolean): Selection {
  const next = new Set(selection.ids);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return { ids: next, anchor: selection.anchor };
}

/** Rows between two positions, inclusive, in either direction (a phone drag). */
export function span(order: readonly string[], a: string, b: string): string[] {
  const from = order.indexOf(a);
  const to = order.indexOf(b);
  if (from === -1 || to === -1) return [];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** Keeps only rows that still exist (after a filter or a refresh). */
export function prune(selection: Selection, present: readonly string[]): Selection {
  const keep = new Set(present);
  const ids = new Set([...selection.ids].filter((id) => keep.has(id)));
  return ids.size === selection.ids.size ? selection : { ids, anchor: selection.anchor && keep.has(selection.anchor) ? selection.anchor : null };
}

export type GroupCheck = "all" | "some" | "none";

export function groupCheck(selection: Selection, ids: readonly string[]): GroupCheck {
  const count = ids.filter((id) => selection.ids.has(id)).length;
  return count === 0 ? "none" : count === ids.length ? "all" : "some";
}

const TONE_RANK: Record<RiskTone, number> = { urgent: 0, soon: 1, low: 2, fine: 3 };

/** Smart order: urgent first, then check soon, low risk and fine; newest first within each. */
export function smartOrder<T>(items: readonly T[], toneOf: (item: T) => RiskTone | null | undefined, timeOf: (item: T) => string | null | undefined): T[] {
  const time = (item: T) => {
    const value = timeOf(item);
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isNaN(parsed) ? -Infinity : parsed;
  };
  return [...items].sort((a, b) => (TONE_RANK[toneOf(a) ?? "fine"] - TONE_RANK[toneOf(b) ?? "fine"]) || (time(b) - time(a)));
}

/** Groups ordered by what needs action: the most serious item first, then the bigger
 * group, then the given order. */
export function orderGroups<G extends { items: readonly unknown[] }>(groups: readonly G[], worst: (group: G) => RiskTone | null): G[] {
  return groups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => (TONE_RANK[worst(a.group) ?? "fine"] - TONE_RANK[worst(b.group) ?? "fine"]) || (b.group.items.length - a.group.items.length) || (a.index - b.index))
    .map(({ group }) => group);
}

// Where a pick sits in the tray: its group (such as the service) and the group's place.
export interface PickGroup { key: string; label: string; icon?: IconName; rank?: number }

/** The picks for the tray, gathered by group: groups by `rank` (then first seen), and
 * picks inside a group in the pool's order. */
export function picksTray<T>(pool: readonly T[], getId: (item: T) => string, groupOf: (item: T) => PickGroup, picked: ReadonlySet<string>) {
  const groups = new Map<string, PickGroup & { items: T[] }>();
  for (const item of pool) {
    if (!picked.has(getId(item))) continue;
    const group = groupOf(item);
    const entry = groups.get(group.key) ?? { ...group, items: [] };
    entry.items.push(item);
    groups.set(group.key, entry);
  }
  const order = [...groups.values()];
  return { groups: order.map((group, index) => ({ group, index })).sort((a, b) => ((a.group.rank ?? 0) - (b.group.rank ?? 0)) || (a.index - b.index)).map(({ group }) => group) };
}
