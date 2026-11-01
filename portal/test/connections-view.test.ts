import assert from "node:assert/strict";
import { test } from "node:test";

import { KEEL_PERMISSIONS } from "../../engine/bootstrap/permissionCatalog.mjs";
import {
  GRANT_LABELS, GRANT_TONES, connectionAlerts, connectionGroups, connectionStatus, grantRows, grantsFromEarlierCheck, grantSummary,
  type Connection,
} from "../lib/connections-view";
import type { PermissionEntry } from "../lib/setup-view";

const NOW = "2026-10-02T09:40:00Z";
const CATALOG = KEEL_PERMISSIONS as unknown as PermissionEntry[];

const connection = (fields: Partial<Connection>): Connection => ({
  id: `c-${fields.role ?? "settings-reader"}`, kind: "app", role: "settings-reader", name: "Keel Settings Reader",
  purpose: "Backs up your Microsoft 365 settings. Read only.", required: true, state: "working", appId: "app-1",
  credentialExpiresAt: "2027-03-01T00:00:00Z", credentialExpiresInDays: 150,
  wanted: { permissions: ["Group.Read.All", "User.Read.All"], roles: [] },
  observed: {
    at: "2026-10-02T09:38:00Z", displayName: "Keel Settings Reader", enabled: true,
    grantedPermissions: ["Group.Read.All", "User.Read.All"], missingPermissions: [], extraPermissions: [], missingRoles: [],
  },
  lastUsedAt: null, lastSignInAt: null, updatedAt: "2026-10-02T09:38:00Z",
  ...fields,
});

test("a state the page does not know is never shown as working or as a problem", () => {
  const status = connectionStatus(connection({ state: "something-new" }), NOW);
  assert.equal(status.label, "Unknown state");
  assert.equal(status.tone, "neutral");
  assert.equal(status.problem, false);
});

test("a restorer switched off between restores is not a problem; any other app switched off is", () => {
  assert.equal(connectionStatus(connection({ role: "settings-restorer", required: false, state: "switched-off" }), NOW).problem, false);
  const content = connectionStatus(connection({ role: "content-reader", required: false, state: "switched-off" }), NOW);
  assert.equal(content.tone, "soon");
  assert.equal(content.problem, true);
  const required = connectionStatus(connection({ state: "switched-off" }), NOW);
  assert.equal(required.tone, "urgent");
  assert.equal(required.problem, true);
});

test("a working app whose certificate ends within 30 days is flagged, amber then red in the last week", () => {
  const ends = (at: string) => connection({ credentialExpiresAt: at });
  assert.equal(connectionStatus(ends("2026-10-14T09:00:00Z"), NOW).label, "Expires in 12 days");
  assert.equal(connectionStatus(ends("2026-10-14T09:00:00Z"), NOW).tone, "soon");
  assert.equal(connectionStatus(ends("2026-10-05T09:00:00Z"), NOW).tone, "urgent");
  assert.equal(connectionStatus(ends("2026-10-01T09:00:00Z"), NOW).label, "Certificate expired");
  assert.equal(connectionStatus(ends("2026-11-05T09:00:00Z"), NOW).label, "Working");
});

test("groups are always Required, Optional, Service accounts, with problems first inside each", () => {
  const groups = connectionGroups([
    connection({ role: "settings-restorer", name: "Keel Settings Restorer", required: false, state: "switched-off" }),
    connection({ role: "content-reader", name: "Keel Content Reader", required: false, state: "missing-permission" }),
    connection({}),
  ], NOW);
  assert.deepEqual(groups.map((group) => group.title), ["Required apps", "Optional apps", "Service accounts"]);
  assert.deepEqual(groups[1].connections.map((entry) => entry.name), ["Keel Content Reader", "Keel Settings Restorer"]);
  assert.equal(groups[2].connections.length, 0);
});

test("alerts say what stops, worst first, and leave certificate expiry to the sign-in warning", () => {
  const alerts = connectionAlerts([
    connection({ credentialExpiresAt: "2026-10-05T09:00:00Z" }),
    connection({ role: "settings-restorer", name: "Keel Settings Restorer", required: false, state: "waiting-for-consent" }),
    connection({
      role: "content-reader", name: "Keel Content Reader", required: false, state: "missing-permission",
      observed: { at: "2026-10-02T09:38:00Z", displayName: null, enabled: true, grantedPermissions: [], missingPermissions: ["Mail.Read", "Files.Read.All"], extraPermissions: [], missingRoles: null },
    }),
  ], NOW);
  assert.deepEqual(alerts.map((alert) => [alert.tone, alert.text]), [
    ["urgent", "Keel Content Reader is missing 2 permissions: mail, file and Teams backups may be incomplete."],
    ["soon", "Keel Settings Restorer is waiting for an administrator to approve it: restores cannot run yet."],
  ]);
});

test("wanted next to granted: missing first, a grant Keel never uses last, roles Keel cannot see not checked", () => {
  const rows = grantRows(connection({
    wanted: { permissions: ["Group.Read.All", "Policy.Read.All", "User.Read.All"], roles: ["Read Only Operator"] },
    observed: {
      at: "2026-10-02T09:38:00Z", displayName: null, enabled: true,
      grantedPermissions: ["Group.Read.All", "User.Read.All"], missingPermissions: ["Policy.Read.All"], extraPermissions: ["Channel.Create"], missingRoles: null,
    },
  }), CATALOG);
  assert.deepEqual(rows.map((row) => [row.name, row.status, row.wanted]), [
    ["Policy.Read.All", "missing", true],
    ["Read Only Operator", "not-checked", true],
    ["User.Read.All", "granted", true],
    ["Group.Read.All", "granted", true],
    ["Channel.Create", "extra", false],
  ]);
  assert.equal(rows[0].words, "Read sign-in rules and other policies");
  assert.equal(grantSummary(rows), "2 of 4 granted");
  // Backlog C4: held but never used is excess privilege, amber, with why and how to remove it.
  const extra = rows.at(-1)!;
  assert.equal(GRANT_TONES.extra, "soon");
  assert.equal(GRANT_LABELS.extra, "Extra access");
  assert.match(extra.usedFor ?? "", /Nothing in Keel uses this\..*sign-in.*Remove it from the app in Entra ID\./);
});

test("without a tenant read nothing is called missing or granted", () => {
  const rows = grantRows(connection({ observed: null }), CATALOG);
  assert.ok(rows.every((row) => row.status === "not-checked"));
  assert.equal(grantSummary(rows), "2 not checked");
  assert.deepEqual(connectionAlerts([connection({ state: "not-checked", observed: null })], NOW), []);
});

test("grants kept from an earlier check are marked as such, never as a fresh read", () => {
  const seen = (at: string) => connection({ observed: { ...connection({}).observed!, at } });
  assert.equal(grantsFromEarlierCheck(seen("2026-10-02T09:38:00Z"), NOW), false);
  assert.equal(grantsFromEarlierCheck(seen("2026-10-01T09:38:00Z"), NOW), true);
  assert.equal(grantsFromEarlierCheck(connection({ observed: null }), NOW), false);
});

test("the Engage writer (issue #681): switched off between restores is fine, its grants come from its own catalogue entry", () => {
  const engage = (fields: Partial<Connection>) => connection({
    role: "engage-writer", name: "Keel Engage Writer", required: false,
    wanted: { permissions: ["Community.ReadWrite.All"], roles: [] }, ...fields,
  });
  assert.equal(connectionStatus(engage({ state: "switched-off" }), NOW).problem, false);
  const missing = engage({
    state: "missing-permission",
    observed: { at: "2026-10-02T09:38:00Z", displayName: null, enabled: true, grantedPermissions: [], missingPermissions: ["Community.ReadWrite.All"], extraPermissions: [], missingRoles: [] },
  });
  assert.deepEqual(connectionAlerts([missing], NOW).map((alert) => alert.text), [
    "Keel Engage Writer is missing 1 permission: Viva Engage community restores may be incomplete.",
  ]);
  const rows = grantRows(missing, CATALOG);
  assert.deepEqual(rows.map((row) => [row.name, row.status, row.words]), [["Community.ReadWrite.All", "missing", "Change Viva Engage communities"]]);
});
