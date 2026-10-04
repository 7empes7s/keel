import type { VerdictTone } from "@/components/verdict";
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
  policyExclusions: "Left out of sign-in policies",
  privilegedAccessPath: "Admin role without an activation step",
  lastValidation: "Emergency sign-in test",
};

export const STATUS_LABELS: Record<DimensionStatus, { label: string; tone: "ok" | "bad" | "warn" }> = {
  pass: { label: "OK", tone: "ok" },
  fail: { label: "Problem", tone: "bad" },
  due: { label: "Due", tone: "bad" },
  unknown: { label: "Not known", tone: "warn" },
};

export const OVERALL_LABELS: Record<ReadinessAccount["overall"], { label: string; tone: "ok" | "bad" | "warn" }> = {
  ready: { label: "Ready", tone: "ok" },
  "not-ready": { label: "Not ready", tone: "bad" },
  unknown: { label: "Cannot confirm", tone: "warn" },
};

export const SURFACE_LABELS: Record<string, string> = {
  conditionalAccess: "Conditional Access policies",
  conditionalAccessRiskConditions: "Risk conditions in Conditional Access",
  authenticationMethodsPolicy: "Tenant sign-in method settings",
  roleEligibility: "Admin role eligibility",
  roleActivationRules: "Admin role activation rules",
  identityProtectionRiskPolicies: "Older Identity Protection risk policies",
  securityDefaults: "Security defaults",
  applicationAccessRestrictions: "Restrictions on admin apps",
};

export const SURFACE_STATUS: Record<ReadinessSurface["status"], { label: string; tone: "ok" | "warn" | "neutral" }> = {
  evaluated: { label: "Checked", tone: "ok" },
  unknown: { label: "Not backed up", tone: "warn" },
  unsupported: { label: "KEEL cannot check this", tone: "neutral" },
};

const METHOD_WORDS: Record<string, string> = {
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
    case "policy-inventory-unavailable": return "There is no complete backup of Conditional Access policies to check.";
    case "enforced-policy-applies": {
      const names = (evidence.policies ?? []).filter((entry) => entry.treatment === "applies").map((entry) => policyName(entry.policy));
      return `${names.length === 1 ? "A policy that is switched on reaches it" : `${names.length} policies that are switched on reach it`}: ${list(names)}.`;
    }
    case "policy-treatment-unknown": {
      const count = (evidence.policies ?? []).filter((entry) => entry.treatment === "unknown").length;
      return `KEEL cannot tell whether ${plural(count, "policy reaches", "policies reach")} it: group or role membership was not read.`;
    }
    case "excluded-from-every-enforced-policy": return "Every policy that is switched on leaves it out.";
    case "no-enforced-policy-applies": return "No policy that is switched on reaches it.";
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
    return `Checked with the other Conditional Access policies (${plural(surface.policies ?? 0, "policy uses", "policies use")} risk).`;
  }
  return "Checked against the latest backup.";
}

export function canarySentence(data: ReadinessData, now: string): string {
  const readUntil = data.canary.sources?.["sign-in"]?.readUntil ?? null;
  if (data.canary.status === "watching") return `KEEL is watching emergency sign-ins: the sign-in log was read up to ${ago(readUntil, now)}.`;
  if (data.canary.status === "not-configured") return "KEEL does not read the sign-in log yet, so it cannot see an emergency sign-in.";
  return readUntil
    ? `KEEL is not watching reliably: the sign-in log was last read completely up to ${ago(readUntil, now)}.`
    : "KEEL is not watching: the sign-in log has not been read completely.";
}

export function alertSentence(alert: ReadinessAlert, now: string): string {
  const who = alert.detail.label ?? "An emergency account";
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
    return { headline: "An emergency account was used", tone: "critical", text: "Check that the use was planned, then acknowledge the alert." };
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
        return { headline: "Not ready", tone: "critical", text: "Register at least two emergency accounts, so one failure does not lock everyone out." };
      }
      const bad = data.accounts.filter((account) => account.overall === "not-ready").length;
      return { headline: "Not ready", tone: "critical", text: `${plural(bad, "emergency account is", "emergency accounts are")} not ready. See what failed below.` };
    }
    case "unknown":
      return { headline: "Cannot confirm", tone: "attention", text: "No check failed, but some evidence is missing, so KEEL cannot confirm the emergency accounts work." };
    default:
      return { headline: "Not set up", tone: "attention", text: "No emergency accounts are registered, so KEEL cannot check them." };
  }
}
