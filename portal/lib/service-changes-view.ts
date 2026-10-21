import { workloadLabel } from "@/lib/compare-view";
import { fieldWords } from "@/lib/changes-view";
import type { DriftRecord } from "@/lib/types";

// Service setting changes: Exchange, SharePoint and OneDrive, Teams, Purview and Power
// Platform settings Keel reads on a schedule. They have no approved setup, so each read
// is compared with the read before it (engine/govern/workloadDrift.mjs, table
// workload_drift). The Changes page lists them beside the approved-setup changes, so
// its service filter and grouping cover every service. Each one raised an alert that
// stays open until someone acknowledges or resolves it.

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

// The fields a read names a resource by, best first.
const NAME_FIELDS = ["displayName", "DisplayName", "name", "Name", "title", "webUrl", "url", "identity"];
// Keys that hold one tenant-wide group of settings rather than a named resource.
const TENANT_KEYS: Record<string, string> = { tenant: "Sharing settings", organization: "Organization settings" };

const text = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function fieldLabel(path: string): string {
  const [head] = path.split(".");
  return FIELD_LABELS[path] ?? FIELD_LABELS[head] ?? fieldWords(path).toLowerCase();
}

/** The name a service change is listed under: the resource's own name from the read,
 * never an id when a name exists. */
export function serviceChangeName(resourceKey: string, fields: Record<string, unknown> | null): string {
  if (TENANT_KEYS[resourceKey]) return TENANT_KEYS[resourceKey];
  for (const field of NAME_FIELDS) {
    const value = text(fields?.[field]);
    if (value) return value.replace(/^https?:\/\//, "");
  }
  const index = resourceKey.indexOf(":");
  return index === -1 ? resourceKey : resourceKey.slice(index + 1);
}

/** One stored workload_drift row, joined with its resource's fields and its alert, as a
 * row of the Changes list. */
export function serviceChangeFrom(row: Record<string, unknown>): DriftRecord {
  const workload = String(row.workload);
  const resourceKey = String(row.resource_key);
  const changeType = row.change_type as DriftRecord["changeType"];
  const current = record(row.current_fields);
  const previous = record(row.previous_fields);
  const fields = (Array.isArray(row.fields) ? row.fields : [])
    .map((field) => record(field))
    .filter((field): field is Record<string, unknown> => field !== null && typeof field.path === "string");
  const changed = (side: "before" | "after") => Object.fromEntries(fields.map((field) => [String(field.path), field[side] ?? null]));
  return {
    id: String(row.id),
    naturalKey: `${workload}:${resourceKey}`,
    resourceType: workload,
    changeType,
    blastRadius: String(row.blast_radius),
    detectedAt: new Date(row.observed_to as string | Date).toISOString(),
    before: changeType === "added" ? null : changeType === "removed" ? previous : changed("before"),
    after: changeType === "removed" ? null : changeType === "added" ? current : changed("after"),
    name: serviceChangeName(resourceKey, current ?? previous),
    serviceRead: {
      workload,
      resourceKey,
      collectionId: String(row.collection_id),
      previousCollectionId: String(row.previous_collection_id),
      alertId: row.alert_id ? String(row.alert_id) : null,
      alertState: row.alert_state ? String(row.alert_state) : null,
    },
  };
}

/** "Mail flow" for a service change; null for an approved-setup change. */
export function serviceReadLabel(item: Pick<DriftRecord, "serviceRead">): string | null {
  return item.serviceRead ? workloadLabel(item.serviceRead.workload) : null;
}
