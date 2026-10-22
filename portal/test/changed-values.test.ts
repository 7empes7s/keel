import assert from "node:assert/strict";
import test from "node:test";

import { changeLine, changesQuery, objectName, valueLines, valueText } from "@/lib/changed-values";
import { idsInValues } from "@/lib/value-names";

const ID = "b1ea0000-0000-4000-8000-000000000001";

test("a plain value is one line; an object reads one line per setting inside it", () => {
  assert.deepEqual(valueLines("enabledForReportingButNotEnforced"), { lines: [{ label: "", text: "enabled for reporting but not enforced" }], more: 0 });
  assert.deepEqual(valueLines({ rule: "user.dept -eq \"x\"", processingState: "On" }).lines, [
    { label: "Processing state", text: "On" },
    { label: "Rule", text: "user.dept -eq \"x\"" },
  ]);
  assert.equal(valueText([{ ruleName: "PasswordRequired", gracePeriodHours: 24 }]), "PasswordRequired · Grace period hours: 24");
  const many = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`k${index}`, index]));
  assert.equal(valueLines(many).lines.length, 12);
  assert.equal(valueLines(many).more, 3);
});

test("ids inside values read as names, and an id without one is said so, never shown", () => {
  assert.equal(valueText([ID, "f1aa0000-0000-4000-8000-000000000002"], { [ID]: "Break-glass admins" }), "Break-glass admins, an object Keel has no name for");
  assert.equal(valueText({ includeGroups: [ID] }, { [ID]: "Break-glass admins" }), "Include groups: Break-glass admins");
  assert.deepEqual(idsInValues([{ a: [ID.toUpperCase()] }, "plain"]), [ID]);
});

test("names, the one-line summary, and which rows say what they changed", () => {
  assert.equal(objectName(`group:${ID}`, "group", null), "An unnamed group");
  assert.equal(objectName("group:Finance", "group", null), "Finance");
  assert.equal(changeLine({ name: "x", resourceType: "group", change: "removed", fields: [], fieldsTotal: 2 }), "Removed; it had 2 settings");
  assert.equal(changeLine({ name: "x", resourceType: "group", change: "changed", fields: [], fieldsTotal: 0 }), "Only settings Microsoft sets itself changed");
  const job = (kind: string, status: string, params: unknown = {}) => ({ job: { id: "j1", kind, status, params } });
  assert.equal(changesQuery(job("backup", "succeeded")), "job=j1");
  assert.equal(changesQuery(job("backup", "failed")), null);
  assert.equal(changesQuery(job("remediate", "queued", { driftIds: ["d"] })), "job=j1");
  assert.equal(changesQuery(job("restore", "succeeded", { artifactId: "a" })), "job=j1");
  assert.equal(changesQuery(job("restore", "succeeded", { artifactId: "a", compensates: "r" })), null);
  assert.equal(changesQuery(job("baseline-create", "succeeded")), null);
  assert.equal(changesQuery({ entry: { subject: { driftId: "d1" } } }), "drift=d1");
  assert.equal(changesQuery({ entry: { subject: { requestId: "r" } } }), null);
});
