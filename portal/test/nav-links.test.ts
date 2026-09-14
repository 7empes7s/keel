import assert from "node:assert/strict";
import { test } from "node:test";

import { visibleNavLinks } from "@/components/nav-links";

// Task 34: an approver-only inbox link must never appear for a principal without the
// approve capability. Hiding the link is a convenience layered on top of the page and
// API guards, which remain authoritative -- but that convenience must not regress into
// showing the link to everyone.
test("the approvals nav link is gated on canApprove", () => {
  const withoutApprove = visibleNavLinks(false);
  assert.equal(
    withoutApprove.some((link) => link.href === "/approvals"),
    false,
    "a principal without approve must not see the approvals link",
  );

  const withApprove = visibleNavLinks(true);
  const approvalsLink = withApprove.find((link) => link.href === "/approvals");
  assert.ok(approvalsLink, "an approver must see the approvals link");
  assert.equal(approvalsLink?.label, "Approvals");
});
