import assert from "node:assert/strict";
import test from "node:test";

import { byRisk, byText, byTime, pageCount, pageGroups, pageWindow, rangeWords, readPage, readPageSize, sortRows } from "../lib/paging";

test("page size reads 25, 50, 100 or all from the address, else the default", () => {
  assert.equal(readPageSize("50"), "50");
  assert.equal(readPageSize("all"), "all");
  assert.equal(readPageSize("7"), "25");
  assert.equal(readPageSize("", "100"), "100");
});

test("the page number stays inside the pages that exist", () => {
  assert.equal(pageCount(0, "25"), 1);
  assert.equal(pageCount(26, "25"), 2);
  assert.equal(pageCount(500, "all"), 1);
  assert.equal(readPage("", 100, "25"), 1);
  assert.equal(readPage("3", 100, "25"), 3);
  assert.equal(readPage("9", 100, "25"), 4);
  assert.equal(readPage("-2", 100, "25"), 1);
  assert.equal(readPage("x", 100, "25"), 1);
});

test("a page covers its rows and says so in words", () => {
  assert.deepEqual(pageWindow(2, 60, "25"), { start: 25, end: 50 });
  assert.deepEqual(pageWindow(3, 60, "25"), { start: 50, end: 60 });
  assert.deepEqual(pageWindow(1, 60, "all"), { start: 0, end: 60 });
  assert.equal(rangeWords(2, 60, "25"), "26–50 of 60");
  assert.equal(rangeWords(1, 0, "25"), "0 of 0");
  assert.equal(rangeWords(2, 26, "25"), "26 of 26");
});

test("a grouped list keeps each group's header on every page with its rows", () => {
  const groups = [{ key: "a", rows: 20 }, { key: "b", rows: 30 }, { key: "c", rows: 5 }];
  const page = (n: number, closed: string[] = []) => pageGroups(groups, (g) => g.rows, (g) => closed.includes(g.key), n, "25");
  const first = page(1);
  assert.equal(first.total, 55);
  assert.deepEqual(first.groups.map((g) => [g.group.key, g.start, g.end, g.continued, g.more]), [["a", 0, 20, false, 0], ["b", 0, 5, false, 25]]);
  assert.deepEqual(page(2).groups.map((g) => [g.group.key, g.start, g.end, g.continued, g.more]), [["b", 5, 30, true, 0]]);
  assert.deepEqual(page(3).groups.map((g) => [g.group.key, g.start, g.end]), [["c", 0, 5]]);
  // A closed group takes no rows; its header sits where its rows would start.
  const closed = page(1, ["b"]);
  assert.equal(closed.total, 25);
  assert.deepEqual(closed.groups.map((g) => g.group.key), ["a", "b", "c"]);
  // Everything on one page.
  assert.deepEqual(pageGroups(groups, (g) => g.rows, () => false, 1, "all").groups.map((g) => g.end), [20, 30, 5]);
});

test("a closed group at the end of a full page shows on the last page, not past it", () => {
  const groups = [{ key: "a", rows: 25 }, { key: "b", rows: 3 }];
  const result = pageGroups(groups, (g) => g.rows, (g) => g.key === "b", 1, "25");
  assert.deepEqual(result.groups.map((g) => g.group.key), ["a", "b"]);
});

test("sorting keeps ties in their order and flips for descending", () => {
  const rows = [{ n: "b", t: 1 }, { n: "a", t: 1 }, { n: "c", t: 2 }];
  assert.deepEqual(sortRows(rows, (x, y) => x.t - y.t, "asc").map((r) => r.n), ["b", "a", "c"]);
  assert.deepEqual(sortRows(rows, (x, y) => x.t - y.t, "desc").map((r) => r.n), ["c", "b", "a"]);
  assert.deepEqual(sortRows(rows, undefined, "desc").map((r) => r.n), ["b", "a", "c"]);
  assert.ok(byText("Item 2", "item 10") < 0);
  assert.ok(byTime("2026-10-01T00:00:00Z", null) > 0);
  assert.ok(byRisk("urgent", "low") > 0);
});
