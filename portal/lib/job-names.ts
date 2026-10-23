// Names, not ids, on a job's page. The server looks up the saved name of each key
// (lib/saved-names.ts); these helpers turn a key into words with that name and never
// return text that holds an object id. Keys and ids stay in Technical details.
import { edgeKeyType } from "@/lib/app-names";
import { workloadLabel } from "@/lib/compare-view";
import { plainError } from "@/lib/error-words";
import { holdsObjectId } from "@/lib/object-ids";
import { resourceTypeLabel } from "@/lib/presentation";

export { holdsObjectId };

export type NamedKeys = Record<string, { name: string | null; resourceType: string }>;

const FAMILY_WORDS: Record<string, string> = { member: "member", owner: "owner" };

function typeOf(naturalKey: string, names: NamedKeys, resourceType?: string | null): string | null {
  const known = names[naturalKey]?.resourceType ?? resourceType;
  if (known) return known;
  const edge = edgeKeyType(naturalKey);
  if (edge) return edge;
  const index = naturalKey.indexOf(":");
  return index > 0 && !holdsObjectId(naturalKey.slice(0, index)) ? naturalKey.slice(0, index) : null;
}

/** One saved setting as a person reads it: "Finance (group)", or "Unnamed device script". */
export function namedResource(naturalKey: string, names: NamedKeys = {}, resourceType?: string | null): string {
  const type = typeOf(naturalKey, names, resourceType);
  const typeWords = type ? resourceTypeLabel(type) : "setting";
  const saved = names[naturalKey]?.name?.trim();
  if (saved && !holdsObjectId(saved)) return `${saved} (${typeWords})`;
  // A tenant-wide setting is stored under its type: its type is its name.
  if (type && naturalKey === type) return typeWords.replace(/^./, (letter) => letter.toUpperCase());
  const index = naturalKey.indexOf(":");
  const fromKey = index === -1 ? naturalKey : naturalKey.slice(index + 1).replaceAll(":", " · ");
  if (fromKey && !holdsObjectId(fromKey)) return `${fromKey} (${typeWords})`;
  return `Unnamed ${typeWords}`;
}

/** A resource or a relationship edge ("parent|family|target") in words. */
export function namedSubject(naturalKey: string, names: NamedKeys = {}, resourceType?: string | null): string {
  const [parent, family, target] = naturalKey.split("|");
  if (family && target) {
    return `${namedResource(target, names)} as ${FAMILY_WORDS[family] ?? family} of ${namedResource(parent, names)}`;
  }
  return namedResource(naturalKey, names, resourceType);
}

/** Issue #447: the types a finished backup did not read in full, from the job's
 *  result. Empty for any other job. */
export function jobIncompleteTypes(job: { status: string; result?: unknown }): string[] {
  if (job.status !== "succeeded") return [];
  const result = job.result as { partial?: unknown; incompleteTypes?: unknown } | null | undefined;
  if (!result || result.partial !== true || !Array.isArray(result.incompleteTypes)) return [];
  return result.incompleteTypes
    .map((entry) => (entry && typeof entry === "object" ? (entry as { type?: unknown }).type : null))
    .filter((type): type is string => typeof type === "string" && type.length > 0);
}

/** The status a person reads: a finished backup with gaps is "partial". */
export function jobDisplayStatus(job: { status: string; result?: unknown }): string {
  return jobIncompleteTypes(job).length ? "partial" : job.status;
}

// Content backups by workload, as Microsoft names them: the full name, a short name for
// one-line lists, the service each sits under, and what one of its items is called.
export const CONTENT_WORKLOADS: Record<string, { name: string; short: string; service: string; item: [string, string] }> = {
  "exchange-mail": { name: "Mail, calendars and contacts", short: "mail", service: "Exchange", item: ["mailbox", "mailboxes"] },
  "group-conversations": { name: "Group conversations", short: "group conversations", service: "Exchange", item: ["group", "groups"] },
  onedrive: { name: "OneDrive files", short: "OneDrive files", service: "SharePoint", item: ["OneDrive", "OneDrives"] },
  sharepoint: { name: "SharePoint document libraries", short: "SharePoint libraries", service: "SharePoint", item: ["library", "libraries"] },
  "sharepoint-sites": { name: "SharePoint sites, lists and files", short: "SharePoint sites", service: "SharePoint", item: ["site", "sites"] },
  teams: { name: "Teams, channels and tabs", short: "Teams", service: "Teams", item: ["team", "teams"] },
  planner: { name: "Planner plans and tasks", short: "Planner", service: "Teams", item: ["plan", "plans"] },
};

/** A kind a backup did not read in full, in words: a setting type, a service workload or a content workload. */
export function incompleteTypeLabel(type: string): string {
  if (type.startsWith("workload:")) return workloadLabel(type.slice("workload:".length));
  if (!type.startsWith("content:")) return resourceTypeLabel(type);
  const workload = type.slice("content:".length);
  return CONTENT_WORKLOADS[workload]?.short ?? `${resourceTypeLabel(workload)} content`;
}

/** "Not backed up: Intune tenant settings" — the gaps of a partial backup as one line. */
export function incompleteTypesLine(types: string[]): string {
  if (!types.length) return "";
  const named = types.slice(0, 3).map((type) => incompleteTypeLabel(type));
  const more = types.length - named.length;
  return `Not backed up: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** A failed job's error as one short plain line for a list; the raw text is on the job page, behind "Show details". */
export function jobErrorLine(error: unknown): string {
  return plainError(error).cause;
}
