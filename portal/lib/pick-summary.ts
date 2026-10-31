import type { IconName } from "@/components/shell/icons";
import type { RiskTone } from "@/lib/menu-status";

// What a confirm panel says about the things chosen for one action: counts by service,
// kind and risk, then every pick in a table. A long list of names in one paragraph is
// unreadable past a handful, so panels summarise instead.

export interface PickFacet {
  key: string;
  label: string;
  // Where the facet sorts: services in Microsoft's order, kinds in the service's order,
  // risk most serious first. Lower comes first.
  rank: number;
}

export interface PickItem {
  id: string;
  name: string;
  service: PickFacet & { icon?: IconName };
  kind: PickFacet;
  risk?: (PickFacet & { tone: RiskTone | null }) | null;
}

export interface PickCount<F extends PickFacet = PickFacet> {
  facet: F;
  count: number;
}

export interface PickCounts {
  services: PickCount<PickItem["service"]>[];
  kinds: PickCount[];
  risks: PickCount<NonNullable<PickItem["risk"]>>[];
}

function countBy<F extends PickFacet>(items: readonly PickItem[], facetOf: (item: PickItem) => F | null | undefined): PickCount<F>[] {
  const counts = new Map<string, PickCount<F>>();
  for (const item of items) {
    const facet = facetOf(item);
    if (!facet) continue;
    const entry = counts.get(facet.key) ?? { facet, count: 0 };
    entry.count += 1;
    counts.set(facet.key, entry);
  }
  return [...counts.values()].sort((a, b) => a.facet.rank - b.facet.rank || a.facet.label.localeCompare(b.facet.label));
}

/** The counts a confirm panel shows: by service, by kind and by risk, each in its order. */
export function pickCounts(items: readonly PickItem[]): PickCounts {
  return {
    services: countBy(items, (item) => item.service),
    kinds: countBy(items, (item) => item.kind),
    risks: countBy(items, (item) => item.risk),
  };
}

/** "Entra ID 775" style chips past this many kinds fold into "and N more kinds". */
export const KIND_CHIPS = 6;
