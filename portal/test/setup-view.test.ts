import assert from "node:assert/strict";
import { test } from "node:test";

import {
  currentStep, nextSentence, permissionChips, permissionList, setupPrimary, setupStatus, stepHelp, stepLink, stepTitle,
  type SetupScope, type SetupState, type SetupStep,
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

test("permissions are plain words with the Microsoft name kept apart; extras are flagged, unknown names fall back", () => {
  const chips = permissionChips(step({ excessScopes: ["MailboxSettings.ReadWrite"], missingScopes: ["Group.ReadWrite.All", "Some.New.Scope"] }));
  assert.deepEqual(chips, [
    { words: "Change groups", code: "Group.ReadWrite.All", extra: false },
    { words: "Some.New.Scope", code: "Some.New.Scope", extra: false },
    { words: "Change mailbox settings", code: "MailboxSettings.ReadWrite", extra: true },
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
