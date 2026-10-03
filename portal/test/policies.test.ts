import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { visibleNavLinks } from "@/components/nav-links";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { automationDisabled } from "@/lib/policies";
import { KillSwitchBadge } from "@/components/policy-state";

test("kill-switch badge reflects file absence and presence using a read-only check", () => {
  const directory = mkdtempSync(join(process.cwd(), ".policy-switch-test-"));
  const path = join(directory, "AUTOMATION_DISABLED");
  try {
    assert.equal(automationDisabled(path), false);
    assert.match(renderToStaticMarkup(createElement(KillSwitchBadge, { disabled: automationDisabled(path) })), /kill switch inactive/);
    writeFileSync(path, "");
    assert.equal(automationDisabled(path), true);
    assert.match(renderToStaticMarkup(createElement(KillSwitchBadge, { disabled: automationDisabled(path) })), /globally halted/);
    assert.equal(readFileSync(path, "utf8"), "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
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
