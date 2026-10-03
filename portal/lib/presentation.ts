import type { ProtectionState } from "@/lib/types";

export const BLAST_RADIUS_ORDER = [
  "tenant-lockout",
  "access-affecting",
  "cosmetic",
];

export const PROTECTION_STATE_ORDER: ProtectionState[] = [
  "failed",
  "not-covered",
  "unprotectable",
  "partially-protected",
  "read-only",
  "protected",
];

export const PROTECTION_STATE_LABEL: Record<ProtectionState, string> = {
  protected: "Protected",
  "partially-protected": "Partially protected",
  "read-only": "Read-only",
  unprotectable: "Unprotectable",
  failed: "FAILED",
  "not-covered": "Not covered",
};

export function words(value: string | null): string {
  if (!value) return "Unknown";
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replaceAll("-", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Invalid timestamp";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date) + " UTC";
}

export function formatAge(value: string | null, now = new Date()): string {
  if (!value) return "No recorded time";
  const date = new Date(value);
  const milliseconds = now.valueOf() - date.valueOf();
  if (!Number.isFinite(milliseconds)) return "Invalid time";
  if (milliseconds < 0) return "In the future";

  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "Less than a minute old";
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h old`;
  return `${Math.floor(hours / 24)}d old`;
}

export function adapterSurface(adapter: string | null): string {
  if (!adapter) return "No serving adapter";
  if (adapter.startsWith("graph-")) return "Microsoft Graph";
  if (adapter.startsWith("powershell")) return "PowerShell";
  if (adapter.startsWith("dsc")) return "DSC";
  return "Adapter";
}

/** A relative age ("3 days ago") measured from when the page's data was read.
 * Show the absolute UTC time beside it only in a title and in the record layer. */
export function ago(value: string | null, now: string | Date): string {
  if (!value) return "at an unknown time";
  const milliseconds = new Date(now).valueOf() - new Date(value).valueOf();
  if (!Number.isFinite(milliseconds)) return "at an unknown time";
  if (milliseconds < 0) return "in the future";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Portal experience contract, rule 4: stored codes reach the screen only through a
// display map. Types not listed fall back to their words.
export const RESOURCE_TYPE_LABELS: Record<string, string> = {
  group: "group",
  conditionalAccessPolicy: "Conditional Access policy",
  namedLocation: "named location",
  roleAssignment: "role assignment",
  servicePrincipal: "enterprise app",
  application: "app registration",
  user: "user",
  authorizationPolicy: "authorization policy",
  crossTenantAccessPolicyPartner: "cross-tenant access partner",
  retentionLabel: "retention label",
  deviceConfiguration: "device configuration",
};

export function resourceTypeLabel(type: string): string {
  return RESOURCE_TYPE_LABELS[type] ?? words(type).toLowerCase();
}

/** A resource as a person reads it: "Helpdesk Tier 0 (group)". The display name
 * comes from collected data when the reader resolved it; otherwise from the key. */
export function resourceLabel(naturalKey: string, displayName?: string | null): string {
  const [type, ...rest] = naturalKey.split(":");
  const name = displayName?.trim() || rest.join(" · ") || naturalKey;
  return `${name} (${resourceTypeLabel(type)})`;
}

export const RECOVERY_POINT_LABELS = {
  qualified: "Cleared",
  unsuitable: "Unsafe",
  unassessed: "Not checked",
} as const;

export const ASSESSMENT_VERDICT_LABELS = {
  clean: "Clean",
  compromised: "Unsafe",
} as const;

// What a viewer can do, in words (contract vocabulary: "what you can do here", never
// "capabilities"). Order follows the work: decide, recover, operate, administer.
const CAPABILITY_VERBS: Record<string, string> = {
  approve: "approve",
  restore: "restore",
  rollback: "undo",
  remediate: "fix changes",
  investigate: "investigate incidents",
  "dispose-accept": "decide on changes",
  collect: "run backups",
  backup: "run backups",
  "baseline-create": "create baselines",
  policies: "manage policies",
  users: "manage people",
  roles: "grant roles",
  configuration: "change settings",
};

export function accessSummary(capabilities: string[]): string {
  const verbs = [...new Set(capabilities.filter((capability) => capability !== "read")
    .map((capability) => CAPABILITY_VERBS[capability] ?? words(capability).toLowerCase()))];
  if (verbs.length === 0) return capabilities.includes("read") ? "You can view" : "No access";
  // Three verbs at most; the rest are counted, and the full list is in the title.
  const shown = verbs.length > 3 ? [...verbs.slice(0, 3), `${verbs.length - 3} more`] : verbs;
  const list = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return `You can ${list}`;
}

// Portal experience contract, rule 4: every stored code the portal renders goes
// through this one map. A value missing from it renders as its words (and
// portal/test/experience-contract.test.ts fails for any value the fixtures use).
export const DISPLAY_ENUMS = {
  jobKind: {
    collect: "Backup of every type",
    backup: "Backup",
    prune: "Clean-up of old snapshots",
    "drift-detect": "Change check",
    offsite: "Off-site copy",
    restore: "Restore",
    "restore-dry-run": "Dry run of a restore",
    remediate: "Roll back changes",
    "baseline-create": "Baseline creation",
    "baseline-activate": "Baseline activation",
    "policy-evaluate": "Policy run",
    notify: "Notification",
    "api-drift": "Microsoft API check",
  },
  jobStatus: {
    queued: "Waiting to start",
    running: "Running",
    succeeded: "Finished",
    failed: "Failed",
    cancelled: "Cancelled",
  },
  policyAction: {
    alert: "Alert only",
    require_approval: "Ask for approval",
    auto_remediate: "Roll back automatically",
    "dispose-accept": "Accept automatically",
  },
  blastRadius: {
    "tenant-lockout": "Could lock out admins",
    "access-affecting": "Affects access",
    cosmetic: "Cosmetic",
  },
  changeType: {
    added: "Added",
    modified: "Changed",
    removed: "Removed",
  },
  decision: {
    accept: "Accept",
    rollback: "Roll back",
    ignore: "Ignore",
  },
  approvalStatus: {
    pending: "Waiting for a decision",
    approved: "Approved",
    rejected: "Rejected",
    expired: "Expired",
  },
  deliveryStatus: {
    queued: "Waiting to send",
    delivering: "Sending",
    retrying: "Retrying",
    delivered: "Delivered",
    failed: "Failed",
    cancelled: "Cancelled",
  },
  exportStatus: {
    pending: "Waiting to send",
    delivering: "Sending",
    acknowledged: "Received",
    quarantined: "Held back",
  },
  severity: {
    notice: "Notice",
    warning: "Warning",
    critical: "Critical",
  },
  role: {
    viewer: "Viewer",
    operator: "Operator",
    approver: "Approver",
    restorer: "Restorer",
    investigator: "Investigator",
    admin: "Admin",
  },
  evidenceKind: {
    "approval-request": "Approval requests",
    "approval-decision": "Approval decisions",
    "action-attempt": "Actions started or refused",
    "policy-evaluation": "Policy checks",
    "automation-execution": "Automatic roll-backs",
    "content-effect-approval": "Content-effect approvals",
    "recovery-completion": "Restore follow-up",
    "incident-recovery": "Incident recovery",
    "incident-recovery-check": "Checks after an incident restore",
    "fidelity-drill": "Test restores",
    "recovery-drill": "Recovery drills",
    "baseline-resnapshot": "Baseline re-captures",
    "benchmark-evaluation": "Control checks",
    "benchmark-exception": "Control exceptions",
  },
  // Roadmap task-87: a control check's stored verdict and its exception state.
  controlVerdict: {
    pass: "Passes",
    fail: "Fails",
    unknown: "Could not be checked",
    "not-applicable": "Nothing to check",
  },
  exceptionState: {
    none: "No exception",
    authorized: "Current exception",
    expired: "Exception expired",
    incomplete: "Exception missing an owner or expiry",
  },
  storageImmutability: {
    unknown: "Not yet proven",
    unsupported: "Cannot lock against deletion",
    "fixture-tested": "Not yet proven on this tenant",
    "live-qualified": "Proven on this tenant",
  },
  eventKind: {
    "drift.detected": "A change was detected",
    "approval.decided": "An approval was decided",
    "job.started": "A job started",
    "collection.completed": "A backup finished",
  },
} as const;

export type DisplayEnumGroup = keyof typeof DISPLAY_ENUMS;

export function displayEnum(group: DisplayEnumGroup, value: string | null | undefined): string {
  if (!value) return "Unknown";
  const map = DISPLAY_ENUMS[group] as Record<string, string>;
  return map[value] ?? words(value.replaceAll("_", "-").replaceAll(".", " "));
}

/** A future time in words ("in 5 hours"); "already passed" when it is not ahead. */
export function fromNow(value: string | null, now: string | Date): string {
  if (!value) return "at an unknown time";
  const milliseconds = new Date(value).valueOf() - new Date(now).valueOf();
  if (!Number.isFinite(milliseconds)) return "at an unknown time";
  if (milliseconds <= 0) return "already passed";
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}
