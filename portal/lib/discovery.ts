import { loadLatestDiscovery } from "../../engine/discovery/store.mjs";
import { connect } from "../../engine/store/db.mjs";

import { databaseUrl, tenantRef } from "@/lib/runtime-config";

// Wave 1 DISC: the latest discovery inventory, and the words the Protect page shows for it.

export type DiscoveryStatus = "catalogued" | "uncatalogued" | "unreadable" | "not-listed";

export interface DiscoveryItem {
  source: string;
  name: string;
  kind: "entitySet" | "singleton" | "navigation" | "cmdlet";
  entityType: string | null;
  status: DiscoveryStatus;
  catalogTypes: string[];
  objects: number | null;
  objectsExact: boolean | null;
  httpStatus: number | null;
  reason: string | null;
  message: string | null;
  missingGrant: string | null;
  grantSource: "graph" | "documented" | null;
}

export interface DiscoverySource {
  source: string;
  status: "complete" | "partial" | "unknown";
  error: string | null;
  metadataVersion: string | null;
  paths: number;
}

export interface CatalogueCoverage {
  type: string;
  path: string;
  version: string;
  coverage: "covered" | "under-item" | "unreadable" | "not-in-metadata";
  objects: number | null;
  reason: string | null;
  missingGrant: string | null;
}

export interface ContainerCount {
  objects: number | null;
  exact: boolean | null;
  reason?: string | null;
  missingGrant?: string | null;
}

export interface DiscoveryInventoryData {
  id: string;
  startedAt: string;
  finishedAt: string;
  sources: DiscoverySource[];
  summary: {
    types: number;
    catalogued: number;
    uncatalogued: number;
    unreadable: number;
    "not-listed": number;
    containers: Record<string, ContainerCount | null>;
    catalogue: Partial<Record<CatalogueCoverage["coverage"], number>>;
  };
  catalogue: CatalogueCoverage[];
  items: DiscoveryItem[];
}

/** The latest run with the items the page lists (everything not already backed up). */
export async function getDiscoveryInventory(): Promise<DiscoveryInventoryData | null> {
  const client = await connect(databaseUrl());
  try {
    return (await loadLatestDiscovery(client, {
      tenantRef: tenantRef(),
      statuses: ["uncatalogued", "unreadable", "not-listed"],
    })) as DiscoveryInventoryData | null;
  } catch (error) {
    // The discovery tables arrive with schema.d/10-discovery.sql. Until a host has
    // applied it, discovery has simply not run there.
    if ((error as { code?: string })?.code === "42P01") return null;
    throw error;
  } finally {
    await client.end();
  }
}

const plural = (count: number, word: string) => `${count.toLocaleString("en-GB")} ${word}${count === 1 ? "" : "s"}`;

/** "deviceConfiguration" -> "Device configuration"; a cmdlet keeps its own name. */
export function typeLabel(item: Pick<DiscoveryItem, "kind" | "name" | "entityType">): string {
  if (item.kind === "cmdlet") return item.name;
  const base = item.entityType ?? item.name.split("/").filter(Boolean).pop() ?? item.name;
  // Split camelCase into words; an acronym such as OAuth2 keeps its capitals.
  const words = base.replace(/^([a-z])([A-Z])/, (_, first: string, second: string) => `${first.toUpperCase()}${second}`)
    .split(/(?<=[a-z0-9])(?=[A-Z])/)
    .map((word) => (/^[A-Z][a-z0-9]*$/.test(word) ? word.toLowerCase() : word))
    .join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Where a type was found, in the reader's words. */
export function sourceLabel(source: string): string {
  if (source === "graph:v1.0") return "Microsoft Graph";
  if (source === "graph:beta") return "Microsoft Graph (beta)";
  if (source.startsWith("powershell:")) return `PowerShell, ${source.slice("powershell:".length)}`;
  return source;
}

export function objectCount(objects: number | null, exact: boolean | null): string {
  if (objects === null) return "count unknown";
  return `${exact === false ? "at least " : ""}${plural(objects, "object")}`;
}

const REASONS: Record<string, string> = {
  "missing-grant": "KEEL's app is not allowed to read it",
  "not-licensed": "the tenant is not licensed for it",
  "not-listable": "Microsoft does not list it this way",
  error: "Microsoft answered with an error",
  "too-large": "the answer was too large to read",
};

/** Why a type could not be read, with the permission it needs when known. */
export function unreadableSentence(item: Pick<DiscoveryItem, "reason" | "missingGrant" | "grantSource">): string {
  const reason = REASONS[item.reason ?? ""] ?? "it could not be read";
  if (!item.missingGrant) return `Not read: ${reason}.`;
  return `Not read: ${reason}. It ${item.grantSource === "graph" ? "needs" : "most likely needs"} the ${item.missingGrant} permission.`;
}

/** The section's one-sentence answer. */
export function discoveryHeadline(data: DiscoveryInventoryData): string {
  const { summary } = data;
  const parts = [`${plural(summary.catalogued, "type")} backed up`];
  parts.push(`${summary.uncatalogued.toLocaleString("en-GB")} readable but not backed up yet`);
  if (summary.unreadable) parts.push(`${summary.unreadable.toLocaleString("en-GB")} KEEL cannot read`);
  return `Discovery found ${plural(summary.types, "type")}: ${parts.join(", ")}.`;
}

/** The catalogue check: whether every type KEEL backs up was found in the tenant. */
export function catalogueSentence(data: DiscoveryInventoryData): string {
  const missing = data.catalogue.filter((entry) => entry.coverage === "unreadable" || entry.coverage === "not-in-metadata");
  if (!missing.length) {
    return data.catalogue.length === 1 ? "The one type KEEL backs up was found and read." : `All ${data.catalogue.length} types KEEL backs up were found and read.`;
  }
  return `${plural(missing.length, "type")} KEEL backs up ${missing.length === 1 ? "was" : "were"} not found or could not be read.`;
}

/** Sources that were not read in full, as sentences. */
export function sourceProblems(data: DiscoveryInventoryData): string[] {
  return data.sources
    .filter((source) => source.status !== "complete")
    .map((source) => source.source.startsWith("powershell:")
      ? `${sourceLabel(source.source)}: the cmdlet list was not supplied, so its cmdlets are not checked.`
      : `${sourceLabel(source.source)} was ${source.status === "partial" ? "only partly read" : "not read"}${source.error ? ` (${source.error})` : ""}.`);
}

const CONTAINER_LABELS: Record<string, string> = { users: "Users", groups: "Groups", teams: "Teams", sites: "Sites" };

export function containerLine(data: DiscoveryInventoryData): string | null {
  const entries = Object.entries(data.summary.containers ?? {});
  if (!entries.length) return null;
  return entries.map(([name, value]) => {
    const label = CONTAINER_LABELS[name] ?? name;
    if (!value || value.objects === null) return `${label} unknown`;
    return `${label} ${value.exact === false ? "at least " : ""}${value.objects.toLocaleString("en-GB")}`;
  }).join(" · ");
}
