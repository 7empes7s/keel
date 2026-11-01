import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { addsWords, readPicked, tileParam, withoutTile, type FilterTile } from "@/lib/filter-set";

// Every page whose summary tiles filter a list must let them add up (OR), show the
// filters as removable chips, and never leave a dead end. This scans the portal so a
// new or changed page cannot quietly go back to single-pick tiles.

const ROOT = join(import.meta.dirname, "..", "components");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

// A tiles section whose tiles mark the picked one: these tiles filter a list.
const filterTilePages = files(ROOT)
  .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }))
  .filter(({ text }) => /className="[a-z]+-tiles"/.test(text) && /aria-current=\{(?!position)/.test(text));

// Single-pick tile links: picking one replaces the others instead of adding to them.
// A map over tiles that toggles one key (`filter === tile.key ? null : tile.key`), or two
// or more tiles that each set the same key to their own value. One tile that turns a
// single on/off filter on and off is fine.
function singlePicks(text: string): string[] {
  const found = [...text.matchAll(/\b([\w.]+) === (tile\.key|key|radius) \? null : \2\b/g), ...text.matchAll(/\bactive \? null : (tile\.key|key|radius)\b/g)].map((match) => match[0]);
  const byKey = new Map<string, Set<string>>();
  for (const match of text.matchAll(/\b([\w.]+) === ("[^"]+") \? null : \2/g)) byKey.set(match[1], (byKey.get(match[1]) ?? new Set()).add(match[2]));
  for (const [key, values] of byKey) if (values.size > 1) found.push(`${key}: ${[...values].join(", ")}`);
  return found;
}

test("the scan finds every page with filter tiles", () => {
  const found = filterTilePages.map(({ path }) => path).sort();
  for (const page of [
    "activity/activity-page.tsx", "alerts/alerts-page.tsx", "approval-inbox.tsx", "baselines/change-list.tsx",
    "compliance/compliance-page.tsx", "incidents/incidents-page.tsx", "notifications/notifications-page.tsx",
    "people/people-page.tsx", "policies/policies-page.tsx", "protect-coverage.tsx", "schedules/schedules-page.tsx",
    "value-report/value-report-page.tsx",
  ]) assert.ok(found.includes(page), `${page} has filter tiles`);
});

test("filter tiles add up, show chips and never dead-end", () => {
  for (const { path, text } of filterTilePages) {
    assert.deepEqual(singlePicks(text), [], `${path}: a tile replaces the picked one instead of adding to it. Use toggleTile or tileParam from lib/filter-set.`);
    assert.match(text, /from "@\/components\/list\/active-filters"/, `${path}: show the filters with ActiveFilters and the empty view with NoMatches`);
    assert.match(text, /<ActiveFilters\b/, `${path}: show the filters as removable chips with ActiveFilters`);
    assert.match(text, /<NoMatches\b/, `${path}: when nothing matches, show NoMatches so each filter can be removed`);
    assert.doesNotMatch(text, /Showing [^<]*only: \{/, `${path}: the old "Showing … only" note is replaced by ActiveFilters`);
    assert.doesNotMatch(text, /match(es)? this filter/, `${path}: an empty filtered list uses NoMatches, not a plain line`);
  }
});

test("address helpers: comma lists, old single links, toggles and adds", () => {
  const tiles: FilterTile<number>[] = [{ key: "a", test: () => true }, { key: "b", test: () => true }, { key: "c", test: () => true }];
  assert.deepEqual(readPicked(tiles, "c,a,zzz"), ["a", "c"], "kept in tile order, unknowns dropped");
  assert.deepEqual(readPicked(tiles, "b"), ["b"], "an old single-value link still works");
  assert.deepEqual(readPicked(tiles, null), []);
  assert.equal(tileParam(tiles, ["a"], "c"), "a,c", "a second tile adds to the first");
  assert.equal(tileParam(tiles, ["a", "c"], "a"), "c", "a picked tile comes off");
  assert.equal(tileParam(tiles, ["a"], "a"), null, "the last one off clears the key");
  assert.equal(tileParam(tiles, ["a", "b"], null), null, "the everything tile clears them all");
  assert.equal(withoutTile(["a", "b"], "a"), "b");
  assert.equal(withoutTile(["a"], "a"), null);
  assert.equal(addsWords({ key: "b", count: 4, adds: 3, picked: false }, 1), "+3 more if picked");
  assert.equal(addsWords({ key: "b", count: 1500, adds: 1190, picked: false }, 1), "+1,190 more if picked");
  assert.equal(addsWords({ key: "b", count: 4, adds: 0, picked: false }, 1), "Nothing new if picked");
  assert.equal(addsWords({ key: "b", count: 4, adds: 3, picked: false }, 0), null, "nothing picked: no adds line");
  assert.equal(addsWords({ key: "a", count: 4, adds: 0, picked: true }, 1), null, "a picked tile says nothing");
});

test("every tile says what it would add in the same words, from addsWords", () => {
  // "+190 if added" and "Adds none" read unclearly and were written by hand on three
  // pages; the hint now comes from one place.
  const lib = join(import.meta.dirname, "..", "lib");
  const sources = [...files(ROOT), ...readdirSync(lib).filter((name) => name.endsWith(".ts")).map((name) => join(lib, name))]
    .filter((path) => !path.endsWith("filter-set.ts"))
    .map((path) => ({ path: relative(join(ROOT, ".."), path), text: readFileSync(path, "utf8") }));
  for (const { path, text } of sources) {
    assert.doesNotMatch(text, /if added|Adds none|more if picked|Nothing new if picked/, `${path}: use addsWords from lib/filter-set for a tile's "would add" hint`);
  }
});
