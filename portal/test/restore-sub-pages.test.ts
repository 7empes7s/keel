import assert from "node:assert/strict";
import { test } from "node:test";

import { followUpTotals } from "@/components/restore-follow-ups";
import type { JobRecord } from "@/lib/portal-jobs";
import { pastRestoresVerdict } from "@/lib/restore-view";
import { servicesVerdict, type RestoreWorkload } from "@/lib/restore-workloads-view";

// The Restore section's sub-pages each lead with one plain sentence. Times are set
// relative to a fixed "now" passed in, never the wall clock.
const NOW = "2026-10-02T12:00:00Z";

function workload(name: string, service: string, backup: boolean, failed = false): RestoreWorkload {
  return {
    workload: name, name, service, reads: [], writes: [], todo: "",
    backup: backup ? { collectionId: `c-${name}`, takenAt: "2026-10-02T09:00:00Z", items: 3, partial: false } : null,
    lastRun: failed ? { collectionId: `f-${name}`, outcome: "failed", at: "2026-10-02T10:00:00Z", reasons: [] } : null,
  };
}

test("Exchange, Teams and more: what can be put back, and which backups failed", () => {
  assert.deepEqual(servicesVerdict([]), { text: "No other service has a backup yet, so there is nothing to put back here.", tone: "neutral" });
  assert.deepEqual(servicesVerdict([workload("exchange-mail-flow", "EXO", true), workload("teams-settings", "Teams", true), workload("purview-labels", "Purview", false)]),
    { text: "2 kinds of setting across 2 services can be put back.", tone: "fine" });
  const failed = servicesVerdict([workload("exchange-mail-flow", "EXO", true), workload("teams-org-policies", "Teams", false, true)]);
  assert.equal(failed.tone, "soon");
  assert.equal(failed.text, "1 kind of setting across 2 services can be put back. The newest backup of 1 kind failed: check them below.");
});

test("Past restores: the newest restore in one sentence, a failure linked to its page", () => {
  const job = (status: string, mode = "enforce") => ({ id: "j1", kind: "restore", status, params: { mode }, createdAt: "2026-10-02T09:00:00Z", startedAt: "2026-10-02T09:00:00Z", finishedAt: "2026-10-02T09:02:00Z" }) as unknown as JobRecord;
  assert.deepEqual(pastRestoresVerdict([], NOW), { text: "No restore has run on this tenant yet.", tone: "neutral", href: null });
  assert.deepEqual(pastRestoresVerdict([job("failed")], NOW), { text: "The newest restore failed. Open it to see why and plan it again.", tone: "urgent", href: "/jobs/j1" });
  const done = pastRestoresVerdict([job("succeeded", "dry-run")], NOW);
  assert.equal(done.tone, "fine");
  assert.match(done.text, /^The newest check before a restore: finished 2 hours ago/);
});

test("follow-up totals add the open steps of every restore", () => {
  assert.deepEqual(followUpTotals([]), { steps: 0, restores: 0 });
  assert.deepEqual(followUpTotals([{ restoreRef: "r1", pending: 2, since: NOW, jobId: "j" }, { restoreRef: "r2", pending: 1, since: NOW, jobId: null }]), { steps: 3, restores: 2 });
});
