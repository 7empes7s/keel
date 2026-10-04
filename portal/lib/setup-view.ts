// Roadmap task-76: the setup page's types and words. Client-safe: no engine or server
// imports, so the progress component and the UI harness can use it.

export type StepProgress =
  | "done" | "waiting-for-you" | "needs-consent" | "to-do" | "unclear" | "in-progress" | "not-started" | "not-checked";

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

export const WORKLOAD_LABELS: Record<string, string> = {
  "entra-collect": "Microsoft Entra settings",
  "intune-collect": "Intune device settings",
  "entra-restore": "Microsoft Entra settings",
};

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

// Pill classes in globals.css.
export const PROGRESS_TONES: Record<StepProgress, "ok" | "warn" | "bad" | "neutral" | "info"> = {
  done: "ok",
  "waiting-for-you": "warn",
  "needs-consent": "warn",
  "to-do": "neutral",
  unclear: "bad",
  "in-progress": "info",
  "not-started": "neutral",
  "not-checked": "neutral",
};

const KEEL_PERMISSION_WORDS: Record<string, string> = {
  "keel.collect": "read the tenant for backups",
  "keel.restore": "write restored settings back",
};

/** One plain sentence saying what the step is and who does it. */
export function stepTitle(step: SetupStep): string {
  switch (step.kind) {
    case "registration": return `Register the app ${step.name} in Microsoft Entra`;
    case "graph-permission": return `Grant admin consent for ${step.name.replace(/ admin consent$/, "")}`;
    case "workload-rbac": return `Give ${appName(step)} the Intune role "${step.name}"`;
    case "pim-activation": return `Activate your "${step.name}" role`;
    case "keel-app-permission": return `Allow ${appName(step)} to ${KEEL_PERMISSION_WORDS[step.name] ?? "work with KEEL"}`;
  }
}

function appName(step: SetupStep): string {
  return `keel-${step.identity}`;
}

/** What the operator does, or what KEEL does, for this step. */
export function stepHelp(step: SetupStep): string {
  switch (step.kind) {
    case "registration":
      return step.action === "reuse-existing"
        ? "KEEL found this app already registered with the permissions it needs and will reuse it."
        : `Creating or widening an app needs the Application Administrator or Cloud Application Administrator role. Its API permissions: ${step.requiredScopes.join(", ")}.`;
    case "graph-permission": {
      const consent = `Consent covers these Microsoft Graph permissions only: ${(step.missingScopes.length ? step.missingScopes : step.requiredScopes).join(", ")}. It does not assign Intune roles or activate admin roles.`;
      const extra = step.excessScopes ?? [];
      return extra.length
        ? `${consent} The app also holds ${extra.length === 1 ? "a permission" : "permissions"} this setup does not ask for: ${extra.join(", ")}. KEEL reports ${extra.length === 1 ? "it" : "them"} and does not remove ${extra.length === 1 ? "it" : "them"}; review ${extra.length === 1 ? "it" : "them"} in Microsoft Entra.`
        : consent;
    }
    case "workload-rbac":
      return "Assign it in the Intune admin center. Admin consent does not grant Intune roles.";
    case "pim-activation":
      return "Activate it in Privileged Identity Management before you start. Being eligible is not enough, and KEEL never activates it for you.";
    case "keel-app-permission":
      return "KEEL records this on the app's registration so the read and write accounts stay separate.";
  }
}

export function progressCounts(steps: SetupStep[]) {
  return {
    done: steps.filter((step) => step.progress === "done").length,
    waitingForYou: steps.filter((step) => step.progress === "waiting-for-you" || step.progress === "needs-consent").length,
    total: steps.length,
  };
}

/** The page's verdict: one sentence about whether KEEL can read the tenant yet. */
export function setupVerdict(state: SetupState): { text: string; tone: "good" | "attention" } {
  if (state.collect.allowed && state.firstCollection) {
    return { text: "KEEL can read your tenant, and its first backup has finished.", tone: "good" };
  }
  if (state.collect.allowed) {
    return { text: "Read access is confirmed. You can run the first backup.", tone: "good" };
  }
  const read = state.scopes.find((scope) => scope.scope === "read");
  const open = read ? read.steps.filter((step) => step.progress !== "done").length : 0;
  return {
    text: open === 1
      ? "1 step is left before KEEL can read your tenant."
      : `${open} steps are left before KEEL can read your tenant.`,
    tone: "attention",
  };
}
