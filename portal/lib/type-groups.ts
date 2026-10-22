import { typeInfo } from "../../engine/insights/taxonomy.mjs";
import { serviceOrder } from "@/lib/services";

// Inside one service, rows sit under the kind of thing they are: "Users and contacts",
// "Groups and administrative units", "Admin roles", then policies, then tenant-wide
// settings (engine/insights/taxonomy.d, `categories`). Every list that shows a service's
// settings groups them with this, so Restore, What's protected, Approved setup and
// Compare all read the same way.
export interface KindPart<T> {
  key: string;
  label: string;
  items: T[];
}

/** Where a type sorts inside `service`: its group, then its place in that group. A type
 * filed under another service (a policy another app created) sorts after the service's
 * own groups, still under its own group's name. */
export function kindRank(type: string, service?: string | null): [number, number] {
  // The service places a kind it stores under its own code ("transportRule" under
  // Exchange) that the taxonomy does not map by name.
  const info = typeInfo(type, service ?? null);
  const foreign = service != null && info.service != null && info.service.toLowerCase() !== service.toLowerCase();
  return [info.categoryRank + (foreign ? 100 : 0), info.typeRank];
}

/** One sort key across services: the service's place, then the kind group, then the
 * type's place in it. A list grouped by type (not by service) sorts its groups by this. */
export function kindOrder(type: string, service: string | null = typeInfo(type).service): number {
  const [kind, place] = kindRank(type, service);
  return serviceOrder(service) * 100_000 + kind * 1_000 + place;
}

/** Sort comparator for types inside one service. */
export function compareKinds(a: string, b: string, service?: string | null): number {
  const [ca, ta] = kindRank(a, service);
  const [cb, tb] = kindRank(b, service);
  return ca - cb || ta - tb || typeInfo(a).name.localeCompare(typeInfo(b).name);
}

/** The rows of one service, split by kind, in the service's order. Inside a part, rows
 * keep the type order and then `within` (a name, or newest first). */
export function kindParts<T>(items: readonly T[], typeOf: (item: T) => string, service?: string | null, within?: (a: T, b: T) => number): KindPart<T>[] {
  const parts = new Map<string, { rank: number; label: string; items: T[] }>();
  for (const item of items) {
    const info = typeInfo(typeOf(item), service ?? null);
    const [rank] = kindRank(typeOf(item), service);
    // A group from another service keeps its own key, so it never merges with this
    // service's group of the same name.
    const key = rank >= 100 ? `${info.service}-${info.category}` : info.category;
    const part = parts.get(key) ?? { rank, label: info.categoryName, items: [] as T[] };
    part.items.push(item);
    parts.set(key, part);
  }
  return [...parts.entries()]
    .sort(([, a], [, b]) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(([key, part]) => ({
      key,
      label: part.label,
      items: part.items
        .map((item, index) => ({ item, index }))
        .sort((x, y) => compareKinds(typeOf(x.item), typeOf(y.item), service) || (within ? within(x.item, y.item) : 0) || x.index - y.index)
        .map(({ item }) => item),
    }));
}
