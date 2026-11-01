import assert from "node:assert/strict";
import { test } from "node:test";

import { listWorkloads } from "../../engine/collect/registry.mjs";
import "../../engine/coverage/report.mjs";
import { SERVICE_FILES } from "../../engine/insights/taxonomy.mjs";
import { CATALOG } from "../../tools/tenant-probe/catalog.mjs";
import { typeService } from "@/lib/baselines-view";
import { backupHealth, backupSentence, protectScopeDetail, restoreStanding, withWorkloadKinds } from "@/lib/protect-view";
import type { CoverageData, CoverageType } from "@/lib/types";
import { workloadKinds } from "@/lib/workload-kinds";

const NOW = "2026-10-21T10:00:00.000Z";

// The coverage report's `workloads` rows, as engine/coverage/report.mjs builds them.
function reportWorkload(workload: string, status: string, extra: Record<string, unknown> = {}) {
  return { workload, type: workload, status, covered: status === "complete", observation: null, resources: null, fieldCounts: null, outOfScope: null, reasons: [], ...extra };
}

function catalogKind(type: string): CoverageType {
  return {
    type, reportStatus: "covered", protectionState: "protected", stale: false, itemCount: 1, lastCollectedAt: NOW, adapter: `graph/${type}`,
    outcome: "complete", detail: null, fidelity: { declared: "full", measured: null, verifiedAt: null }, criticality: "tier1", blastRadius: null, remappable: null,
  };
}

function coverage(workloads: unknown): CoverageData {
  return {
    generatedAt: NOW, snapshot: null,
    summary: { covered: 0, failed: 0, notCovered: CATALOG.length, neverCollected: 0, stale: 0, unavailable: 0, total: CATALOG.length },
    types: CATALOG.map((entry: { type: string }) => catalogKind(entry.type)),
    workloads: workloadKinds(workloads, new Set(["exchange-mail-flow"])),
  };
}

test("What's protected groups by every service Keel reads, not only Entra ID and Intune", () => {
  const raw = listWorkloads().map((descriptor: { workload: string }) => reportWorkload(descriptor.workload, "never-collected"));
  const page = withWorkloadKinds(coverage(raw));
  const shown = new Set(page.types.map((item) => typeService(item.type).code));
  const read = new Set<string>(SERVICE_FILES.map((file) => file.service));
  assert.deepEqual([...shown].sort(), [...read].sort());
  assert.ok(read.size > 2, "the taxonomy reads more than Entra ID and Intune");
  // No workload falls into "Other services".
  assert.ok(page.types.every((item) => typeService(item.type).name !== "Other services"));
  assert.equal(page.types.length, CATALOG.length + raw.length);
});

test("a workload's last run reads as its backup health", () => {
  const kinds = workloadKinds([
    reportWorkload("exchange-mail-flow", "complete", { resources: 23, observation: { startedAt: "2026-10-21T02:00:00.000Z", endedAt: "2026-10-21T02:04:00.000Z" } }),
    reportWorkload("teams-org-policies", "failed", { observation: { startedAt: "2026-10-21T02:00:00.000Z", endedAt: "2026-10-21T02:01:00.000Z" } }),
    reportWorkload("purview-labels", "disabled", { reasons: ["no live proof"] }),
    reportWorkload("power-platform-settings", "never-collected"),
    reportWorkload("sharepoint-site-settings", "partial", { resources: 4, observation: { startedAt: "2026-10-21T02:00:00.000Z", endedAt: "2026-10-21T02:03:00.000Z" } }),
  ], new Set(["exchange-mail-flow"]));
  const [mailFlow, teams, purview, power, sharepoint] = kinds;

  assert.equal(backupHealth(mailFlow), "ok");
  assert.equal(mailFlow.lastCollectedAt, "2026-10-21T02:04:00.000Z");
  assert.equal(mailFlow.itemCount, 23);
  assert.equal(restoreStanding(mailFlow), "unproven");

  assert.equal(backupHealth(teams), "failed");
  assert.equal(backupHealth(sharepoint), "failed");
  assert.equal(restoreStanding(sharepoint), "cannot-restore");

  for (const off of [purview, power]) {
    assert.equal(backupHealth(off), "not-collected");
    assert.equal(off.lastCollectedAt, null);
    assert.match(backupSentence(off, NOW), /switches this on for your tenant once a live read from it is checked/);
  }
});

test("a report without workloads leaves the page as it was", () => {
  const data = coverage(undefined);
  assert.deepEqual(data.workloads, []);
  assert.equal(withWorkloadKinds(data), data);
});

test("a filtered Protect verdict names its filter and every service's totals", () => {
  const ok = catalogKind("conditionalAccessPolicies");
  const failed = { ...catalogKind("namedLocations"), outcome: "failed" as const, reportStatus: "failed" as const };
  const never = { ...catalogKind("groups"), lastCollectedAt: null, itemCount: null, outcome: null, reportStatus: "never-collected" as const };
  assert.equal(backupHealth(failed), "failed");
  assert.equal(backupHealth(never), "never");
  assert.equal(
    protectScopeDetail(["In Intune"], [ok, failed, never]),
    "Counts follow your filter: In Intune. Across all services: 1 of 3 setting types backed up, 1 failed, 1 out of date or never.",
  );
  // Nothing wrong anywhere: only the backed-up total.
  assert.equal(protectScopeDetail(["In Teams"], [ok]), "Counts follow your filter: In Teams. Across all services: 1 of 1 setting type backed up.");
});
