import assert from "node:assert/strict";
import { test } from "node:test";

import { protectionHeadline } from "../../engine/coverage/protectionHeadline.mjs";
import { menuStatuses } from "@/lib/menu-status";
import { coverageSegments, overviewTiles } from "@/lib/overview-view";
import { coverageBuckets, coverageSentence, coverageSummary, protectCounts, withWorkloadKinds } from "@/lib/protect-view";
import { serviceStatuses } from "@/lib/setup-services";
import type { CoverageData, CoverageType, DashboardData, ProtectionHeadline } from "@/lib/types";
import { headlineEntries, workloadKinds } from "@/lib/workload-kinds";

// Audit 31 Oct 2026, metrics 3 and 4: failed, not backed up and backed up kinds
// disagreed between Overview, the menu, What's protected and Setup, and the parts did
// not add up to the total. Every one now counts the same kinds with coverageBuckets.

const NOW = "2026-10-21T10:00:00.000Z";

const WORKLOADS = workloadKinds([
  { workload: "exchange-mail-flow", status: "complete", resources: null, observation: { endedAt: "2026-10-21T02:05:00Z" } },
  // Partly done: its own amber count everywhere, never failed and never backed up (decision 31 Oct 2026).
  { workload: "teams-settings", status: "partial", resources: 4, observation: { endedAt: "2026-10-21T02:06:00Z" } },
  { workload: "purview-labels", status: "failed", resources: null, observation: { endedAt: "2026-10-21T02:07:00Z" } },
  { workload: "power-platform", status: "disabled", resources: null, observation: null },
  { workload: "onedrive-site-settings", status: "never-collected", resources: null, observation: null },
], new Set(["exchange-mail-flow"]));

function kind(type: string, extra: Partial<CoverageType> = {}): CoverageType {
  return {
    type, reportStatus: "covered", protectionState: "protected", stale: false, itemCount: 3, lastCollectedAt: "2026-10-21T09:00:00Z",
    adapter: `graph/${type}`, outcome: "complete", detail: null, fidelity: { declared: "full", measured: null, verifiedAt: null },
    criticality: "tier1", blastRadius: null, remappable: null, ...extra,
  };
}

// The Entra ID and Intune types, normalized, and the raw engine rows they came from.
const TYPES: CoverageType[] = [
  kind("group"),
  kind("user", { outcome: "complete-empty", itemCount: 0 }),
  kind("namedLocation", { stale: true, lastCollectedAt: "2026-10-01T00:00:00Z" }),
  kind("conditionalAccessPolicy", { reportStatus: "failed", protectionState: "failed", outcome: "failed" }),
  // A partly done type read: "partial" on What's protected and the Overview, not failed.
  kind("application", { reportStatus: "failed", protectionState: "failed", outcome: "partial", itemCount: 40 }),
  kind("crossTenantAccessPolicyPartner", { reportStatus: "never-collected", outcome: "not-requested", lastCollectedAt: null, itemCount: null }),
  kind("deviceConfiguration", { reportStatus: "failed", protectionState: "failed", outcome: "unavailable", itemCount: null }),
  kind("managedDevice", { reportStatus: "not-covered", protectionState: "not-covered", adapter: null, outcome: null, lastCollectedAt: null, itemCount: null }),
];
const RAW = TYPES.map((item) => ({
  type: item.type,
  status: item.reportStatus,
  outcome: item.outcome,
  stale: item.stale,
  lastCollectedAt: item.lastCollectedAt,
  fidelity: { declared: item.fidelity.declared, verifiedBy: null },
}));
const DATA: CoverageData = { generatedAt: NOW, snapshot: null, summary: coverageSummary([...TYPES, ...WORKLOADS]), types: TYPES, workloads: WORKLOADS };
const KINDS = withWorkloadKinds(DATA).types;

test("every kind lands in exactly one bucket, so the buckets add up to the total", () => {
  const buckets = coverageBuckets(KINDS);
  assert.deepEqual(buckets, {
    total: 13,
    backedUp: 3, // group, user (empty), exchange-mail-flow
    failed: 2, // conditionalAccessPolicy, purview-labels
    partial: 2, // application, teams-settings
    stale: 1,
    never: 1,
    notCollected: 3, // managedDevice, power-platform (switched off), onedrive-site-settings (switched off)
    unavailable: 1,
  });
  const { total, ...parts } = buckets;
  assert.equal(Object.values(parts).reduce((sum, value) => sum + value, 0), total);
  assert.equal(coverageSentence(DATA.summary), "13 kinds: 3 backed up, 2 failed, 2 partly done, 2 out of date or never, 3 not backed up by Keel yet and 1 not on this tenant.");
});

test("the Overview sentence, ring, tile and menu badge count what What's protected counts", () => {
  const headline = protectionHeadline(headlineEntries(RAW, KINDS) as never) as ProtectionHeadline;
  const protect = protectCounts(KINDS);
  assert.equal(headline.counts.failed, protect.failed, "partly done reads are not failed in the sentence either");
  assert.equal(headline.counts.partial, protect.partial);
  assert.equal(headline.sentence, "6 configuration types have no complete, current backup; the last backup failed for 2 and was only partly done for 2 of them.");
  assert.equal(headline.counts.stale, protect.stale);
  assert.equal(headline.counts.neverCollected, protect.never);
  assert.equal(headline.counts.backedUp, protect.backedUp);
  assert.equal(headline.counts.failing, protect.failed + protect.partial + protect.stale + protect.never, "switched-off and unavailable kinds are not failures");

  const ring = coverageSegments(DATA.summary);
  assert.equal(ring.total, KINDS.length);
  assert.equal(ring.segments.reduce((sum, segment) => sum + segment.value, 0), ring.total, "the ring's parts add up to every kind");
  assert.deepEqual(ring.segments.map((segment) => [segment.key, segment.value, segment.href]), [
    ["covered", 3, "/protect?health=backed-up"],
    ["failed", 2, "/protect?health=failed"],
    ["partial", 2, "/protect?health=partial"],
    ["late", 2, "/protect?health=out-of-date"],
    ["uncovered", 3, "/protect"],
    ["unavailable", 1, "/protect"],
  ]);

  const dashboard = {
    generatedAt: NOW, coverage: DATA.summary, headline, alerts: [], openDriftByBlastRadius: [], openDriftTotal: 0,
    evidence: { ok: true, chainLength: 1 }, waiting: { openAlerts: 0, openIncidents: 0, restoreFollowUps: 0 },
  } as unknown as DashboardData;
  const tile = overviewTiles(dashboard, null).find((entry) => entry.key === "backups")!;
  assert.equal(tile.value, "2 failed");
  assert.equal(tile.detail, "3 of 13 kinds backed up, 2 partly done");
  assert.equal(menuStatuses(dashboard).Backup?.count, protect.failed, "the menu badge is What's protected's failed count");
});

test("Setup's service lines add up to the same failed kinds", () => {
  const services = serviceStatuses(KINDS, NOW);
  const failed = services.reduce((sum, service) => sum + (Number(/^(\d+) kinds? failed/.exec(service.backup.text)?.[1]) || 0), 0);
  assert.equal(failed, protectCounts(KINDS).failed);
});

test("a workload never read or switched off is not a failure in the sentence", () => {
  const healthy = KINDS.filter((item) => ["group", "exchange-mail-flow", "power-platform", "onedrive-site-settings"].includes(item.type));
  const headline = protectionHeadline(headlineEntries(RAW, healthy) as never);
  assert.equal(headline.counts.backedUp, 2);
  assert.equal(headline.counts.failing, 0);
  assert.equal(headline.counts.restorable, 2, "the group and the workload Keel can put back");
});
