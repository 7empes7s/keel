import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { visibleNavLinks } from "@/components/nav-links";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { automationDisabled } from "@/lib/policies";
import { AutomationBanner, matchPhrase, policiesVerdict, policySentence, policyStateSentence } from "@/components/policy-state";
import type { Policy } from "@/lib/policies";

test("the automation banner reflects the halt file's absence and presence using a read-only check", () => {
  const directory = mkdtempSync(join(process.cwd(), ".policy-switch-test-"));
  const path = join(directory, "AUTOMATION_DISABLED");
  const now = "2026-10-02T09:40:00Z";
  try {
    assert.equal(automationDisabled(path), false);
    assert.match(renderToStaticMarkup(createElement(AutomationBanner, { halted: automationDisabled(path), now })), /Automation is on\./);
    writeFileSync(path, "");
    assert.equal(automationDisabled(path), true);
    const halted = renderToStaticMarkup(createElement(AutomationBanner, { halted: automationDisabled(path), haltFile: path, now }));
    assert.match(halted, /Automation is halted/);
    assert.doesNotMatch(halted, /kill switch/i);
    assert.equal(readFileSync(path, "utf8"), "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const basePolicy: Policy = {
  id: "7a1d0f3e-0000-4000-8000-000000000001", name: "Auto-accept cosmetic drift", enabled: true, paused_at: null, run_as_repair_required: false,
  run_as_principal_id: "3f9c2b1e-0000-4000-8000-000000000002",
  run_as_principal: { id: "3f9c2b1e-0000-4000-8000-000000000002", email: "svc-policy@contoso.com", name: "svc-policy@contoso.com", readable: true },
  resource_type: null, blast_radius: "cosmetic", natural_key_glob: null, change_type: "modified", action: "auto_remediate",
  max_blast_radius: "cosmetic", max_actions_per_window: 50, window_seconds: 3600, created_by: "admin", created_at: "2026-09-12T08:00:00Z",
  last_action_at: "2026-10-02T07:40:00Z", last_action_status: "executed", last_action_natural_key: "namedLocation:Branch offices", actions_last_7_days: 14,
};

test("a policy reads as what it does, acting as whom — never its codes or ids", () => {
  assert.equal(policySentence(basePolicy),
    "Rolls back cosmetic changes to any resource automatically, up to 50 an hour, acting as svc-policy@contoso.com.");
  assert.equal(policySentence({ ...basePolicy, action: "alert" }), "Alerts on cosmetic changes to any resource.");
  assert.match(matchPhrase({ ...basePolicy, natural_key_glob: "group:Admin*", change_type: null, blast_radius: null }), /^changes to groups named like “Admin\*”$/);
  assert.equal(policyStateSentence({ ...basePolicy, paused_at: "2026-10-02T07:40:00Z" }, "2026-10-02T09:40:00Z"), "Paused 2 hours ago after reaching its limit");
  assert.equal(policyStateSentence({ ...basePolicy, enabled: false }, "2026-10-02T09:40:00Z"), "Turned off");
  assert.match(policySentence({ ...basePolicy, run_as_principal: { ...basePolicy.run_as_principal!, readable: false, name: null } }), /account 3f9c2b1e \(no longer readable\)/);
  assert.equal(policiesVerdict([basePolicy, { ...basePolicy, paused_at: "2026-10-02T07:40:00Z" }], false), "Automation is on. 2 policies, 1 paused.");
  for (const sentence of [policySentence(basePolicy), policiesVerdict([basePolicy], true)]) {
    assert.doesNotMatch(sentence, /dispose-accept|auto_remediate|[0-9a-f]{8}-[0-9a-f]{4}/);
  }
});

test("policy writes and navigation retain the policies capability boundary", () => {
  const lib = readFileSync(new URL("../lib/policies.ts", import.meta.url), "utf8");
  for (const name of ["Create", "Update", "ActivationPreview", "Activate"]) {
    assert.match(lib.slice(lib.indexOf(`export function guardedPolicy${name}`)), /return guarded\(\{[^\n]*capability: surface.capability, recordAttempt: true/);
  }
  // The Policies page is listed in navigation exactly with the policies capability.
  for (const canPolicies of [true, false]) {
    assert.equal(visibleNavLinks({ canRead: true, canPolicies }).some((link) => link.href === "/policies"), canPolicies);
  }
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /readAccess\(requestHeaders, DATA_SURFACES.policiesPage\)/);
  assert.match(layout, /canPolicies=\{canPolicies\}/);
});

// Roadmap task-92: the activation preview reads in words; ids, codes and versions stay
// in its record; a queued roll back never reads as done.
import { ActivationPreviewView, outcomesSentence, previewSentence, refusalSentence } from "@/components/policy-preview";
import type { ActivationPreview } from "@/lib/policies";

const preview: ActivationPreview = {
  id: "9a0c0000-0000-4000-8000-000000000092", requestedBy: "8c1e0000-0000-4000-8000-0000000000a1",
  createdAt: "2026-10-03T09:00:00Z", expiresAt: "2026-10-03T09:30:00Z",
  policy: { id: basePolicy.id, name: basePolicy.name, enabled: false, action: "auto_remediate" },
  matched: [{ driftId: "d1000000-0000-4000-8000-000000000001", naturalKey: "group:Finance", resourceType: "group", changeType: "modified", blastRadius: "cosmetic", detectedAt: "2026-10-03T08:00:00Z" }],
  matchedOverCeiling: [{ driftId: "d1000000-0000-4000-8000-000000000002", naturalKey: "group:Privileged", resourceType: "group", changeType: "modified", blastRadius: "tenant-lockout", detectedAt: "2026-10-03T08:00:00Z" }],
  operations: [
    { naturalKey: "group:Finance", resourceType: "group", verb: "update", blastRadius: "cosmetic", role: "matched", driftId: "d1000000-0000-4000-8000-000000000001" },
    { naturalKey: "group:Privileged", resourceType: "group", verb: "create-or-update", blastRadius: "tenant-lockout", role: "dependency" },
  ],
  dependencies: [{ naturalKey: "group:Privileged", resourceType: "group", blastRadius: "tenant-lockout", requiredBy: ["group:Finance"], overCeiling: true }],
  impact: { maxBlastRadius: "tenant-lockout", ceiling: "cosmetic" },
  unsupported: [{ naturalKey: "application:Payroll", resourceType: "application", operation: "delete", claim: "unsupported" }],
  unknowns: [],
  runAs: { principalId: basePolicy.run_as_principal_id, email: "svc-policy@contoso.com", name: "Policy service", readable: true, disabled: false, authorized: true,
    grants: [{ id: "6a000000-0000-4000-8000-000000000009", role: "restorer", scope: "*", activeFrom: "2026-09-01T00:00:00Z", activeUntil: null }] },
  ownership: { state: "read", resources: [] },
  benchmarkFindings: { state: "read", findings: [{ id: "e7a10000-0000-4000-8000-0000000000e9", controlId: "keel.groups.owner", title: "Groups have an owner", verdict: "fail", exposed: true, link: "mismatch", driftIds: ["d1000000-0000-4000-8000-000000000001"] }] },
  limits: { maxBlastRadius: "cosmetic", maxActionsPerWindow: 50, windowSeconds: 3600, automationHalted: false },
  blockers: [], verdict: "ready",
  versions: { policy: "a".repeat(64), grant: "b".repeat(64), ownership: "c".repeat(64), projection: "d".repeat(64) },
  digest: "e".repeat(64),
  outcomes: { queued: 1, rolledBack: 0, failed: 0 },
};

test("the activation preview names what it would roll back and everything it depends on above the limit", () => {
  assert.equal(previewSentence(preview), "Ready to turn on. It would roll back 1 change now; KEEL will refuse 1 that depends on something above its limit.");
  assert.ok(previewSentence(preview).split(/\s+/).length <= 25);
  assert.equal(previewSentence({ ...preview, verdict: "blocked", blockers: ["unknown-impact"], unknowns: [{ reason: "unresolved-reference", naturalKeys: ["group:Finance"], detail: "x" }] }),
    "Cannot turn on: KEEL cannot tell what rolling back 1 resource would affect.");
  assert.equal(previewSentence({ ...preview, verdict: "blocked", blockers: ["run-as-not-authorized"] }), "Cannot turn on: the account it acts as can no longer roll back changes.");
  const html = renderToStaticMarkup(createElement(ActivationPreviewView, { preview, now: "2026-10-03T09:05:00Z" }));
  assert.match(html, /Privileged \(group\), needed by Finance \(group\)\. Impact: could lock out admins\. Above its limit, so KEEL will refuse these roll backs\./);
  assert.match(html, /Finance \(group\) was changed\. Impact: cosmetic\.<\/li><li>Left alone: Privileged \(group\) was changed, but its impact \(could lock out admins\) is above its limit\./);
  assert.match(html, /Deleting Payroll \(app registration\) is not supported, so it stays manual\./);
  assert.match(html, /Policy service can roll back changes now\./);
  assert.match(html, /Groups have an owner: failing, with no exception\. Checked against a different backup than this change\./);
  assert.match(html, /1 waiting to run, not yet rolled back/);
  assert.match(html, /KEEL checks again before every roll back/);
  // Everything outside the record is words; every id and version is inside it.
  const [outside, record] = html.split('data-layer="record"');
  assert.doesNotMatch(outside, /[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{32,}|group:|auto_remediate|tenant-lockout|closure|blast radius|projection/i);
  for (const value of [preview.id, preview.policy.id, preview.versions.grant, preview.digest, "group:Privileged tenant-lockout over-ceiling", "6a000000-0000-4000-8000-000000000009", "e7a10000-0000-4000-8000-0000000000e9"]) {
    assert.ok(record.includes(value), `record keeps ${value}`);
  }
});

test("a queued roll back is never reported as done, and refusals say what changed", () => {
  assert.equal(outcomesSentence({ queued: 2, rolledBack: 0, failed: 0 }), "2 waiting to run, not yet rolled back");
  assert.doesNotMatch(outcomesSentence({ queued: 2, rolledBack: 0, failed: 0 }), /\b2 rolled back/);
  assert.equal(outcomesSentence({ queued: 0, rolledBack: 0, failed: 0 }), "It has not acted yet.");
  assert.equal(outcomesSentence({ queued: 1, rolledBack: 3, failed: 1 }), "1 waiting to run, not yet rolled back · 3 rolled back · 1 failed or refused");
  assert.equal(refusalSentence("preview-stale", ["grant"]), "The account's access changed since the preview. Preview again.");
  assert.equal(refusalSentence("preview-stale", ["policy", "ownership"]), "The policy and who owns what it touches changed since the preview. Preview again.");
  assert.equal(refusalSentence("preview-used"), "This preview was already used. Preview again.");
});
