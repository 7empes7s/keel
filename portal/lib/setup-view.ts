// Setup (portal audit, pick A: two checklists side by side). The page's types and
// words. Client-safe: no engine or server imports, so the page body, the UI harness
// and the unit tests can all use it.

import type { RiskTone } from "@/lib/menu-status";

export type StepProgress =
  | "done" | "waiting-for-you" | "needs-consent" | "to-do" | "unclear" | "in-progress" | "not-started" | "not-checked";

// The Entra app a step is about: its real display name when Keel has seen the
// registration, and its app id. Identifiers, not secrets.
export interface SetupApp {
  displayName: string | null;
  appId: string | null;
}

export interface SetupStep {
  id: string;
  kind: "registration" | "graph-permission" | "workload-rbac" | "pim-activation" | "keel-app-permission";
  identity: "collector" | "restorer";
  workload: string | null;
  name: string;
  action: string;
  requiredScopes: string[];
  missingScopes: string[];
  // Permissions the app already holds beyond what setup asks for. Shown, never removed.
  excessScopes?: string[];
  manual: boolean;
  progress: StepProgress;
  app?: SetupApp | null;
}

export interface SetupRun {
  artifactId: string;
  state: "complete" | "stopped" | "waiting-for-you" | "ready" | "interrupted";
  workloads: string[];
  approvedBy: string;
  approvedByName: string | null;
  approvedAt: string;
  lastEventAt: string | null;
  resumableByViewer: boolean;
  build: string;
  qualificationMode: string;
}

export interface SetupScope {
  scope: "read" | "restore";
  workloads: string[];
  observed: boolean;
  run: SetupRun | null;
  planId?: string;
  steps: SetupStep[];
}

export interface SetupState {
  generatedAt: string;
  // The tenant's Entra id, for Microsoft links and Technical details only.
  tenantId?: string | null;
  scopes: SetupScope[];
  collect: { allowed: boolean; basis: string; missing: string[] };
  firstCollection: { snapshotId: string; completedAt: string; read: number; notRead: number } | null;
  canCheck: boolean;
  canProvision: boolean;
  // The server can check the tenant but the last look failed.
  checkFailed?: boolean;
}

export const SCOPE_TITLES: Record<SetupScope["scope"], string> = {
  read: "Read access for backups",
  restore: "Write access for restores",
};

export const SCOPE_PURPOSE: Record<SetupScope["scope"], string> = {
  read: "So Keel can save copies of your settings. Nothing here lets Keel change anything.",
  restore: "So Keel can put settings back when you approve. Backups do not wait for this.",
};

export const WORKLOAD_LABELS: Record<string, string> = {
  "entra-collect": "Microsoft Entra settings",
  "intune-collect": "Intune device settings",
  "entra-governance-collect": "Microsoft Entra identity governance",
  "entra-restore": "Microsoft Entra settings",
};

// The short name on a service chip, with its icon.
export const WORKLOAD_CHIPS: Record<string, { label: string; icon: "service-entra" | "service-intune" }> = {
  "entra-collect": { label: "Entra ID", icon: "service-entra" },
  "intune-collect": { label: "Intune", icon: "service-intune" },
  "entra-governance-collect": { label: "Identity governance", icon: "service-entra" },
  "entra-restore": { label: "Entra ID", icon: "service-entra" },
};

export function workloadChip(workload: string): { label: string; icon: "service-entra" | "service-intune" } {
  return WORKLOAD_CHIPS[workload] ?? { label: "Another service", icon: workload.startsWith("intune") ? "service-intune" : "service-entra" };
}

export function workloadLabel(workload: string): string {
  return WORKLOAD_LABELS[workload] ?? workloadChip(workload).label;
}

export const PROGRESS_LABELS: Record<StepProgress, string> = {
  done: "Done",
  "waiting-for-you": "Waiting for you",
  "needs-consent": "Needs admin consent",
  "to-do": "Not done yet",
  unclear: "Not sure it worked",
  "in-progress": "In progress",
  "not-started": "Not started",
  "not-checked": "Not checked",
};

// Shared badge tones: colour means risk only.
export const PROGRESS_TONES: Record<StepProgress, "urgent" | "soon" | "low" | "fine" | "neutral"> = {
  done: "fine",
  "waiting-for-you": "soon",
  "needs-consent": "soon",
  "to-do": "neutral",
  unclear: "urgent",
  "in-progress": "low",
  "not-started": "neutral",
  "not-checked": "neutral",
};

// Microsoft Graph permission names in plain words. The Microsoft name stays beside
// them in smaller text: it is what the admin matches on the consent screen.
export const PERMISSION_WORDS: Record<string, string> = {
  "DeviceManagementConfiguration.Read.All": "Read Intune device settings",
  "DeviceManagementRBAC.Read.All": "Read Intune roles",
  "Group.Read.All": "Read groups",
  "Policy.Read.All": "Read sign-in rules and other policies",
  "RoleManagement.Read.Directory": "Read admin roles",
  "User.Read.All": "Read users",
  "Directory.Read.All": "Read the directory",
  "Group.ReadWrite.All": "Change groups",
  "Policy.ReadWrite.ConditionalAccess": "Change sign-in rules",
  "RoleManagement.ReadWrite.Directory": "Change admin roles",
  "MailboxSettings.ReadWrite": "Change mailbox settings",
  "Directory.ReadWrite.All": "Change the directory",
};

export function permissionWords(scope: string): string {
  return PERMISSION_WORDS[scope] ?? scope;
}

export interface PermissionChip {
  words: string;
  code: string;
  extra: boolean;
}

/** What the step asks for, then anything extra the app already holds. */
export function permissionChips(step: SetupStep): PermissionChip[] {
  const asked = step.kind === "graph-permission" && step.missingScopes.length ? step.missingScopes : step.requiredScopes;
  return [
    ...asked.map((code) => ({ words: permissionWords(code), code, extra: false })),
    ...(step.excessScopes ?? []).map((code) => ({ words: permissionWords(code), code, extra: true })),
  ];
}

const APP_ROLES: Record<SetupStep["identity"], string> = {
  collector: "backup reader app",
  restorer: "restore writer app",
};

export function appRole(identity: SetupStep["identity"]): string {
  return APP_ROLES[identity];
}

/** The app's real name in Entra when Keel has seen it, else what it is for. */
export function appWho(step: SetupStep): string {
  return step.app?.displayName ?? `the ${appRole(step.identity)}`;
}

/** One plain sentence saying what the step is. */
export function stepTitle(step: SetupStep): string {
  const role = appRole(step.identity);
  switch (step.kind) {
    case "registration": return `Register the ${role} in Entra ID`;
    case "graph-permission": return `Grant admin consent for the ${role}`;
    case "workload-rbac": return `Give the ${role} the Intune role "${step.name}"`;
    case "pim-activation": return `Activate your "${step.name}" role`;
    case "keel-app-permission": return step.identity === "collector" ? "Allow Keel to read the tenant for backups" : "Allow Keel to make restores";
  }
}

/** One short line: what the step does and who can do it. */
export function stepHelp(step: SetupStep): string {
  if (step.progress === "unclear") {
    return "Keel could not tell whether this worked. Continue: Keel checks the tenant first, so it never makes the change twice.";
  }
  const who = appWho(step);
  switch (step.kind) {
    case "registration":
      return step.action === "reuse-existing"
        ? `Keel found ${who} already registered and reuses it.`
        : "Needs an Application Administrator or Cloud Application Administrator.";
    case "graph-permission":
      return `Approve what ${who} may ${step.identity === "collector" ? "read" : "change"}. A Global Administrator signs in once.`;
    case "workload-rbac":
      return `Lets ${who} ${step.identity === "collector" ? "read" : "change"} Intune settings. Needs an Intune Administrator; admin consent does not grant Intune roles.`;
    case "pim-activation":
      return "Activate it in Privileged Identity Management. Being eligible is not enough, and Keel never activates it for you.";
    case "keel-app-permission":
      return "Keel records this on the app's registration, so the read and write apps stay separate.";
  }
}

const ENTRA = "https://entra.microsoft.com/#view";

/**
 * The exact Microsoft admin page for a step, opened in a new tab. Keel writes
 * nothing through it. Admin consent needs both the tenant id and the app id, so
 * that link is left out while either is unknown.
 */
export function stepLink(step: SetupStep, tenantId: string | null | undefined): { label: string; href: string } | null {
  const appId = step.app?.appId ?? null;
  switch (step.kind) {
    case "registration":
      return appId
        ? { label: "Open the app in Entra ID", href: `${ENTRA}/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Overview/appId/${encodeURIComponent(appId)}` }
        : { label: "Open app registrations in Entra ID", href: `${ENTRA}/Microsoft_AAD_RegisteredApps/ApplicationsListBlade` };
    case "graph-permission":
      return tenantId && appId
        ? { label: "Open admin consent in Microsoft", href: `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/adminconsent?client_id=${encodeURIComponent(appId)}` }
        : null;
    case "workload-rbac":
      return { label: "Open Intune roles in Microsoft", href: "https://intune.microsoft.com/#view/Microsoft_Intune_DeviceSettings/RolesLandingMenuBlade/~/roles" };
    case "pim-activation":
      return { label: "Open My roles in Microsoft", href: `${ENTRA}/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadmigratedroles` };
    case "keel-app-permission":
      return null;
  }
}

/** Where to review permissions an app holds beyond what setup asks for. */
export function permissionsLink(step: SetupStep): string | null {
  const appId = step.app?.appId;
  return appId ? `${ENTRA}/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/${encodeURIComponent(appId)}` : null;
}

/** What "Copy permission list" puts on the clipboard: the Microsoft names, one a line. */
export function permissionList(step: SetupStep): string {
  return permissionChips(step).filter((chip) => !chip.extra).map((chip) => chip.code).join("\n");
}

const NEEDS_YOU = new Set<StepProgress>(["waiting-for-you", "needs-consent", "unclear"]);

/** The step to open: the one waiting on someone, else the first one not done. */
export function currentStep(steps: SetupStep[]): SetupStep | null {
  return steps.find((step) => NEEDS_YOU.has(step.progress)) ?? steps.find((step) => step.progress !== "done") ?? null;
}

/** "Next: give the backup reader app the Intune role …", or null when every step is done. */
export function nextSentence(scope: SetupScope): string | null {
  const step = currentStep(scope.steps);
  if (!step) return null;
  const title = stepTitle(step);
  return `Next: ${title.charAt(0).toLowerCase()}${title.slice(1)}.`;
}

export function progressCounts(steps: SetupStep[]) {
  return {
    done: steps.filter((step) => step.progress === "done").length,
    waitingForYou: steps.filter((step) => NEEDS_YOU.has(step.progress)).length,
    total: steps.length,
  };
}

/** The page's verdict: one sentence about whether Keel can read the tenant yet. */
export function setupVerdict(state: SetupState): { text: string; tone: "good" | "attention" } {
  if (state.collect.allowed && state.firstCollection) {
    return { text: "Keel can read your tenant, and its first backup has finished.", tone: "good" };
  }
  if (state.collect.allowed) {
    return { text: "Read access is confirmed. You can run the first backup.", tone: "good" };
  }
  const read = state.scopes.find((scope) => scope.scope === "read");
  const open = read ? read.steps.filter((step) => step.progress !== "done").length : 0;
  return {
    text: open === 1
      ? "1 step is left before Keel can read your tenant."
      : `${open} steps are left before Keel can read your tenant.`,
    tone: "attention",
  };
}

/** The header's status pill. */
export function setupStatus(state: SetupState): { tone: RiskTone; label: string } {
  const waiting = state.scopes.reduce((sum, scope) => sum + progressCounts(scope.steps).waitingForYou, 0);
  if (waiting) return { tone: "soon", label: `Waiting on you: ${waiting} ${waiting === 1 ? "step" : "steps"}` };
  if (state.collect.allowed) return { tone: "fine", label: "Connected" };
  if (state.checkFailed) return { tone: "urgent", label: "Keel cannot read the tenant" };
  return { tone: "low", label: "Not connected yet" };
}

export type SetupPrimary =
  | { kind: "backup" }
  | { kind: "continue"; scope: SetupScope["scope"] }
  | { kind: "start"; scope: SetupScope["scope"] }
  | null;

const RESUMABLE = new Set<SetupRun["state"]>(["waiting-for-you", "stopped", "interrupted", "ready"]);

export function canContinue(scope: SetupScope): boolean {
  return scope.run !== null && RESUMABLE.has(scope.run.state) && scope.run.resumableByViewer;
}

export function canStartScope(scope: SetupScope, canStart: boolean): boolean {
  const run = scope.run;
  return canStart && (run === null || run.state === "complete" || !run.resumableByViewer || run.state === "stopped");
}

/**
 * The page's one amber action: the first backup once read access is confirmed,
 * else continuing a paused setup, else starting the first setup not yet done.
 * Every other button is outlined.
 */
export function setupPrimary(state: SetupState, { canStart, canBackup }: { canStart: boolean; canBackup: boolean }): SetupPrimary {
  if (state.collect.allowed && !state.firstCollection && canBackup) return { kind: "backup" };
  if (!state.canProvision) return null;
  const waiting = state.scopes.find(canContinue);
  if (waiting) return { kind: "continue", scope: waiting.scope };
  const start = state.scopes.find((scope) => scope.run === null && canStartScope(scope, canStart)
    && scope.steps.some((step) => step.progress !== "done"));
  return start ? { kind: "start", scope: start.scope } : null;
}

/** What the run line under a track's heading says. */
export function runSentence(run: SetupRun, when: string): string {
  switch (run.state) {
    case "complete": return `Finished ${when}. Keel checked every step again before calling it done.`;
    case "waiting-for-you": return "Paused on a step only you can do. Do it, then continue.";
    case "stopped": return `Stopped ${when}. Continue to check what is in place and pick up from there.`;
    case "interrupted": return "Did not finish. Continue to check what is in place and pick up from there.";
    case "ready": return "Approved and ready to start.";
  }
}
