import type { AlertState } from "@/lib/alerts-view";
import { fieldWords } from "@/lib/changes-view";

// Site permissions audit: changes to SharePoint site settings between two daily reads
// (engine/govern/workloadDrift.mjs, table workload_drift). They have no baseline, so
// the Changes page lists them on their own, next to the baseline changes. Each one
// raised an alert that stays open until a person acknowledges or resolves it.

export interface SiteChange {
  id: string;
  // `site:<id>` or `tenant` (the tenant's sharing settings), as stored.
  resourceKey: string;
  siteId: string | null;
  name: string | null;
  changeType: "added" | "modified" | "removed";
  fields: string[];
  blastRadius: string;
  // When the read that found the change finished.
  seenAt: string;
  collectionId: string;
  previousCollectionId: string;
  alertId: string | null;
  alertState: AlertState | null;
}

export interface SiteChangesData {
  // Changes found within this many days are listed, newest per site first.
  days: number;
  changes: SiteChange[];
}

const FIELD_LABELS: Record<string, string> = {
  appPermissionGrants: "app access",
  siteGroups: "SharePoint groups",
  roleAssignments: "roles given on the site",
  displayName: "name",
  name: "short name",
  webUrl: "web address",
  sharingCapability: "external sharing",
  sharingDomainRestrictionMode: "sharing domain limits",
  sharingAllowedDomainList: "domains allowed for sharing",
  sharingBlockedDomainList: "domains blocked for sharing",
  isResharingByExternalUsersEnabled: "resharing by guests",
};

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** One stored workload_drift row, joined with its site's name and its alert. */
export function siteChangeFrom(row: Record<string, unknown>): SiteChange {
  const resourceKey = String(row.resource_key);
  const site = (row.site_fields ?? {}) as Record<string, unknown>;
  const fields = Array.isArray(row.fields) ? row.fields : [];
  return {
    id: String(row.id),
    resourceKey,
    siteId: resourceKey.startsWith("site:") ? resourceKey.slice("site:".length) : null,
    name: text(site.displayName) ?? text(site.name) ?? text(site.webUrl)?.replace(/^https?:\/\//, "") ?? null,
    changeType: row.change_type as SiteChange["changeType"],
    fields: fields.map((field) => String((field as { path?: unknown })?.path ?? "")).filter((path) => path.length > 0),
    blastRadius: String(row.blast_radius),
    seenAt: new Date(row.observed_to as string | Date).toISOString(),
    collectionId: String(row.collection_id),
    previousCollectionId: String(row.previous_collection_id),
    alertId: row.alert_id ? String(row.alert_id) : null,
    alertState: (row.alert_state as AlertState | null) ?? null,
  };
}

export function siteChangeName(change: SiteChange): string {
  if (!change.siteId) return "Tenant sharing settings";
  return change.name ?? "A site with no name";
}

export function fieldLabel(path: string): string {
  const [head] = path.split(".");
  return FIELD_LABELS[path] ?? FIELD_LABELS[head] ?? fieldWords(path).toLowerCase();
}

/** What changed, in one sentence. */
export function siteChangeLine(change: SiteChange): string {
  if (change.changeType === "added") return change.siteId ? "A new site was found." : "Sharing settings were read for the first time.";
  if (change.changeType === "removed") return change.siteId ? "The site was not found in the newest read." : "Sharing settings were missing from the newest read.";
  const labels = [...new Set(change.fields.map(fieldLabel))];
  if (!labels.length) return "Its settings changed.";
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `${list[0].toUpperCase()}${list.slice(1)} changed.`;
}

/** An alert still waiting for someone to look at it. */
export function waitingForReview(change: SiteChange): boolean {
  return change.alertState === "open" || change.alertState === "reopened";
}
