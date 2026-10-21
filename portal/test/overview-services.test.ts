import assert from "node:assert/strict";
import { test } from "node:test";

import { protectionHeadline } from "../../engine/coverage/protectionHeadline.mjs";
import { headlineEntries, withWorkloadCoverage, workloadKinds } from "@/lib/workload-kinds";

const WORKLOADS = workloadKinds([
  { workload: "exchange-mail-flow", status: "complete", resources: null, observation: { endedAt: "2026-10-21T02:05:00Z" } },
  { workload: "teams-settings", status: "partial", resources: 4, observation: { endedAt: "2026-10-21T02:06:00Z" } },
  { workload: "purview-labels", status: "failed", resources: null, observation: { endedAt: "2026-10-21T02:07:00Z" } },
  { workload: "power-platform", status: "disabled", resources: null, observation: null },
  { workload: "onedrive-site-settings", status: "never-collected", resources: null, observation: null },
], new Set(["exchange-mail-flow"]));

test("the Overview ring counts every service's workloads beside the Entra ID and Intune types", () => {
  const summary = { covered: 80, failed: 2, notCovered: 0, neverCollected: 1, stale: 3, total: 94 };
  assert.deepEqual(withWorkloadCoverage(summary, WORKLOADS), {
    covered: 82, failed: 3, notCovered: 2, neverCollected: 1, stale: 3, total: 99,
  });
  assert.deepEqual(withWorkloadCoverage(summary, undefined), summary, "no workloads leave the counts as they are");
});

test("the Overview sentence counts a failed workload and leaves out one not switched on yet", () => {
  const types = [{ type: "group", status: "covered", stale: false, lastCollectedAt: "2026-10-21T00:00:00Z", fidelity: { declared: "full", verifiedBy: null } }];
  const healthy = protectionHeadline([...types, ...headlineEntries(WORKLOADS.filter((kind) => kind.type !== "purview-labels"))] as never);
  assert.equal(healthy.counts.backedUp, 3, "one type and two workloads read");
  assert.equal(healthy.counts.failing, 0, "a workload never read or switched off is not a failure");
  assert.equal(healthy.counts.restorable, 2, "the group and the workload Keel can put back");

  const failing = protectionHeadline([...types, ...headlineEntries(WORKLOADS)] as never);
  assert.equal(failing.counts.failed, 1);
  assert.equal(failing.state, "collection");
});
