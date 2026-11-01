import assert from "node:assert/strict";
import { test } from "node:test";

import { AUDIT_CHECK_WORDS, auditCheckOf, dashboardAuditCheck } from "@/lib/audit-check";
import { integrityWords } from "@/lib/activity-view";
import { integrationAlerts, integrationsPageVerdict, integrationsStatus } from "@/lib/integrations-view";
import { menuStatuses } from "@/lib/menu-status";
import { buildAlerts } from "@/lib/portal-data";
import type { DashboardData } from "@/lib/types";

// Codex review P0-02 (backlog C6): the Overview said the audit record failed its check
// while Activity said it was only not checked, and Integrations said "Working". A failed
// check and a record with no off-site copy to compare with are two states, with the same
// words and colours on every page, and a missing copy never hides a broken chain.

test("the check reads as one of four states, and a broken own chain is always failed", () => {
  assert.equal(auditCheckOf(null), "unknown");
  assert.equal(auditCheckOf({ ok: true, status: "verified" }), "intact");
  assert.equal(auditCheckOf({ ok: false, status: "unanchored", ownChain: "intact" }), "unchecked");
  assert.equal(auditCheckOf({ ok: false, status: "unanchored" }), "unchecked");
  assert.equal(auditCheckOf({ ok: false, status: "unanchored", ownChain: "broken" }), "failed");
  assert.equal(auditCheckOf({ ok: false, status: "broken-at-sequence" }), "failed");
  assert.equal(auditCheckOf({ ok: false, status: "truncated" }), "failed");
  assert.equal(dashboardAuditCheck({ ok: false, check: "unchecked" }), "failed", "the Overview's own chain outranks the off-site check");
  assert.equal(dashboardAuditCheck({ ok: true, check: "unchecked" }), "unchecked");
  assert.equal(dashboardAuditCheck({ ok: true }), "unknown");
});

test("Activity: no off-site copy over a broken chain is red Failed the check, not amber", () => {
  const broken = integrityWords({ ok: false, status: "unanchored", ownChain: "broken" });
  assert.deepEqual([broken.state, broken.label, broken.tone], ["broken", "Failed the check", "urgent"]);
  const unchecked = integrityWords({ ok: false, status: "unanchored", ownChain: "intact" });
  assert.deepEqual([unchecked.state, unchecked.label, unchecked.tone], ["unchecked", "Not checked: no off-site copy", "soon"]);
});

function overview(evidence: DashboardData["evidence"]) {
  return buildAlerts({
    activeBaseline: { resourceCount: 3 } as DashboardData["activeBaseline"],
    lastCollection: { completedAt: "2026-10-31T10:00:00Z", status: "complete" },
    coverage: { covered: 3, failed: 0, partial: 0, stale: 0, neverCollected: 0, notCovered: 0, unavailable: 0, total: 3 },
    evidence,
  }).filter((alert) => alert.key === "audit").map((alert) => [alert.severity, alert.title, alert.href]);
}

test("Overview: Urgent for a failed check, Check soon for no off-site copy, nothing when intact", () => {
  assert.deepEqual(overview({ ok: false, chainLength: 9, check: "unchecked" }), [["critical", "The audit record failed the check", "/activity?show=records"]]);
  assert.deepEqual(overview({ ok: true, chainLength: 9, check: "failed" }), [["critical", "The audit record failed the check", "/activity?show=records"]]);
  assert.deepEqual(overview({ ok: true, chainLength: 9, check: "unchecked" }), [["warning", "The audit record is not checked: no off-site copy", "/activity?show=records"]]);
  assert.deepEqual(overview({ ok: true, chainLength: 9, check: "intact" }), []);
  assert.deepEqual(overview({ ok: true, chainLength: 9 }), [], "an off-site check that could not be read says nothing");
});

test("menu: the Audit log badge has the Overview's colour and words", () => {
  const base: Parameters<typeof menuStatuses>[0] = {
    headline: null as never,
    coverage: { covered: 3, failed: 0, partial: 0, notCovered: 0, neverCollected: 0, stale: 0, unavailable: 0, total: 3 },
    openDriftByBlastRadius: [],
    openDriftTotal: 0,
    evidence: { ok: true, chainLength: 9, check: "unchecked" },
  };
  assert.deepEqual(menuStatuses(base)["Audit log"], { tone: "soon", note: AUDIT_CHECK_WORDS.unchecked.title });
  assert.deepEqual(menuStatuses({ ...base, evidence: { ok: false, chainLength: 9, check: "unchecked" } })["Audit log"], { tone: "urgent", note: AUDIT_CHECK_WORDS.failed.title });
  assert.equal(menuStatuses({ ...base, evidence: { ok: true, chainLength: 9, check: "intact" } })["Audit log"], undefined);
});

test("Integrations never says Working over an unchecked or failed audit record", () => {
  assert.deepEqual(integrationsStatus(integrationAlerts([], [], null, "intact")), { tone: "fine", label: "Working" });

  const unchecked = integrationAlerts([], [], null, "unchecked");
  assert.deepEqual(unchecked.filter((alert) => alert.key.startsWith("audit")).map((alert) => [alert.tone, alert.title, alert.action?.href]),
    [["soon", "The audit record is not checked: no off-site copy", "/activity?show=records"]]);
  assert.deepEqual(integrationsStatus(unchecked), { tone: "soon", label: "Check soon" });
  assert.equal(integrationsPageVerdict([], [], null, "unchecked").tone, "attention");

  const failed = integrationAlerts([], [], null, "failed");
  assert.equal(failed[0].key, "audit-failed", "a failed check comes first");
  assert.equal(failed[0].title, "The audit record failed the check");
  assert.deepEqual(integrationsStatus(failed), { tone: "urgent", label: "Needs attention" });
  assert.match(integrationsPageVerdict([], [], null, "failed").text, /^The audit record failed the check\./);

  assert.equal(integrationAlerts([], [], null).some((alert) => alert.key.startsWith("audit")), false, "an unread check adds nothing");
});
