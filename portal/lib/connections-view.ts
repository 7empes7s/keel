// Setup's Connections list (handoff/delegated-access DESIGN 3.5, build step 3): each
// Keel app and service account in the tenant, grouped Required / Optional / Service
// accounts, problems first, with what each one should hold next to what it holds.
// Read only: nothing here changes the tenant. Client-safe, like lib/setup-view.ts.

import type { BadgeTone } from "@/components/ui/badge";
import { fromNow } from "@/lib/presentation";
import type { ConnectionExpiry } from "@/lib/setup-services";
import type { PermissionEntry } from "@/lib/setup-view";

// The states engine/bootstrap/connections.mjs records (CONNECTION_STATES).
export type ConnectionState =
  | "not-checked" | "not-created" | "waiting-for-consent" | "working"
  | "missing-permission" | "switched-off" | "needs-reconnect" | "removed";

// One row of /api/setup `connections` (engine loadConnections).
export interface Connection extends ConnectionExpiry {
  id: string;
  kind: "app" | "service-account";
  purpose: string;
  required: boolean;
  // A string, not ConnectionState: a newer server can send a state this page does not know.
  state: string;
  credentialExpiresInDays: number | null;
  wanted: { permissions: string[]; roles: string[] } | null;
  observed: {
    at: string;
    displayName: string | null;
    enabled: boolean | null;
    grantedPermissions: string[];
    missingPermissions: string[];
    extraPermissions: string[];
    // null: Keel cannot see the role assignments, so none is called missing.
    missingRoles: string[] | null;
  } | null;
  lastUsedAt: string | null;
  lastSignInAt: string | null;
  updatedAt: string;
}

export type ConnectionGroupKey = "required" | "optional" | "service-accounts";

export const CONNECTION_GROUPS: { key: ConnectionGroupKey; title: string; hint: string; empty: string }[] = [
  { key: "required", title: "Required apps", hint: "Keel cannot back up without these.", empty: "No required app is recorded yet." },
  { key: "optional", title: "Optional apps", hint: "Each adds a feature. Nothing else stops without them.", empty: "No optional app is recorded yet." },
  {
    key: "service-accounts", title: "Service accounts",
    hint: "Signed-in accounts for the few settings Microsoft only shows to a person.",
    empty: "None yet. Keel adds one only for a setting Microsoft shows to signed-in accounts, and only when you choose it.",
  },
];

export function connectionGroup(connection: Connection): ConnectionGroupKey {
  if (connection.kind === "service-account") return "service-accounts";
  return connection.required ? "required" : "optional";
}

// Warn this many days before a certificate ends, counted like the sign-in warning above the page.
const DAY = 86_400_000;
const EXPIRY_DAYS = 30;

export interface ConnectionStatus {
  label: string;
  tone: BadgeTone;
  // 0 is the worst. Problems sort to the top of their group.
  rank: number;
  problem: boolean;
}

/**
 * The badge for one connection at the page's time `now`. A state this page does not
 * know is never shown as working.
 */
export function connectionStatus(connection: Connection, now: string): ConnectionStatus {
  const ends = connection.credentialExpiresAt ? Date.parse(connection.credentialExpiresAt) : Number.NaN;
  const left = ends - Date.parse(now);
  switch (connection.state) {
    case "needs-reconnect": return { label: "Needs reconnect", tone: "urgent", rank: 0, problem: true };
    case "missing-permission": return { label: "Missing permission", tone: "urgent", rank: 0, problem: true };
    case "not-created": return connection.required
      ? { label: "Not set up", tone: "urgent", rank: 0, problem: true }
      : { label: "Not set up", tone: "neutral", rank: 5, problem: false };
    // Restorers are meant to be off between restores; a required app is not.
    case "switched-off": return connection.required
      ? { label: "Switched off", tone: "urgent", rank: 0, problem: true }
      : { label: "Switched off", tone: "neutral", rank: 4, problem: false };
    case "waiting-for-consent": return { label: "Waiting for approval", tone: "soon", rank: 1, problem: true };
    case "working":
      if (Number.isFinite(left) && left <= EXPIRY_DAYS * DAY) {
        const label = left <= 0 ? "Certificate expired" : `Expires ${fromNow(connection.credentialExpiresAt, now)}`;
        return { label, tone: left <= 7 * DAY ? "urgent" : "soon", rank: left <= 7 * DAY ? 0 : 2, problem: true };
      }
      return { label: "Working", tone: "fine", rank: 6, problem: false };
    case "not-checked": return { label: "Not checked", tone: "neutral", rank: 3, problem: false };
    case "removed": return { label: "Removed", tone: "neutral", rank: 7, problem: false };
    default: return { label: "Unknown state", tone: "neutral", rank: 3, problem: false };
  }
}

// What stops, in a few words, when an app does not work.
const FEATURE: Record<string, string> = {
  "settings-reader": "settings backups",
  "content-reader": "mail, file and Teams backups",
  "settings-restorer": "restores",
};
const feature = (connection: Connection) => FEATURE[connection.role] ?? "the features that use it";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The problems to show above the list, worst first, one sentence each. Certificate
 * expiry is left out: the sign-in warning at the top of Setup already says it.
 */
export function connectionAlerts(connections: Connection[], now: string): { id: string; tone: "urgent" | "soon"; text: string }[] {
  const out: { id: string; tone: "urgent" | "soon"; text: string; rank: number }[] = [];
  for (const connection of connections) {
    const status = connectionStatus(connection, now);
    if (!status.problem || status.tone === "neutral" || status.tone === "fine" || status.tone === "low") continue;
    let text: string | null = null;
    if (connection.state === "missing-permission") {
      const permissions = connection.observed?.missingPermissions.length ?? 0;
      const roles = connection.observed?.missingRoles?.length ?? 0;
      const what = [permissions ? count(permissions, "permission", "permissions") : null, roles ? count(roles, "role", "roles") : null].filter(Boolean).join(" and ");
      text = `${connection.name} is missing ${what || "a permission"}: ${feature(connection)} may be incomplete.`;
    } else if (connection.state === "waiting-for-consent") {
      text = `${connection.name} is waiting for an administrator to approve it: ${feature(connection)} cannot run yet.`;
    } else if (connection.state === "not-created") {
      text = `${connection.name} is not set up in your tenant: ${feature(connection)} cannot run.`;
    } else if (connection.state === "switched-off") {
      text = `${connection.name} is switched off in your tenant: ${feature(connection)} have stopped.`;
    }
    if (text) out.push({ id: connection.id, tone: status.tone, text, rank: status.rank });
  }
  return out.sort((a, b) => a.rank - b.rank).map(({ id, tone, text }) => ({ id, tone, text }));
}

export interface ConnectionGroup {
  key: ConnectionGroupKey;
  title: string;
  hint: string;
  empty: string;
  connections: Connection[];
}

/** Every group, always in the same order; within a group problems first, then by name. */
export function connectionGroups(connections: Connection[], now: string): ConnectionGroup[] {
  return CONNECTION_GROUPS.map((group) => ({
    ...group,
    connections: connections
      .filter((connection) => connectionGroup(connection) === group.key)
      .sort((a, b) => connectionStatus(a, now).rank - connectionStatus(b, now).rank || a.name.localeCompare(b.name)),
  }));
}

export type GrantStatus = "missing" | "not-checked" | "granted" | "extra";

export const GRANT_LABELS: Record<GrantStatus, string> = {
  missing: "Missing",
  "not-checked": "Not checked",
  granted: "Granted",
  extra: "Not used by Keel",
};

export const GRANT_TONES: Record<GrantStatus, BadgeTone> = {
  missing: "urgent",
  "not-checked": "neutral",
  granted: "fine",
  extra: "neutral",
};

const GRANT_ORDER: GrantStatus[] = ["missing", "not-checked", "granted", "extra"];

export interface GrantRow {
  kind: "permission" | "role";
  name: string;
  words: string;
  usedFor: string | null;
  wanted: boolean;
  status: GrantStatus;
}

// The permission catalog names the backup reader and restore writer by their old identity.
const CATALOG_IDENTITY: Record<string, string> = {
  "settings-reader": "collector",
  "content-reader": "content-reader",
  "settings-restorer": "restorer",
};

/**
 * Wanted next to granted for one connection: every permission and role Keel wants, plus
 * any it holds that Keel never uses. Missing first, held-but-unused last. Without a
 * tenant read nothing is called missing or granted.
 */
export function grantRows(connection: Connection, catalog: PermissionEntry[] = [], words: Record<string, string> = {}): GrantRow[] {
  const identity = CATALOG_IDENTITY[connection.role] ?? connection.role;
  const entries = catalog.filter((entry) => entry.identity === identity && entry.api === "graph");
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const order = new Map(entries.map((entry, index) => [entry.name, index]));
  const observed = connection.observed;
  const wanted = connection.wanted ?? { permissions: [], roles: [] };
  const granted = new Set(observed?.grantedPermissions ?? []);
  const missing = new Set(observed?.missingPermissions ?? []);

  const rows: GrantRow[] = [];
  const permission = (name: string, isWanted: boolean, status: GrantStatus): GrantRow => ({
    kind: "permission", name, words: byName.get(name)?.words ?? words[name] ?? name, usedFor: byName.get(name)?.usedFor ?? null, wanted: isWanted, status,
  });
  for (const name of wanted.permissions) {
    const status: GrantStatus = !observed ? "not-checked" : missing.has(name) ? "missing" : granted.has(name) ? "granted" : "not-checked";
    rows.push(permission(name, true, status));
  }
  for (const name of observed?.extraPermissions ?? []) {
    if (!wanted.permissions.includes(name)) rows.push(permission(name, false, "extra"));
  }
  const rolesMissing = observed?.missingRoles ?? null;
  for (const name of wanted.roles) {
    const status: GrantStatus = !observed || rolesMissing === null ? "not-checked" : rolesMissing.includes(name) ? "missing" : "granted";
    rows.push({ kind: "role", name, words: `Role: ${name}`, usedFor: null, wanted: true, status });
  }
  const rank = (row: GrantRow) => order.get(row.name) ?? Number.MAX_SAFE_INTEGER;
  return rows.sort((a, b) => GRANT_ORDER.indexOf(a.status) - GRANT_ORDER.indexOf(b.status)
    || (a.kind === b.kind ? 0 : a.kind === "permission" ? -1 : 1)
    || rank(a) - rank(b) || a.words.localeCompare(b.words));
}

/** "4 of 5 granted", or why it is not known. */
export function grantSummary(rows: GrantRow[]): string {
  const wanted = rows.filter((row) => row.wanted);
  if (!wanted.length) return "Nothing to check";
  if (wanted.every((row) => row.status === "not-checked")) return `${wanted.length} not checked`;
  const granted = wanted.filter((row) => row.status === "granted").length;
  return `${granted} of ${wanted.length} granted`;
}
