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
  "unplaced": { name: "Items Keel can't place in a service", phrase: "items Keel can't place in a service", detail: "Kinds no service setting covers yet", icon: "info" },
};

export function isRestoreApprovalRule(value: unknown): value is RestoreApprovalRule {
  return typeof value === "string" && (RESTORE_APPROVAL_RULE_ORDER as readonly string[]).includes(value);
}

export const ruleOrder = (rule: string) => {
  const index = (RESTORE_APPROVAL_RULE_ORDER as readonly string[]).indexOf(rule);
  return index === -1 ? RESTORE_APPROVAL_RULE_ORDER.length : index;
};
