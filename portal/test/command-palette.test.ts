import assert from "node:assert/strict";
import { test } from "node:test";

import { scoreCommand } from "@/components/command-palette";
import { groupNavLinks, visibleNavLinks } from "@/components/nav-links";

test("palette ranks a label prefix above keyword and loose matches", () => {
  assert.equal(scoreCommand("Restore", "Recovery", "re"), 4);
  assert.equal(scoreCommand("Backups", "Recovery", "re"), 2, "group keyword is a weaker hit");
  assert.equal(scoreCommand("Use dark theme", "theme", "dark"), 3, "a later word in the label");
  assert.equal(scoreCommand("Backups", "Recovery", "bkp"), 1, "in-order letters of the label");
});

test("palette loose matching never reaches through keywords", () => {
  assert.equal(scoreCommand("Drift", "Posture", "re"), 0);
  assert.equal(scoreCommand("Dashboard", "Posture", "pst"), 0);
});

test("grouped pages keep every visible page once, under the seven sections in map order", () => {
  const visible = visibleNavLinks({ canRead: true, canPolicies: true, canUsers: true, canApprove: true });
  const sections = groupNavLinks(visible);
  assert.equal(sections.flatMap((section) => section.links).length, visible.length);
  assert.deepEqual(sections.map((section) => section.group), ["Overview", "Protect", "Changes", "Restore", "Approvals", "Activity", "Settings"]);
  assert.deepEqual(groupNavLinks(visibleNavLinks({})).map((section) => section.group), ["Overview", "Protect", "Changes", "Restore"],
    "a principal without read-gated pages sees no empty sections");
});
