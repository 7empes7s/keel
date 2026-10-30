import assert from "node:assert/strict";
import { test } from "node:test";

import { chartFloor, changeTone, changeWords, historyRows, historyServices, historySummary, percentTone, readRange, seriesFor, type ScorePoint } from "@/lib/baseline-history-view";

// Every time is fixed: NOW, and points placed relative to it.
const NOW = "2026-10-30T12:00:00Z";
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
const count = (matching: number, judged: number) => ({ matching, judged, percent: judged ? Math.floor((matching / judged) * 100) : null });
const point = (id: string, days: number, overall: [number, number], services: Record<string, [number, number]>, extra: Partial<ScorePoint> = {}): ScorePoint => ({
  id, baselineId: "b1", recordedAt: daysAgo(days), trigger: "backup", sourceId: null, ...count(...overall),
  services: Object.fromEntries(Object.entries(services).map(([code, pair]) => [code, count(...pair)])), ...extra,
});

const POINTS = [
  point("p3", 1, [95, 100], { Intune: [20, 20], Entra: [75, 80] }, { trigger: "service-read", baselineId: "b2" }),
  point("p1", 60, [80, 100], { Entra: [60, 80], Intune: [20, 20] }),
  point("p2", 10, [70, 100], { Entra: [50, 80], Intune: [20, 20], Exchange: [0, 0] }),
];

test("the series keeps the period and the line, oldest first", () => {
  assert.deepEqual(seriesFor(POINTS, "overall", "30", NOW).map((entry) => entry.percent), [70, 95]);
  assert.deepEqual(seriesFor(POINTS, "overall", "all", NOW).map((entry) => entry.percent), [80, 70, 95]);
  assert.deepEqual(seriesFor(POINTS, "Entra", "90", NOW).map((entry) => entry.percent), [75, 62, 93]);
  // A service with nothing judged has no percentage, so no point on its line.
  assert.deepEqual(seriesFor(POINTS, "Exchange", "all", NOW), []);
  assert.equal(readRange("bogus"), "30");
  assert.equal(readRange("all"), "all");
});

test("the summary names the latest, the change in the period and the lowest point", () => {
  const summary = historySummary(seriesFor(POINTS, "overall", "all", NOW))!;
  assert.equal(summary.latest, 95);
  assert.equal(summary.change, 15);
  assert.equal(summary.lowest.percent, 70);
  assert.equal(summary.highest.percent, 95);
  assert.equal(historySummary([]), null);
  assert.equal(historySummary([{ at: NOW, percent: 50 }])!.change, null);
});

test("rows are newest first, each compared with the point before it", () => {
  const rows = historyRows(POINTS);
  assert.deepEqual(rows.map((row) => [row.point.id, row.change]), [["p3", 25], ["p2", -10], ["p1", null]]);
  // Services in Microsoft's order, with their own change.
  assert.deepEqual(rows[0].services.map((entry) => [entry.service.name, entry.change]), [["Entra ID", 31], ["Intune", 0]]);
  assert.equal(rows[0].newSetup, true);
  assert.equal(rows[1].newSetup, false);
  assert.deepEqual(historyServices(POINTS).map((service) => service.code), ["Entra", "Exchange", "Intune"]);
});

test("words and colours: rising is good, falling needs a look, the rings' bands", () => {
  assert.equal(changeWords(3), "+3 points");
  assert.equal(changeWords(-1), "−1 point");
  assert.equal(changeWords(0), "No change");
  assert.deepEqual([changeTone(2), changeTone(-2), changeTone(0), changeTone(null)], ["fine", "urgent", "neutral", "neutral"]);
  assert.deepEqual([percentTone(90), percentTone(89), percentTone(59), percentTone(null)], ["fine", "soon", "urgent", "neutral"]);
});

test("the chart's floor sits under the lowest point, in tens, never above 50", () => {
  assert.deepEqual([chartFloor(97), chartFloor(64), chartFloor(41), chartFloor(5)], [50, 50, 30, 0]);
});
