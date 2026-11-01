import type { IconName } from "@/components/shell/icons";

// Kinds of restore with their own approval setting (engine/govern/restoreApprovalSettings.mjs
// RESTORE_APPROVAL_RULES), in the order the Approvals page lists them. Plain names for
// the settings card and the audit record.
export const RESTORE_APPROVAL_RULE_ORDER = [
  "content-restore",
  "turn-on-conditional-access",
  "compliance-fix",
  "tenant-wide",
  "other-tenant",
  "unplaced",
] as const;

export type RestoreApprovalRule = (typeof RESTORE_APPROVAL_RULE_ORDER)[number];

export const RESTORE_APPROVAL_RULE_INFO: Record<RestoreApprovalRule, { name: string; phrase: string; detail: string; icon: IconName }> = {
  "content-restore": { name: "Mail, file and Teams restores", phrase: "mail, file and Teams restores", detail: "Bringing back emails, files or Teams messages", icon: "page" },
  "turn-on-conditional-access": { name: "Turning a Conditional Access policy on", phrase: "turning a Conditional Access policy on", detail: "Can block sign-ins. Keel checks break-glass accounts first", icon: "baselines" },
  "compliance-fix": { name: "Compliance fixes", phrase: "compliance fixes", detail: "Sets the value a compliance control asks for", icon: "audit" },
  "tenant-wide": { name: "Organization-wide changes", phrase: "organization-wide changes", detail: "Workload settings that apply to everyone", icon: "cloud" },
  "other-tenant": { name: "Restores into another tenant", phrase: "restores into another tenant", detail: "Writes a backup into a different Microsoft 365 tenant", icon: "swap" },
  "unplaced": { name: "Settings Keel can't place in a service", phrase: "settings Keel can't place in a service", detail: "Types no service setting covers yet", icon: "info" },
};

// Kinds of restore that are high risk without a person checking them first. Same list
// as the engine's HIGH_RISK_RESTORE_APPROVAL_RULES. The customer still decides: turning
// one off shows what can go wrong and needs the admin to tick that they understand,
// and the API refuses it without that.
export const HIGH_RISK_RESTORE_APPROVAL_RULES = ["turn-on-conditional-access", "tenant-wide", "other-tenant"] as const satisfies readonly RestoreApprovalRule[];

export const HIGH_RISK_INFO: Record<(typeof HIGH_RISK_RESTORE_APPROVAL_RULES)[number], { risks: string[]; acknowledge: string }> = {
  "turn-on-conditional-access": {
    risks: [
      "A policy that is switched on can block people from signing in, including admins.",
      "Keel checks break-glass accounts first, but it cannot know every account your organization depends on.",
      "Nobody looks at the policy before it starts applying to sign-ins.",
    ],
    acknowledge: "I understand a restore can switch on a Conditional Access policy without anyone checking it first.",
  },
  "tenant-wide": {
    risks: [
      "One restore can change settings that apply to everyone in the organization at once.",
      "A mistake reaches every user straight away, not just one mailbox, site or team.",
      "Nobody reviews the change before it is made.",
    ],
    acknowledge: "I understand a restore can change organization-wide settings without anyone checking it first.",
  },
  "other-tenant": {
    risks: [
      "A backup is written into a different Microsoft 365 tenant, which may belong to another organization.",
      "Choosing the wrong target tenant can overwrite its settings or expose your data there.",
      "Nobody confirms the target before the restore starts.",
    ],
    acknowledge: "I understand a restore can write into another tenant without anyone checking it first.",
  },
};

export function isHighRiskRule(rule: string): rule is (typeof HIGH_RISK_RESTORE_APPROVAL_RULES)[number] {
  return (HIGH_RISK_RESTORE_APPROVAL_RULES as readonly string[]).includes(rule);
}

export function isRestoreApprovalRule(value: unknown): value is RestoreApprovalRule {
  return typeof value === "string" && (RESTORE_APPROVAL_RULE_ORDER as readonly string[]).includes(value);
}

export const ruleOrder = (rule: string) => {
  const index = (RESTORE_APPROVAL_RULE_ORDER as readonly string[]).indexOf(rule);
  return index === -1 ? RESTORE_APPROVAL_RULE_ORDER.length : index;
};
