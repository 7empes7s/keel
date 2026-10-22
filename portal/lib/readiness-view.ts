import type { BadgeTone } from "@/components/ui/badge";
import type { IconName } from "@/components/shell/icons";
import type { VerdictTone } from "@/components/verdict";
import type { RiskTone } from "@/lib/menu-status";
import { ago, formatTimestamp } from "@/lib/presentation";

// Roadmap task-94: the Emergency access page in words. The report comes from
// engine/safety/breakGlassReadiness.mjs; this file only turns it into sentences.
// Client-safe: no engine or server imports, so the view and the UI harness can use it.
// "Not known" is a state of its own: it is never shown as OK.

export type DimensionStatus = "pass" | "fail" | "due" | "unknown";
export type ReadinessOverall = "ready" | "not-ready" | "unknown" | "not-configured";
export type DimensionName =
  | "cloudOnlyIdentity"
  | "phishingResistantCredential"
  | "policyExclusions"
  | "privilegedAccessPath"
  | "lastValidation";

export interface PolicyTreatment {
  policy: string;
  treatment: "excluded" | "applies" | "not-applicable" | "unknown" | "report-only";
  reason: string;
}

export interface Dimension {
  status: DimensionStatus;
  reason: string;
  evidence: {
    basis?: "observed" | "attested";
    recordedAt?: string | null;
    methods?: string[];
    policies?: PolicyTreatment[];
    observedAt?: string | null;
    naturalKey?: string;
    domain?: string;
    assignment?: string;
    lastValidatedAt?: string | null;
    dueAt?: string | null;
    dueSince?: string | null;
    intervalDays?: number;
  };
}

export interface Reminder {
  kind: "validation" | "rotation";
  intervalDays: number;
  last: string | null;
  dueAt: string | null;
  status: "due" | "scheduled";
}

export interface ReadinessAccount {
  accountId: string;
  label: string;
  // From the newest user backup; null when the backup does not have the account.
  displayName?: string | null;
  signInName?: string | null;
  resourceKey: string;
  validationIntervalDays: number;
  rotationIntervalDays: number | null;
  registeredAt: string | null;
  lastValidatedAt: string | null;
  lastRotatedAt: string | null;
  methodEvidence: { basis: "observed" | "attested"; occurredAt: string | null; methods: string[] } | null;
  overall: "ready" | "not-ready" | "unknown";
  dimensions: Record<DimensionName, Dimension>;
  reminders: Reminder[];
}

export interface ReadinessSurface {
  surface: string;
  status: "evaluated" | "unknown" | "unsupported";
  reason: string;
  missing?: string[];
  policies?: number;
}

export interface ReadinessAlert {
  id: string;
  resourceKey: string;
  condition: string;
  state: string;
  severity: "notice" | "warning" | "critical";
  active: boolean;
  occurrence: number;
  firstOpenedAt: string | null;
  lastFiringAt: string | null;
  ackDeadlineAt: string | null;
  lastEventId: string;
  detail: {
    accountId?: string;
    label?: string;
    auditEventId?: string;
    correlationId?: string;
    expectedTest?: boolean;
    changeCount?: number;
    changes?: { auditEventId: string; occurredAt: string | null; targetType: string; targetId: string; operation: string; activity: string | null }[];
    dueAt?: string | null;
  };
}

export interface ReadinessData {
  generatedAt: string;
  configured: boolean;
  overall: ReadinessOverall;
  reason: string;
  accounts: ReadinessAccount[];
  surfaces: ReadinessSurface[];
  inventory?: Record<string, { status: string; observedAt: string | null }>;
  canary: { status: "watching" | "not-watching" | "not-configured"; reason: string; sources?: Record<string, { status: string; readUntil: string | null }> };
  alerts: ReadinessAlert[];
}

export const DIMENSION_ORDER: DimensionName[] = [
  "cloudOnlyIdentity",
  "phishingResistantCredential",
  "policyExclusions",
  "privilegedAccessPath",
  "lastValidation",
];

export const DIMENSION_LABELS: Record<DimensionName, string> = {
  cloudOnlyIdentity: "Cloud-only account",
  phishingResistantCredential: "Phishing-resistant sign-in",
  policyExclusions: "Left out of sign-in rules",
  privilegedAccessPath: "Admin role without an activation step",
  lastValidation: "Emergency sign-in test",
};

// "Not known" is its own state with its own icon: it never reads as passing.
export const STATUS_LABELS: Record<DimensionStatus, { label: string; tone: BadgeTone; icon: IconName }> = {
  pass: { label: "Passes", tone: "fine", icon: "check-circle" },
  fail: { label: "Problem", tone: "urgent", icon: "alert" },
  due: { label: "Due", tone: "soon", icon: "clock" },
  unknown: { label: "Not known", tone: "soon", icon: "info" },
};

export const OVERALL_LABELS: Record<ReadinessAccount["overall"], { label: string; tone: BadgeTone }> = {
  ready: { label: "Ready", tone: "fine" },
  "not-ready": { label: "Not ready", tone: "urgent" },
  unknown: { label: "Cannot confirm", tone: "soon" },
};

// Microsoft's own term goes in a tooltip; the label is ours.
export const SURFACE_TERMS: Record<string, string> = {
  conditionalAccess: "Conditional Access policies",
  conditionalAccessRiskConditions: "Risk conditions in Conditional Access",
  identityProtectionRiskPolicies: "Identity Protection risk policies",
};

export const SURFACE_LABELS: Record<string, string> = {
  conditionalAccess: "Sign-in rules",
  conditionalAccessRiskConditions: "Risk conditions in sign-in rules",
  authenticationMethodsPolicy: "Tenant sign-in method settings",
  roleEligibility: "Admin role eligibility",
  roleActivationRules: "Admin role activation rules",
  identityProtectionRiskPolicies: "Older risk rules (Identity Protection)",
  securityDefaults: "Security defaults",
  applicationAccessRestrictions: "Restrictions on admin apps",
};

export const SURFACE_STATUS: Record<ReadinessSurface["status"], { label: string; tone: BadgeTone; icon: IconName }> = {
  evaluated: { label: "Checked", tone: "fine", icon: "check-circle" },
  unknown: { label: "Not backed up", tone: "soon", icon: "clock" },
  unsupported: { label: "Check by hand", tone: "neutral", icon: "info" },
};

export const METHOD_WORDS: Record<string, string> = {
  password: "a password",
  microsoftAuthenticator: "the Authenticator app",
  phone: "a phone",
  email: "an email code",
  softwareOath: "a one-time code app",
  temporaryAccessPass: "a temporary access pass",
  fido2: "a security key or passkey",
  windowsHelloForBusiness: "Windows Hello",
  x509Certificate: "a certificate",
  platformCredential: "a device-bound platform key",
};

/** "Require MFA" from a stored policy key; never the key itself. */
export function policyName(key: string): string {
  const index = key.indexOf(":");
  return index > -1 ? key.slice(index + 1) : key;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One dimension's finding, in one plain sentence. */
export function dimensionSentence(name: DimensionName, dimension: Dimension, now: string): string {
  const { reason, evidence } = dimension;
  switch (reason) {
    case "cloud-only-member-account": return "A cloud-only, switched-on member account on a Microsoft-managed domain.";
    case "account-not-in-inventory": return "The latest backup of accounts has no account with this identity.";
    case "synchronized-from-on-premises": return "It is synchronized from on-premises Active Directory, so an outage there can block it.";
    case "account-disabled": return "The account is switched off.";
    case "guest-account": return "It is a guest account, not a member of this tenant.";
    case "sync-state-not-collected": return "The backup did not record whether it is synchronized from on-premises.";
    case "sign-in-name-not-collected":
    case "domain-inventory-unavailable":
    case "domain-not-in-inventory":
    case "domain-authentication-not-collected":
      return "KEEL cannot tell whether its domain signs in through another service.";
    case "federated-domain": return "Its domain signs in through a federation service, which an outage could take down.";
    case "user-inventory-unavailable": return "There is no complete backup of accounts to check.";
    case "no-method-evidence": return "No sign-in method has been recorded for it, so KEEL cannot say.";
    case "no-phishing-resistant-method": {
      const methods = (evidence.methods ?? []).map((method) => METHOD_WORDS[method] ?? "another method");
      return methods.length
        ? `It signs in with ${list(methods)}, and none of these resists phishing.`
        : "No phishing-resistant method is registered for it.";
    }
    case "method-policy-unavailable":
    case "method-policy-incomplete":
      return "The tenant's sign-in method settings are not backed up, so KEEL cannot tell whether its method is allowed.";
    case "method-disabled-by-tenant-policy": return "The tenant's sign-in method settings switch its method off.";
    case "phishing-resistant-method": {
      const methods = (evidence.methods ?? []).filter((method) => ["fido2", "windowsHelloForBusiness", "x509Certificate", "platformCredential"].includes(method));
      const source = evidence.basis === "observed" ? "read from Microsoft" : "recorded by a person";
      return `It has ${list(methods.map((method) => METHOD_WORDS[method] ?? "a phishing-resistant method"))} (${source} ${ago(evidence.recordedAt ?? null, now)}).`;
    }
    case "policy-inventory-unavailable": return "There is no complete backup of sign-in rules to check.";
    case "enforced-policy-applies": {
      const names = reachingRules(dimension);
      return `${names.length === 1 ? "A sign-in rule that is switched on reaches it" : `${names.length} sign-in rules that are switched on reach it`}: ${list(names)}.`;
    }
    case "policy-treatment-unknown": {
      const count = (evidence.policies ?? []).filter((entry) => entry.treatment === "unknown").length;
      return `KEEL cannot tell whether ${plural(count, "sign-in rule reaches", "sign-in rules reach")} it: group or role membership was not read.`;
    }
    case "excluded-from-every-enforced-policy": return "Every sign-in rule that is switched on leaves it out.";
    case "no-enforced-policy-applies": return "No sign-in rule that is switched on reaches it.";
    case "role-inventory-unavailable": return "There is no complete backup of admin role assignments to check.";
    case "active-global-administrator": return "It holds Global Administrator permanently, with no activation step.";
    case "eligible-only-needs-activation": return "It is only eligible for Global Administrator, so it must be activated first, which can fail in an emergency.";
    case "no-active-global-administrator": return "It does not hold Global Administrator.";
    case "validated-recently": return `Last tested ${ago(evidence.lastValidatedAt ?? null, now)}; the next test is due ${formatTimestamp(evidence.dueAt ?? null)}.`;
    case "validation-overdue": return `Last tested ${ago(evidence.lastValidatedAt ?? null, now)}; a new test has been due since ${formatTimestamp(evidence.dueSince ?? null)}.`;
    case "never-validated": return "Nobody has recorded a test sign-in with it.";
    default: return name === "lastValidation" ? "The test record could not be read." : "KEEL could not check this.";
  }
}

export function reminderSentence(reminder: Reminder, now: string): string {
  const what = reminder.kind === "validation" ? "Emergency sign-in test" : "Credential review";
  if (!reminder.last) return `${what}: never recorded, so it is due now.`;
  return reminder.status === "due"
    ? `${what}: due since ${formatTimestamp(reminder.dueAt)} (last ${ago(reminder.last, now)}).`
    : `${what}: next due ${formatTimestamp(reminder.dueAt)}, every ${reminder.intervalDays} days.`;
}

export function surfaceSentence(surface: ReadinessSurface): string {
  if (surface.status === "unsupported") return "KEEL has no reader for this, so it is not part of the verdict. Check it by hand.";
  if (surface.status === "unknown") return "The latest backup did not cover this, so the accounts that depend on it cannot be confirmed.";
  if (surface.surface === "conditionalAccessRiskConditions") {
    return `Checked with the other sign-in rules (${plural(surface.policies ?? 0, "rule uses", "rules use")} risk).`;
  }
  return "Checked against the latest backup.";
}

export function canarySentence(data: ReadinessData, now: string): string {
  const readUntil = data.canary.sources?.["sign-in"]?.readUntil ?? null;
  if (data.canary.status === "watching") return `KEEL is watching emergency sign-ins: the sign-in log was read up to ${ago(readUntil, now)}.`;
  if (data.canary.status === "not-configured") return "KEEL does not read the sign-in log yet, so it cannot see an emergency sign-in.";
  // One sign-in entry that could not be stored safely was skipped: it might be the emergency sign-in.
  if (data.canary.sources?.["sign-in"]?.status === "events-skipped") {
    return "KEEL is not watching reliably: it skipped some sign-in entries it could not store safely, and one of them could be an emergency sign-in.";
  }
  return readUntil
    ? `KEEL is not watching reliably: the sign-in log was last read completely up to ${ago(readUntil, now)}.`
    : "KEEL is not watching: the sign-in log has not been read completely.";
}

export function alertSentence(alert: ReadinessAlert, now: string, accounts: ReadinessAccount[] = []): string {
  const who = alertAccountName(alert, accounts);
  if (alert.condition === "emergency-account-used") {
    const changes = alert.detail.changeCount ?? 0;
    const made = changes ? `, and made ${plural(changes, "change", "changes")} after it` : "";
    const planned = alert.detail.expectedTest ? " A test sign-in was recorded around then." : " Nobody recorded a planned test.";
    return `${who} was used ${ago(alert.lastFiringAt, now)}${made}.${planned}`;
  }
  if (alert.condition === "validation-due") return `${who} is due for an emergency sign-in test.`;
  if (alert.condition === "rotation-due") return `${who} is due for a credential review.`;
  return `${who} needs attention.`;
}

export function readinessVerdict(data: ReadinessData): { headline: string; text: string; tone: VerdictTone } {
  const used = data.alerts.filter((alert) => alert.active && alert.condition === "emergency-account-used");
  if (used.length) {
    return { headline: "An emergency account was used", tone: "critical", text: "An emergency account was used: check that the use was planned, then acknowledge the alert." };
  }
  const unchecked = data.surfaces.filter((surface) => surface.status === "unsupported").length;
  switch (data.overall) {
    case "ready":
      return {
        headline: "Ready",
        tone: "good",
        text: `Every emergency account passes every check KEEL can make. ${plural(unchecked, "area needs", "areas need")} a manual check.`,
      };
    case "not-ready": {
      if (data.reason === "fewer-than-two-accounts") {
        return { headline: "Not ready", tone: "critical", text: "Add at least two emergency accounts, so one failure does not lock everyone out." };
      }
      const bad = data.accounts.filter((account) => account.overall === "not-ready").length;
      return { headline: "Not ready", tone: "critical", text: `${plural(bad, "emergency account is", "emergency accounts are")} not ready. See what failed below.` };
    }
    case "unknown":
      return { headline: "Cannot confirm", tone: "attention", text: "No check failed, but some evidence is missing, so KEEL cannot confirm the emergency accounts work." };
    default:
      return { headline: "Not set up", tone: "attention", text: "No emergency accounts are set up yet, so KEEL cannot check them." };
  }
}

/** The page's status pill. */
export function readinessStatus(data: ReadinessData): { tone: RiskTone; label: string } {
  if (activeUses(data).length) return { tone: "urgent", label: "Account used" };
  switch (data.overall) {
    case "ready": return { tone: "fine", label: "Ready" };
    case "not-ready": return { tone: "urgent", label: "Not ready" };
    case "unknown": return { tone: "soon", label: "Cannot confirm" };
    default: return { tone: "soon", label: "Not set up" };
  }
}

export function activeUses(data: Pick<ReadinessData, "alerts">): ReadinessAlert[] {
  return data.alerts.filter((alert) => alert.active && alert.condition === "emergency-account-used");
}

/** The account's name for people: its display name, else its sign-in name. */
export function accountName(account: Pick<ReadinessAccount, "displayName" | "signInName" | "label">): string {
  return account.displayName || account.signInName || account.label;
}

/** The line under the name: the sign-in name, when the name is something else. */
export function accountSubName(account: Pick<ReadinessAccount, "displayName" | "signInName" | "label">): string | null {
  const sub = account.signInName || account.label;
  return sub && sub !== accountName(account) ? sub : null;
}

export function accountInitials(account: Pick<ReadinessAccount, "displayName" | "signInName" | "label">): string {
  const name = accountName(account).split("@")[0];
  const words = name.split(/[\s._-]+/).filter((word) => /[A-Za-z0-9]/.test(word));
  const letters = words.length > 1 ? `${words[0][0]}${words[words.length - 1][0]}` : name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2);
  return letters.toUpperCase() || "?";
}

export function alertAccountName(alert: ReadinessAlert, accounts: ReadinessAccount[]): string {
  const account = accounts.find((entry) => entry.accountId === alert.detail.accountId);
  if (account) return accountName(account);
  return alert.detail.label ?? "An emergency account";
}

const STATUS_RANK: Record<DimensionStatus, number> = { fail: 0, due: 1, unknown: 2, pass: 3 };

/** The five checks, problems first; ties keep the usual order. */
export function orderedChecks(account: ReadinessAccount): DimensionName[] {
  return [...DIMENSION_ORDER].sort((a, b) => STATUS_RANK[account.dimensions[a].status] - STATUS_RANK[account.dimensions[b].status]
    || DIMENSION_ORDER.indexOf(a) - DIMENSION_ORDER.indexOf(b));
}

/** Sign-in rules (by name) that reach the account while switched on. */
export function reachingRules(dimension: Dimension): string[] {
  return (dimension.evidence.policies ?? []).filter((entry) => entry.treatment === "applies").map((entry) => policyName(entry.policy));
}

export function testDue(account: ReadinessAccount): boolean {
  return account.dimensions.lastValidation.status === "due"
    || account.reminders.some((reminder) => reminder.kind === "validation" && reminder.status === "due");
}

export interface ReadinessCounts {
  accounts: number;
  ready: number;
  testsDue: number;
  unplanned: number;
}

export function readinessCounts(data: ReadinessData): ReadinessCounts {
  return {
    accounts: data.accounts.length,
    ready: data.accounts.filter((account) => account.overall === "ready").length,
    testsDue: data.accounts.filter(testDue).length,
    unplanned: activeUses(data).filter((alert) => !alert.detail.expectedTest).length,
  };
}

/** What the verdict's one amber action does, if anything. */
export type ReadinessNext =
  | { kind: "review"; alertId: string; label: string }
  | { kind: "record"; accountId: string; label: string }
  | { kind: "add"; label: string };

export function readinessNext(data: ReadinessData, { canConfigure, canRespond }: { canConfigure: boolean; canRespond: boolean }): ReadinessNext | null {
  const used = activeUses(data)[0];
  if (used) return canRespond ? { kind: "review", alertId: used.id, label: "Review the sign-in" } : null;
  if (!canConfigure) return null;
  if (data.accounts.length < 2) return { kind: "add", label: "Add an emergency account" };
  const due = data.accounts.find(testDue);
  if (due) return { kind: "record", accountId: due.accountId, label: "Record a test sign-in" };
  return null;
}

/** The reminder rows of an account card, in words. */
export function reminderRows(account: ReadinessAccount, now: string): { kind: "validation" | "rotation"; text: string; due: boolean }[] {
  const validation = account.reminders.find((reminder) => reminder.kind === "validation");
  const rotation = account.reminders.find((reminder) => reminder.kind === "rotation");
  return [
    validation
      ? { kind: "validation", text: reminderSentence(validation, now).replace("Emergency sign-in test", "Test sign-in"), due: validation.status === "due" || !validation.last }
      : { kind: "validation", text: `Test sign-in: every ${account.validationIntervalDays} days.`, due: false },
    rotation
      ? { kind: "rotation", text: reminderSentence(rotation, now), due: rotation.status === "due" || !rotation.last }
      : { kind: "rotation", text: "Credential review: no interval is set.", due: false },
  ];
}

export type SurfaceGroupKey = "unsupported" | "unknown" | "evaluated";
export const SURFACE_GROUPS: { key: SurfaceGroupKey; label: string; about: string }[] = [
  { key: "unsupported", label: "Check by hand", about: "KEEL has no reader for these yet." },
  { key: "unknown", label: "Not backed up", about: "Back these up so KEEL can check them." },
  { key: "evaluated", label: "Checked", about: "Checked against the latest backup." },
];

export function surfaceGroups(surfaces: ReadinessSurface[]): { key: SurfaceGroupKey; label: string; about: string; items: ReadinessSurface[] }[] {
  return SURFACE_GROUPS.map((group) => ({ ...group, items: surfaces.filter((surface) => surface.status === group.key) })).filter((group) => group.items.length);
}

/**
 * The account after a test sign-in recorded on this page, until the server's next read:
 * the test check passes and the account is ready when every other check passes.
 */
export function withRecordedTest(account: ReadinessAccount, at: string): ReadinessAccount {
  const dueAt = new Date(Date.parse(at) + account.validationIntervalDays * 86_400_000).toISOString();
  const dimensions = {
    ...account.dimensions,
    lastValidation: { status: "pass" as const, reason: "validated-recently", evidence: { lastValidatedAt: at, dueAt, intervalDays: account.validationIntervalDays } },
  };
  const statuses = DIMENSION_ORDER.map((name) => dimensions[name].status);
  const overall = statuses.every((status) => status === "pass") ? "ready" : statuses.includes("fail") || statuses.includes("due") ? "not-ready" : "unknown";
  return {
    ...account,
    lastValidatedAt: at,
    overall,
    dimensions,
    reminders: account.reminders.map((reminder) => (reminder.kind === "validation" ? { ...reminder, last: at, dueAt, status: "scheduled" as const } : reminder)),
  };
}
