import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { compareWorkloads } from "../../engine/govern/compare.mjs";
import { IntentCard } from "@/components/change-intent";
import { exclusionLabel } from "@/lib/incidents-view";
import { ActivationPreviewView } from "@/components/policy-preview";
import { recordTitle, type ChangeRecord } from "@/lib/ask-view";
import { intentResource, type ChangeIntent } from "@/lib/change-intents-view";
import { exceptionSentence } from "@/lib/compliance-view";
import { previewNames, type ActivationPreview, type Policy } from "@/lib/policies";
import { withApproverNames } from "@/lib/portal-data";
import { renderPoliciesAt } from "./render-policies";
import type { BaselineRecord, ComplianceFinding } from "@/lib/types";

// Emergency changes, Policies, Baselines and the smaller spots name what they are about
// and who acted, never by an object id, an email address or a system code. Ids stay in
// Technical details.

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SCRIPT_ID = "5b1c2d3e-0000-4000-8000-00000000c0de";
const GROUP_ID = "6c2d3e4f-0000-4000-8000-0000000000aa";
const NOW = "2026-10-17T10:00:00Z";

function visible(html: string): string {
  return html.replace(/<details[\s\S]*?<\/details>/g, "").replace(/(href|value|title|data-row-id|aria-labelledby|id|for)="[^"]*"/g, "");
}

const person = (id: string, email: string | null, name: string | null) => ({ id, email, name, readable: email != null });

const intent: ChangeIntent = {
  id: "11111111-0000-4000-8000-000000000001", naturalKey: SCRIPT_ID, resourceType: "deviceManagementScript", name: "Disable USB storage",
  transitions: [{ field: "runAsAccount", before: { present: true, value: "system" }, after: { present: true, value: "user" } }],
  transitionDigest: "d", owner: person("22222222-0000-4000-8000-000000000002", "maro.defili@contoso.com", "maro.defili@contoso.com"),
  approver: person("33333333-0000-4000-8000-000000000003", "ops@contoso.com", "Ops Lead"), reason: "Hotfix", externalChangeId: null,
  sourceDriftId: null, windowStart: "2026-10-17T09:00:00Z", windowEnd: "2026-10-17T13:00:00Z", approvedAt: "2026-10-17T09:00:00Z",
  decisionDigest: "x", revokedAt: null, revokedBy: null, revokeReason: null, settledAt: null, settlement: null, state: "active",
};

test("an emergency change names its resource and people, never their ids or emails", () => {
  const html = renderToStaticMarkup(createElement(IntentCard, { intent, now: NOW }));
  const shown = visible(html);
  assert.match(shown, /Disable USB storage \(device management script\)/);
  assert.match(shown, /Approved by<\/dt><dd>Ops Lead/);
  assert.match(shown, /Change made by<\/dt><dd>Maro Defili/);
  assert.doesNotMatch(shown, GUID);
  assert.doesNotMatch(shown, /@contoso\.com/);
  assert.match(html, new RegExp(SCRIPT_ID), "the key stays in Technical details");
  // Without a saved name: the kind, never the id.
  assert.equal(intentResource({ ...intent, name: null }), "Unnamed device management script");
  assert.equal(intentResource({ naturalKey: "group:Finance", resourceType: "group", name: null }), "Finance (group)");
});

const policy: Policy = {
  id: "7a1d0f3e-0000-4000-8000-000000000001", name: "Auto-accept cosmetic drift", enabled: true, paused_at: null, run_as_repair_required: false,
  run_as_principal_id: "3f9c2b1e-0000-4000-8000-000000000002",
  run_as_principal: { id: "3f9c2b1e-0000-4000-8000-000000000002", email: "svc-policy@contoso.com", name: "svc-policy@contoso.com", readable: true },
  resource_type: null, blast_radius: "cosmetic", natural_key_glob: null, change_type: "modified", action: "auto_remediate",
  max_blast_radius: "cosmetic", max_actions_per_window: 50, window_seconds: 3600, created_by: "admin", created_at: "2026-09-12T08:00:00Z",
  last_action_at: "2026-10-17T07:40:00Z", last_action_status: "executed", last_action_natural_key: SCRIPT_ID, last_action_name: "Disable USB storage", last_action_resource_type: "deviceManagementScript",
  actions_last_7_days: 3,
};

test("a rule says what it last acted on and who it acts as by name", async () => {
  const shown = visible(await renderPoliciesAt("", { canEdit: true, policies: [policy], halted: false, now: NOW }));
  assert.match(shown, /Last undid Disable USB storage 2 hours ago/);
  assert.match(shown, /Svc Policy/, "the run-as account reads as a name drawn from its email");
  assert.doesNotMatch(shown, /svc-policy@contoso\.com/);
  assert.doesNotMatch(shown, GUID);
  const unnamed = visible(await renderPoliciesAt("", { canEdit: true, policies: [{ ...policy, last_action_name: null, last_action_resource_type: null }], halted: false, now: NOW }));
  assert.match(unnamed, /Last undid an unnamed setting 2 hours ago/);
  assert.doesNotMatch(unnamed, GUID);
});

const preview: ActivationPreview = {
  id: "9a0c0000-0000-4000-8000-000000000092", requestedBy: "8c1e0000-0000-4000-8000-0000000000a1",
  createdAt: "2026-10-17T09:00:00Z", expiresAt: "2026-10-17T09:30:00Z",
  policy: { id: policy.id, name: policy.name, enabled: false, action: "auto_remediate" },
  matched: [{ driftId: "d1000000-0000-4000-8000-000000000001", naturalKey: SCRIPT_ID, resourceType: "deviceManagementScript", changeType: "modified", blastRadius: "cosmetic", detectedAt: NOW }],
  matchedOverCeiling: [],
  operations: [],
  dependencies: [{ naturalKey: GROUP_ID, resourceType: "group", blastRadius: "cosmetic", requiredBy: [SCRIPT_ID], overCeiling: false }],
  impact: { maxBlastRadius: "cosmetic", ceiling: "cosmetic" },
  unsupported: [{ naturalKey: GROUP_ID, resourceType: "group", operation: "create", claim: "none" }],
  unknowns: [{ reason: "impact-unknown", naturalKeys: [SCRIPT_ID], detail: "x" }],
  runAs: { principalId: policy.run_as_principal_id, email: "svc-policy@contoso.com", name: "svc-policy@contoso.com", readable: true, disabled: false, authorized: true, grants: [] },
  ownership: { state: "owned", resources: [] },
  benchmarkFindings: { state: "read", findings: [] },
  limits: { maxBlastRadius: "cosmetic", maxActionsPerWindow: null, windowSeconds: null, automationHalted: false },
  blockers: [], verdict: "ready", versions: { policy: "1", grant: "1", ownership: "1", projection: "1" }, digest: "x",
};

test("the activation preview lists every resource by its saved name", async () => {
  const client = {
    async query(sql: string) {
      if (sql.includes("FROM resource_version")) {
        return { rows: [{ natural_key: GROUP_ID, resource_type: "group", name: "Finance" }, { natural_key: SCRIPT_ID, resource_type: "deviceManagementScript", name: null }] };
      }
      return { rows: [{ natural_key: SCRIPT_ID, resource_type: "deviceManagementScript", after_payload: { displayName: "Disable USB storage" }, before_payload: null }] };
    },
  };
  const names = await previewNames(client, "tenant", preview);
  assert.equal(names[SCRIPT_ID]?.name, "Disable USB storage", "the change's own name fills a gap in the backup");
  assert.equal(names[GROUP_ID]?.name, "Finance");
  const html = renderToStaticMarkup(createElement(ActivationPreviewView, { preview: { ...preview, names }, now: NOW }));
  const shown = visible(html);
  assert.match(shown, /Disable USB storage \(device management script\) was changed/);
  assert.match(shown, /Finance \(group\), needed by Disable USB storage \(device management script\)/);
  assert.match(shown, /Svc Policy can undo changes now/);
  assert.doesNotMatch(shown, GUID);
  // A failed lookup leaves names empty, never the preview down.
  assert.deepEqual(await previewNames({ async query() { throw new Error("down"); } }, "tenant", preview), {});
  assert.doesNotMatch(visible(renderToStaticMarkup(createElement(ActivationPreviewView, { preview, now: NOW }))), GUID);
});

test("a baseline's approver is a name: a person, or Keel's scheduler, never a code or id", async () => {
  const known = "44444444-0000-4000-8000-000000000004";
  const gone = "55555555-0000-4000-8000-000000000005";
  const client = { async query() { return { rows: [{ id: known, email: "maro.defili@contoso.com", display_name: null }] }; } };
  const base = { id: "b", label: "Setup", setAt: NOW } as unknown as BaselineRecord;
  const named = await withApproverNames(client as never, [
    { ...base, setBy: known }, { ...base, setBy: "scheduler" }, { ...base, setBy: gone },
  ]);
  assert.deepEqual(named.map((baseline) => baseline.setByRef?.name), ["Maro Defili", "Keel's scheduler", "an account that no longer exists"]);
});

test("smaller spots: compare sites, incident exclusions, ask answers and exception owners use names", () => {
  // Compare: a SharePoint site reads by its title, never the site id its key holds.
  const site = `contoso.sharepoint.com,${GROUP_ID},${SCRIPT_ID}`;
  const observation = (title: string | null, sharing: string) => ({ resourceKey: `site:${site}`, fields: { ...(title ? { title } : {}), sharing }, fieldCoverage: { title: { status: "observed" }, sharing: { status: "observed" } } });
  const side = (title: string | null, sharing: string) => new Map([["sharepoint-site-settings", { collectionId: "c", outcome: "complete", at: NOW, observations: [observation(title, sharing)] }]]);
  const sites = compareWorkloads(side("Finance team", "off"), side("Finance team", "anyone"));
  assert.equal((sites.groups[0] as { items?: { name?: string }[] }).items?.[0]?.name, "Finance team");

  assert.equal(exclusionLabel({ naturalKey: SCRIPT_ID, field: null, displayName: null }), "Unnamed setting");
  assert.equal(exclusionLabel({ naturalKey: `group:${GROUP_ID}`, field: "description", displayName: "Board" }), "the “description” setting of Board (group)");

  const record = { kind: "change", id: "x", resourceType: "deviceManagementScript", naturalKey: SCRIPT_ID, name: null } as unknown as ChangeRecord;
  assert.equal(recordTitle(record), "Unnamed device management script");
  assert.equal(recordTitle({ ...record, name: "Disable USB storage" }), "Disable USB storage (device management script)");

  const finding = { exception: { owner: "maro.defili@contoso.com", expiresAt: "2026-11-01T00:00:00Z", reason: "Pilot" }, exceptionState: "authorized" } as unknown as ComplianceFinding;
  assert.match(exceptionSentence(finding, NOW) ?? "", /^Exception owned by Maro Defili until /);
});
