import assert from "node:assert/strict";
import test from "node:test";

import { compareSettings, comparisonSentence, listDiff } from "@/lib/change-comparison";
import { changeName } from "@/lib/changes-view";
import { plainKind } from "@/lib/baselines-view";

const APP = "1fec8e78-bce4-4aaf-ab1b-5451cc387264";
const GRANT = { id: "aTowaS50fG1zLnNwLmV4dHwxZmVj", roles: ["write"], applications: [{ id: APP, displayName: "KEEL-RT-site-grant-app" }] };

test("a removed site grant reads as the app and its access, never as paths or ids", () => {
  const comparison = compareSettings({ appPermissionGrants: [GRANT] }, { appPermissionGrants: [] });
  assert.equal(comparison.rows.length, 1);
  const [row] = comparison.rows;
  assert.equal(row.label, "App permission grants");
  assert.equal(row.diff, "changed");
  assert.deepEqual(row.entries, [{ diff: "removed", text: "App KEEL-RT-site-grant-app · Write access" }]);
  assert.ok(!JSON.stringify(row).includes("#1"));
  assert.ok(!JSON.stringify(row).includes(APP));
});

test("settings that differ are counted by kind; matching settings stay apart", () => {
  const before = { displayName: "Block legacy auth", state: "enabled", conditions: { users: { excludeGroups: ["Break-glass admins"] }, clientAppTypes: ["other"] }, old: 1 };
  const after = { displayName: "Block legacy auth", state: "enabledForReportingButNotEnforced", conditions: { users: { excludeGroups: ["Break-glass admins", "Finance"] }, clientAppTypes: ["other"] }, added: true };
  const comparison = compareSettings(before, after);
  assert.deepEqual({ ...comparison.counts }, { changed: 2, added: 1, removed: 1, same: 2, unknown: 0 });
  const groups = comparison.rows.find((row) => row.path === "conditions.users.excludeGroups");
  assert.equal(groups?.section, "Conditions");
  assert.equal(groups?.label, "Users › exclude groups");
  assert.deepEqual(groups?.entries?.filter((entry) => entry.diff !== "same"), [{ diff: "added", text: "Finance" }]);
  const state = comparison.rows.find((row) => row.path === "state");
  assert.equal(state?.before, "enabled");
  assert.equal(state?.after, "enabled for reporting but not enforced");
  assert.equal(comparisonSentence(comparison, "the approved setup"), "4 settings differ from the approved setup: 2 changed, 1 added and 1 removed.");
});

test("a new item lists its own settings; an unknown earlier copy is never shown as removed", () => {
  const added = compareSettings(null, { displayName: "Branch offices", ipRanges: ["203.0.113.0/24"], id: "x", "@odata.type": "#x" });
  assert.deepEqual(added.rows.map((row) => [row.label, row.diff, row.after]), [["Display name", "added", "Branch offices"], ["IP ranges", "added", "203.0.113.0/24"]]);
  assert.equal(comparisonSentence(added, "the approved setup"), "New: not in the approved setup. It holds 2 settings.");
  const unknown = compareSettings(null, { displayName: "HQ" }, {}, false);
  assert.equal(unknown.rows[0].diff, "unknown");
  assert.match(comparisonSentence(unknown, "the approved setup"), /nothing is shown as removed/);
});

test("list entries match by id, so a changed entry reads as changed, not removed and added", () => {
  const entries = listDiff([{ id: "a", displayName: "Sales", roles: ["read"] }], [{ id: "a", displayName: "Sales", roles: ["write"] }]);
  assert.deepEqual(entries, [{ diff: "changed", text: "Sales · Write access", was: "Sales · Read access" }]);
});

test("a tenant-wide setting is named by its kind, never by its type code", () => {
  assert.equal(changeName({ naturalKey: "sharepointSettings", resourceType: "sharepointSettings", name: "sharepointSettings" }), "SharePoint and OneDrive settings");
  assert.equal(plainKind("sharepointSettings"), "SharePoint and OneDrive settings");
});
