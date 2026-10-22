import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { visibleNavLinks } from "@/components/nav-links";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { automationDisabled } from "@/lib/policies";
import { ruleSentence, rulesStatus, rulesVerdict, ruleCounts, ruleState } from "@/lib/policy-view";
import type { Policy } from "@/lib/policies";
import { renderPoliciesAt } from "./render-policies";

test("the page reflects the stop file's absence and presence using a read-only check, and keeps its path in the record", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".policy-switch-test-"));
  const path = join(directory, "AUTOMATION_DISABLED");
  const now = "2026-10-02T09:40:00Z";
  try {
    assert.equal(automationDisabled(path), false);
    const on = await renderPoliciesAt("", { canEdit: true, policies: [basePolicy], halted: automationDisabled(path), haltFile: path, now });
    assert.doesNotMatch(on, /stopped by an operator/);
    assert.deepEqual(rulesStatus(ruleCounts([basePolicy]), automationDisabled(path)), { tone: "fine", label: "Automation on" });
    writeFileSync(path, "");
    assert.equal(automationDisabled(path), true);
    const halted = await renderPoliciesAt("", { canEdit: true, policies: [basePolicy], halted: automationDisabled(path), haltedAt: "2026-10-02T07:40:00Z", haltFile: path, now });
    const [outside, record] = halted.split('data-layer="record"');
    assert.match(outside, /Automation is stopped by an operator/);
    assert.match(outside, /since <time[^>]*>2 hours ago<\/time>/);
    assert.doesNotMatch(outside, /kill switch|halt file/i);
    assert.equal(outside.includes(path), false, "the stop file's path is not in the visible text");
    assert.ok(record.includes(path), "the stop file's path is in Technical details");
    assert.deepEqual(rulesStatus(ruleCounts([basePolicy]), true), { tone: "urgent", label: "Automation halted" });
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

test("a rule reads as what it does and how often, never its codes or ids", async () => {
  const now = "2026-10-02T09:40:00Z";
  assert.equal(ruleSentence(basePolicy), "Undoes low-risk changes to anything, up to 50 an hour.");
  assert.equal(ruleSentence({ ...basePolicy, action: "alert" }), "Alerts on low-risk changes to anything and changes nothing.");
  assert.equal(ruleState({ ...basePolicy, paused_at: "2026-10-02T07:40:00Z" }), "paused");
  assert.equal(ruleState({ ...basePolicy, enabled: false }), "off");
  const paused = rulesVerdict([basePolicy, { ...basePolicy, id: "7a1d0f3e-0000-4000-8000-000000000002", name: "Undo group changes", paused_at: "2026-10-02T07:40:00Z" }], false, now);
  assert.equal(paused.text, "Undo group changes paused itself after hitting its limit 2 hours ago.");
  assert.equal(paused.resume?.name, "Undo group changes");
  // The run-as account reads as a person, by name; an unreadable one says so.
  const html = await renderPoliciesAt("", { canEdit: true, policies: [basePolicy, { ...basePolicy, id: "7a1d0f3e-0000-4000-8000-000000000002", name: "Undo mail changes", run_as_principal: { ...basePolicy.run_as_principal!, readable: false, name: null } }], halted: false, now });
  const [outside] = html.split('data-layer="record"');
  assert.match(outside, /Svc Policy/);
  assert.match(outside, /an account that no longer exists/);
  for (const sentence of [ruleSentence(basePolicy), paused.text, outside.replace(/(href|title|data-row-id|aria-labelledby|id|for)="[^"]*"/g, "")]) {
    assert.doesNotMatch(sentence, /dispose-accept|auto_remediate|[0-9a-f]{8}-[0-9a-f]{4}|svc-policy@/);
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
  assert.match(layout, /capabilities=\{\{[^}]*\bcanPolicies\b/);
});

// Roadmap task-92: the activation preview reads in words; ids, codes and versions stay
// in its record; a queued roll back never reads as done.
import { ActivationPreviewView, outcomesSentence, previewSentence, refusalSentence } from "@/components/policy-preview";
import { previewAlerts, previewTiles } from "@/lib/policy-preview-view";
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
  assert.equal(previewSentence(preview), "Ready to turn on. It would undo 1 change now; Keel will refuse 1 that depends on something above its limit.");
  assert.ok(previewSentence(preview).split(/\s+/).length <= 25);
  assert.equal(previewSentence({ ...preview, verdict: "blocked", blockers: ["unknown-impact"], unknowns: [{ reason: "unresolved-reference", naturalKeys: ["group:Finance"], detail: "x" }] }),
    "Cannot turn on: Keel cannot tell what undoing 1 change would affect.");
  assert.equal(previewSentence({ ...preview, verdict: "blocked", blockers: ["run-as-not-authorized"] }), "Cannot turn on: the account it acts as can no longer undo changes.");
  const html = renderToStaticMarkup(createElement(ActivationPreviewView, { preview, now: "2026-10-03T09:05:00Z" }));
  const words = html.replace(/<details[\s\S]*?<\/details>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  // Rows, not prose: each item with what changed, its impact and what happens to it.
  assert.match(words, /Finance \(group\) Needs Privileged \(group\) Changed Low risk Will refuse/);
  assert.match(words, /Privileged \(group\) Above its limit Changed Could lock out admins Left alone/);
  assert.match(words, /Privileged \(group\) Needed by Finance \(group\) Could lock out admins Above its limit/);
  assert.match(words, /Payroll \(app registration\) Delete Not rated Manual only/);
  assert.match(words, /Policy service Can undo changes/);
  assert.match(words, /Groups have an owner Failing No exception · Different backup than this change/);
  assert.match(words, /1 waiting to run, not yet undone/);
  assert.match(words, /Keel checks again before every undo/);
  // What needs the reader comes first, worst first, each with what to do; specifics wait behind Show details.
  assert.deepEqual(previewAlerts(preview).map((alert) => [alert.key, alert.tone]), [["refused", "soon"], ["manual", "soon"], ["left-alone", "low"]]);
  assert.ok(html.indexOf('data-alert="refused"') < html.indexOf('class="rs-table pv-table"'), "alerts come before the table");
  assert.match(html, /<details class="ui-alert-more"[^>]*><summary>Show details<\/summary><ul><li>Privileged \(group\) \(could lock out admins\) is needed by Finance \(group\)\.<\/li>/);
  assert.deepEqual(previewTiles(preview).map((tile) => [tile.key, tile.value, tile.tone]), [["undo", "0", "neutral"], ["refused", "1", "soon"], ["left-alone", "2", "low"], ["checks", "1", "urgent"]]);
  // A blocked preview leads with the blocker, in red.
  assert.equal(previewAlerts({ ...preview, verdict: "blocked", blockers: ["run-as-not-authorized"], runAs: { ...preview.runAs, authorized: false } })[0].key, "run-as");
  assert.equal(previewAlerts({ ...preview, verdict: "blocked", blockers: ["run-as-not-authorized"], runAs: { ...preview.runAs, authorized: false } })[0].tone, "urgent");
  // Everything outside the record is words; every id and version is inside it.
  const [outside, record] = html.split('data-layer="record"');
  assert.doesNotMatch(outside, /[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{32,}|group:|auto_remediate|tenant-lockout|closure|blast radius|projection/i);
  for (const value of [preview.id, preview.policy.id, preview.versions.grant, preview.digest, "group:Privileged tenant-lockout over-ceiling", "6a000000-0000-4000-8000-000000000009", "e7a10000-0000-4000-8000-0000000000e9"]) {
    assert.ok(record.includes(value), `record keeps ${value}`);
  }
});

test("a queued undo is never reported as done, and refusals say what changed", () => {
  assert.equal(outcomesSentence({ queued: 2, rolledBack: 0, failed: 0 }), "2 waiting to run, not yet undone");
  assert.doesNotMatch(outcomesSentence({ queued: 2, rolledBack: 0, failed: 0 }), /\b2 undone/);
  assert.equal(outcomesSentence({ queued: 0, rolledBack: 0, failed: 0 }), "It has not acted yet.");
  assert.equal(outcomesSentence({ queued: 1, rolledBack: 3, failed: 1 }), "1 waiting to run, not yet undone · 3 undone · 1 failed or refused");
  assert.equal(refusalSentence("preview-stale", ["grant"]), "The account's access changed since the preview. Preview again.");
  assert.equal(refusalSentence("preview-stale", ["policy", "ownership"]), "The policy and who owns what it touches changed since the preview. Preview again.");
  assert.equal(refusalSentence("preview-used"), "This preview was already used. Preview again.");
});
