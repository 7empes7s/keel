import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAlerts } from "@/lib/portal-data";
import type { DashboardData } from "@/lib/types";

// Codex review, 31 Oct: an audit record that is not checked (no off-site copy) read as
// "failed its integrity check". Not checked is amber; only a failed check is Urgent.
// A missing off-site copy is one Check soon item linked to Resilience.

function data(evidence: DashboardData["evidence"], offsite?: DashboardData["offsite"]) {
  return {
    activeBaseline: { resourceCount: 3 } as DashboardData["activeBaseline"],
    lastCollection: { completedAt: "2026-10-31T10:00:00Z", status: "complete" },
    coverage: { covered: 3, failed: 0, stale: 0, neverCollected: 0, notCovered: 0, unavailable: 0, total: 3 },
    evidence,
    offsite,
  };
}

test("no off-site copy is one Check soon item that also explains the unchecked audit record", () => {
  const alerts = buildAlerts(data({ ok: false, chainLength: 9, status: "unanchored" }, { measured: false }));
  assert.deepEqual(alerts.map((alert) => [alert.key, alert.severity, alert.href]), [["no-offsite", "warning", "/resilience"]]);
  assert.match(alerts[0].detail, /audit record cannot be checked/);
  assert.equal(alerts.some((alert) => /failed/i.test(alert.title)), false, "not checked never reads as failed");
});

test("an unchecked audit record without the off-site state reads Not checked, amber", () => {
  const alerts = buildAlerts(data({ ok: false, chainLength: 9, status: "unanchored" }));
  assert.deepEqual(alerts.map((alert) => [alert.key, alert.severity, alert.title]), [["audit-unchecked", "warning", "The audit record is not checked: no off-site copy"]]);
});

test("only a broken record is Urgent, and a measured off-site copy shows no item", () => {
  const broken = buildAlerts(data({ ok: false, chainLength: 9, status: "broken-at-sequence" }, { measured: true }));
  assert.deepEqual(broken.map((alert) => [alert.key, alert.severity, alert.title]), [["audit", "critical", "The audit record failed its integrity check"]]);
  assert.deepEqual(buildAlerts(data({ ok: true, chainLength: 9, status: "verified" }, { measured: true })), []);
  // Without an off-site copy but with a verified record, only the off-site item shows.
  assert.deepEqual(buildAlerts(data({ ok: true, chainLength: 9, status: "verified" }, { measured: false })).map((alert) => alert.key), ["no-offsite"]);
});
