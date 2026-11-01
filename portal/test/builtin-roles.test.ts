import assert from "node:assert/strict";
import { test } from "node:test";

import { itemKindName, kindLine, plainKind } from "@/lib/baselines-view";
import { actionKindLine } from "@/lib/policy-view";

// Backlog D3: Global Administrator and Security Administrator read as "Custom admin role ·
// changed". An Entra role definition holds Microsoft's roles and the tenant's own, so one
// role reads by its isBuiltIn flag and the kind (filters, groups) reads as "Admin role".
test("a built-in admin role is never called custom", () => {
  assert.equal(kindLine({ resourceType: "roleDefinition", changeType: "modified", builtIn: true }), "Built-in admin role · changed");
  assert.equal(kindLine({ resourceType: "roleDefinition", changeType: "added", builtIn: false }), "Custom admin role · added");
  assert.equal(itemKindName({ resourceType: "roleDefinition" }), "Admin role");
  assert.equal(plainKind("roleDefinition"), "Admin role");
  assert.equal(actionKindLine({ resource_type: "roleDefinition", change_type: "modified", built_in: true }), "Built-in admin role · Entra ID · changed");
});

test("the flag changes nothing for other kinds", () => {
  assert.equal(kindLine({ resourceType: "conditionalAccessPolicy", changeType: "modified", builtIn: true }), "Sign-in rule · changed");
});
