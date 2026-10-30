import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ObjectSteps, PendingSteps, objectSteps } from "@/components/pending-steps";
import { CompletionChecklist, completionBadge, completionStateLabel, type CompletionResource } from "@/components/recovery-completion";

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

test("a skipped object never reads as restored: it says to set it by hand", () => {
  const skipped: CompletionResource = {
    naturalKey: "namedLocation:KEEL-RT-Head office",
    resourceType: "namedLocation",
    mechanism: "skipped",
    state: "configuration-restored",
    items: [
      { id: "s1", kind: "manual-setting", requirement: "isTrusted", description: "Mark this location as trusted again", owner: "op", state: "pending", evidence: [], closedAt: null, reopenCount: 0 },
    ],
  };
  const html = renderToStaticMarkup(createElement(CompletionChecklist, { resources: [skipped], canComplete: true }));
  assert.doesNotMatch(html, /Configuration restored|restored in full/);
  assert.match(html, /completion-badge-skipped/);
  assert.match(html, /Not restored: set it by hand/);
  assert.match(html, /KEEL wrote nothing to it/);
  assert.match(html, /Add evidence/);
  assert.deepEqual(completionBadge({ mechanism: "skipped", state: "verified-complete" }), { label: "Set by hand, verified", tone: "fine", key: "skipped-verified" });
  // Every other mechanism keeps the state's own label.
  assert.equal(completionBadge({ mechanism: "recreate", state: "configuration-restored" }).label, "Configuration restored");
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

test("issue #546: a dry run shows each step left for a person on its object, one step or a list", () => {
  assert.equal(renderToStaticMarkup(createElement(ObjectSteps, { entries: [{ naturalKey: "deviceConfiguration:KEEL-RT" }] })), "");
  const entries = [
    { naturalKey: "deviceCustomAttributeShellScript:KEEL-RT-attribute", completion: [{ kind: "integration", requirement: "assignments", description: "Assignments not restored: the backup could not read who it is assigned to" }] },
    { naturalKey: "crossTenantAccessPolicyConfigurationPartner:KEEL-RT", completion: { kind: "manual-setting", requirement: "inboundTrust", description: "Set inbound trust by hand" } },
    { naturalKey: "deviceConfiguration:KEEL-RT", completion: [{ requirement: "x" }] },
  ];
  assert.equal(objectSteps(entries).length, 2, "a step without words is not shown");
  const html = renderToStaticMarkup(createElement(ObjectSteps, { entries, label: (key: string) => `name of ${key}` }));
  assert.match(html, /alert-warning/);
  assert.match(html, /2 steps are left for a person/);
  assert.match(html, /name of deviceCustomAttributeShellScript:KEEL-RT-attribute<\/strong>: Assignments not restored/);
  assert.match(html, /Set inbound trust by hand/);
});

test("a manual setting step shows as an open item with its own icon and an evidence form", () => {
  const manual: CompletionResource = {
    naturalKey: "crossTenantAccessPolicyConfigurationPartner:KEEL-RT",
    label: "KEEL-RT partner",
    resourceType: "crossTenantAccessPolicyConfigurationPartner",
    mechanism: "update-existing",
    state: "configuration-restored",
    items: [{ id: "m1", kind: "manual-setting", requirement: "trustFields", description: "Check inboundTrust in the admin center", owner: "op", state: "pending", evidence: [], closedAt: null, reopenCount: 0 }],
  };
  const html = renderToStaticMarkup(createElement(CompletionChecklist, { resources: [manual], canComplete: true }));
  assert.match(html, /Manual setting|manual setting/);
  assert.match(html, /Check inboundTrust in the admin center/);
  assert.match(html, /1 needs evidence/);
  assert.match(html, /Add evidence/);
});
