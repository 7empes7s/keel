import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAlerts } from "@/lib/portal-data";
import type { DashboardData } from "@/lib/types";

// Codex review, 31 Oct: a missing off-site copy is one Check soon item on the Overview,
// linked to Resilience. The audit row stays for a failed check of the record's own chain.

function data(evidence: DashboardData["evidence"], offsite?: DashboardData["offsite"], covered = 3, backupStorage?: DashboardData["backupStorage"]) {
  return {
    activeBaseline: { resourceCount: 3 } as DashboardData["activeBaseline"],
    lastCollection: { completedAt: "2026-10-31T10:00:00Z", status: "complete" },
    coverage: { covered, failed: 0, stale: 0, neverCollected: 0, notCovered: 0, unavailable: 0, total: covered },
    evidence,
    offsite,
    backupStorage,
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

// Decision 3 of the Codex triage: off-site copy and deletable backups share one Check soon
// item on the Overview, in plain words, linked to Resilience.
test("deletable backups with no off-site copy stay one item that says both", () => {
  const alerts = buildAlerts(data({ ok: true, chainLength: 9 }, { measured: false }, 3, "deletable"));
  assert.deepEqual(alerts.map((alert) => [alert.key, alert.severity, alert.href]), [["no-offsite", "warning", "/resilience"]]);
  assert.match(alerts[0].detail, /lost with it\. They can also be deleted where they are kept\. Fix the daily off-site copy\./);
});

test("unknown storage with no off-site copy says Keel cannot tell", () => {
  const [alert] = buildAlerts(data({ ok: true, chainLength: 9 }, { measured: false }, 3, "unknown"));
  assert.equal(alert.key, "no-offsite");
  assert.match(alert.detail, /cannot tell whether they can be deleted/);
});

test("deletable backups with a checked off-site copy are their own Check soon item", () => {
  const alerts = buildAlerts(data({ ok: true, chainLength: 9 }, { measured: true }, 3, "deletable"));
  assert.deepEqual(alerts.map((alert) => [alert.key, alert.severity, alert.title, alert.href]), [["deletable", "warning", "Backups can be deleted", "/resilience"]]);
  const [unknown] = buildAlerts(data({ ok: true, chainLength: 9 }, { measured: true }, 3, "unknown"));
  assert.equal(unknown.title, "Backup storage unknown");
});

test("locked or unread storage and nothing backed up add no storage item", () => {
  assert.deepEqual(buildAlerts(data({ ok: true, chainLength: 9 }, { measured: true }, 3, "other")), []);
  assert.deepEqual(buildAlerts(data({ ok: true, chainLength: 9 }, { measured: true }, 3)), []);
  assert.deepEqual(buildAlerts(data({ ok: true, chainLength: 9 }, { measured: true }, 0, "deletable")), []);
  assert.equal(buildAlerts(data({ ok: true, chainLength: 9 }, { measured: false }, 3, "other"))[0].detail,
    "If this server is lost, its backups are lost with it. Fix the daily off-site copy.");
});
