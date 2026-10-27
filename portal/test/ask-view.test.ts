import { strict as assert } from "node:assert";
import { test } from "node:test";

import { answerSummary, askAlerts, askInputFrom, understoodFilters, type GroundedAnswer } from "@/lib/ask-view";

const BASE: GroundedAnswer = {
  version: 1, status: "answered", intent: "changes", understood: null, scope: { central: true, entities: [] },
  plan: { intent: "changes", params: { entity: "SALES", from: "2026-10-19T00:00:00.000Z", to: "2026-10-22T11:00:00.000Z", resourceType: null, resourceTypes: ["teams-org-policies", "teams-voice-policies"], name: "Meeting", changeType: "modified", limit: 100 } },
  window: null, known: null, gaps: [], total: 3, shown: 0, truncated: true, records: [], sentence: "", generatedAt: "2026-10-22T11:00:00.000Z",
  summary: [
    { resourceType: "teams-org-policies", changeType: "modified", impact: "access-affecting", count: 2 },
    { resourceType: "conditionalAccessPolicy", changeType: "modified", impact: "tenant-lockout", count: 1 },
  ],
};

test("each understood filter but the topic and period can be removed, keeping the rest", () => {
  const filters = understoodFilters(BASE);
  assert.deepEqual(filters.map((filter) => filter.key), ["intent", "period", "entity", "kind", "change", "name"]);
  assert.equal(filters[0].removeHref, null);
  assert.equal(filters[1].removeHref, null);
  const kind = new URL(filters.find((filter) => filter.key === "kind")!.removeHref!, "http://x");
  assert.equal(kind.searchParams.get("types"), null);
  assert.equal(kind.searchParams.get("entity"), "SALES");
  assert.equal(kind.searchParams.get("name"), "Meeting");
  // The link reads back as the same request, minus the filter.
  const input = askInputFrom(Object.fromEntries(new URL(filters.find((filter) => filter.key === "entity")!.removeHref!, "http://x").searchParams));
  assert.deepEqual(input, {
    intent: "changes", entity: undefined, period: undefined, from: "2026-10-19T00:00:00.000Z", to: "2026-10-22T11:00:00.000Z",
    resourceType: undefined, resourceTypes: ["teams-org-policies", "teams-voice-policies"], name: "Meeting", changeType: "modified",
  });
});

test("how an ambiguous word was read is shown before the answer", () => {
  const assumed = ["Read “MFA” as sign-in method settings.", "KEEL compares backups, so it shows what changed and when, but not who made the change."];
  const alerts = askAlerts({ ...BASE, assumed: ["period", ...assumed] });
  const reading = alerts.find((alert) => alert.key === "assumed-reading")!;
  assert.equal(reading.tone, "low");
  assert.equal(reading.todo, assumed.join(" "));
  assert.equal(askAlerts({ ...BASE, assumed: ["period"] }).some((alert) => alert.key === "assumed-reading"), false);
});

test("words the reading left out are said plainly, and the summary counts every match", () => {
  const alerts = askAlerts({ ...BASE, ignored: ["printers"] });
  assert.equal(alerts[0].key, "ignored");
  assert.match(String(alerts[0].title), /printers/);
  const summary = answerSummary(BASE)!;
  assert.deepEqual(summary.services.map((row) => [row.label, row.count]), [["Teams", 2], ["Entra ID", 1]]);
  assert.deepEqual(summary.risks.map((row) => [row.key, row.count]), [["tenant-lockout", 1], ["access-affecting", 2]]);
});
