import type { BadgeTone } from "@/components/ui/badge";
import { plainError } from "@/lib/error-words";
import { bytesWords } from "@/lib/compare-view";

// What's protected, content backups: what the nightly content backup holds per
// workload, how its last run went, and which names it read. Pure: the loader is
// lib/content-backups.ts, which reads engine/coverage/serviceBackups.mjs.

/** One stored workload code, as loadServiceBackups(...).content[] returns it. */
export interface ContentBackup {
  workload: string;
  latest: {
    id: string; outcome: string; at: string | null; reasons: string[];
    // "name: reason" for what Microsoft 365 holds but Keel cannot read, and is not a failure.
    skipped?: string[];
    namePrefix: string | null;
  } | null;
  lastGood: { id: string; from: string | null; at: string | null; items: number; bytes: number } | null;
  stored: { items: number; versions: number; containers: number; bytes: number; storedBytes: number; newestAt: string | null } | null;
}

export interface ContentBackupsData {
  generatedAt: string;
  content: ContentBackup[];
}

/** A row on the page: one collector, and the stored workload codes it writes. */
export interface ContentWorkload {
  code: string;
  name: string;
  service: string;
  holds: string[];
  // What the scope prefix narrows ("mailboxes"); null when the collector reads everything.
  scoped: string | null;
  container: { one: string; many: string };
  what: string;
}

// In the order the nightly run reads them (engine/content/collectors.mjs).
export const CONTENT_WORKLOADS: ContentWorkload[] = [
  { code: "exchange-mail", name: "Mail", service: "Exchange Online", holds: ["exchange-mail"], scoped: "mailboxes",
    container: { one: "mailbox", many: "mailboxes" }, what: "Folders, messages, calendars and contacts, archive mailboxes included" },
  { code: "onedrive", name: "OneDrive files", service: "OneDrive", holds: ["onedrive"], scoped: "OneDrives",
    container: { one: "OneDrive", many: "OneDrives" }, what: "Every file with its versions" },
  { code: "sharepoint-sites", name: "SharePoint sites and files", service: "SharePoint", holds: ["sharepoint-sites", "sharepoint"], scoped: "sites",
    container: { one: "site", many: "sites" }, what: "Sites, lists and list items, document libraries and files with versions, site permissions" },
  { code: "teams", name: "Teams structure", service: "Teams", holds: ["teams"], scoped: null,
    container: { one: "team", many: "teams" }, what: "Teams, channels, members, tabs and apps. Channel files are kept with the team's SharePoint site" },
  { code: "planner", name: "Planner and group conversations", service: "Planner", holds: ["planner", "group-conversations"], scoped: "groups",
    container: { one: "plan or group", many: "plans and groups" }, what: "Plans, buckets and tasks with details; group conversations, posts and attachments" },
];

const count = (value: number) => value.toLocaleString("en-GB");
const plural = (value: number, one: string, many: string) => `${count(value)} ${value === 1 ? one : many}`;

// A nightly run is out of date once it is two days old.
const STALE_MS = 2 * 24 * 60 * 60 * 1000;

export type ContentState = "backed-up" | "partial" | "failed" | "stale" | "held" | "never";

export interface ContentRow {
  workload: ContentWorkload;
  items: number;
  versions: number;
  containers: number;
  bytes: number;
  storedBytes: number;
  newestAt: string | null;
  // The collector's own run (the workload code it records under).
  latest: ContentBackup["latest"];
  lastGood: ContentBackup["lastGood"];
  state: ContentState;
}

function rowState(latest: ContentBackup["latest"], items: number, now: string): ContentState {
  if (!latest) return items > 0 ? "held" : "never";
  if (latest.outcome === "failed") return "failed";
  if (latest.outcome !== "succeeded") return "partial";
  if (latest.at && Date.parse(now) - Date.parse(latest.at) > STALE_MS) return "stale";
  return "backed-up";
}

export function contentRows(data: ContentBackupsData, now: string = data.generatedAt): ContentRow[] {
  return CONTENT_WORKLOADS.map((workload) => {
    const held = data.content.filter((entry) => workload.holds.includes(entry.workload)).map((entry) => entry.stored).filter((stored) => stored !== null);
    const sum = (key: "items" | "versions" | "containers" | "bytes" | "storedBytes") => held.reduce((total, stored) => total + stored[key], 0);
    const newestAt = held.map((stored) => stored.newestAt).filter((at): at is string => Boolean(at)).sort().at(-1) ?? null;
    const own = data.content.find((entry) => entry.workload === workload.code);
    const items = sum("items");
    const latest = own?.latest ?? null;
    return {
      workload, items, versions: sum("versions"), containers: sum("containers"), bytes: sum("bytes"), storedBytes: sum("storedBytes"),
      newestAt, latest, lastGood: own?.lastGood ?? null, state: rowState(latest, items, now),
    };
  });
}

export const STATE_BADGE: Record<ContentState, { tone: BadgeTone; label: string }> = {
  "backed-up": { tone: "fine", label: "Backed up" },
  partial: { tone: "soon", label: "Partly backed up" },
  failed: { tone: "urgent", label: "Failed" },
  stale: { tone: "soon", label: "Out of date" },
  held: { tone: "neutral", label: "Held" },
  never: { tone: "neutral", label: "Not backed up yet" },
};

/** "932 items · 7.4 MB · in 2 sites". */
export function holdingLine(row: ContentRow): string {
  if (!row.items) return "Nothing stored yet";
  return [
    plural(row.items, "item", "items"),
    bytesWords(row.bytes),
    `in ${plural(row.containers, row.workload.container.one, row.workload.container.many)}`,
  ].join(" · ");
}

/** What the run reads for one workload, in words. `prefix` undefined: not recorded yet. */
export function scopeWords(workload: ContentWorkload, prefix: string | null | undefined): string {
  if (!workload.scoped) return prefix ? "Every team: Teams has no name filter" : "Every team in the tenant";
  if (prefix === undefined) return "Scope shown after the next nightly run";
  if (prefix === null) return `Every ${workload.container.one} in the tenant`;
  return `Only ${workload.scoped} whose names start with ${prefix}`;
}

/** The raw reasons of a run that did not finish, for "Show details". */
export function runReasons(row: ContentRow): string[] {
  return row.latest && row.latest.outcome !== "succeeded" ? row.latest.reasons : [];
}

// Skip reasons as the engine records them (engine/content/onedrives.mjs), in words.
const SKIP_WORDS: Record<string, { one: string; many: string }> = {
  "OneDrive locked in Microsoft 365": { one: "OneDrive Microsoft 365 has locked", many: "OneDrives Microsoft 365 has locked" },
};

/** The raw "name: reason" lines the last run skipped, for "Show details". */
export function runSkipped(row: ContentRow): string[] {
  return row.latest?.skipped ?? [];
}

/** What the last run skipped because Microsoft 365 does not let Keel read it; null when nothing. */
export function skippedLine(row: ContentRow): string | null {
  const skipped = runSkipped(row);
  if (!skipped.length) return null;
  const byReason = new Map<string, number>();
  for (const line of skipped) {
    const reason = line.slice(line.lastIndexOf(": ") + 2);
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  const parts = [...byReason].map(([reason, n]) => {
    const words = SKIP_WORDS[reason];
    return words ? plural(n, words.one, words.many) : `${count(n)} ${reason}`;
  });
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `Skipped ${list}. Keel cannot read ${skipped.length === 1 ? "it" : "them"}, so this is not counted as an error`;
}

/** Why the last run did not finish, or what the last good run stored. */
export function runLine(row: ContentRow): string | null {
  const { latest, lastGood } = row;
  if (!latest) return row.items ? "Stored before Keel recorded each run. The next nightly run is recorded here." : null;
  // The raw reasons stay behind "Show details" (runReasons); the line gets plain words.
  const reason = latest.reasons[0] ? `. ${plainError(latest.reasons[0]).cause}` : "";
  if (latest.outcome === "failed") return `Last run failed${reason}`;
  if (latest.outcome !== "succeeded") return `Last run could not read ${plural(latest.reasons.length || 1, "part", "parts")}${reason}`;
  if (lastGood && lastGood.id === latest.id) {
    return lastGood.items ? `Last run stored ${plural(lastGood.items, "new item or version", "new items or versions")} (${bytesWords(lastGood.bytes)})` : "Last run found nothing new";
  }
  return null;
}

/** The scope the newest recorded run read: a prefix, null for the whole tenant, undefined before any run is recorded. */
export function runScope(data: ContentBackupsData): string | null | undefined {
  const newest = data.content.map((entry) => entry.latest).filter((latest) => latest !== null)
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))[0];
  return newest ? newest.namePrefix : undefined;
}

/** The newest recorded run time across workloads. */
export function lastRunAt(rows: ContentRow[]): string | null {
  return rows.map((row) => row.latest?.at ?? null).filter((at): at is string => Boolean(at)).sort().at(-1) ?? null;
}

/** The section's answer, first. */
export function contentHeadline(rows: ContentRow[]): string {
  const items = rows.reduce((total, row) => total + row.items, 0);
  const bytes = rows.reduce((total, row) => total + row.bytes, 0);
  if (!items && rows.every((row) => !row.latest)) return "Keel has not backed up any content yet. The nightly content backup runs at 01:00 UTC.";
  const holding = rows.filter((row) => row.items > 0).length;
  const failing = rows.filter((row) => row.state === "failed" || row.state === "partial");
  const stale = rows.filter((row) => row.state === "stale");
  const lead = `Keel holds ${plural(items, "content item", "content items")} (${bytesWords(bytes)}) across ${plural(holding, "workload", "workloads")}.`;
  if (failing.length) return `${lead} The last run did not finish for ${failing.map((row) => row.workload.name).join(", ")}.`;
  if (stale.length) return `${lead} ${stale.map((row) => row.workload.name).join(", ")} ${stale.length === 1 ? "has" : "have"} not been backed up for over two days.`;
  if (rows.every((row) => row.state === "backed-up")) return `${lead} The last nightly run backed up all ${rows.length}.`;
  return lead;
}

/** The scope in one sentence, under the headline. */
export function scopeSentence(prefix: string | null | undefined): string | null {
  if (prefix === undefined) return null;
  if (prefix === null) return "Content is backed up for the whole tenant.";
  return `Content is backed up only for names starting with ${prefix}: mailboxes, OneDrives, sites and groups. Widening it to the whole tenant is a setting on the Keel server.`;
}

export const NOT_BACKED_UP = "Teams chat and channel messages are not backed up yet: Microsoft has to approve the Teams export API for this tenant first.";

/** Versions and disk use after deduplication, for the row's details. */
export function storageNote(row: ContentRow): string | null {
  if (!row.items) return null;
  const disk = `${bytesWords(row.storedBytes)} on disk after deduplication`;
  return row.versions > row.items ? `${plural(row.versions, "version", "versions")} held · ${disk}` : disk;
}
