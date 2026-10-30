import assert from "node:assert/strict";
import { test } from "node:test";

import { kindMatch, matchScore, overallScore, plainLabel, quickComparisons, serviceSummaries, setupStatus, setupVerdict } from "@/lib/baselines-view";
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

test("every service shows: service reads are measured against the previous backup", () => {
  const summaries = serviceSummaries(active, [
    { resourceType: "exchange-mail-flow", blastRadius: "access-affecting", serviceRead: { workload: "exchange-mail-flow", resourceKey: "transport-rule:Forward", collectionId: "c2", previousCollectionId: "c1", previousReadAt: null, comparedWith: "approved", alertId: null, alertState: null, undo: { possible: true, reason: null } } },
  ], ["group"], [
    { type: "exchange-mail-flow", read: true },
    { type: "exchange-mailbox-settings", read: true },
    { type: "sharepoint-site-settings", read: true },
    { type: "onedrive-site-settings", read: false },
    { type: "teams-org-policies", read: true },
    { type: "purview-labels", read: false },
    { type: "power-platform-settings", read: true },
  ]);
  const by = new Map(summaries.map((summary) => [summary.service.name, summary]));
  assert.deepEqual([...by.keys()].sort(), ["Entra ID", "Exchange Online", "Intune", "Power Platform", "Purview", "SharePoint and OneDrive", "Teams"]);
  assert.equal(by.get("Entra ID")!.basis, "approved-setup");
  assert.equal(by.get("Intune")!.basis, "approved-setup");
  const exchange = by.get("Exchange Online")!;
  assert.equal(exchange.basis, "previous-backup");
  assert.deepEqual([exchange.changed, exchange.changedKinds, exchange.inLine, exchange.notCovered], [1, ["exchange-mail-flow"], ["exchange-mailbox-settings"], []]);
  assert.equal(exchange.tone, "soon");
  const sharepoint = by.get("SharePoint and OneDrive")!;
  assert.deepEqual([sharepoint.basis, sharepoint.inLine, sharepoint.notCovered], ["previous-backup", ["sharepoint-site-settings"], ["onedrive-site-settings"]]);
  assert.deepEqual(by.get("Purview")!.notCovered, ["purview-labels"]);
  // A service read is never listed as missing from the approved setup.
  assert.ok(summaries.every((summary) => summary.basis === "previous-backup" || !summary.notCovered.some((type) => type.includes("-"))));
});

test("a kind's match counts each changed, removed or added setting once", () => {
  // Approved setup holds 10: 2 changed and 1 removed no longer match; 1 added is extra.
  assert.deepEqual(kindMatch(10, { added: 1, modified: 2, removed: 1 }, "approved-setup"), { matching: 7, judged: 11 });
  // A service read found 10 now: 1 added and 2 changed do not match; 1 removed is missing.
  assert.deepEqual(kindMatch(10, { added: 1, modified: 2, removed: 1 }, "previous-backup"), { matching: 7, judged: 11 });
  // Never below zero.
  assert.deepEqual(kindMatch(1, { added: 0, modified: 3, removed: 0 }, "approved-setup"), { matching: 0, judged: 1 });
  // Rounded down, so one change left never reads 100%.
  assert.equal(matchScore({ matching: 999, judged: 1000 }).percent, 99);
  assert.equal(matchScore({ matching: 0, judged: 0 }).percent, null);
});

test("each service and the whole tenant get a match percentage of settings", () => {
  const summaries = serviceSummaries(active, [
    { resourceType: "conditionalAccessPolicy", blastRadius: "tenant-lockout", changeType: "modified" },
    { resourceType: "deviceConfiguration", blastRadius: "cosmetic", changeType: "added" },
    { resourceType: "exchange-mail-flow", blastRadius: "access-affecting", changeType: "removed", serviceRead: { workload: "exchange-mail-flow", resourceKey: "transport-rule:Forward", collectionId: "c2", previousCollectionId: "c1", previousReadAt: null, comparedWith: "approved", alertId: null, alertState: null, undo: { possible: true, reason: null } } },
  ], ["namedLocation"], [
    // The full open count (2 removed) wins over the recent list (1 removed).
    { type: "exchange-mail-flow", read: true, itemCount: 9, open: { added: 0, modified: 0, removed: 2 } },
    { type: "teams-org-policies", read: true, itemCount: null, open: { added: 0, modified: 0, removed: 0 } },
    { type: "purview-labels", read: false, itemCount: 4, open: { added: 0, modified: 0, removed: 0 } },
    // Its open changes could not be counted: no score, never 100%.
    { type: "power-platform-settings", read: true, itemCount: 30, open: null },
  ], { conditionalAccessPolicy: 4, group: 16, deviceConfiguration: 5, namedLocation: 99 });
  const by = new Map(summaries.map((summary) => [summary.service.name, summary]));
  // Entra ID: 4 sign-in rules + 16 groups held, 1 rule changed. Named locations are not covered: left out.
  assert.deepEqual(by.get("Entra ID")!.score, { passed: 19, evaluated: 20, excepted: 0, percent: 95 });
  // Intune: 5 held, 1 added that the setup does not hold.
  assert.deepEqual(by.get("Intune")!.score, { passed: 5, evaluated: 6, excepted: 0, percent: 83 });
  // Exchange: 9 read now, 2 removed since.
  assert.deepEqual(by.get("Exchange Online")!.score, { passed: 9, evaluated: 11, excepted: 0, percent: 81 });
  // A read with no count, and one not read, get no score.
  assert.equal(by.get("Teams")!.score, null);
  assert.equal(by.get("Purview")!.score, null);
  assert.equal(by.get("Power Platform")!.score, null);
  assert.deepEqual(overallScore(summaries), { passed: 33, evaluated: 37, excepted: 0, percent: 89 });
  // Without the counts, no service is scored.
  assert.ok(serviceSummaries(active, [], []).every((summary) => summary.score === null));
  assert.equal(overallScore(serviceSummaries(active, [], [])), null);
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
