import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PendingSteps } from "@/components/pending-steps";
import { CompletionChecklist, completionStateLabel, type CompletionResource } from "@/components/recovery-completion";

const resource = (state: CompletionResource["state"]): CompletionResource => ({
  naturalKey: "application:Payroll connector",
  resourceType: "application",
  mechanism: "recreate",
  state,
  items: [
    { id: "i1", kind: "credential", requirement: "passwordCredentials", description: "Issue new client secrets", owner: "op", state: "pending", evidence: [], closedAt: null, reopenCount: 0 },
    { id: "i2", kind: "integration", requirement: "newObjectId", description: "Update external references", owner: "op", state: "verified", evidence: [{ type: "ticket", reference: "CHG-1" }], closedAt: "2026-10-02T09:40:00Z", reopenCount: 0 },
  ],
});

test("states have plain-language labels", () => {
  assert.equal(completionStateLabel("configuration-restored"), "Configuration restored");
  assert.equal(completionStateLabel("service-validation-pending"), "Service validation pending");
  assert.equal(completionStateLabel("verified-complete"), "Verified complete");
});

test("a restorer sees Add evidence for open items and Reopen for verified ones; the form waits for the click", () => {
  const html = renderToStaticMarkup(createElement(CompletionChecklist, { resources: [resource("configuration-restored")], canComplete: true }));
  assert.match(html, /Add evidence/);
  assert.match(html, /Reopen/);
  // The evidence form (and its "never the secret" hint) opens only when asked for; the
  // harness test checks the hint is announced with the field once it is open.
  assert.doesNotMatch(html, /Mark verified/);
  assert.match(html, /1 needs evidence/);
  assert.match(html, /1 of 2 verified/);
  assert.match(html, /data-tone="soon"/);
  assert.match(html, /Evidence: ticket CHG-1/);
  assert.doesNotMatch(html, /type="password"/, "the form never collects a credential");
});

test("without the restore capability the checklist is read-only", () => {
  const html = renderToStaticMarkup(createElement(CompletionChecklist, { resources: [resource("configuration-restored")], canComplete: false }));
  assert.doesNotMatch(html, /Add evidence|Mark verified|Reopen/);
});

test("no items renders an explicit nothing-left message", () => {
  assert.match(renderToStaticMarkup(createElement(CompletionChecklist, { resources: [], canComplete: true })), /Nothing to follow up/);
});

test("task-152: a pending enforcement step names the approved next step and offers no evidence form", () => {
  const enforcement: CompletionResource = {
    naturalKey: "conditionalAccessPolicy:Require-MFA-All",
    resourceType: "conditionalAccessPolicy",
    mechanism: "soft-delete-restore",
    state: "configuration-restored",
    items: [
      { id: "e1", kind: "enforcement", requirement: "conditionalAccessEnabled", description: "Turn the policy back on", owner: "op", state: "pending", evidence: [], closedAt: null, reopenCount: 0 },
    ],
  };
  const html = renderToStaticMarkup(createElement(CompletionChecklist, { resources: [enforcement], canComplete: true }));
  assert.match(html, /Next: ask for the enforcement step\. A second person approves it/);
  assert.doesNotMatch(html, /Add evidence|Mark verified/, "a ticket cannot stand in for turning the policy on");
});

test("task-152: the pending steps list shows only when the restore left a policy report-only", () => {
  assert.equal(renderToStaticMarkup(createElement(PendingSteps, { steps: [] })), "");
  const html = renderToStaticMarkup(createElement(PendingSteps, {
    steps: [{
      naturalKey: "conditionalAccessPolicy:Require-MFA-All", resourceType: "conditionalAccessPolicy", step: "turn-on-conditional-access-policy",
      snapshotState: "enabled", restoredState: "enabledForReportingButNotEnforced", description: "",
    }],
  }));
  assert.match(html, /Still to do after this restore/);
  assert.match(html, /report-only mode and protects no one/);
  assert.match(html, /second person approves/);
});
