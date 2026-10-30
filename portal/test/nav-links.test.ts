import assert from "node:assert/strict";
import { test } from "node:test";

import { visibleNavLinks } from "@/components/nav-links";

// Task 34: an approver-only inbox link must never appear for a principal without the
// approve capability. Hiding the link is a convenience layered on top of the page and
// API guards, which remain authoritative -- but that convenience must not regress into
// showing the link to everyone.
test("the approvals nav link is gated on canApprove", () => {
  const withoutApprove = visibleNavLinks({ canApprove: false });
  assert.equal(
    withoutApprove.some((link) => link.href === "/approvals"),
    false,
    "a principal without approve must not see the approvals link",
  );

  const withApprove = visibleNavLinks({ canApprove: true });
  const approvalsLink = withApprove.find((link) => link.href === "/approvals");
  assert.ok(approvalsLink, "an approver must see the approvals link");
  assert.equal(approvalsLink?.label, "Approvals");
});

// The Restore section lists its areas as sub-pages, in the order people use them, and
// /restore is current only on itself (its sub-pages sit under the same path).
test("restore areas are sub-pages, in order, and each is current only on its own page", async () => {
  const { NAV_MAP, isCurrentPath, sectionForPath, sectionLinks } = await import("@/components/nav-links");
  assert.deepEqual(
    sectionLinks("Restore", { canRead: true }).map((link) => [link.href, link.label]),
    [
      ["/restore", "Configurations"],
      ["/restore/services", "Exchange, Teams and more"],
      ["/restore/follow-ups", "Follow-up steps"],
      ["/restore/history", "Past restores"],
      ["/incidents", "Incidents"],
      ["/resilience", "Resilience"],
      ["/readiness", "Emergency access"],
    ],
  );
  const restore = NAV_MAP.Restore.find((route) => route.href === "/restore")!;
  assert.equal(isCurrentPath("/restore", restore.href, restore.exact), true);
  assert.equal(isCurrentPath("/restore/services", restore.href, restore.exact), false);
  assert.equal(isCurrentPath("/restore/services", "/restore/services"), true);
  for (const path of ["/restore", "/restore/services", "/restore/follow-ups", "/restore/history"]) {
    assert.equal(sectionForPath(path), "Restore", path);
  }
});
