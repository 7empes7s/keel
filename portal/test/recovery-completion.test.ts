import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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

test("a restorer sees a reference form for open items and Reopen for verified ones", () => {
  const html = renderToStaticMarkup(createElement(CompletionChecklist, { resources: [resource("configuration-restored")], canComplete: true }));
  assert.match(html, /Mark verified/);
  assert.match(html, /Reopen/);
  assert.match(html, /never the secret/);
  assert.match(html, /Evidence: ticket CHG-1/);
  assert.doesNotMatch(html, /type="password"/, "the form never collects a credential");
});

test("without the restore capability the checklist is read-only", () => {
  const html = renderToStaticMarkup(createElement(CompletionChecklist, { resources: [resource("configuration-restored")], canComplete: false }));
  assert.doesNotMatch(html, /Mark verified|Reopen/);
});

test("no items renders an explicit nothing-left message", () => {
  assert.match(renderToStaticMarkup(createElement(CompletionChecklist, { resources: [], canComplete: true })), /no follow-up work/);
});
