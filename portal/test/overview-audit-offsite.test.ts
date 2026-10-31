import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAlerts } from "@/lib/portal-data";
import type { DashboardData } from "@/lib/types";

// Codex review, 31 Oct: a missing off-site copy is one Check soon item on the Overview,
// linked to Resilience. The audit row stays for a failed check of the record's own chain.

function data(evidence: DashboardData["evidence"], offsite?: DashboardData["offsite"], covered = 3) {
  return {
    activeBaseline: { resourceCount: 3 } as DashboardData["activeBaseline"],
    lastCollection: { completedAt: "2026-10-31T10:00:00Z", status: "complete" },
    coverage: { covered, failed: 0, stale: 0, neverCollected: 0, notCovered: 0, unavailable: 0, total: covered },
    evidence,
    offsite,
  };
}

test("no off-site copy is one Check soon item linked to Resilience", () => {
  const alerts = buildAlerts(data({ ok: true, chainLength: 9 }, { measured: false }));
  assert.deepEqual(alerts.map((alert) => [alert.key, alert.severity, alert.href]), [["no-offsite", "warning", "/resilience"]]);
});

test("no item when a checked copy exists, the state could not be read, or nothing is backed up yet", () => {
  assert.deepEqual(buildAlerts(data({ ok: true, chainLength: 9 }, { measured: true })), []);
  assert.deepEqual(buildAlerts(data({ ok: true, chainLength: 9 })), []);
  assert.deepEqual(buildAlerts(data({ ok: true, chainLength: 9 }, { measured: false }, 0)).map((alert) => alert.key), []);
});

test("a failed chain check is still Urgent", () => {
  const alerts = buildAlerts(data({ ok: false, chainLength: 9 }, { measured: true }));
  assert.deepEqual(alerts.map((alert) => [alert.key, alert.severity]), [["audit", "critical"]]);
});
