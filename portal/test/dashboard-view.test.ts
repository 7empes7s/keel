import assert from "node:assert/strict";
import { test } from "node:test";

import { overviewVerdict } from "@/components/dashboard/status-hero";
import type { ProtectionHeadline } from "@/lib/types";
import { DRIFT_TREND_DAYS, fillDriftTrend } from "@/lib/portal-data";

test("the drift trend has one zero-filled point per UTC day, ending today", () => {
  const end = new Date("2026-10-02T09:40:00Z");
  const trend = fillDriftTrend([{ day: "2026-10-02", count: 4 }, { day: "2026-09-20", count: 2 }], end);
  assert.equal(trend.length, DRIFT_TREND_DAYS);
  assert.deepEqual(trend.at(-1), { day: "2026-10-02", count: 4 });
  assert.equal(trend[0].day, "2026-09-03");
  assert.equal(trend.find((point) => point.day === "2026-09-20")?.count, 2);
  assert.equal(trend.reduce((sum, point) => sum + point.count, 0), 6, "days outside the window are dropped");
});

test("the verdict keeps the engine's sentence; alerts can only make its tone worse", () => {
  const critical = { severity: "critical" as const, title: "a", detail: "" };
  const warning = { severity: "warning" as const, title: "b", detail: "" };
  const proven: ProtectionHeadline = {
    state: "proven", tone: "good", headline: "Protected",
    sentence: "KEEL can restore 48 of 52 configuration types today. Last proven restore: 20 Sept 2026.",
    action: null, counts: { backedUp: 52, restorable: 48, failing: 0, failed: 0, stale: 0, neverCollected: 0 },
    lastProvenRestoreAt: "2026-09-20T14:00:00Z", failingSince: null,
  };
  assert.deepEqual(overviewVerdict(proven, []), { tone: "good", headline: "Protected", sentence: proven.sentence, action: null });
  assert.equal(overviewVerdict(proven, [warning]).tone, "attention");
  assert.equal(overviewVerdict(proven, [warning]).headline, "Protected");
  const withCritical = overviewVerdict(proven, [warning, critical]);
  assert.equal(withCritical.tone, "critical");
  assert.equal(withCritical.headline, "Action needed");
  assert.equal(withCritical.sentence, proven.sentence, "the number is never replaced by an alert");
});
