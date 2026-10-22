import assert from "node:assert/strict";
import { test } from "node:test";

import { itemService, serviceSummaries } from "@/lib/baselines-view";
import { restoreService, rowImpact } from "@/lib/restore-view";
import { madeInSharePoint } from "@/lib/services";

// The Restore list's impact badge and service for rows that did not change.

test("an unchanged row shows no impact once KEEL has compared it: a restore writes nothing", () => {
  assert.equal(rowImpact("tenant-lockout", true), null);
  assert.equal(rowImpact("access-affecting", true), null);
});

test("before the comparison the impact stays, even for sign-in rules", () => {
  assert.equal(rowImpact("tenant-lockout", false), "tenant-lockout");
  assert.equal(rowImpact("cosmetic", false), "cosmetic");
});

test("sign-in rules made in SharePoint admin center sit under SharePoint", () => {
  const made = { resourceType: "conditionalAccessPolicy", service: "Entra", name: "[SharePoint admin center]Block access from apps on unmanaged devices - 2024/12/02" };
  assert.equal(madeInSharePoint(made.resourceType, made.name), true);
  assert.equal(restoreService(made), "SharePoint");
  // The name may only reach the row as its label.
  const unnamed = { resourceType: "conditionalAccessPolicy", service: "Entra", name: null };
  assert.equal(restoreService(unnamed, "[SharePoint admin center]Use app-enforced Restrictions for browser access - 2025/01/20"), "SharePoint");
});

test("other sign-in rules and other types keep their service", () => {
  assert.equal(restoreService({ resourceType: "conditionalAccessPolicy", service: "Entra", name: "Require MFA for admins" }), "Entra");
  assert.equal(restoreService({ resourceType: "group", service: "Entra", name: "[SharePoint admin center] look-alike" }), "Entra");
  assert.equal(restoreService({ resourceType: "conditionalAccessPolicy", service: null, name: "SharePoint admin center policy" }), null);
});

const SP_RULE = { resourceType: "conditionalAccessPolicy", blastRadius: "tenant-lockout", name: "[SharePoint admin center]Use app-enforced Restrictions for browser access - 2025/01/20" };

test("Baselines places a change to a SharePoint-made sign-in rule under SharePoint, and counts it there", () => {
  assert.equal(itemService(SP_RULE).code, "SharePoint");
  assert.equal(itemService({ ...SP_RULE, name: "Require MFA for admins" }).code, "Entra");
  const summaries = serviceSummaries(null, [SP_RULE, { ...SP_RULE, name: "Require MFA for admins" }], []);
  const changed = Object.fromEntries(summaries.map((summary) => [summary.service.code, summary.changed]));
  assert.deepEqual(changed, { Entra: 1, SharePoint: 1 });
});
