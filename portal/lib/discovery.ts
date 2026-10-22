import { loadLatestDiscovery } from "../../engine/discovery/store.mjs";
import { connect } from "@/lib/db";

import { databaseUrl, tenantRef } from "@/lib/runtime-config";

// Wave 1 DISC: the latest discovery inventory, and the words the Protect page shows for it.

export type DiscoveryStatus = "catalogued" | "uncatalogued" | "skipped" | "unreadable" | "not-listed";

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
  coverage: "covered" | "under-item" | "not-used" | "unreadable" | "not-in-metadata";
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
    /** Readable but not worth backing up; absent on runs before it existed. */
    skipped?: number;
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
      statuses: ["uncatalogued", "skipped", "unreadable", "not-listed"],
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
  if (source.startsWith("powershell:")) return `${powershellArea(source)} (PowerShell)`;
  return source;
}

const POWERSHELL_AREAS: Record<string, string> = {
  ExchangeOnlineManagement: "Exchange Online and Purview",
  MicrosoftTeams: "Teams",
  "PnP.PowerShell": "SharePoint",
};

function powershellArea(source: string): string {
  const module = source.slice("powershell:".length);
  return POWERSHELL_AREAS[module] ?? module;
}

export function objectCount(objects: number | null, exact: boolean | null): string {
  if (objects === null) return "count unknown";
  return `${exact === false ? "at least " : ""}${plural(objects, "object")}`;
}

const REASONS: Record<string, string> = {
  "missing-grant": "KEEL's app is not allowed to read it",
  "refused-with-grant": "Microsoft refused it, although KEEL's app holds the permission this area usually needs",
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

const SKIP_REASONS: Record<string, string> = {
  "not-configuration": "it holds logs, reports or activity, not settings",
  "microsoft-published": "Microsoft publishes the same list in every tenant",
  "holds-secrets": "it holds passwords or codes KEEL does not store, and little else",
  retired: "it configures a product Microsoft retired or never shipped",
  "other-tenant": "it only exists while another tenant or a partner takes part, so it is set up again with them",
};

/** Why a readable type is not worth backing up. */
export function skippedSentence(item: Pick<DiscoveryItem, "reason">): string {
  return `Not backed up: ${SKIP_REASONS[item.reason ?? ""] ?? "it holds no settings to restore"}.`;
}

/** The section's one-sentence answer. */
export function discoveryHeadline(data: DiscoveryInventoryData): string {
  const { summary } = data;
  const parts = [`${plural(summary.catalogued, "type")} backed up`];
  parts.push(`${summary.uncatalogued.toLocaleString("en-GB")} readable but not backed up yet`);
  if (summary.skipped) parts.push(`${summary.skipped.toLocaleString("en-GB")} not worth backing up`);
  if (summary.unreadable) parts.push(`${summary.unreadable.toLocaleString("en-GB")} KEEL cannot read`);
  return `Discovery found ${plural(summary.types, "type")}: ${parts.join(", ")}.`;
}

/** Backed-up types discovery could not read, other than those the tenant does not use. */
export function missingCatalogue(data: DiscoveryInventoryData): CatalogueCoverage[] {
  return data.catalogue.filter((entry) => entry.coverage === "unreadable" || entry.coverage === "not-in-metadata");
}

/** Backed-up types this tenant does not use (no licence, feature off, never set up). */
export function notUsedCatalogue(data: DiscoveryInventoryData): CatalogueCoverage[] {
  return data.catalogue.filter((entry) => entry.coverage === "not-used");
}

const NOT_USED_REASONS: Record<string, string> = {
  "not-licensed": "the tenant has no licence for it",
  "feature-off": "the feature is not switched on or not offered in this tenant",
  "not-set-up": "it has never been set up in this tenant",
};

/** Why a backed-up type is not used in this tenant. */
export function notUsedSentence(entry: Pick<CatalogueCoverage, "reason">): string {
  return `Not used in this tenant: ${NOT_USED_REASONS[entry.reason ?? ""] ?? "the tenant does not have this feature"}. Nothing to back up.`;
}

/** The catalogue check: whether every type KEEL backs up was found in the tenant. */
export function catalogueSentence(data: DiscoveryInventoryData): string {
  const missing = missingCatalogue(data);
  const notUsed = notUsedCatalogue(data).length;
  const unused = notUsed ? ` ${plural(notUsed, "type")} ${notUsed === 1 ? "is" : "are"} not used in this tenant.` : "";
  if (!missing.length) {
    const read = data.catalogue.length - notUsed;
    if (!notUsed) return data.catalogue.length === 1 ? "The one type KEEL backs up was found and read." : `All ${data.catalogue.length} types KEEL backs up were found and read.`;
    return `Every type KEEL backs up that this tenant uses was found and read (${read.toLocaleString("en-GB")}).${unused}`;
  }
  return `${plural(missing.length, "type")} KEEL backs up ${missing.length === 1 ? "was" : "were"} not found or could not be read.${unused}`;
}

/** Microsoft Graph sources that were not read in full, as sentences. */
export function sourceProblems(data: DiscoveryInventoryData): string[] {
  return data.sources
    .filter((source) => source.status !== "complete" && !source.source.startsWith("powershell:"))
    .map((source) => `${sourceLabel(source.source)} was ${source.status === "partial" ? "only partly read" : "not read"}${source.error ? ` (${source.error})` : ""}.`);
}

// What engine/discovery/discover.mjs records when a run was given no list at all.
const NO_COMMAND_LIST = "no command list was supplied for this module";

export interface PowerShellNote {
  area: string;
  /** Why the list is missing, for Technical details; null when nobody tried. */
  reason: string | null;
}

/**
 * PowerShell areas whose cmdlets this run could not list. This only limits what
 * discovery could look for; backups of those areas run on their own, so it is a
 * note, not an error.
 */
export function powershellNotes(data: DiscoveryInventoryData): PowerShellNote[] {
  return data.sources
    .filter((source) => source.status !== "complete" && source.source.startsWith("powershell:"))
    .map((source) => ({
      area: powershellArea(source.source),
      reason: source.error && source.error !== NO_COMMAND_LIST ? source.error : null,
    }));
}

/** The note's one sentence. */
export function powershellNoteSentence(notes: PowerShellNote[]): string | null {
  if (!notes.length) return null;
  const areas = notes.map((note) => note.area);
  const list = areas.length === 1 ? areas[0] : `${areas.slice(0, -1).join(", ")} and ${areas.at(-1)}`;
  return `Not checked this run: ${list} settings that need PowerShell. Their backups are not affected; the next discovery run tries again.`;
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
