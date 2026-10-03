import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GLOBAL_ADMINISTRATOR, evaluateAccountReadiness, evaluateSurfaces, tenantReadiness,
} from "../../engine/safety/breakGlassReadiness.mjs";
import { causeSentence, type AlertItem } from "@/lib/alerts-view";
import {
  DIMENSION_ORDER, STATUS_LABELS, alertSentence, canarySentence, dimensionSentence, policyName, readinessVerdict,
  surfaceSentence, type ReadinessAccount, type ReadinessData,
} from "@/lib/readiness-view";

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
  assert.equal(sentence, "A policy that is switched on reaches it: Require MFA.");
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
