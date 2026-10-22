import assert from "node:assert/strict";
import test from "node:test";

import { CATALOG } from "../../tools/tenant-probe/catalog.mjs";
import { compareKinds, kindOrder, kindParts } from "../lib/type-groups";

// Inside every service, lists show settings under their kind, in one order:
// people and objects, then memberships and roles, then policies, then tenant settings.

test("a service's settings split by kind, people first and tenant settings last", () => {
  const rows = ["organization", "conditionalAccessPolicy", "roleAssignment", "groupMembership", "group", "user", "servicePrincipal", "user"]
    .map((type, index) => ({ type, name: `${type}-${8 - index}` }));
  const parts = kindParts(rows, (row) => row.type, "Entra", (a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(parts.map((part) => part.label), [
    "Users and contacts", "Groups and administrative units", "Memberships and owners", "Admin roles",
    "Apps and consent", "Sign-in rules and methods", "Tenant and directory settings",
  ]);
  assert.deepEqual(parts[0].items.map((row) => row.name), ["user-1", "user-3"], "rows inside a kind sort by the given order");
});

test("a type filed under another service sorts after the service's own kinds, under its own kind name", () => {
  const parts = kindParts([{ type: "conditionalAccessPolicy" }, { type: "sharepointSettings" }, { type: "sharepoint-site-settings" }], (row) => row.type, "SharePoint");
  assert.deepEqual(parts.map((part) => part.label), ["Sites and OneDrive", "Tenant settings", "Sign-in rules and methods"]);
  assert.equal(parts[2].key, "Entra-sign-in");
});

test("unknown types land in one Other group at the end, never on their own", () => {
  const parts = kindParts([{ type: "brandNewThing" }, { type: "user" }, { type: "anotherNewThing" }], (row) => row.type, "Entra");
  assert.deepEqual(parts.map((part) => [part.label, part.items.length]), [["Users and contacts", 1], ["Other settings", 2]]);
});

test("every catalogued type has a kind, so no list shows it under Other", () => {
  const other = CATALOG.map((entry: { type: string }) => entry.type).filter((type: string) => kindParts([{ type }], (row) => row.type)[0].key === "other");
  assert.deepEqual(other, []);
});

test("type lists across services sort by service, then kind", () => {
  const sorted = ["deviceConfiguration", "exchange-mail-flow", "conditionalAccessPolicy", "user"].sort((a, b) => kindOrder(a) - kindOrder(b));
  assert.deepEqual(sorted, ["user", "conditionalAccessPolicy", "exchange-mail-flow", "deviceConfiguration"]);
  assert.ok(compareKinds("managedDevice", "deviceConfiguration", "Intune") < 0);
});

test("Exchange and the other app services split by kind too, including codes stored without a service prefix", () => {
  const rows = ["exchangeOrganizationConfig", "transportRule", "exchangeMailboxSettings", "exchangeRoleDefinition", "exchangeInboundConnector"].map((type) => ({ type }));
  const parts = kindParts(rows, (row) => row.type, "Exchange");
  assert.deepEqual(parts.map((part) => [part.label, part.items.length]), [
    ["Mailboxes", 1], ["Admin roles", 1], ["Mail flow and protection", 2], ["Organization settings", 1],
  ]);
  const teams = kindParts([{ type: "teamsMeetingPolicy" }, { type: "teamsMembership" }], (row) => row.type, "Teams");
  assert.deepEqual(teams.map((part) => part.label), ["Teams and members", "Calling and meetings"]);
});

test("a service with one kind still gets its kind heading", () => {
  const parts = kindParts([{ type: "exchangeRoleDefinition" }, { type: "exchangeRoleAssignment" }], (row) => row.type, "Exchange");
  assert.deepEqual(parts.map((part) => part.label), ["Admin roles"]);
});
