import assert from "node:assert/strict";
import { test } from "node:test";

import { addItem, COOKIE_BUDGET, EMPTY_PREFS, isPortalHref, LIMITS, moveItem, parseMenuPrefs, removeItem, serializeMenuPrefs, toggleClosed } from "@/lib/menu-prefs";
import { menuStatuses, worstTone } from "@/lib/menu-status";
import { groupCheck, NO_SELECTION, orderGroups, picksTray, prune, selectRange, setMany, smartOrder, span, toggleOne } from "@/lib/selection";
import { addDays, addMonths, inRange, isDay, monthGrid, presets, rangeFromParam, rangeLabel, rangeToParam } from "@/lib/date-range";
import { serviceFor, SERVICES } from "@/lib/services";
import { SERVICES as TAXONOMY_SERVICES } from "../../engine/insights/taxonomy.mjs";

// The page frame's menu (Pinned, Favourites, closed groups, hidden), its
// section statuses, the shared list's selection rules and the date picker's dates.

test("menu preferences round-trip through the cookie and drop anything unsafe", () => {
  let prefs = EMPTY_PREFS;
  const added = addItem(prefs, "pinned", { href: "/drift?group=risk", label: "  Changes   by risk ", icon: "baselines" });
  assert.ok(added.ok);
  prefs = added.ok ? added.prefs : prefs;
  assert.deepEqual(prefs.pinned, [{ href: "/drift?group=risk", label: "Changes by risk", icon: "baselines" }]);
  prefs = toggleClosed({ ...prefs, hidden: true }, "favourites");
  assert.deepEqual(parseMenuPrefs(serializeMenuPrefs(prefs)), prefs);

  const hostile = encodeURIComponent(JSON.stringify({
    pinned: [
      { href: "https://evil.example", label: "Away", icon: "pin" },
      { href: "//evil.example/x", label: "Away", icon: "pin" },
      { href: "/\\evil", label: "Away", icon: "pin" },
      { href: "/ok", label: "", icon: "pin" },
      { href: "/ok", label: "Fine", icon: "not-an-icon" },
      { href: "/ok", label: "Duplicate", icon: "pin" },
    ],
    closed: ["pinned", "nope"],
    hidden: "yes",
  }));
  const parsed = parseMenuPrefs(hostile);
  assert.deepEqual(parsed.pinned, [{ href: "/ok", label: "Fine", icon: "page" }]);
  assert.deepEqual(parsed.closed, ["pinned"]);
  assert.equal(parsed.hidden, false);
  assert.deepEqual(parseMenuPrefs("%7Bnot json"), EMPTY_PREFS);
  // An older cookie's Custom group (saved views) folds into Favourites, after what is there.
  const legacy = parseMenuPrefs(encodeURIComponent(JSON.stringify({
    favourites: [{ href: "/jobs", label: "Jobs", icon: "page" }],
    custom: [{ href: "/drift?group=risk", label: "By risk", icon: "filter" }, { href: "/jobs", label: "Jobs again", icon: "page" }],
    closed: ["custom", "favourites"],
  })));
  assert.deepEqual(legacy.favourites, [{ href: "/jobs", label: "Jobs", icon: "page" }, { href: "/drift?group=risk", label: "By risk", icon: "filter" }]);
  assert.deepEqual(legacy.closed, ["favourites"]);
  assert.equal("custom" in legacy, false);
  // The server hands over the cookie already decoded; a % in a saved link must survive.
  const percent = addItem(EMPTY_PREFS, "favourites", { href: "/drift?q=50%25", label: "Half", icon: "page" });
  assert.ok(percent.ok);
  if (percent.ok) {
    assert.deepEqual(parseMenuPrefs(serializeMenuPrefs(percent.prefs)), percent.prefs);
    assert.deepEqual(parseMenuPrefs(decodeURIComponent(serializeMenuPrefs(percent.prefs))), percent.prefs);
  }
  assert.equal(isPortalHref("javascript:alert(1)"), false);
  assert.equal(isPortalHref("/jobs/a4"), true);
});

test("a full group refuses more, and the cookie stays under the browser's limit", () => {
  let prefs = EMPTY_PREFS;
  for (let index = 0; index < LIMITS.favourites; index += 1) {
    const result = addItem(prefs, "favourites", { href: `/jobs/${index}?view=${"x".repeat(150)}`, label: "A long favourite name that fills the label limit right up", icon: "audit" });
    if (!result.ok) {
      assert.equal(result.reason, "full");
      break;
    }
    prefs = result.prefs;
  }
  assert.ok(serializeMenuPrefs(prefs).length <= COOKIE_BUDGET);
  const more = addItem(prefs, "favourites", { href: `/one-more?view=${"x".repeat(150)}`, label: "A long favourite name that fills the label limit right up", icon: "audit" });
  assert.equal(more.ok, false);
});

test("pinned items move and come out in place", () => {
  let prefs = EMPTY_PREFS;
  for (const href of ["/a", "/b", "/c"]) {
    const result = addItem(prefs, "pinned", { href, label: href, icon: "page" });
    assert.ok(result.ok);
    if (result.ok) prefs = result.prefs;
  }
  prefs = moveItem(prefs, "pinned", "/c", -1);
  assert.deepEqual(prefs.pinned.map((item) => item.href), ["/a", "/c", "/b"]);
  assert.equal(moveItem(prefs, "pinned", "/a", -1), prefs, "the first item cannot move up");
  prefs = removeItem(prefs, "pinned", "/c");
  assert.deepEqual(prefs.pinned.map((item) => item.href), ["/a", "/b"]);
});

test("section statuses come from the Overview's data, in plain words", () => {
  const base: Parameters<typeof menuStatuses>[0] = {
    headline: { state: "unproven", tone: "attention", headline: "Backups need attention", sentence: "", action: null, counts: { backedUp: 0, restorable: 0, failing: 0, failed: 0, stale: 0, neverCollected: 0 }, proof: { restorable: 0, proven: 0, tested: 0, untested: 0, lastProvenAt: null, href: "/protect?health=proven" }, lastProvenRestoreAt: null, failingSince: null },
    coverage: { covered: 142, failed: 4, notCovered: 21, neverCollected: 2, stale: 3, unavailable: 0, total: 172 },
    openDriftByBlastRadius: [{ blastRadius: "tenant-lockout", count: 2 }, { blastRadius: "cosmetic", count: 5 }],
    openDriftTotal: 7,
    evidence: { ok: false, chainLength: 10 },
    waiting: { openAlerts: 3, openIncidents: 1, restoreFollowUps: 0 },
  };
  const statuses = menuStatuses(base, 2);
  assert.deepEqual(statuses.Backup, { tone: "urgent", count: 4, note: "4 setting types failed to back up, and 5 more are out of date" });
  assert.deepEqual(statuses.Baselines, { tone: "urgent", count: 2, note: "2 changes could lock out admins, of 7 changes since your approved setup" });
  assert.equal(statuses.Restore?.count, 1);
  assert.equal(statuses["Audit log"]?.tone, "urgent");
  assert.deepEqual(statuses.Inbox, { tone: "soon", count: 5, note: "2 approvals and 3 alerts waiting" });
  assert.equal(statuses.Dashboards?.tone, "soon");
  // A critical alert turns the Overview's banner red, and the menu's dot with it.
  const withAlert = menuStatuses({ ...base, alerts: [{ severity: "critical" } as never] }, 2);
  assert.equal(withAlert.Dashboards?.tone, "urgent");
  assert.equal(statuses.Reports, undefined, "a section with nothing to say shows nothing");
  assert.equal(worstTone(["low", "soon", undefined]), "soon");
  assert.equal(worstTone([]), null);
});

const ORDER = ["a", "b", "c", "d", "e"];

test("Shift+click selects from the anchor, in either direction, adding to the selection", () => {
  let selection = toggleOne(NO_SELECTION, "b");
  selection = selectRange(selection, ORDER, "d");
  assert.deepEqual([...selection.ids].sort(), ["b", "c", "d"]);
  selection = toggleOne(selection, "e");
  selection = selectRange(selection, ORDER, "a");
  assert.deepEqual([...selection.ids].sort(), ORDER);
  assert.deepEqual([...selectRange(NO_SELECTION, ORDER, "c").ids], ["c"], "no anchor selects the row alone");
});

test("select a whole group, see whether it is all, some or none, and keep only rows that remain", () => {
  let selection = setMany(NO_SELECTION, ["a", "b"], true);
  assert.equal(groupCheck(selection, ["a", "b"]), "all");
  assert.equal(groupCheck(selection, ["b", "c"]), "some");
  assert.equal(groupCheck(selection, ["d"]), "none");
  selection = setMany(selection, ["a"], false);
  assert.deepEqual([...selection.ids], ["b"]);
  assert.deepEqual([...prune(selection, ["a", "c"]).ids], []);
  assert.deepEqual(span(ORDER, "d", "b"), ["b", "c", "d"]);
});

test("the picks tray gathers picks by service in service order, keeping the pool's order inside each", () => {
  const pool = [
    { id: "x1", service: "Intune", rank: 1 },
    { id: "x2", service: "Entra", rank: 0 },
    { id: "x3", service: "Intune", rank: 1 },
    { id: "x4", service: "Exchange", rank: 2 },
    { id: "x5", service: "Entra", rank: 0 },
  ];
  const tray = picksTray(pool, (item) => item.id, (item) => ({ key: item.service, label: item.service, rank: item.rank }), new Set(["x3", "x1", "x5", "gone"]));
  assert.deepEqual(tray.groups.map((group) => [group.label, group.items.map((item) => item.id)]), [["Entra", ["x5"]], ["Intune", ["x1", "x3"]]]);
  assert.deepEqual(picksTray(pool, (item) => item.id, (item) => ({ key: item.service, label: item.service }), new Set()).groups, []);
});

test("smart order puts urgent first, then newest; groups that need action come first", () => {
  const items = [
    { id: 1, tone: "low" as const, at: "2026-10-02T00:00:00Z" },
    { id: 2, tone: "urgent" as const, at: "2026-09-01T00:00:00Z" },
    { id: 3, tone: "urgent" as const, at: "2026-10-01T00:00:00Z" },
    { id: 4, tone: "fine" as const, at: null },
  ];
  assert.deepEqual(smartOrder(items, (item) => item.tone, (item) => item.at).map((item) => item.id), [3, 2, 1, 4]);
  const groups = orderGroups([
    { key: "quiet", items: [1, 2, 3] },
    { key: "urgent", items: [1] },
    { key: "big-quiet", items: [1, 2, 3, 4] },
  ], (group) => (group.key === "urgent" ? "urgent" : "fine"));
  assert.deepEqual(groups.map((group) => group.key), ["urgent", "big-quiet", "quiet"]);
});

test("date presets, the month grid and URL ranges", () => {
  const today = "2026-10-16";
  assert.deepEqual(presets(today, "2026-10-15").map((preset) => [preset.label, preset.range]), [
    ["Today", { from: today }],
    ["Last 7 days", { from: "2026-10-10", to: today }],
    ["Last 30 days", { from: "2026-09-17", to: today }],
    ["Since last backup", { from: "2026-10-15", to: today }],
  ]);
  assert.equal(presets(today, "2026-10-20").length, 3, "a future backup is not a preset");
  const grid = monthGrid("2026-10-16");
  assert.equal(grid.length, 42);
  assert.equal(grid[0].day, "2026-09-28", "weeks start on Monday");
  assert.equal(grid.filter((cell) => cell.inMonth).length, 31);
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(isDay("2026-02-30"), false);
  assert.deepEqual(rangeFromParam(rangeToParam({ from: "2026-10-16", to: "2026-10-10" })), { from: "2026-10-10", to: "2026-10-16" });
  assert.equal(rangeFromParam("2026-10-10..nope"), null);
  assert.equal(inRange("2026-10-12", { from: "2026-10-10", to: "2026-10-16" }), true);
  assert.equal(rangeLabel({ from: "2026-10-10", to: today }, today, presets(today)), "Last 7 days · 10 Oct – 16 Oct");
  assert.equal(rangeLabel({ from: "2025-12-30" }, today), "30 Dec 2025");
  assert.equal(rangeLabel(null, today), "Any time");
});

test("services use Microsoft's own names and never show a bare code", () => {
  assert.deepEqual(SERVICES.slice(0, 6).map((service) => service.name), ["Entra ID", "Exchange Online", "SharePoint and OneDrive", "Teams", "Intune", "Power Platform"]);
  assert.equal(serviceFor("entra").name, "Entra ID");
  assert.equal(serviceFor("SomethingNew").name, "Other services");
  // Every service the engine's taxonomy files a type under has a name here.
  for (const code of TAXONOMY_SERVICES) assert.notEqual(serviceFor(code).name, "Other services", code);
});
