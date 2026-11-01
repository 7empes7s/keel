import { strict as assert } from "node:assert";
import { test } from "node:test";

import { withSharedCoverage } from "@/lib/ask-coverage";
import { askTiles, askVerdict, coverageAnswerSummary, recordBadges, recordNote, type CoverageRecord, type GroundedAnswer } from "@/lib/ask-view";
import { coverageSentence, coverageSummary } from "@/lib/protect-view";
import { serviceStatus } from "@/lib/setup-services";
import type { CoverageData, CoverageType } from "@/lib/types";

// Backlog G2 (Codex end-to-end report, 31 Oct 2026): Ask said Intune had 66 kinds with 60
// missing from the latest backup while Setup said all 64 were backed up. Ask now counts
// the kinds asked about with the shared coverage buckets, from the same report.

const NOW = "2026-10-31T21:00:00.000Z";
const READ_AT = "2026-10-31T20:00:00.000Z";

function kind(type: string, extra: Partial<CoverageType> = {}): CoverageType {
  return {
    type, reportStatus: "covered", protectionState: "protected", stale: false, itemCount: 3, lastCollectedAt: READ_AT,
    adapter: `graph-${type}`, outcome: "complete", detail: null, fidelity: { declared: "full", measured: null, verifiedAt: null },
    criticality: "tier2", blastRadius: null, remappable: null, ...extra,
  } as CoverageType;
}

const INTUNE = ["deviceCompliancePolicy", "deviceConfiguration", "deviceManagementConfigurationPolicy", "mobileApp"];
// A part of a kind the question parser knows (one endpoint security family) but the report
// counts inside its kind.
const PART = "intentsEndpointSecurity";

function engineRecord(type: string, outcome: string, backup: CoverageRecord["backup"] = "settings"): CoverageRecord {
  return {
    kind: "coverage", backup, id: `snap/${type}`, resourceType: type, name: null, service: null, outcome, count: null,
    window: { from: "2026-10-31T20:26:00.000Z", to: "2026-10-31T20:40:00.000Z" }, source: { kind: "collection", id: "snap", href: "/protect" },
  };
}

// What the engine answered after a Tier 3 run: one kind read, the rest not part of that run.
function answer(params: Partial<NonNullable<GroundedAnswer["plan"]>["params"]> = {}, scope = { central: true, entities: [] as string[] }): GroundedAnswer {
  const records = [...INTUNE, PART].map((type, index) => engineRecord(type, index === 0 ? "complete" : "not-requested"));
  return {
    version: 1, status: "answered", intent: "coverage", understood: null, scope,
    plan: { intent: "coverage", params: { entity: null, from: null, to: null, resourceType: null, resourceTypes: [...INTUNE, PART].sort(), name: null, changeType: null, limit: 100, ...params } },
    window: null, known: null, gaps: [], total: records.length, shown: records.length, truncated: false, records,
    sentence: "", generatedAt: NOW,
  } as GroundedAnswer;
}

function report(types: CoverageType[], workloads: CoverageType[] = []): CoverageData {
  return { generatedAt: NOW, snapshot: { id: "snap", status: "complete", startedAt: null, completedAt: READ_AT }, summary: coverageSummary([...types, ...workloads]), types, workloads, liveEvidence: [] } as unknown as CoverageData;
}

test("Ask counts Intune kinds as Setup does, not as the newest run did", () => {
  const types = [...INTUNE.map((type) => kind(type)), kind("user")];
  const shared = withSharedCoverage(answer(), report(types), NOW);
  const intune = types.filter((item) => INTUNE.includes(item.type));

  assert.deepEqual(shared.coverage, coverageSummary(intune));
  assert.equal(shared.coverage?.total, INTUNE.length, "the part is not a kind of its own, and Entra ID is not asked about");
  assert.equal(shared.records.length, INTUNE.length);
  assert.ok(shared.records.every((record) => record.kind === "coverage" && record.health === "ok"));
  // Setup's Intune line says all are backed up; so does Ask.
  assert.equal(serviceStatus("Intune", intune, NOW).backup.text, `All ${INTUNE.length} kinds backed up`);
  assert.equal(askVerdict(shared).text, coverageSentence(coverageSummary(intune)));
  assert.equal(askVerdict(shared).tone, "good");
  assert.ok(!shared.records.some((record) => recordBadges(record).some((badge) => badge.label === "Not part of this backup")));
});

test("failed, partly read, out of date and never backed up kinds land in the shared buckets", () => {
  const types = [
    kind("deviceCompliancePolicy"),
    kind("deviceConfiguration", { outcome: "partial", itemCount: 7 }),
    kind("deviceManagementConfigurationPolicy", { stale: true }),
    kind("mobileApp", { reportStatus: "never-collected", lastCollectedAt: null, outcome: null, itemCount: null }),
  ];
  const shared = withSharedCoverage(answer(), report(types), NOW);
  assert.deepEqual(shared.coverage, { covered: 1, failed: 0, partial: 1, stale: 1, neverCollected: 1, notCovered: 0, unavailable: 0, total: 4 });
  // Partly done is its own count, never inside failed (decision 31 Oct 2026).
  assert.equal(askVerdict(shared).text, "4 kinds: 1 backed up, 1 partly done and 2 out of date or never.");
  assert.equal(askVerdict(shared).tone, "attention");

  const byType = new Map(shared.records.map((record) => [record.kind === "coverage" ? record.resourceType : "", record]));
  assert.deepEqual(recordBadges(byType.get("deviceConfiguration")!), [{ label: "Partly done", tone: "soon" }]);
  assert.match(recordNote(byType.get("deviceConfiguration")!), /read only part of this type \(7 items seen\)/);
  assert.deepEqual(recordBadges(byType.get("mobileApp")!), [{ label: "Never backed up", tone: "soon" }]);

  const summary = coverageAnswerSummary(shared)!;
  assert.deepEqual(summary.states.map((row) => [row.label, row.count]), [["Partly done", 1], ["Out of date or never", 2], ["Backed up", 1]]);
  assert.deepEqual(summary.services.map((row) => [row.label, row.count]), [["Intune", 4]]);
  assert.equal(askTiles(shared).find((tile) => tile.key === "period")?.value, "Latest reads");
});

test("service settings take the shared state and keep their settings count; content rows stay", () => {
  const plain = answer({ resourceTypes: null });
  plain.records = [
    { ...engineRecord("exchange-mail-flow", "complete", "service-settings"), count: 12 },
    engineRecord("mail", "succeeded", "content"),
    ...plain.records,
  ];
  const workloads = [kind("exchange-mail-flow", { outcome: "partial" }), kind("teams-org-policies", { protectionState: "not-covered", reportStatus: "not-covered", adapter: "teams-org-policies", lastCollectedAt: null, outcome: null })];
  const types = INTUNE.map((type) => kind(type));
  const shared = withSharedCoverage(plain, report(types, workloads), NOW);

  assert.equal(shared.coverage?.total, types.length + workloads.length, "every kind, as What's protected counts them");
  const mailFlow = shared.records.find((record) => record.kind === "coverage" && record.resourceType === "exchange-mail-flow") as CoverageRecord;
  assert.equal(mailFlow.health, "partial");
  assert.equal(mailFlow.count, 12);
  const teams = shared.records.find((record) => record.kind === "coverage" && record.resourceType === "teams-org-policies") as CoverageRecord;
  assert.equal(teams.health, "not-collected", "a workload with no run yet still gets its row");
  const mail = shared.records.find((record) => record.kind === "coverage" && record.backup === "content") as CoverageRecord;
  assert.equal(mail.health, undefined);
  assert.equal(shared.total, shared.records.length);
  // The Found tile counts the kinds the verdict counts, and names the content rows apart.
  const found = askTiles(shared).find((tile) => tile.key === "found")!;
  assert.equal(found.value, String(shared.coverage?.total));
  assert.equal(found.about, "kinds of backup, and 1 other backup");
});

test("an owner's answer, a part-only question and a refusal keep the engine's answer", () => {
  const data = report(INTUNE.map((type) => kind(type)));
  const scoped = answer({}, { central: false, entities: ["SALES"] });
  assert.equal(withSharedCoverage(scoped, data, NOW), scoped);
  const owner = answer({ entity: "SALES" });
  assert.equal(withSharedCoverage(owner, data, NOW), owner);
  const part = answer({ resourceTypes: null, resourceType: PART });
  assert.equal(withSharedCoverage(part, data, NOW), part);
  const refused = { ...answer(), status: "refused" as const };
  assert.equal(withSharedCoverage(refused, data, NOW), refused);
});
