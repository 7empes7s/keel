import type { FilterTile } from "@/lib/filter-set";
import type { DriftRecord } from "@/lib/types";

// The summary tiles are one set: each risk level, and service setting changes. Picking
// several shows every change in any of them; service, kind and find narrow that.
export const SERVICES_TILE = "services";
export function changeTiles(radii: readonly string[]): FilterTile<DriftRecord>[] {
  return [
    ...radii.map((radius) => ({ key: radius, test: (item: DriftRecord) => item.blastRadius === radius })),
    { key: SERVICES_TILE, test: (item: DriftRecord) => Boolean(item.serviceRead) },
  ];
}

/** The address keys behind the tiles: risk levels as a comma list in `risk`, and
 *  `from=services` for service setting changes. */
export function tileParams(picked: readonly string[]): { risk: string | null; from: string | null } {
  const risks = picked.filter((key) => key !== SERVICES_TILE);
  return { risk: risks.join(",") || null, from: picked.includes(SERVICES_TILE) ? SERVICES_TILE : null };
}

