// Client-safe words for objects named by engine/insights/names.mjs (redesign A2, IN-NAMES).

export type ObjectStatus = "found" | "deleted" | "unknown";

/** What a page needs about one object besides its name: no ids except under Technical details. */
export interface ObjectFacts {
  status: ObjectStatus;
  // When the first complete backup that no longer held it started (ISO), for `deleted`.
  deletedSince: string | null;
  // When the newest backup that held it started (ISO), or null.
  lastSeenAt: string | null;
  // The Microsoft object id from the backup, for Technical details only.
  objectId: string | null;
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "Deleted since 3 Oct 2026", or "Deleted" when the date is unknown. */
export function deletedSinceWords(since: string | null): string {
  const date = since ? new Date(since) : null;
  return date && !Number.isNaN(date.valueOf()) ? `Deleted since ${DAY.format(date)}` : "Deleted";
}

/**
 * A title such as "Finance (group)" or "Unnamed group" as its two parts, so a page can
 * style the name and the kind apart. A title with no kind is all name.
 */
export function splitObjectTitle(title: string): { name: string | null; type: string | null } {
  const unnamed = /^Unnamed (.+)$/.exec(title);
  if (unnamed) return { name: null, type: unnamed[1] };
  const named = /^(.*\S) \(([^()]+)\)$/.exec(title);
  if (named) return { name: named[1], type: named[2] };
  return { name: title, type: null };
}
