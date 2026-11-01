import { strict as assert } from "node:assert";
import { test } from "node:test";

import { answerSummary, askAlerts, askFormDefaults, askInputFrom, recordFields, understoodFilters, type GroundedAnswer } from "@/lib/ask-view";

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
  const assumed = ["Read “MFA” as sign-in method settings.", "Ask does not answer about licences yet: the Licences page has them."];
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

test("the settings a change touched read as words, not as Microsoft's field names", () => {
  const record = { kind: "change", id: "x", resourceType: "user", naturalKey: "user:x", name: "x", changeType: "modified", impact: "access-affecting", decision: null,
    seenAt: null, window: { from: null, to: null }, source: { kind: "change", id: "x", href: "/changes", collectionId: null } } as const;
  assert.equal(recordFields({ ...record, fields: ["accountEnabled", "scheduleInfo.expiration.endDateTime"] } as never), "Account enabled, Schedule info › expiration › end date time");
  assert.equal(recordFields({ ...record, fields: ["department"], moreFields: true } as never), "Department and more");
  assert.equal(recordFields({ ...record, fields: [] } as never), "");
});

// Backlog D19: the "Or choose" pickers start from the question just answered, and send
// it back unchanged when nothing is changed.
test("the form's pickers follow the question, and send it back as the same request", () => {
  const chosen = askFormDefaults({ ...BASE, asksWho: true });
  assert.deepEqual(
    [chosen.intent, chosen.entity, chosen.type, chosen.change, chosen.name, chosen.who],
    ["changes", "SALES", "teams-org-policies,teams-voice-policies", "modified", "Meeting", true],
  );
  // Dates that are not a named period get their own choice; several kinds get one too.
  assert.equal(chosen.period, "2026-10-19T00:00:00.000Z/2026-10-22T11:00:00.000Z");
  assert.ok(chosen.datesOption && /19 Oct 2026/.test(chosen.datesOption.label));
  assert.equal(chosen.typeOption?.value, chosen.type);
  const sent = askInputFrom({
    intent: chosen.intent, period: chosen.period, entity: chosen.entity, type: chosen.type, change: chosen.change, name: chosen.name, who: "1",
  });
  assert.deepEqual(sent, {
    intent: "changes", entity: "SALES", period: undefined, from: "2026-10-19T00:00:00.000Z", to: "2026-10-22T11:00:00.000Z",
    resourceType: undefined, resourceTypes: ["teams-org-policies", "teams-voice-policies"], name: "Meeting", changeType: "modified", who: true,
  });
  // A named period is chosen by name; a kind the picker lists is chosen as it is.
  const named = askFormDefaults({ ...BASE, period: "last-week", plan: { intent: "changes", params: { ...BASE.plan!.params, resourceTypes: null, resourceType: "group", changeType: null, name: null, entity: null } } }, ["group"]);
  assert.deepEqual([named.period, named.datesOption, named.type, named.typeOption, named.change, named.entity, named.who], ["last-week", null, "group", null, "", "", false]);
  // Coverage has no period or change; with no answer the form starts at this week's changes.
  const coverage = askFormDefaults({ ...BASE, intent: "coverage", plan: { intent: "coverage", params: { ...BASE.plan!.params, from: null, to: null, changeType: null } } });
  assert.deepEqual([coverage.intent, coverage.period, coverage.change], ["coverage", "this-week", ""]);
  assert.deepEqual(askFormDefaults(null), { intent: "changes", period: "this-week", datesOption: null, entity: "", type: "", typeOption: null, change: "", name: "", who: false });
  // One kind the picker already lists is chosen as it is, not added again.
  const one = askFormDefaults({ ...BASE, plan: { intent: "changes", params: { ...BASE.plan!.params, resourceTypes: ["group"] } } }, ["group"]);
  assert.deepEqual([one.type, one.typeOption], ["group", null]);
  // Jobs have no owner, so an owner left in the form is not sent with them.
  assert.equal(askInputFrom({ intent: "failed-jobs", period: "today", entity: "SALES" })?.entity, undefined);
  // The who box only asks about changes.
  assert.equal(askInputFrom({ intent: "failed-jobs", period: "today", who: "1" })?.who, undefined);
});
