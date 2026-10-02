import assert from "node:assert/strict";
import { test } from "node:test";

import { postureFor } from "@/components/dashboard/status-hero";
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

test("posture is the worst alert severity, and never claims more than was checked", () => {
  const critical = { severity: "critical" as const, title: "a", detail: "" };
  const warning = { severity: "warning" as const, title: "b", detail: "" };
  assert.equal(postureFor([warning, critical]).tone, "critical");
  assert.match(postureFor([warning, critical]).summary, /1 critical issue and 1 warning/);
  assert.equal(postureFor([warning]).headline, "Degraded");
  assert.equal(postureFor([]).headline, "No issues detected");
});
