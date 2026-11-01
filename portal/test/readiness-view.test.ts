import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GLOBAL_ADMINISTRATOR, evaluateAccountReadiness, evaluateSurfaces, tenantReadiness,
} from "../../engine/safety/breakGlassReadiness.mjs";
import { causeSentence, type AlertItem } from "@/lib/alerts-view";
import {
  DIMENSION_ORDER, STATUS_LABELS, SURFACE_LABELS, accountInitials, accountName, accountSubName, alertSentence, canarySentence,
  dimensionSentence, orderedChecks, policyName, readinessCounts, readinessNext, readinessStatus, readinessVerdict, surfaceGroups,
  surfaceSentence, withRecordedTest, type ReadinessAccount, type ReadinessAlert, type ReadinessData,
} from "@/lib/readiness-view";
import { renderReadinessAt } from "./render-readiness";

// Roadmap task-94: the Emergency access page's words, fed by the engine's own pure
// evaluation (engine/safety/breakGlassReadiness.mjs) so the view reads the shapes the
// reader returns.

const NOW = "2026-10-03T12:00:00.000Z";
const BG1 = "b9000000-0000-4000-8000-000000000001";
const BG2 = "b9000000-0000-4000-8000-000000000002";
const OBJECT_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RESOURCE_KEY = /\b[a-z][A-Za-z]+:[A-Za-z0-9]/;

const covered = (resources: { naturalKey: string; payload: Record<string, unknown> }[]) => ({ status: "covered", observedAt: NOW, resources });
function inventory({ withRoleAssignments = true } = {}) {
  return {
    user: covered([BG1, BG2].map((id, index) => ({
      naturalKey: `user:bg${index + 1}@contoso.onmicrosoft.com`,
      payload: { id, userPrincipalName: `bg${index + 1}@contoso.onmicrosoft.com`, accountEnabled: true, userType: "Member", onPremisesSyncEnabled: null },
    }))),
    domain: covered([{ naturalKey: "domain:contoso.onmicrosoft.com", payload: { id: "contoso.onmicrosoft.com", authenticationType: "Managed" } }]),
    roleAssignment: withRoleAssignments
      ? covered([BG1, BG2].map((id) => ({ naturalKey: `roleAssignment:GlobalAdministrator@${id}@/`, payload: { principalId: id, roleDefinitionId: GLOBAL_ADMINISTRATOR, directoryScopeId: "/" } })))
      : { status: "unavailable", observedAt: null, resources: [] },
    roleEligibilitySchedule: covered([]),
    conditionalAccessPolicy: covered([
      { naturalKey: "conditionalAccessPolicy:Require MFA", payload: { state: "enabled", conditions: { users: { includeUsers: ["All"], excludeUsers: [BG1] } } } },
    ]),
    authenticationMethodsPolicy: covered([{ naturalKey: "authenticationMethodsPolicy:Policy", payload: { authenticationMethodConfigurations: [{ id: "Fido2", state: "enabled" }] } }]),
  };
}

function account(id: string, label: string, methods: string[] | null): ReadinessAccount {
  const base = {
    accountId: id, label, resourceKey: `user:${label}`, validationIntervalDays: 90, rotationIntervalDays: null,
    registeredAt: "2026-06-01T00:00:00.000Z", lastValidatedAt: "2026-09-20T00:00:00.000Z", lastRotatedAt: null,
    methodEvidence: methods ? { basis: "attested" as const, occurredAt: "2026-09-01T00:00:00.000Z", methods } : null,
    usage: { signInLogRead: true, signInDays: 0, lastSignInAt: null, keelPerson: null },
  };
  const inv = inventory();
  return { ...base, ...evaluateAccountReadiness({ account: base, inventory: inv, now: new Date(NOW) }) } as unknown as ReadinessAccount;
}

function data(accounts: ReadinessAccount[], extra: Partial<ReadinessData> = {}): ReadinessData {
  const verdict = tenantReadiness(accounts);
  return {
    generatedAt: NOW, configured: true, overall: verdict.overall as ReadinessData["overall"], reason: verdict.reason, accounts,
    surfaces: evaluateSurfaces(inventory()) as ReadinessData["surfaces"],
    canary: { status: "watching", reason: "covered", sources: { "sign-in": { status: "covered", readUntil: "2026-10-03T11:00:00.000Z" } } },
    alerts: [], ...extra,
  };
}

test("unknown evidence reads as not known, never OK, and the verdict cannot be good", () => {
  const unknown = account(BG1, "bg1@contoso.onmicrosoft.com", null);
  const credential = unknown.dimensions.phishingResistantCredential;
  assert.equal(credential.status, "unknown");
  assert.equal(STATUS_LABELS[credential.status].label, "Not known");
  assert.match(dimensionSentence("phishingResistantCredential", credential, NOW), /cannot say/);
  const verdict = readinessVerdict(data([unknown, account(BG1, "bg1b@contoso.onmicrosoft.com", ["fido2"])]));
  assert.notEqual(verdict.tone, "good");
});

test("a policy that reaches the account is named in words, never by its stored key", () => {
  const bg2 = account(BG2, "bg2@contoso.onmicrosoft.com", ["fido2"]);
  const exclusions = bg2.dimensions.policyExclusions;
  assert.equal(exclusions.status, "fail");
  const sentence = dimensionSentence("policyExclusions", exclusions, NOW);
  assert.equal(sentence, "A sign-in rule that is switched on reaches it: Require MFA.");
  assert.equal(policyName("conditionalAccessPolicy:Require MFA"), "Require MFA");
  assert.equal(readinessVerdict(data([account(BG1, "bg1@contoso.onmicrosoft.com", ["fido2"]), bg2])).tone, "critical");
});

test("every sentence is plain: no object ids, no stored keys", () => {
  const accounts = [account(BG1, "bg1@contoso.onmicrosoft.com", ["fido2"]), account(BG2, "bg2@contoso.onmicrosoft.com", ["password"])];
  const page = data(accounts, {
    alerts: [{
      id: "a1e70000-0000-4000-8000-000000000094", resourceKey: "user:bg1@contoso.onmicrosoft.com", condition: "emergency-account-used",
      state: "open", severity: "critical", active: true, occurrence: 1, firstOpenedAt: NOW, lastFiringAt: "2026-10-03T10:00:00.000Z",
      ackDeadlineAt: null, lastEventId: "breakglass-sign-in:si-1",
      detail: { accountId: BG1, label: "bg1@contoso.onmicrosoft.com", auditEventId: "si-1", changeCount: 2, expectedTest: false },
    }],
  });
  const sentences = [
    ...accounts.flatMap((entry) => DIMENSION_ORDER.map((name) => dimensionSentence(name, entry.dimensions[name], NOW))),
    ...page.surfaces.map(surfaceSentence), canarySentence(page, NOW), ...page.alerts.map((alert) => alertSentence(alert, NOW)),
    readinessVerdict(page).text,
  ];
  for (const sentence of sentences) {
    assert.doesNotMatch(sentence, OBJECT_ID, sentence);
    assert.doesNotMatch(sentence, RESOURCE_KEY, sentence);
  }
  assert.equal(alertSentence(page.alerts[0], NOW), "bg1@contoso.onmicrosoft.com was used 2 hours ago, and made 2 changes after it. Nobody recorded a planned test.");
  // An active usage alert outranks every other verdict.
  assert.equal(readinessVerdict(page).headline, "An emergency account was used");
  assert.ok(readinessVerdict(page).text.split(/\s+/).length <= 25);
});

test("checks KEEL cannot make stay visible, even when every account is ready", () => {
  const ready = [account(BG1, "bg1@contoso.onmicrosoft.com", ["fido2"]), account(BG1, "bg1b@contoso.onmicrosoft.com", ["fido2"])];
  const page = data(ready);
  assert.equal(page.overall, "ready");
  const unsupported = page.surfaces.filter((surface) => surface.status === "unsupported");
  assert.equal(unsupported.length, 4);
  assert.match(surfaceSentence(unsupported[0]), /not part of the verdict/);
  const verdict = readinessVerdict(page);
  assert.equal(verdict.tone, "good");
  assert.match(verdict.text, /4 areas need a manual check/);
});

test("fewer than two accounts and no accounts each say what to do", () => {
  assert.match(readinessVerdict(data([account(BG1, "bg1@contoso.onmicrosoft.com", ["fido2"])])).text, /at least two/);
  assert.equal(readinessVerdict({ ...data([]), overall: "not-configured", reason: "no-accounts-registered", configured: false }).headline, "Not set up");
});

test("the alerts inbox explains emergency account alerts in words", () => {
  const alert = { control: "break-glass", condition: "emergency-account-used", conditionActive: true } as AlertItem;
  assert.equal(causeSentence(alert), "This emergency account was used. Check that it was planned.");
  assert.equal(causeSentence({ ...alert, condition: "validation-due" }), "Its emergency sign-in test is due.");
  assert.equal(causeSentence({ ...alert, conditionActive: false }), "It was reviewed and closed.");
});

// ------------------------------------------------------------- the redesigned page

const USED: ReadinessAlert = {
  id: "a1e70000-0000-4000-8000-000000000094", resourceKey: "user:bg2@contoso.onmicrosoft.com", condition: "emergency-account-used",
  state: "open", severity: "critical", active: true, occurrence: 1, firstOpenedAt: NOW, lastFiringAt: "2026-10-03T11:00:00.000Z",
  ackDeadlineAt: null, lastEventId: "breakglass-sign-in:si-1",
  detail: {
    accountId: BG2, label: "bg2@contoso.onmicrosoft.com", auditEventId: "si-1", changeCount: 1, expectedTest: false,
    changes: [{ auditEventId: "au-1", occurredAt: "2026-10-03T11:05:00.000Z", targetType: "group", targetId: "c9000000-0000-4000-8000-0000000000c2", operation: "update", activity: "Add member to group" }],
  },
};

function named(entry: ReadinessAccount, displayName: string | null): ReadinessAccount {
  return { ...entry, displayName, signInName: entry.label };
}

/** Text outside every Technical details block, without attributes. */
function outsideRecord(html: string): string {
  return html.replace(/<details class="technical-details"[^>]*data-layer="record"[^>]*>[\s\S]*?<\/details>/g, "")
    .replace(/\s(?:data-[a-z-]+|href|title|id|for|aria-labelledby|aria-label)="[^"]*"/g, "")
    .replace(/<[^>]+>/g, " ");
}

test("plain words: Passes, sign-in rules, and an account named by its display name", () => {
  assert.equal(STATUS_LABELS.pass.label, "Passes");
  assert.equal(SURFACE_LABELS.conditionalAccess, "Sign-in rules");
  const bg1 = named(account(BG1, "bg1@contoso.onmicrosoft.com", ["fido2"]), "Emergency admin 1");
  assert.equal(accountName(bg1), "Emergency admin 1");
  assert.equal(accountSubName(bg1), "bg1@contoso.onmicrosoft.com");
  assert.equal(accountInitials(bg1), "E1");
  const unnamed = named(bg1, null);
  assert.equal(accountName(unnamed), "bg1@contoso.onmicrosoft.com");
  assert.equal(accountSubName(unnamed), null);
  const page = data([bg1], { alerts: [{ ...USED, detail: { ...USED.detail, accountId: BG1 } }] });
  assert.match(alertSentence(page.alerts[0], NOW, page.accounts), /^Emergency admin 1 was used 1 hour ago/);
});

test("status pill, tiles and the one next step follow the evidence", () => {
  const bg1 = account(BG1, "bg1@contoso.onmicrosoft.com", ["fido2"]);
  const bg2 = account(BG2, "bg2@contoso.onmicrosoft.com", null);
  const page = data([bg1, bg2], { alerts: [USED] });
  assert.deepEqual(readinessStatus(page), { tone: "urgent", label: "Account used" });
  assert.deepEqual(readinessCounts(page), { accounts: 2, ready: 1, testsDue: 0, unplanned: 1 });
  assert.deepEqual(readinessNext(page, { canConfigure: true, canRespond: true }), { kind: "review", alertId: USED.id, label: "Review the sign-in" });
  assert.equal(readinessNext(page, { canConfigure: true, canRespond: false }), null, "no amber action someone cannot take");
  assert.deepEqual(readinessNext(data([bg1]), { canConfigure: true, canRespond: true }), { kind: "add", label: "Add an emergency account" });
  assert.equal(readinessNext(data([bg1]), { canConfigure: false, canRespond: true }), null);
  assert.deepEqual(readinessStatus({ ...data([]), overall: "not-configured" }), { tone: "soon", label: "Not set up" });

  // A test that is due: the next step records it, and recording it flips the check.
  const stale = { ...bg1, lastValidatedAt: "2026-05-01T00:00:00.000Z" };
  const overdue = { ...stale, ...evaluateAccountReadiness({ account: stale, inventory: inventory(), now: new Date(NOW) }) } as unknown as ReadinessAccount;
  assert.equal(overdue.dimensions.lastValidation.status, "due");
  assert.deepEqual(orderedChecks(overdue)[0], "lastValidation", "problems come first");
  const due = data([overdue, account(BG1, "bg1b@contoso.onmicrosoft.com", ["fido2"])]);
  assert.equal(readinessCounts(due).testsDue, 1);
  assert.deepEqual(readinessNext(due, { canConfigure: true, canRespond: true }), { kind: "record", accountId: BG1, label: "Record a test sign-in" });
  const after = withRecordedTest(overdue, "2026-10-03T09:00:00.000Z");
  assert.equal(STATUS_LABELS[after.dimensions.lastValidation.status].label, "Passes");
  assert.match(dimensionSentence("lastValidation", after.dimensions.lastValidation, NOW), /^Last tested 3 hours ago/);
  assert.equal(after.overall, "ready");
});

test("what can block a sign-in is grouped: check by hand first, checked last", () => {
  const groups = surfaceGroups(data([]).surfaces);
  assert.deepEqual(groups.map((group) => group.key), ["unsupported", "evaluated"]);
  assert.equal(groups[0].items.length, 4);
});

test("the page names accounts, keeps ids in Technical details, and shows changes only to people who may make them", async () => {
  const bg1 = named(account(BG1, "bg1@contoso.onmicrosoft.com", ["fido2"]), "Emergency admin 1");
  const bg2 = named(account(BG2, "bg2@contoso.onmicrosoft.com", null), "Emergency admin 2");
  const page = data([bg1, bg2], { alerts: [USED] });
  const html = await renderReadinessAt("", { data: page, canConfigure: true, canRespond: true });
  const visible = outsideRecord(html);
  assert.doesNotMatch(visible, OBJECT_ID, "no object id outside Technical details");
  assert.doesNotMatch(visible, /conditionalAccessPolicy:|user:bg/, "no stored key outside Technical details");
  assert.match(visible, /Emergency admin 2/);
  assert.match(visible, /Emergency admin 2 was used 1 hour ago, and made 1 change after it\./);
  assert.match(visible, /Add member to group/);
  assert.match(html, /Record a test sign-in/);
  assert.match(html, />Acknowledge</);
  assert.match(html, /href="\/alerts\?open=a1e70000-0000-4000-8000-000000000094"[^>]*>Review the sign-in</);
  assert.equal(html.match(/btn-primary/g)?.length, 1, "one amber action");
  assert.match(html, /href="\/changes\?q=Require%20MFA"/);
  assert.doesNotMatch(visible, /Only people who manage configuration/);

  const viewer = await renderReadinessAt("", { data: page, canConfigure: false, canRespond: false });
  assert.match(viewer, /Only people who manage configuration can change emergency accounts\./);
  assert.doesNotMatch(viewer, /Record a test sign-in|Add an emergency account|>Acknowledge<|>Resolve<|>More<|Record sign-in methods|>Edit</);
  assert.doesNotMatch(viewer, /btn-primary/);

  const empty = await renderReadinessAt("", { data: { ...data([]), overall: "not-configured", reason: "no-accounts-registered", configured: false }, canConfigure: true, canRespond: true });
  assert.match(empty, /No emergency accounts yet\. Add two cloud-only accounts so one failure does not lock everyone out\./);
  assert.match(empty, /btn-primary[^>]*>Add an emergency account</);
});

test("a sign-in log with skipped entries is not called watched or read completely", () => {
  const page = data([account(BG1, "bg1@contoso.onmicrosoft.com", ["fido2"])]);
  page.canary = { status: "not-watching", reason: "events-skipped", sources: { "sign-in": { status: "events-skipped", readUntil: NOW } } };
  const sentence = canarySentence(page, NOW);
  assert.match(sentence, /^KEEL is not watching reliably: it skipped some sign-in entries/);
  assert.doesNotMatch(sentence, /completely/);
});

test("a sign-in log read for part of the lookback is called partly read, not unread", () => {
  const dimension = { status: "unknown" as const, reason: "sign-in-log-partly-read", evidence: { lookbackDays: 30 } };
  const sentence = dimensionSentence("dedicatedAccount", dimension, NOW);
  assert.match(sentence, /reads the sign-in log but has not yet read all of the last 30 days/);
  assert.doesNotMatch(sentence, /not reading/);
});
