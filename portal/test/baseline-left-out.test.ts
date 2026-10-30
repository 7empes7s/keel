import assert from "node:assert/strict";
import { test } from "node:test";
import { leftOutRows, leftOutSummary, serviceSummaries } from "@/lib/baselines-view";

// Baselines gap 3: every kind an approved setup does not hold is listed with the reason
// its backup gave, and marked once a later backup read it so a new version would add it.

const capture = {
  basis: "source-snapshot" as const, capturedAt: "2026-10-29T08:00:00Z", ageMs: 3_600_000, sourceSnapshotId: "s1",
  window: null, types: ["conditionalAccessPolicy", "group"],
  leftOut: [
    { type: "todoSettings", reason: "microsoft-service-error", readLater: true },
    { type: "lifecycleWorkflow", reason: "no-licence", readLater: false },
    { type: "deviceConfiguration", reason: "refused", readLater: true },
    { type: "formsSettings", reason: "something-new" },
  ],
};

test("each left-out kind reads as plain words with its reason, never as a code", () => {
  const rows = leftOutRows(capture);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.doesNotMatch(row.name, /todoSettings|lifecycleWorkflow|deviceConfiguration|formsSettings/);
    assert.doesNotMatch(row.reason.label, /-/);
  }
  const by = Object.fromEntries(rows.map((row) => [row.type, row]));
  assert.equal(by.todoSettings.reason.label, "Microsoft error");
  assert.equal(by.lifecycleWorkflow.reason.label, "No licence");
  assert.equal(by.deviceConfiguration.reason.label, "Access refused");
  assert.equal(by.deviceConfiguration.reason.tone, "urgent");
  assert.equal(by.formsSettings.reason.label, "Reason not recorded", "an unknown reason is said, not guessed");
  assert.equal(by.todoSettings.canAdd, true);
  assert.equal(by.formsSettings.canAdd, false, "an older reader without readLater offers nothing");
});

test("left-out kinds are grouped by service in Microsoft's order", () => {
  const services = leftOutRows(capture).map((row) => row.service.name);
  // Each service's rows sit together.
  assert.deepEqual(services, services.filter((name, index) => services.indexOf(name) === index || services[index - 1] === name));
  assert.ok(services.indexOf("Entra ID") < services.indexOf("Intune"), services.join(", "));
});

test("the summary says how many are left out and whether a new version would add them", () => {
  const rows = leftOutRows(capture);
  const summary = leftOutSummary(rows, true);
  assert.equal(summary?.tone, "soon");
  assert.match(summary?.text ?? "", /^4 kinds of setting are not in this setup, so changes to them are not checked\. A later backup read 2 of them: capture a new version to add them\.$/);
  assert.match(leftOutSummary(rows, false)?.text ?? "", /a new version would add them\.$/);
  const none = leftOutRows({ leftOut: [{ type: "lifecycleWorkflow", reason: "no-licence", readLater: false }] });
  assert.deepEqual(leftOutSummary(none, true), { tone: "low", text: "1 kind of setting is not in this setup, so changes to it are not checked. No later backup has read it yet." });
  assert.equal(leftOutSummary([], true), null);
  assert.deepEqual(leftOutRows({ leftOut: undefined }), [], "an older baseline left nothing out");
});

test("a left-out kind counts as not covered on its service card even when nothing read it since", () => {
  const summaries = serviceSummaries({ capture }, [], ["conditionalAccessPolicy", "group"]);
  const intune = summaries.find((summary) => summary.service.name === "Intune");
  assert.deepEqual(intune?.notCovered, ["deviceConfiguration"]);
  const entra = summaries.find((summary) => summary.service.name === "Entra ID");
  assert.ok(entra?.notCovered.includes("lifecycleWorkflow"));
});
