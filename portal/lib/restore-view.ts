import type { RiskTone } from "@/lib/menu-status";
import type { Day } from "@/lib/date-range";
import { fieldWords } from "@/lib/changes-view";
import { displayEnum } from "@/lib/presentation";
import { typeName } from "@/lib/protect-view";
import type { RestoreChange, RestoreChangesData } from "@/lib/restore-changes";
import type { JobRecord, SnapshotOption } from "@/lib/portal-jobs";
import { jobStatusSentence } from "@/lib/sentences";

// Plain words for the Restore page (redesign rules 2, 3 and 5): the point in time, the
// one-sentence verdict, and how each change reads. Pure, so tests drive them directly.

// Rule 3: a person reads "sign-in rule", not "Conditional Access policy". The Microsoft
// term stays in the row's tooltip.
const PLAIN_TYPES: Record<string, string> = {
  conditionalAccessPolicy: "Sign-in rule",
  namedLocation: "Trusted location",
  authenticationStrength: "Sign-in strength",
  authenticationStrengthPolicy: "Sign-in strength",
  transportRule: "Mail flow rule",
};

export function plainType(type: string): string {
  return PLAIN_TYPES[type] ?? typeName(type);
}

// A Graph object id (GUID). Many types are stored under their id, or carry one inside
// the key, so a key alone is never shown when it holds one (rule: names, not ids).
const OBJECT_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function holdsId(text: string): boolean {
  return OBJECT_ID.test(text);
}

/** What each saved setting is called, by its stored key: the name the backup holds,
 * else the readable part of the key, else "Unnamed <type>". */
export interface NameEntry { name: string; resourceType: string }
export type NameBook = ReadonlyMap<string, NameEntry>;

export function nameBook(resources: { naturalKey: string; resourceType: string; name?: string | null }[]): NameBook {
  return new Map(resources.map((resource) => [resource.naturalKey, { name: settingName(resource), resourceType: resource.resourceType }]));
}

export function settingName(resource: { naturalKey: string; resourceType: string; name?: string | null }): string {
  const name = resource.name?.trim();
  if (name && !holdsId(name)) return name;
  // A tenant-wide setting is stored under its type: its plain type is its name.
  if (resource.naturalKey === resource.resourceType) return plainType(resource.resourceType);
  const fromKey = keyName(resource.naturalKey);
  if (!holdsId(fromKey)) return fromKey;
  return `Unnamed ${plainType(resource.resourceType).toLowerCase()}`;
}

function keyName(naturalKey: string): string {
  const index = naturalKey.indexOf(":");
  return index === -1 ? naturalKey : naturalKey.slice(index + 1).replaceAll(":", " · ");
}

/** The name part of a stored key: "group:Finance" → "Finance". With a name book, the
 * name the backup holds; a key that is only an id never shows. */
export function itemName(naturalKey: string, names?: NameBook): string {
  const known = names?.get(naturalKey);
  if (known) return known.name;
  const fromKey = keyName(naturalKey);
  if (!holdsId(fromKey)) return fromKey;
  const index = naturalKey.indexOf(":");
  return index === -1 ? "Unnamed setting" : `Unnamed ${plainType(naturalKey.slice(0, index)).toLowerCase()}`;
}

/** When a backup was taken: completed time, else start time. */
export function takenAt(snapshot: Pick<SnapshotOption, "completedAt" | "startedAt">): string | null {
  return snapshot.completedAt ?? snapshot.startedAt;
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const TIME_FORMAT = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const SHORT_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "Thu 2 Oct 2026" */
export function dayWords(value: string | null): string {
  return value ? DAY_FORMAT.format(new Date(value)) : "an unknown day";
}

/** "09:12 UTC" */
export function timeWords(value: string | null): string {
  return value ? `${TIME_FORMAT.format(new Date(value))} UTC` : "unknown time";
}

/** "2 Oct, 09:12" */
export function shortWhen(value: string | null): string {
  return value ? `${SHORT_FORMAT.format(new Date(value))}, ${TIME_FORMAT.format(new Date(value))}` : "an unknown time";
}

/** The age of a backup in words: "Today", "Yesterday", "14 days old". */
export function backupAge(value: string | null, now: string): string {
  if (!value) return "Age not known";
  const days = Math.floor((Date.parse(now.slice(0, 10)) - Date.parse(value.slice(0, 10))) / 86_400_000);
  if (days <= 0) return "Taken today";
  if (days === 1) return "Taken yesterday";
  return `${days} days old`;
}

/** Days that have at least one backup, for the calendar's marks. */
export function backupDays(snapshots: SnapshotOption[]): Set<Day> {
  return new Set(snapshots.map(takenAt).filter((value): value is string => Boolean(value)).map((value) => value.slice(0, 10)));
}

/** Backups taken on one day, newest first. */
export function backupsOn(snapshots: SnapshotOption[], day: Day): SnapshotOption[] {
  return snapshots
    .filter((snapshot) => takenAt(snapshot)?.slice(0, 10) === day)
    .sort((a, b) => (takenAt(b) ?? "").localeCompare(takenAt(a) ?? ""));
}

/** The backup a chosen day means: the newest that day, else the newest before it, else
 * the oldest after it. `exact` says whether the day itself has one. */
export function backupForDay(snapshots: SnapshotOption[], day: Day): { snapshot: SnapshotOption; exact: boolean } | null {
  const that = backupsOn(snapshots, day)[0];
  if (that) return { snapshot: that, exact: true };
  const sorted = [...snapshots].sort((a, b) => (takenAt(b) ?? "").localeCompare(takenAt(a) ?? ""));
  const before = sorted.find((snapshot) => (takenAt(snapshot) ?? "").slice(0, 10) < day);
  const fallback = before ?? sorted[sorted.length - 1];
  return fallback ? { snapshot: fallback, exact: false } : null;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

/** The page's one sentence for the choose step (at most 25 words). */
export function restoreVerdict({ chosen, isNewest, changes }: {
  chosen: string | null;
  isNewest: boolean;
  changes: RestoreChangesData | null;
}): { text: string; tone: "good" | "attention" } {
  const day = dayWords(chosen);
  if (!changes) return { text: `Restoring to the backup of ${day}. KEEL could not compare it with now, so choose what to put back.`, tone: "attention" };
  const count = changes.changes.length + changes.more;
  if (count > 0) {
    return { text: `${plural(count, "setting")} changed since the backup of ${day}. Undo the ones nobody expected.`, tone: "attention" };
  }
  if (isNewest && changes.earlier?.count) {
    return { text: `${plural(changes.earlier.count, "setting")} changed just before your newest backup. Pick an earlier day to undo them.`, tone: "attention" };
  }
  return { text: `Nothing has changed since the backup of ${day}. Choose anything you want to put back.`, tone: "good" };
}

/** Tone of a row: something gone is urgent, something changed is worth a look. */
export function changeTone(change: RestoreChange | undefined): RiskTone | null {
  if (!change) return null;
  return change.kind === "deleted" ? "urgent" : "soon";
}

/** What changed, in one line: "State: on → report only, and 2 more". */
export function changeLine(change: RestoreChange): string {
  if (change.kind === "deleted") return "Deleted after this backup. Undo brings it back.";
  const first = change.fields[0];
  if (!first) return `${plural(change.fieldCount, "setting")} changed.`;
  const rest = change.fieldCount - 1;
  return `${fieldWords(first.path)}: ${first.before} → ${first.after}${rest > 0 ? `, and ${rest} more` : ""}`;
}

/** Who changed it, as far as the audit log tells. */
export function whoWords(change: RestoreChange): string {
  if (!change.who) return "Who: not in the audit log";
  const names = change.who.names.length > 2 ? `${change.who.names.slice(0, 2).join(", ")} and others` : change.who.names.join(" and ");
  return change.who.certain ? `By ${names}` : `Probably ${names}`;
}

/** When, as a window between two backups. */
export function whenWords(change: RestoreChange): string {
  return `between ${shortWhen(change.sameUntil)} and ${shortWhen(change.seenAt)}`;
}

/** How much a wrong restore of this item could break, in words. */
export function impactWords(blastRadius: string): string {
  return displayEnum("blastRadius", blastRadius);
}

export const IMPACT_ORDER = ["tenant-lockout", "access-affecting", "cosmetic"];

export const IMPACT_ABOUT: Record<string, string> = {
  "tenant-lockout": "A wrong restore here could stop admins signing in",
  "access-affecting": "Changes who can reach apps, data or devices",
  cosmetic: "Names, labels and looks; nobody loses access",
};

const JOB_TONES: Record<string, RiskTone> = { failed: "urgent", cancelled: "soon", running: "low", queued: "low", succeeded: "fine" };
const JOB_WORDS: Record<string, string> = { failed: "failed", cancelled: "cancelled", running: "running", queued: "waiting", succeeded: "finished" };

/** The "Last restore" tile: the newest restore job, in words, linked to its page. */
export function lastRestoreTile(jobs: JobRecord[], now: string): { label: string; detail: string; href: string; tone: RiskTone } | null {
  const job = jobs.find((entry) => entry.kind === "restore");
  if (!job) return null;
  const params = (job.params ?? {}) as Record<string, unknown>;
  const what = params.mode === "enforce" ? "Restore" : "Check";
  return {
    label: `${what} ${JOB_WORDS[job.status] ?? "status unknown"}`,
    detail: `${jobStatusSentence(job, now)}.`,
    href: `/jobs/${job.id}`,
    tone: JOB_TONES[job.status] ?? "low",
  };
}

/** "Block legacy auth (sign-in rule)": a setting by its name and plain type. */
export function plainLabel(naturalKey: string, names?: NameBook): string {
  const known = names?.get(naturalKey);
  if (known) {
    const type = plainType(known.resourceType);
    return known.name === type || known.name.startsWith("Unnamed ") ? known.name : `${known.name} (${type.toLowerCase()})`;
  }
  const index = naturalKey.indexOf(":");
  if (index === -1) return itemName(naturalKey);
  const name = itemName(naturalKey);
  return name.startsWith("Unnamed ") ? name : `${name} (${plainType(naturalKey.slice(0, index)).toLowerCase()})`;
}

/** What a check says it would do to one setting, in words; the coded reason stays in
 * Technical details. */
export function plannedWords(reason: string | undefined): string {
  if (!reason) return "will be put back";
  if (/unchanged|already/i.test(reason)) return "already as in the backup; nothing to write";
  const count = /(\d+) propert/i.exec(reason);
  if (count) return `${plural(Number(count[1]), "setting")} go back`;
  return "will be put back";
}
