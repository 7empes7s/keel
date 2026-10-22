import assert from "node:assert/strict";
import { test } from "node:test";

import { KEEL_PERMISSIONS, PERMISSION_APIS, PERMISSION_KINDS, PERMISSION_SERVICES } from "../../engine/bootstrap/permissionCatalog.mjs";
import {
  apiPermissionsLink, consentLink, currentStep, missingSentence, nextSentence, permissionChips, permissionCounts, permissionList, permissionRows,
  setupPrimary, setupStatus, stepHelp, stepLink, stepTitle,
  type PermissionEntry, type SetupPermissions, type SetupScope, type SetupState, type SetupStep,
} from "../lib/setup-view";

const TENANT = "72f988bf-0000-4000-8000-0000000000aa";
const APP = { displayName: "Keel Restore Writer (Contoso)", appId: "2e570e00-0000-4000-8000-0000000000c2" };

const step = (fields: Partial<SetupStep>): SetupStep => ({
  id: "step-1", kind: "graph-permission", identity: "restorer", workload: null, name: "keel-restorer admin consent",
  action: "grant-consent", requiredScopes: ["Group.ReadWrite.All", "Policy.ReadWrite.ConditionalAccess"],
  missingScopes: ["Group.ReadWrite.All", "Policy.ReadWrite.ConditionalAccess"], manual: false, progress: "needs-consent", app: APP,
  ...fields,
});

const scope = (steps: SetupStep[], fields: Partial<SetupScope> = {}): SetupScope => ({ scope: "restore", workloads: ["entra-restore"], observed: true, run: null, steps, ...fields });
const state = (scopes: SetupScope[], fields: Partial<SetupState> = {}): SetupState => ({
  generatedAt: "2026-10-21T12:00:00Z", tenantId: TENANT, scopes, collect: { allowed: false, basis: "not-set-up", missing: [] },
  firstCollection: null, canCheck: true, canProvision: true, ...fields,
});

test("admin consent links to Microsoft's consent page only when the tenant and app ids are known", () => {
  assert.deepEqual(stepLink(step({}), TENANT), {
    label: "Open admin consent in Microsoft",
    href: `https://login.microsoftonline.com/${TENANT}/adminconsent?client_id=${APP.appId}`,
  });
  assert.equal(stepLink(step({ app: null }), TENANT), null);
  assert.equal(stepLink(step({ app: { displayName: "x", appId: null } }), TENANT), null);
  assert.equal(stepLink(step({}), null), null);
  assert.equal(stepLink(step({ kind: "keel-app-permission" }), TENANT), null);
  assert.match(stepLink(step({ kind: "workload-rbac" }), TENANT)!.href, /^https:\/\/intune\.microsoft\.com\//);
  assert.match(stepLink(step({ kind: "pim-activation" }), TENANT)!.href, /^https:\/\/entra\.microsoft\.com\//);
  assert.match(stepLink(step({ kind: "registration" }), TENANT)!.href, new RegExp(`appId/${APP.appId}$`));
  assert.match(stepLink(step({ kind: "registration", app: null }), TENANT)!.href, /ApplicationsListBlade$/);
});

test("a step's permissions are plain words with the Microsoft name kept apart; what the app holds beyond them is not a step chip", () => {
  const chips = permissionChips(step({ excessScopes: ["MailboxSettings.ReadWrite"], missingScopes: ["Group.ReadWrite.All", "Some.New.Scope"] }));
  assert.deepEqual(chips, [
    { words: "Change groups", code: "Group.ReadWrite.All" },
    { words: "Some.New.Scope", code: "Some.New.Scope" },
  ]);
  assert.equal(permissionList(step({})), "Group.ReadWrite.All\nPolicy.ReadWrite.ConditionalAccess");
  for (const kind of ["registration", "graph-permission", "workload-rbac", "pim-activation", "keel-app-permission"] as const) {
    const words = `${stepTitle(step({ kind, name: "Role" }))} ${stepHelp(step({ kind, name: "Role" }))}`;
    assert.doesNotMatch(words, /\.(Read|ReadWrite)\.|keel-(collector|restorer)|KEEL/, kind);
  }
});

test("titles name what the app is for; help names the app's real name when Keel has seen it", () => {
  assert.equal(stepTitle(step({ kind: "workload-rbac", identity: "collector", name: "Read Only Operator" })), 'Give the backup reader app the Intune role "Read Only Operator"');
  assert.equal(stepTitle(step({})), "Grant admin consent for the restore writer app");
  assert.match(stepHelp(step({})), /^Approve what Keel Restore Writer \(Contoso\) may change\./);
  assert.match(stepHelp(step({ app: null })), /^Approve what the restore writer app may change\./);
});

test("the step to open is the one waiting on someone, else the first not done", () => {
  const steps = [step({ id: "a", progress: "done" }), step({ id: "b", progress: "to-do" }), step({ id: "c", progress: "waiting-for-you", kind: "pim-activation", name: "Privileged Role Administrator" })];
  assert.equal(currentStep(steps)?.id, "c");
  assert.equal(nextSentence(scope(steps)), 'Next: activate your "Privileged Role Administrator" role.');
  assert.equal(currentStep([steps[0], steps[1]])?.id, "b");
  assert.equal(currentStep([steps[0]]), null);
  assert.equal(nextSentence(scope([steps[0]])), null);
});

test("one amber action: the first backup, else continue, else start; nothing when the server cannot provision", () => {
  const run = { artifactId: "r", state: "waiting-for-you" as const, workloads: [], approvedBy: "p", approvedByName: "Sam", approvedAt: "2026-10-21T10:00:00Z", lastEventAt: null, resumableByViewer: true, build: "b", qualificationMode: "live-qualified" };
  const paused = scope([step({ progress: "waiting-for-you" })], { scope: "read", run });
  const fresh = scope([step({})]);
  assert.deepEqual(setupPrimary(state([paused, fresh]), { canStart: true, canBackup: true }), { kind: "continue", scope: "read" });
  assert.deepEqual(setupPrimary(state([fresh]), { canStart: true, canBackup: true }), { kind: "start", scope: "restore" });
  assert.equal(setupPrimary(state([fresh]), { canStart: false, canBackup: true }), null);
  assert.equal(setupPrimary(state([paused, fresh], { canProvision: false }), { canStart: true, canBackup: true }), null);
  assert.deepEqual(setupPrimary(state([paused], { collect: { allowed: true, basis: "read-access-confirmed", missing: [] } }), { canStart: true, canBackup: true }), { kind: "backup" });
  assert.deepEqual(setupPrimary(state([paused], { collect: { allowed: true, basis: "read-access-confirmed", missing: [] } }), { canStart: true, canBackup: false }), { kind: "continue", scope: "read" });
});

test("the status pill counts steps waiting on you, then says connected or not", () => {
  assert.deepEqual(setupStatus(state([scope([step({}), step({ id: "b", progress: "waiting-for-you" })])])), { tone: "soon", label: "Waiting on you: 2 steps" });
  assert.deepEqual(setupStatus(state([scope([step({ progress: "done" })])], { collect: { allowed: true, basis: "collected-before", missing: [] } })), { tone: "fine", label: "Connected" });
  assert.deepEqual(setupStatus(state([scope([step({ progress: "not-checked" })])], { checkFailed: true })), { tone: "urgent", label: "Keel cannot read the tenant" });
  assert.deepEqual(setupStatus(state([scope([step({ progress: "not-checked" })])])), { tone: "low", label: "Not connected yet" });
});

const catalog = (observed: SetupPermissions["observed"]): SetupPermissions => ({
  permissions: KEEL_PERMISSIONS as unknown as PermissionEntry[],
  services: PERMISSION_SERVICES.map((service) => ({ ...service })),
  kinds: [...PERMISSION_KINDS],
  apis: Object.fromEntries(Object.entries(PERMISSION_APIS).map(([key, api]) => [key, api.label])),
  observed,
});
const restorerNames = KEEL_PERMISSIONS.filter((entry) => entry.identity === "restorer");
const collectorNames = KEEL_PERMISSIONS.filter((entry) => entry.identity === "collector" && entry.need === "required");
const grant = (entry: { api: string; name: string }) => ({ api: entry.api, name: entry.name });

test("permission rows: granted, missing, optional and held-but-unused, grouped by app then service, most urgent first", () => {
  const heldRestorer = restorerNames.filter((entry) => entry.name !== "Policy.ReadWrite.ConditionalAccess").map(grant);
  const observed = {
    complete: true,
    byIdentity: {
      collector: { granted: collectorNames.map(grant), requested: collectorNames.map(grant) },
      restorer: { granted: [...heldRestorer, { api: "graph", name: "Channel.Create" }, { api: "graph", name: "Team.ReadBasic.All" }], requested: heldRestorer },
    },
  };
  const rows = permissionRows(state([scope([step({ progress: "done" })])], { permissions: catalog(observed) }));
  const counts = permissionCounts(rows);
  assert.equal(counts.missing, 1);
  assert.equal(counts.optional, 1, "the Purview audit search is optional, never missing");
  assert.equal(counts.unused, 2);
  assert.equal(counts["not-checked"], 0);
  const missing = rows.find((row) => row.status === "missing")!;
  assert.equal(missing.name, "Policy.ReadWrite.ConditionalAccess");
  assert.equal(missing.requested, false, "not on the app's list, so consent alone cannot grant it");
  // Grouping and order: the app with something missing first, services in their order, unused last.
  assert.deepEqual([...new Set(rows.map((row) => row.identity))], ["restorer", "collector"]);
  const restorer = rows.filter((row) => row.identity === "restorer");
  assert.equal(restorer[0].service, "entra");
  assert.deepEqual(restorer.slice(-2).map((row) => [row.status, row.name]), [["unused", "Channel.Create"], ["unused", "Team.ReadBasic.All"]]);
  assert.equal(restorer.at(-1)!.words, "List teams", "an unused permission still gets plain words when Keel knows them");
  const entra = restorer.filter((row) => row.service === "entra");
  const kinds = ["Users", "Groups", "Memberships", "Roles", "Devices", "Apps", "Policies", "Settings"];
  assert.deepEqual(entra.map((row) => kinds.indexOf(row.kind)), [...entra.map((row) => kinds.indexOf(row.kind))].sort((a, b) => a - b), "users, groups, roles, then policies and settings");
  const policies = entra.filter((row) => row.kind === "Policies");
  assert.equal(policies[0].status, "missing", "inside a kind, missing comes first");
  assert.ok(rows.some((row) => row.api === "exchange" && row.apiLabel === "Exchange Online"));
  assert.deepEqual(setupStatus(state([scope([step({ progress: "done" })])], { permissions: catalog(observed), collect: { allowed: true, basis: "collected-before", missing: [] } })), { tone: "urgent", label: "1 permission missing" });
});

test("without a fresh look only what setup saw is known; the rest is not checked, never missing", () => {
  const consent = step({ progress: "done", missingScopes: ["Group.ReadWrite.All"], excessScopes: ["Channel.Create"] });
  const rows = permissionRows(state([scope([consent])], { permissions: catalog(null) }));
  const byName = (name: string) => rows.find((row) => row.identity === "restorer" && row.name === name)!;
  assert.equal(byName("Group.ReadWrite.All").status, "missing");
  assert.equal(byName("Policy.ReadWrite.ConditionalAccess").status, "granted");
  assert.equal(byName("TeamSettings.ReadWrite.All").status, "not-checked");
  assert.equal(byName("Channel.Create").status, "unused");
  assert.ok(rows.filter((row) => row.identity === "collector").every((row) => row.status === "not-checked"));
  assert.deepEqual([...new Set(rows.map((row) => row.identity))], ["restorer", "collector"]);
  assert.equal(byName("Group.ReadWrite.All").requested, null);
  // An API whose names could not be read is not checked, never missing.
  const partial = permissionRows(state([scope([consent])], { permissions: catalog({ complete: false, byIdentity: { restorer: { granted: [], requested: [] } } }) }));
  assert.equal(partial.find((row) => row.identity === "restorer" && row.api === "exchange")!.status, "not-checked");
  assert.equal(partial.find((row) => row.identity === "restorer" && row.name === "Group.ReadWrite.All")!.status, "missing");
  assert.deepEqual(permissionRows(state([scope([consent])])), [], "no catalogue, no table");
});

test("consent and Entra links need the ids; the missing sentence says what stops", () => {
  assert.equal(consentLink(TENANT, APP.appId), `https://login.microsoftonline.com/${TENANT}/adminconsent?client_id=${APP.appId}`);
  assert.equal(consentLink(null, APP.appId), null);
  assert.equal(consentLink(TENANT, null), null);
  assert.match(apiPermissionsLink(APP.appId)!, /CallAnAPI\/appId\/2e570e00/);
  assert.equal(apiPermissionsLink(null), null);
  assert.equal(missingSentence("restorer", [{} as never, {} as never]), "The restore writer app is missing 2 permissions. Restores that need them stop until an admin approves them.");
  assert.equal(missingSentence("collector", [{} as never]), "The backup reader app is missing 1 permission. Backups that need it stay incomplete until an admin approves it.");
});

test("the table holds more apps and delegated permissions: a new app is listed after the known ones", () => {
  const extra: PermissionEntry = { identity: "planner-reader", type: "delegated", api: "graph", name: "Tasks.Read", service: "other", kind: "Settings", words: "Read plans as a service account", usedFor: "Back up Planner plans", need: "required" };
  const permissions = { ...catalog({ complete: true, byIdentity: { "planner-reader": { granted: [], requested: [] } } }) };
  permissions.permissions = [...permissions.permissions, extra];
  const rows = permissionRows(state([scope([step({ progress: "done" })])], { permissions }));
  const row = rows.find((candidate) => candidate.identity === "planner-reader")!;
  assert.equal(row.type, "delegated");
  assert.equal(row.status, "missing");
  assert.deepEqual([...new Set(rows.map((candidate) => candidate.identity))], ["restorer", "planner-reader", "collector"], "apps with something missing first, known apps before new ones");
  assert.equal(missingSentence("planner-reader", [row]), "The planner reader app is missing 1 permission. What needs it stops until an admin approves it.");
});
