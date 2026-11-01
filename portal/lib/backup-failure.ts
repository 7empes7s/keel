// Why one kind's last backup failed, in plain words, and what fixes it (portal audit
// 31 Oct, issue 10). When Microsoft refused the read for want of a permission or an
// admin role, the reason names it and links to that row on Setup, where the page shows
// whether the app holds it and how to approve it. Pure and client-safe: What's
// protected, Setup's service tiles and the UI harness all use it.

import { KEEL_PERMISSIONS } from "../../engine/bootstrap/permissionCatalog.mjs";
import { WORKLOAD_DESCRIPTORS } from "../../engine/collect/workloadContract.mjs";
import { missingGrant } from "../../engine/discovery/grants.mjs";
import { backupHealth } from "@/lib/protect-view";
import type { CoverageType } from "@/lib/types";

export type FailureTone = "urgent" | "soon" | "neutral";

/** One permission or admin role Keel's backup app needs for this kind. */
export interface FailureNeed {
  type: "permission" | "role";
  // Microsoft's name: "Policy.Read.All", "SharePoint Administrator".
  name: string;
  // What it lets the app do, from Setup's permission list; null when Setup does not list it.
  words: string | null;
  // Its row on Setup.
  href: string;
}

export interface FailureReason {
  // The cause in one plain sentence.
  text: string;
  tone: FailureTone;
  // Empty unless the cause is a missing permission or role.
  needs: FailureNeed[];
}

interface CatalogEntry { identity: string; api: string; name: string; words: string; type: string }

// The backup app reads settings; the content reader reads mail, files and Teams content.
const READERS = ["collector", "content-reader"];
const CATALOG = (KEEL_PERMISSIONS as readonly CatalogEntry[]).filter((entry) => READERS.includes(entry.identity));

/** Setup's permission list, found by one Microsoft name: the row shows its status and fix. */
export function setupPermissionHref(name: string, identity = "collector"): string {
  return `/setup?perm-app=${encodeURIComponent(identity)}&perm-q=${encodeURIComponent(name)}#setup-permissions`;
}

function need(name: string, type: FailureNeed["type"]): FailureNeed {
  const entry = CATALOG.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase()
    && (type === "role") === (candidate.type === "admin-role"));
  return {
    type,
    name: entry?.name ?? name,
    words: entry?.words ?? null,
    // A name Setup does not list would find no row there: open the whole list instead.
    href: entry ? setupPermissionHref(entry.name, entry.identity) : "/setup#setup-permissions",
  };
}

const AUTHZ = /\b40[13]\b|access ?denied|forbidden|unauthori[sz]ed|insufficient privileges|authorization_requestdenied|not authorized|requires one of|required scopes/i;
const CAUSES: Array<[RegExp, string, FailureTone]> = [
  [/\b429\b|throttl|too many requests/i, "Microsoft 365 slowed Keel down (too many requests). Retrying later usually works.", "soon"],
  [/\b423\b|\blocked\b/i, "Microsoft had it locked while Keel read it. Retrying usually works.", "soon"],
  [/timed? ?out|ETIMEDOUT|ECONNRESET|fetch failed|socket hang up|\b50[0234]\b|gateway|service ?unavailable/i, "Microsoft 365 did not answer in time. Retrying usually works.", "soon"],
  [/\b404\b|not ?found/i, "Microsoft could not find part of it; it may have been moved or deleted during the backup.", "soon"],
  [/not licensed|licen[cs]e/i, "This tenant does not have the licence Microsoft needs for it.", "neutral"],
];

// Each workload's declared permissions and roles (engine/collect/workloadContract.mjs).
function workloadNeeds(workload: string): FailureNeed[] {
  const rows = (WORKLOAD_DESCRIPTORS as readonly { workload: string; rbac?: { permissions?: string[]; roles?: string[] } }[])
    .filter((descriptor) => descriptor.workload === workload);
  const permissions = [...new Set(rows.flatMap((row) => row.rbac?.permissions ?? []))];
  const roles = [...new Set(rows.flatMap((row) => row.rbac?.roles ?? []))];
  return [...permissions.map((name) => need(name, "permission")), ...roles.map((name) => need(name, "role"))];
}

const isWorkload = (item: CoverageType) => (WORKLOAD_DESCRIPTORS as readonly { workload: string }[]).some((descriptor) => descriptor.workload === item.type);

// A Graph path without its version: "/v1.0/policies/x" reads as "/policies/x".
function graphPath(item: CoverageType): string | null {
  const path = item.detail?.endpoint ?? item.declaredEndpoint?.path ?? null;
  if (!path) return null;
  try {
    const bare = path.startsWith("http") ? new URL(path).pathname : path;
    return bare.replace(/^\/(v1\.0|beta)(?=\/)/i, "").split("?")[0];
  } catch {
    return null;
  }
}

function listed(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function needsSentence(needs: FailureNeed[], confirmed: boolean): string {
  const permissions = needs.filter((entry) => entry.type === "permission").map((entry) => entry.name);
  const roles = needs.filter((entry) => entry.type === "role").map((entry) => entry.name);
  const parts = [
    permissions.length ? `${permissions.length === 1 ? "the permission" : "the permissions"} ${listed(permissions)}` : "",
    roles.length ? `${roles.length === 1 ? "the admin role" : "the admin roles"} ${listed(roles)}` : "",
  ].filter(Boolean);
  return confirmed
    ? `Microsoft refused the read because Keel's backup app does not hold ${parts.join(" or ")}.`
    : `Microsoft refused the read. Keel's backup app needs ${parts.join(" and ")} for it; Setup shows which one is missing.`;
}

/** Why one kind's last backup failed or was partly done, or null when neither.
 *  A partly done kind stays amber, so its reason is never red. */
export function failureReason(item: CoverageType): FailureReason | null {
  if (!needsRetry(item)) return null;
  const reason = whyNotBackedUp(item);
  return backupHealth(item) === "partial" && reason.tone === "urgent" ? { ...reason, tone: "soon" } : reason;
}

function whyNotBackedUp(item: CoverageType): FailureReason {
  const diagnosis = item.diagnosis;
  const confirmed = diagnosis?.confirmed ?? {};
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

  // A confirmed missing prerequisite (engine/coverage/diagnosis.mjs) wins.
  if (diagnosis?.diagnosis === "missing-scope") {
    const scopes = strings(confirmed.consentScopes);
    const fromReason = diagnosis.reason?.match(/[A-Z][\w-]*\.[\w.-]*(Read|Write)[\w.-]*/)?.[0];
    const names = scopes.length ? scopes.slice(0, 1) : fromReason ? [fromReason] : [];
    if (names.length) return { text: needsSentence(names.map((name) => need(name, "permission")), true), tone: "urgent", needs: names.map((name) => need(name, "permission")) };
    return { text: "Microsoft refused the read because Keel's backup app is missing a permission Microsoft asks for.", tone: "urgent", needs: [] };
  }
  if (diagnosis?.diagnosis === "missing-role") {
    const roles = strings(confirmed.requiredRoles).slice(0, 1).map((name) => need(name, "role"));
    return { text: roles.length ? needsSentence(roles, true) : "Microsoft refused the read because Keel's backup app is missing an admin role.", tone: "urgent", needs: roles };
  }
  if (diagnosis?.diagnosis === "missing-license" || diagnosis?.diagnosis === "disabled-plan") {
    return { text: "This tenant does not have the licence Microsoft needs for it, so Microsoft refused the read.", tone: "neutral", needs: [] };
  }

  const status = item.detail?.httpStatus ?? diagnosis?.original.httpStatus ?? null;
  const code = item.detail?.graphCode ?? diagnosis?.original.graphCode ?? null;
  const message = item.detail?.message ?? null;
  const text = [status ? `HTTP ${status}` : "", code ?? "", message ?? ""].join(" ");
  const refused = status === 401 || status === 403 || AUTHZ.test(text);

  if (refused) {
    if (isWorkload(item)) {
      const needs = workloadNeeds(item.type);
      return needs.length
        ? { text: needsSentence(needs, false), tone: "urgent", needs }
        : { text: "Microsoft refused the read because Keel's backup app is missing a permission or admin role.", tone: "urgent", needs: [] };
    }
    const path = graphPath(item);
    const grant = path ? missingGrant(path, message) : null;
    if (grant) {
      const needs = [need(grant.grant, "permission")];
      return { text: needsSentence(needs, grant.source === "graph"), tone: "urgent", needs };
    }
    return { text: "Microsoft refused the read because Keel's backup app is missing a permission or admin role.", tone: "urgent", needs: [] };
  }

  const [, cause, tone] = CAUSES.find(([pattern]) => pattern.test(text)) ?? [null, null, null];
  // The cause only: the row's own sentence already says whether part of it was read.
  if (cause) return { text: cause, tone: tone!, needs: [] };
  return item.outcome === "partial"
    ? { text: "Keel did not get all of it from Microsoft 365. Retrying usually finishes it.", tone: "soon", needs: [] }
    : { text: "Keel could not read it from Microsoft 365. Retry it; if it fails again, its record has the error.", tone: "soon", needs: [] };
}

/** A kind whose last backup failed or was only partly done: it says why and can be run again. */
export function needsRetry(item: CoverageType): boolean {
  const health = backupHealth(item);
  return health === "failed" || health === "partial";
}

/** How to run one kind again: its tier's backup, the service settings backup, or a full read. */
export type RetryPlan =
  | { kind: "tier"; tier: string }
  | { kind: "workloads" }
  | { kind: "full" };

export function retryPlan(item: CoverageType, tiers: readonly string[]): RetryPlan {
  if (item.criticality && tiers.includes(item.criticality)) return { kind: "tier", tier: item.criticality };
  if (isWorkload(item)) return { kind: "workloads" };
  return { kind: "full" };
}
