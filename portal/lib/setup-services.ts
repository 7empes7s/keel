// Setup: one status line per Microsoft 365 service and the Keel app certificate dates.
// Client-safe: the page body, the UI harness and the unit tests all use it. The
// service lines come from the same coverage report What's protected reads, so both
// pages agree on what is backed up, what failed and what Keel can put back.

import type { IconName } from "@/components/shell/icons";
import { typeInfo } from "../../engine/insights/taxonomy.mjs";
import { plainKind, typeService } from "@/lib/baselines-view";
import { ago, formatTimestamp, fromNow } from "@/lib/presentation";
import { failureReason } from "@/lib/backup-failure";
import { backupHealth, protectCounts, type BackupHealth } from "@/lib/protect-view";
import { SERVICES, serviceFor, serviceOrder } from "@/lib/services";
import type { CoverageType } from "@/lib/types";

export type ServiceTone = "urgent" | "soon" | "low" | "fine" | "neutral";

export interface ServiceFix {
  label: string;
  href: string;
}

export interface ServiceStatus {
  code: string;
  name: string;
  icon: IconName;
  tone: ServiceTone;
  // The badge: Working, Failing, Out of date, Not set up or Not on this tenant.
  label: string;
  backup: { tone: ServiceTone; text: string };
  restore: { tone: ServiceTone; text: string };
  // The newest read of this service that finished, or null when none has.
  lastGoodRead: string | null;
  // The one thing most worth fixing, with where to fix it.
  blocker: { text: string; fix: ServiceFix | null } | null;
}

const kindName = (item: CoverageType) => {
  const info = typeInfo(item.type);
  return item.type.includes("-") && info.known ? info.name : plainKind(item.type);
};

const PROBLEM: BackupHealth[] = ["failed", "partial", "stale", "never"];
const READ: BackupHealth[] = ["ok", "empty", "stale"];
// Problems first, then working services, then the ones with nothing to show yet.
const TONE_RANK: Record<ServiceTone, number> = { urgent: 0, soon: 1, low: 2, fine: 3, neutral: 4 };

function kinds(count: number): string {
  return `${count} ${count === 1 ? "type" : "types"}`;
}

/** Why one kind is not backed up, in words, and where to fix it. */
function blockerFor(item: CoverageType, code: string, now: string): { text: string; fix: ServiceFix | null } {
  const name = kindName(item);
  const failed: ServiceFix = { label: "See what failed", href: `/protect?service=${encodeURIComponent(code)}&health=failed` };
  const partial: ServiceFix = { label: "See what was partly done", href: `/protect?service=${encodeURIComponent(code)}&health=partial` };
  const late: ServiceFix = { label: "See what is out of date", href: `/protect?service=${encodeURIComponent(code)}&health=out-of-date` };
  // A refused read names the permission or role it needs and opens it on Setup.
  const reason = failureReason(item);
  if (reason?.needs.length) {
    const [first] = reason.needs;
    return {
      text: `${name}: ${reason.text}`,
      fix: reason.needs.length === 1
        ? { label: `Check ${first.name}`, href: first.href }
        : { label: "See missing permissions", href: "/setup?perm-app=collector&perm-status=missing#setup-permissions" },
    };
  }
  switch (item.diagnosis?.diagnosis) {
    case "missing-scope":
      return { text: `${name}: Keel's backup app is missing a permission Microsoft asks for.`, fix: { label: "Check read access", href: "#setup-read" } };
    case "missing-role":
      return { text: `${name}: Keel's backup app is missing an admin role Microsoft asks for.`, fix: { label: "Check read access", href: "#setup-read" } };
    case "missing-license":
    case "disabled-plan":
      return {
        text: `${name}: this tenant does not have the licence Microsoft needs for it.`,
        fix: backupHealth(item) === "failed" ? failed : backupHealth(item) === "partial" ? partial : null,
      };
    default:
      break;
  }
  switch (backupHealth(item)) {
    case "failed":
      return { text: `${name}: the last backup failed.`, fix: failed };
    case "partial":
      return { text: `${name}: the last backup read only part of it.`, fix: partial };
    case "stale":
      return { text: `${name}: last backed up ${ago(item.lastCollectedAt, now)}, longer ago than its tier allows.`, fix: late };
    default:
      return { text: `${name}: never backed up yet.`, fix: late };
  }
}

/** One service's line. `types` are every kind Keel knows under that service. */
export function serviceStatus(code: string, types: CoverageType[], now: string): ServiceStatus {
  const service = serviceFor(code);
  const base = { code, name: service.name, icon: service.icon };
  const counted = types.filter((item) => !["not-collected", "unavailable"].includes(backupHealth(item)));
  if (counted.length === 0) {
    const unavailable = types.some((item) => backupHealth(item) === "unavailable");
    return {
      ...base,
      tone: "neutral",
      label: unavailable ? "Not on this tenant" : "Not set up",
      backup: { tone: "neutral", text: unavailable ? "This tenant does not have the licence Microsoft needs." : "Keel does not back this service up yet." },
      restore: { tone: "neutral", text: "Nothing to put back yet." },
      lastGoodRead: null,
      blocker: null,
    };
  }
  const counts = protectCounts(counted);
  const outOfDate = counts.stale + counts.never;
  const backup: ServiceStatus["backup"] = counts.failed
    ? { tone: "urgent", text: `${kinds(counts.failed)} failed${counts.partial ? `, ${counts.partial} partly done` : ""}, ${counts.backedUp} of ${counted.length} backed up` }
    : counts.partial
      ? { tone: "soon", text: `${kinds(counts.partial)} partly done${outOfDate ? `, ${outOfDate} out of date` : ""}, ${counts.backedUp} of ${counted.length} backed up` }
      : outOfDate
      ? { tone: "soon", text: `${kinds(outOfDate)} out of date, ${counts.backedUp} of ${counted.length} backed up` }
      : { tone: "fine", text: `All ${kinds(counted.length)} backed up` };
  const restore: ServiceStatus["restore"] = counts.restorable === 0
    ? { tone: "neutral", text: "Backup only: Keel cannot put these back yet" }
    : {
      tone: counts.proven ? "fine" : "low",
      // The same "restore proven" count as What's protected and the Overview.
      text: `${counts.restorable} of ${counted.length} can be put back, ${counts.proven ? `${counts.proven} proven on this tenant` : "none proven yet"}${counts.tested ? `, ${counts.tested} ${counts.tested === 1 ? "passes" : "pass"} tests only` : ""}`,
    };
  const reads = counted.filter((item) => READ.includes(backupHealth(item)) && item.lastCollectedAt)
    .map((item) => item.lastCollectedAt!).sort();
  const worst = [...counted]
    .filter((item) => PROBLEM.includes(backupHealth(item)))
    .sort((a, b) => PROBLEM.indexOf(backupHealth(a)) - PROBLEM.indexOf(backupHealth(b)) || kindName(a).localeCompare(kindName(b)))[0];
  return {
    ...base,
    tone: backup.tone,
    label: counts.failed ? "Failing" : counts.partial ? "Partly done" : outOfDate ? "Out of date" : "Working",
    backup,
    restore,
    lastGoodRead: reads.at(-1) ?? null,
    blocker: worst ? blockerFor(worst, code, now) : null,
  };
}

/**
 * Every Microsoft 365 service, worst first, then in the portal's service order.
 * Keel's own records are not a service to set up, so they are left out. Kinds Keel
 * has not placed in a service yet get an "Other services" line, so none is hidden.
 */
export function serviceStatuses(types: CoverageType[], now: string): ServiceStatus[] {
  const byService = new Map<string, CoverageType[]>();
  for (const item of types) {
    const placed = typeService(item.type).code;
    const code = SERVICES.some((service) => service.code === placed) ? placed : "other";
    if (code === "Keel") continue;
    byService.set(code, [...(byService.get(code) ?? []), item]);
  }
  const codes = [...SERVICES.map((service) => service.code).filter((code) => code !== "Keel"),
    ...[...byService.keys()].filter((code) => !SERVICES.some((service) => service.code === code))];
  return codes
    .map((code) => serviceStatus(code, byService.get(code) ?? [], now))
    .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || serviceOrder(a.code) - serviceOrder(b.code));
}

/** "Last good read 3 hours ago", or that there has been none. */
export function lastReadWords(status: Pick<ServiceStatus, "lastGoodRead">, now: string): string {
  return status.lastGoodRead ? `Last good read ${ago(status.lastGoodRead, now)}` : "No good read yet";
}

/** The section's one-line summary: how many services work and how many need a look. */
export function servicesSummary(statuses: ServiceStatus[]): { tone: ServiceTone; text: string } {
  const failing = statuses.filter((status) => status.tone === "urgent").length;
  const late = statuses.filter((status) => status.tone === "soon").length;
  const working = statuses.filter((status) => status.label === "Working").length;
  if (failing) return { tone: "urgent", text: `${failing} of ${statuses.length} services ${failing === 1 ? "is" : "are"} failing to back up.` };
  if (late) return { tone: "soon", text: `${late} of ${statuses.length} services ${late === 1 ? "is" : "are"} out of date.` };
  if (working === 0) return { tone: "neutral", text: "No service has been backed up yet." };
  return { tone: "fine", text: `${working} of ${statuses.length} services are backed up and working.` };
}

// ---- Keel app certificates ----------------------------------------------------

// What /api/setup's `connections` carries that the warning needs: one row per Keel app.
// The certificate date is read from the certificate file Keel signs in with.
export interface ConnectionExpiry {
  role: string;
  name: string;
  appId: string | null;
  credentialExpiresAt: string | null;
}

// Warn this many days before a certificate stops working; at a week it is urgent.
export const EXPIRY_WARNING_DAYS = 30;
const DAY = 86_400_000;

export interface CredentialWarning {
  role: string;
  tone: "urgent" | "soon";
  title: string;
  detail: string;
  fix: ServiceFix;
}

const STOPS: Record<string, string> = {
  "settings-reader": "settings backups stop",
  "content-reader": "mail, file and Teams backups stop",
  "settings-restorer": "restores stop",
  "engage-writer": "Viva Engage community restores stop",
};

const ENTRA = "https://entra.microsoft.com/#view";

/** The Entra page where an admin adds a new certificate to the app. */
export function credentialsLink(appId: string | null): string {
  return appId
    ? `${ENTRA}/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Credentials/appId/${encodeURIComponent(appId)}`
    : `${ENTRA}/Microsoft_AAD_RegisteredApps/ApplicationsListBlade`;
}

function dateWords(value: string): string {
  return formatTimestamp(value).replace(/,? \d{2}:\d{2}( UTC)?$/, "");
}

/** One warning per Keel app whose certificate runs out within 30 days, soonest first. */
export function credentialWarnings(connections: ConnectionExpiry[] | null | undefined, now: string): CredentialWarning[] {
  return (connections ?? [])
    .filter((connection) => knownDate(connection.credentialExpiresAt)
      && Date.parse(connection.credentialExpiresAt) - Date.parse(now) <= EXPIRY_WARNING_DAYS * DAY)
    .sort((a, b) => Date.parse(a.credentialExpiresAt!) - Date.parse(b.credentialExpiresAt!))
    .map((connection) => {
      const endsAt = connection.credentialExpiresAt!;
      const left = Date.parse(endsAt) - Date.parse(now);
      const stops = STOPS[connection.role] ?? "what it does for Keel stops";
      const fix = { label: "Add a new certificate in Entra ID", href: credentialsLink(connection.appId) };
      return left <= 0
        ? {
          role: connection.role, tone: "urgent" as const, fix,
          title: `${connection.name}: its certificate expired ${ago(endsAt, now)}`,
          detail: `Keel cannot sign in as this app, so ${stops}. Add a new certificate, then give Keel the new one.`,
        }
        : {
          role: connection.role, tone: left <= 7 * DAY ? "urgent" as const : "soon" as const, fix,
          title: `${connection.name}: its certificate expires ${fromNow(endsAt, now)}, on ${dateWords(endsAt)}`,
          detail: `When it expires, ${stops}. Add a new certificate before then, then give Keel the new one.`,
        };
    });
}

const knownDate = (value: string | null): value is string => value !== null && Number.isFinite(Date.parse(value));

/**
 * The quiet line when nothing runs out soon: the first date a Keel app certificate
 * ends, and which app's it is, so the date can be matched to that app's row below.
 * Only when every app's date is known; otherwise null, so nothing unknown reads as fine.
 */
export function credentialsFine(connections: ConnectionExpiry[] | null | undefined): string | null {
  const list = connections ?? [];
  if (!list.length || !list.every((connection) => knownDate(connection.credentialExpiresAt))) return null;
  const first = list.map((connection) => Date.parse(connection.credentialExpiresAt!)).reduce((a, b) => Math.min(a, b));
  const day = dateWords(new Date(first).toISOString());
  const names = list.filter((connection) => dateWords(connection.credentialExpiresAt!) === day).map((connection) => connection.name);
  const which = list.length === 1 ? ""
    : names.length === list.length ? " All of them end that day."
    : ` ${names.join(" and ")} ${names.length === 1 ? "ends" : "end"} first.`;
  return `Keel's app certificates are valid until at least ${day}.${which}`;
}

/** The apps whose certificate end date Keel does not know, by name. */
export function credentialsUnknown(connections: ConnectionExpiry[] | null | undefined): string[] {
  return (connections ?? []).filter((connection) => !knownDate(connection.credentialExpiresAt)).map((connection) => connection.name);
}
