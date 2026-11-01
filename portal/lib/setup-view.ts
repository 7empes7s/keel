// Setup (portal audit, pick A: two checklists side by side). The page's types and
// words. Client-safe: no engine or server imports, so the page body, the UI harness
// and the unit tests can all use it.

import type { RiskTone } from "@/lib/menu-status";
import type { Connection } from "@/lib/connections-view";
import { ago } from "@/lib/presentation";

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

export type SetupIdentity = SetupStep["identity"];

// One permission or admin role a Keel app uses (engine/bootstrap/permissionCatalog.mjs).
// `identity` names the app: the backup reader, the restore writer, the content reader.
export interface PermissionEntry {
  identity: string;
  // "application" (admin consent), "delegated" (acts as a signed-in account) or
  // "admin-role" (an Entra or Intune role assigned to the app; consent cannot grant it).
  type?: "application" | "delegated" | "admin-role";
  // "graph", "exchange" or "sharepoint": the Microsoft API the permission belongs to.
  // For a role, "directory" (an Entra admin role) or "intune" (an Intune role).
  api: string;
  // An Entra role's template id, the same in every tenant; the role's fix link uses it.
  templateId?: string | null;
  name: string;
  service: string;
  kind: string;
  words: string;
  usedFor: string;
  need: "required" | "optional";
}

export interface PermissionGrant {
  api: string;
  name: string;
}

export interface SetupPermissions {
  permissions: PermissionEntry[];
  services: { key: string; label: string }[];
  kinds: string[];
  apis: Record<string, string>;
  // What each app holds now and what its registration asks for; null when the server
  // could not look. `complete` is false when an API's permission names could not be read.
  observed: {
    byIdentity: Partial<Record<string, { granted: PermissionGrant[]; requested: PermissionGrant[]; app?: SetupApp }>>;
    complete: boolean;
    // Where Keel could not look this time (for example "intune": Intune's role lists).
    uncheckedApis?: string[];
  } | null;
}

export interface SetupState {
  generatedAt: string;
  permissions?: SetupPermissions;
  // The tenant's Entra id, for Microsoft links and Technical details only.
  tenantId?: string | null;
  scopes: SetupScope[];
  collect: { allowed: boolean; basis: string; missing: string[] };
  firstCollection: { snapshotId: string; completedAt: string; read: number; notRead: number } | null;
  canCheck: boolean;
  canProvision: boolean;
  // The server can check the tenant but the last look failed.
  checkFailed?: boolean;
  // One row per Keel app (/api/setup `connections`), with when its certificate ends;
  // null when Keel could not record them. Only the fields this page reads are typed here.
  connections?: Connection[] | null;
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
}

/** What the step asks for. What the app holds beyond it is in the permission table. */
export function permissionChips(step: SetupStep): PermissionChip[] {
  const asked = step.kind === "graph-permission" && step.missingScopes.length ? step.missingScopes : step.requiredScopes;
  return asked.map((code) => ({ words: permissionWords(code), code }));
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

/** What "Copy permission list" puts on the clipboard: the Microsoft names, one a line. */
export function permissionList(step: SetupStep): string {
  return permissionChips(step).map((chip) => chip.code).join("\n");
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

/** The First backup tile's line: when it ran and, when Keel knows, how many types it read. */
export function firstBackupLine(first: NonNullable<SetupState["firstCollection"]>, now: string): string {
  const when = ago(first.completedAt, now);
  const parts = [first.read ? `${first.read} ${first.read === 1 ? "type" : "types"} read` : "", first.notRead ? `${first.notRead} not read` : ""].filter(Boolean);
  return parts.length ? `${when}: ${parts.join(", ")}` : when;
}

/** Per app, the Intune roles whose setup step is done: Setup's connections use them while
 * Keel cannot read role assignments itself, so both lists agree. */
export function confirmedRoles(state: { scopes: { steps: { kind: string; identity: string; name: string; progress: string }[] }[] }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const step of state.scopes.flatMap((scope) => scope.steps)) {
    if (step.kind === "workload-rbac" && step.progress === "done") (out[step.identity] ??= []).push(step.name);
  }
  return out;
}

/** The header's status pill. */
export function setupStatus(state: SetupState): { tone: RiskTone; label: string } {
  const waiting = state.scopes.reduce((sum, scope) => sum + progressCounts(scope.steps).waitingForYou, 0);
  if (waiting) return { tone: "soon", label: `Waiting on you: ${waiting} ${waiting === 1 ? "step" : "steps"}` };
  const missing = permissionRows(state).filter((row) => row.status === "missing");
  if (missing.length) return { tone: "urgent", label: `${missingWords(missing)} missing` };
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

// ---- The permission table ---------------------------------------------------------

export type PermissionStatus = "missing" | "optional" | "not-checked" | "granted" | "unused";

// Most urgent first: what blocks a backup or restore, then extra access an admin should
// remove, then what would add a feature.
export const PERMISSION_STATUS_ORDER: readonly PermissionStatus[] = ["missing", "unused", "optional", "not-checked", "granted"];

export const PERMISSION_STATUS_LABELS: Record<PermissionStatus, string> = {
  missing: "Missing",
  optional: "Optional",
  "not-checked": "Not checked",
  granted: "Granted",
  unused: "Extra access",
};

export const PERMISSION_STATUS_TONES: Record<PermissionStatus, "urgent" | "soon" | "low" | "neutral" | "fine"> = {
  missing: "urgent",
  optional: "low",
  "not-checked": "neutral",
  granted: "fine",
  // Excess privilege: nothing breaks, but it widens what a leaked app sign-in could do.
  unused: "soon",
};

/** Why a permission Keel never uses matters, in plain words (Setup's table and alerts). */
export const UNUSED_WHY = "Keel gains nothing from it, but anyone who got hold of the app's sign-in could use it.";

export const APP_NAMES: Record<string, string> = {
  collector: "Backup reader app",
  restorer: "Restore writer app",
  "content-reader": "Content reader app",
  "engage-writer": "Viva Engage writer app",
};

export function appName(identity: string): string {
  return APP_NAMES[identity] ?? `${identity.charAt(0).toUpperCase()}${identity.slice(1).replace(/-/g, " ")} app`;
}

// Names that start with a product name keep their capitals inside a sentence.
const PROPER_NAMES = new Set(["engage-writer"]);

/** The app's name as it reads inside a sentence: "the backup reader app", "the Viva Engage writer app". */
export function appNameInSentence(identity: string): string {
  return PROPER_NAMES.has(identity) ? appName(identity) : appName(identity).toLowerCase();
}

export interface PermissionRow {
  id: string;
  identity: string;
  type: "application" | "delegated" | "admin-role";
  api: string;
  apiLabel: string;
  name: string;
  templateId: string | null;
  words: string;
  usedFor: string;
  service: string;
  serviceLabel: string;
  serviceOrder: number;
  kind: string;
  kindOrder: number;
  status: PermissionStatus;
  // Whether the app registration lists it, so admin consent can grant it; null when unknown.
  requested: boolean | null;
}

const KNOWN_APPS: readonly string[] = ["collector", "restorer", "content-reader", "engage-writer"];
const ROLE_APIS = new Set(["directory", "intune"]);

/** Every app the catalogue names: the known ones in order, then any new one as listed. */
export function permissionApps(catalog: SetupPermissions | undefined): string[] {
  const listed = [...new Set((catalog?.permissions ?? []).map((entry) => entry.identity))];
  return [...KNOWN_APPS.filter((identity) => listed.includes(identity)), ...listed.filter((identity) => !KNOWN_APPS.includes(identity))];
}
const key = (api: string, name: string) => `${api}:${name}`;

/** The Graph grants a setup step saw, for a page whose server could not look just now. */
function grantsFromSteps(state: SetupState, identity: string): { held: Set<string>; known: Set<string> } | null {
  const step = state.scopes.flatMap((scope) => scope.steps).find((candidate) => candidate.kind === "graph-permission" && candidate.identity === identity);
  if (!step || step.progress === "not-checked") return null;
  const missing = new Set(step.missingScopes);
  const held = new Set([...step.requiredScopes.filter((name) => !missing.has(name)), ...(step.excessScopes ?? [])].map((name) => key("graph", name)));
  return { held, known: new Set([...step.requiredScopes, ...(step.excessScopes ?? [])].map((name) => key("graph", name))) };
}

/**
 * One row per permission each app uses, plus any it holds that Keel never uses. With a
 * fresh look at the tenant every row has a status; without one, only what the setup
 * steps saw is known and everything else is "not checked", never "missing".
 */
export function permissionRows(state: SetupState): PermissionRow[] {
  const catalog = state.permissions;
  if (!catalog) return [];
  const serviceOrder = new Map(catalog.services.map((service, index) => [service.key, index]));
  const serviceLabel = new Map(catalog.services.map((service) => [service.key, service.label]));
  const wordsByName = new Map(catalog.permissions.map((entry) => [entry.name, entry.words]));
  const rows: PermissionRow[] = [];
  const apps = permissionApps(catalog);
  for (const identity of apps) {
    const observed = catalog.observed?.byIdentity[identity] ?? null;
    const fallback = observed ? null : grantsFromSteps(state, identity);
    const held = observed ? new Set(observed.granted.map((grant) => key(grant.api, grant.name))) : fallback?.held ?? new Set<string>();
    const requested = observed ? new Set(observed.requested.map((grant) => key(grant.api, grant.name))) : null;
    const entries = catalog.permissions.filter((entry) => entry.identity === identity);
    const listed = new Set(entries.map((entry) => key(entry.api, entry.name)));
    const statusOf = (entry: PermissionEntry): PermissionStatus => {
      const id = key(entry.api, entry.name);
      if (held.has(id)) return "granted";
      if (observed) {
        if (catalog.observed!.uncheckedApis?.includes(entry.api)) return "not-checked";
        if (!catalog.observed!.complete && entry.api !== "graph" && !ROLE_APIS.has(entry.api)) return "not-checked";
        return entry.need === "optional" ? "optional" : "missing";
      }
      return fallback?.known.has(id) ? (entry.need === "optional" ? "optional" : "missing") : "not-checked";
    };
    for (const entry of entries) {
      rows.push({
        id: `${identity}:${entry.type ?? "application"}:${key(entry.api, entry.name)}`, identity, type: entry.type ?? "application", api: entry.api, apiLabel: catalog.apis[entry.api] ?? entry.api,
        name: entry.name, words: entry.words, usedFor: entry.usedFor, service: entry.service,
        serviceLabel: serviceLabel.get(entry.service) ?? entry.service, serviceOrder: serviceOrder.get(entry.service) ?? catalog.services.length,
        kind: entry.kind, kindOrder: Math.max(0, catalog.kinds.indexOf(entry.kind)), status: statusOf(entry),
        templateId: entry.templateId ?? null,
        // A role is never on the registration's list: consent has nothing to say about it.
        requested: requested && entry.type !== "admin-role" ? requested.has(key(entry.api, entry.name)) : null,
      });
    }
    for (const id of [...held].filter((candidate) => !listed.has(candidate)).sort()) {
      const [api, ...rest] = id.split(":");
      const name = rest.join(":");
      const isRole = ROLE_APIS.has(api);
      rows.push({
        id: `${identity}:${isRole ? "admin-role" : "application"}:${id}`, identity, type: isRole ? "admin-role" : "application", api, apiLabel: catalog.apis[api] ?? "Another Microsoft API", name,
        words: isRole ? name : wordsByName.get(name) ?? PERMISSION_WORDS[name] ?? name,
        usedFor: isRole
          ? `Nothing in Keel needs this role. ${UNUSED_WHY} Remove the role from the app in Entra ID.`
          : `Nothing in Keel uses this. ${UNUSED_WHY} Remove it from the app in Entra ID.`,
        service: "unused", serviceLabel: "Extra access Keel never uses", serviceOrder: catalog.services.length,
        kind: "", kindOrder: 0, status: "unused", templateId: null, requested: requested && !isRole ? requested.has(id) : null,
      });
    }
  }
  return sortPermissionRows(rows, apps);
}

/** The app with the most missing first (errors first), then the backup reader, the
 * restore writer and the content reader; inside an app, services in order, kinds in
 * order, the most urgent first, then name. */
export function sortPermissionRows(rows: PermissionRow[], apps: readonly string[] = [...new Set(rows.map((row) => row.identity))]): PermissionRow[] {
  const missing = (identity: string) => rows.filter((row) => row.identity === identity && row.status === "missing").length;
  const order = [...apps].sort((a, b) => missing(b) - missing(a));
  return [...rows].sort((a, b) => order.indexOf(a.identity) - order.indexOf(b.identity)
    || a.serviceOrder - b.serviceOrder
    || a.kindOrder - b.kindOrder
    || PERMISSION_STATUS_ORDER.indexOf(a.status) - PERMISSION_STATUS_ORDER.indexOf(b.status)
    || a.words.localeCompare(b.words));
}

export type PermissionCounts = Record<PermissionStatus, number>;

export function permissionCounts(rows: PermissionRow[]): PermissionCounts {
  const counts = Object.fromEntries(PERMISSION_STATUS_ORDER.map((status) => [status, 0])) as PermissionCounts;
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** The app Keel signs in as for one identity: from the setup steps that saw it, else from
 * the permission check (the content reader has no setup steps). */
export function appFor(state: SetupState, identity: string): SetupApp | null {
  return state.scopes.flatMap((scope) => scope.steps).find((step) => step.identity === identity && step.app)?.app
    ?? state.permissions?.observed?.byIdentity[identity]?.app ?? null;
}

/**
 * Microsoft's admin consent page for one app: a Global Administrator (or Privileged
 * Role Administrator) signs in once and grants every permission the app registration
 * lists. Keel writes nothing through it. Null while the tenant or app id is unknown.
 */
export function consentLink(tenantId: string | null | undefined, appId: string | null | undefined): string | null {
  return tenantId && appId ? `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/adminconsent?client_id=${encodeURIComponent(appId)}` : null;
}

/** The app's API permissions page in Entra ID, where a permission is added or removed. */
export function apiPermissionsLink(appId: string | null | undefined): string | null {
  return appId ? `${ENTRA}/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/${encodeURIComponent(appId)}` : null;
}

/** Where an admin assigns one role to the app: the Entra role's assignments page, or
 * Intune's roles page (an Intune role is given to a group the app is in). */
export function roleLink(row: Pick<PermissionRow, "api" | "name" | "templateId">): string | null {
  if (row.api === "intune") return "https://intune.microsoft.com/#view/Microsoft_Intune_DeviceSettings/RolesLandingMenuBlade/~/roles";
  if (row.api !== "directory") return null;
  if (!row.templateId) return `${ENTRA}/Microsoft_AAD_IAM/AllRolesBlade`;
  const id = encodeURIComponent(row.templateId);
  return `${ENTRA}/Microsoft_AAD_IAM/RoleMenuBlade/~/RoleMembers/objectId/${id}/roleName/${encodeURIComponent(row.name)}/roleTemplateId/${id}/adminUnitObjectId//customRole~/false/resourceScope/%2F`;
}

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "2 permissions and 1 admin role", for the page header and the alerts. */
export function missingWords(missing: PermissionRow[]): string {
  const roles = missing.filter((row) => row.type === "admin-role").length;
  const permissions = missing.length - roles;
  return [permissions ? counted(permissions, "permission", "permissions") : "", roles ? counted(roles, "admin role", "admin roles") : ""].filter(Boolean).join(" and ");
}

/** "The backup reader app holds 3 permissions Keel never uses.", for Setup's amber alert. */
export function unusedSentence(identity: string, unused: PermissionRow[]): string {
  return `The ${appNameInSentence(identity)} holds ${missingWords(unused)} Keel never uses. Remove ${unused.length === 1 ? "it" : "them"}.`;
}

/** "2 permissions are missing", in plain words for the page and its alerts. */
export function missingSentence(identity: string, missing: PermissionRow[]): string {
  const count = missing.length;
  const it = count === 1 ? "it" : "them";
  const what = identity === "collector" ? `Backups that need ${it} stay incomplete` : identity === "restorer" ? `Restores that need ${it} stop` : identity === "content-reader" ? `Content backups that need ${it} stay incomplete` : identity === "engage-writer" ? `Viva Engage community restores stop` : `What needs ${it} stops`;
  const roles = missing.some((row) => row.type === "admin-role");
  const fix = roles && missing.every((row) => row.type === "admin-role") ? "assigns" : "approves";
  return `The ${appNameInSentence(identity)} is missing ${missingWords(missing)}. ${what} until an admin ${fix} ${it}.`;
}
