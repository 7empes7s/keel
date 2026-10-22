import assert from "node:assert/strict";
import { test } from "node:test";

import { madeInSharePoint, restoreService, rowImpact } from "@/lib/restore-view";

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
  assert.equal(madeInSharePoint(made), true);
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
