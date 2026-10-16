import assert from "node:assert/strict";
import { test } from "node:test";

import { plainLabel, quickComparisons, serviceSummaries, setupStatus, setupVerdict } from "@/lib/baselines-view";
import type { BaselineRecord } from "@/lib/types";

const NOW = "2026-10-02T09:40:00Z";
const active = {
  id: "b1", label: "Golden state", active: true, setAt: "2026-09-29T14:00:00Z", resourceCount: 10,
  capture: { capturedAt: "2026-09-30T09:40:00Z", sourceSnapshotId: "s-approved", types: ["conditionalAccessPolicy", "group", "deviceConfiguration"] },
} as unknown as BaselineRecord;

test("each service sums up what is in line, changed and not covered, worst first", () => {
  const summaries = serviceSummaries(active, [
    { resourceType: "deviceConfiguration", blastRadius: "cosmetic" },
    { resourceType: "conditionalAccessPolicy", blastRadius: "tenant-lockout" },
  ], ["group", "namedLocation", "deviceCompliancePolicy"]);
  const [entra, intune] = summaries;
  assert.equal(entra.service.name, "Entra ID");
  assert.equal(entra.tone, "urgent");
  assert.deepEqual([entra.changed, entra.inLine, entra.notCovered], [1, ["group"], ["namedLocation"]]);
  assert.equal(intune.service.name, "Intune");
  assert.deepEqual([intune.changed, intune.notCovered], [1, ["deviceCompliancePolicy"]]);
});

test("the status and verdict say how the tenant stands, in words", () => {
  assert.deepEqual(setupStatus(null, []), { tone: "urgent", label: "None approved" });
  assert.deepEqual(setupStatus(active, []), { tone: "fine", label: "In line" });
  assert.deepEqual(setupStatus(active, [{ blastRadius: "access-affecting" }]), { tone: "soon", label: "1 change to review" });
  assert.equal(setupVerdict(active, [], NOW).text, "The tenant matches “Golden state”, captured 2 days ago.");
  assert.equal(setupVerdict(active, [{ blastRadius: "tenant-lockout" }, { blastRadius: "cosmetic" }], NOW).text,
    "2 changes since “Golden state”, captured 2 days ago; 1 could lock out admins.");
  assert.equal(plainLabel("conditionalAccessPolicy:Block legacy auth"), "Block legacy auth (sign-in rule)");
  assert.equal(plainLabel("namedLocation:HQ"), "HQ (trusted location)");
});

test("quick comparisons offer only pairs whose backups can be chosen", () => {
  const snapshots = [
    { id: "s-latest", completedAt: "2026-10-02T09:00:00Z" },
    { id: "s-before", completedAt: "2026-10-01T09:00:00Z" },
    { id: "s-approved", completedAt: "2026-09-30T09:00:00Z" },
    { id: "s-week", completedAt: "2026-09-25T09:00:00Z" },
  ];
  assert.deepEqual(quickComparisons({ snapshots }, active).map((pick) => [pick.label, pick.from, pick.to]), [
    ["Approved setup and the latest backup", "s-approved", "s-latest"],
    ["The last two backups", "s-before", "s-latest"],
    ["A week ago and the latest backup", "s-week", "s-latest"],
  ]);
  assert.deepEqual(quickComparisons({ snapshots: snapshots.slice(0, 1) }, active), []);
  assert.deepEqual(quickComparisons(undefined, null), []);
});
