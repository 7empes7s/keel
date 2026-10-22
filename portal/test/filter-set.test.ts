import assert from "node:assert/strict";
import { test } from "node:test";

import { changeTiles, SERVICES_TILE, tileParams } from "@/lib/change-tiles";
import { applyFilters, inPickedTiles, pickedTiles, tileCounts, toggleTile } from "@/lib/filter-set";
import type { DriftRecord } from "@/lib/types";

const RADII = ["tenant-lockout", "access-affecting", "cosmetic"];
const change = (id: string, blastRadius: string, extra: Partial<DriftRecord> = {}) => ({ id, blastRadius, resourceType: "group", ...extra }) as unknown as DriftRecord;
const service = { workload: "exchange-mail-flow", resourceKey: "k", collectionId: "c2", previousCollectionId: "c1", alertId: null, alertState: null };
const items = [
  change("lock1", "tenant-lockout"),
  change("lock2", "tenant-lockout", { resourceType: "namedLocation" }),
  change("acc1", "access-affecting"),
  change("cos1", "cosmetic"),
  // A service setting change is also on a risk level.
  change("svc1", "access-affecting", { serviceRead: service } as Partial<DriftRecord>),
  change("svc2", "access-affecting", { serviceRead: service } as Partial<DriftRecord>),
];
const tiles = changeTiles(RADII);
const ids = (list: DriftRecord[]) => list.map((item) => item.id);

test("no tile picked shows every change", () => {
  assert.deepEqual(ids(applyFilters(items, tiles, [])), ids(items));
});

test("tiles add up: cosmetic and service settings shows both sets, not their overlap", () => {
  // The reported bug: these two together showed 0 because they were ANDed.
  assert.deepEqual(ids(applyFilters(items, tiles, ["cosmetic", SERVICES_TILE])), ["cos1", "svc1", "svc2"]);
  assert.deepEqual(ids(applyFilters(items, tiles, ["tenant-lockout", "cosmetic"])), ["lock1", "lock2", "cos1"]);
});

test("a row in two picked tiles shows once", () => {
  assert.deepEqual(ids(applyFilters(items, tiles, ["access-affecting", SERVICES_TILE])), ["acc1", "svc1", "svc2"]);
});

test("other filters narrow the tiles (AND)", () => {
  const onlyLocations = (item: DriftRecord) => item.resourceType === "namedLocation";
  assert.deepEqual(ids(applyFilters(items, tiles, ["tenant-lockout", "cosmetic"], [onlyLocations])), ["lock2"]);
  assert.deepEqual(ids(applyFilters(items, tiles, [], [onlyLocations])), ["lock2"]);
  // Two other filters must both hold.
  assert.deepEqual(ids(applyFilters(items, tiles, [], [onlyLocations, (item) => item.id === "lock1"])), []);
});

test("unknown tile keys are ignored rather than hiding everything", () => {
  assert.deepEqual(pickedTiles(tiles, ["nonsense", "cosmetic"]), ["cosmetic"]);
  assert.equal(inPickedTiles(items[0], tiles, ["nonsense"]), true);
});

test("toggling adds and removes a tile and keeps the tiles' order", () => {
  assert.deepEqual(toggleTile(tiles, [], SERVICES_TILE), [SERVICES_TILE]);
  assert.deepEqual(toggleTile(tiles, [SERVICES_TILE], "cosmetic"), ["cosmetic", SERVICES_TILE]);
  assert.deepEqual(toggleTile(tiles, ["cosmetic", SERVICES_TILE], "tenant-lockout"), ["tenant-lockout", "cosmetic", SERVICES_TILE]);
  assert.deepEqual(toggleTile(tiles, ["tenant-lockout", "cosmetic"], "tenant-lockout"), ["cosmetic"]);
});

test("counts follow the other filters and say what each tile would add", () => {
  const byKey = (list: ReturnType<typeof tileCounts>) => Object.fromEntries(list.map((entry) => [entry.key, [entry.count, entry.adds, entry.picked]]));
  // Nothing picked: plain counts, nothing to add yet.
  assert.deepEqual(byKey(tileCounts(items, tiles, [])), {
    "tenant-lockout": [2, 0, false], "access-affecting": [3, 0, false], cosmetic: [1, 0, false], [SERVICES_TILE]: [2, 0, false],
  });
  // Service settings picked: access-affecting holds 3 but adds only 1 (the other 2 already show).
  assert.deepEqual(byKey(tileCounts(items, tiles, [SERVICES_TILE])), {
    "tenant-lockout": [2, 2, false], "access-affecting": [3, 1, false], cosmetic: [1, 1, false], [SERVICES_TILE]: [2, 0, true],
  });
  // A find narrows the counts too.
  const lockOnly = (item: DriftRecord) => item.id.startsWith("lock");
  assert.deepEqual(byKey(tileCounts(items, tiles, ["cosmetic"], [lockOnly])), {
    "tenant-lockout": [2, 2, false], "access-affecting": [0, 0, false], cosmetic: [0, 0, true], [SERVICES_TILE]: [0, 0, false],
  });
});

test("the picked tiles live in the address as risk=a,b and from=services", () => {
  assert.deepEqual(tileParams([]), { risk: null, from: null });
  assert.deepEqual(tileParams(["cosmetic", SERVICES_TILE]), { risk: "cosmetic", from: SERVICES_TILE });
  assert.deepEqual(tileParams(["tenant-lockout", "cosmetic"]), { risk: "tenant-lockout,cosmetic", from: null });
});
