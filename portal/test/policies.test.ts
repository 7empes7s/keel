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
  for (const name of ["Create", "Update"]) {
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
