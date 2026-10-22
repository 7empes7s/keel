// How a list's filters combine, in one place so every page behaves the same:
//  - Summary tiles are one set. Picking several shows every row that matches any of
//    them (OR). No tile picked means no tile filter.
//  - Every other filter (service, kind, find, ...) narrows what the tiles show (AND).
// Counts are worked out against the other filters, so a tile always says how many rows
// it holds in the current view, and how many it would add to what is shown now.

export interface FilterTile<T> {
  key: string;
  test: (item: T) => boolean;
}

export interface TileCount {
  key: string;
  // Rows in this tile that pass every other filter.
  count: number;
  // Of those, rows not already shown by the picked tiles: what picking it would add.
  adds: number;
  picked: boolean;
}

/** Keys picked from a comma list, kept in the tiles' own order and without unknowns. */
export function pickedTiles<T>(tiles: readonly FilterTile<T>[], picked: readonly string[]): string[] {
  return tiles.map((tile) => tile.key).filter((key) => picked.includes(key));
}

/** Adds the key when it is not picked, removes it when it is. Keeps the tiles' order. */
export function toggleTile<T>(tiles: readonly FilterTile<T>[], picked: readonly string[], key: string): string[] {
  const current = pickedTiles(tiles, picked);
  return current.includes(key) ? current.filter((entry) => entry !== key) : pickedTiles(tiles, [...current, key]);
}

/** True when the row is in any picked tile, or when no tile is picked. */
export function inPickedTiles<T>(item: T, tiles: readonly FilterTile<T>[], picked: readonly string[]): boolean {
  const chosen = tiles.filter((tile) => picked.includes(tile.key));
  return chosen.length === 0 || chosen.some((tile) => tile.test(item));
}

/** The rows shown: in any picked tile (OR) and passing every other filter (AND). */
export function applyFilters<T>(items: readonly T[], tiles: readonly FilterTile<T>[], picked: readonly string[], others: readonly ((item: T) => boolean)[] = []): T[] {
  return items.filter((item) => others.every((test) => test(item)) && inPickedTiles(item, tiles, picked));
}

/** Each tile's count in the current view, and what picking it would add. */
export function tileCounts<T>(items: readonly T[], tiles: readonly FilterTile<T>[], picked: readonly string[], others: readonly ((item: T) => boolean)[] = []): TileCount[] {
  const base = items.filter((item) => others.every((test) => test(item)));
  const chosen = tiles.filter((tile) => picked.includes(tile.key));
  const shown = (item: T) => chosen.some((tile) => tile.test(item));
  return tiles.map((tile) => {
    const inTile = base.filter(tile.test);
    return { key: tile.key, count: inTile.length, adds: chosen.length ? inTile.filter((item) => !shown(item)).length : 0, picked: chosen.includes(tile) };
  });
}
