// One change, setting by setting: what the approved setup (or the previous read) holds
// next to what the tenant holds now. Pure, so the panel, the UI harness and the unit
// tests share it. Settings that differ come first; settings that match are counted and
// listed apart. A list (grants, members, rules) compares entry by entry, so "one app
// lost its access" reads as that, not as two blobs.
import { entryWords, fieldWords, valueWords } from "@/lib/changes-view";
import { readableValue } from "@/lib/changed-values";
import { isEmptyValue, maskCredentials, sameForDiff } from "../../engine/safety/diffHygiene.mjs";

export type Diff = "changed" | "added" | "removed" | "same" | "unknown";

export interface EntryDiff {
  diff: Exclude<Diff, "unknown">;
  text: string;
  // For a changed entry: how it read before.
  was?: string;
}

export interface SettingRow {
  path: string;
  // The part of the item the setting sits in ("Conditions"), or "General".
  section: string;
  // The setting inside its section, in words ("Users › exclude groups").
  label: string;
  diff: Diff;
  // Each side in words; null when the side does not hold the setting.
  before: string | null;
  after: string | null;
  // Set when the setting is a list: each entry and whether it was added or removed.
  entries: EntryDiff[] | null;
  // What an empty side reads; "Not set" when not given.
  absent?: string;
}

export interface Comparison {
  rows: SettingRow[];
  counts: Record<Diff, number>;
  // Rows that differ (everything but "same").
  differing: number;
}

export const DIFF_WORDS: Record<Diff, string> = { changed: "Changed", added: "Added", removed: "Removed", same: "Same", unknown: "Now set" };

const NOISE = /^(@|id$)|^(created|lastModified|modified|deleted|renewed)DateTime$/;
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
// Empty against missing and list order are not differences (engine/safety/diffHygiene.mjs).
const same = (a: unknown, b: unknown) => sameForDiff(a, b);

/** Every setting in a copy by path. Objects are walked; lists and plain values are
 *  settings in their own right. Ids and the times Microsoft stamps are left out. */
function settings(payload: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (value: unknown, path: string[]) => {
    if (isPlain(value) && (Object.keys(value).length || !path.length)) {
      for (const key of Object.keys(value)) {
        if (NOISE.test(key)) continue;
        walk(value[key], [...path, key]);
      }
      return;
    }
    out.set(path.length ? path.join(".") : "(value)", value);
  };
  walk(payload, []);
  return out;
}

function entryKey(entry: unknown): string {
  if (isPlain(entry) && typeof entry.id === "string" && entry.id) return `id:${entry.id}`;
  return JSON.stringify(entry);
}

/** Two lists entry by entry: removed first, then added, then changed, then the same. */
export function listDiff(before: unknown[], after: unknown[], names: Readonly<Record<string, string>> = {}): EntryDiff[] {
  const words = (entry: unknown) => entryWords(readableValue(entry, names), names);
  const was = new Map(before.map((entry) => [entryKey(entry), entry]));
  const now = new Map(after.map((entry) => [entryKey(entry), entry]));
  const removed: EntryDiff[] = [];
  const added: EntryDiff[] = [];
  const changed: EntryDiff[] = [];
  const kept: EntryDiff[] = [];
  for (const [key, entry] of was) if (!now.has(key)) removed.push({ diff: "removed", text: words(entry) });
  for (const [key, entry] of now) {
    const old = was.get(key);
    if (old === undefined) added.push({ diff: "added", text: words(entry) });
    else if (!same(old, entry)) changed.push({ diff: "changed", text: words(entry), was: words(old) });
    else kept.push({ diff: "same", text: words(entry) });
  }
  return [...removed, ...added, ...changed, ...kept];
}

function sideWords(value: unknown, names: Readonly<Record<string, string>>): string {
  if (Array.isArray(value) && value.length && value.every(isPlain)) return value.map((entry) => entryWords(readableValue(entry, names), names)).join("; ");
  if (isPlain(value) && !Object.keys(value).length) return "none";
  return valueWords(readableValue(value, names), names);
}

function placed(path: string): { section: string; label: string } {
  const parts = path.split(".");
  if (parts.length === 1) return { section: "General", label: fieldWords(path) };
  const rest = fieldWords(parts.slice(1).join("."));
  return { section: fieldWords(parts[0]), label: rest.charAt(0).toUpperCase() + rest.slice(1) };
}

/**
 * Compare two copies of one item. `before` null means the item is new (or, with
 * `beforeKnown` false, that the earlier copy was not kept); `after` null means it is gone.
 * A new or removed item lists its own settings, so the person sees what it holds.
 */
export function compareSettings(before: unknown, after: unknown, names: Readonly<Record<string, string>> = {}, beforeKnown = true): Comparison {
  const counts: Record<Diff, number> = { changed: 0, added: 0, removed: 0, same: 0, unknown: 0 };
  const hasBefore = before !== null && before !== undefined;
  const hasAfter = after !== null && after !== undefined;
  if (!hasBefore && !hasAfter) return { rows: [], counts, differing: 0 };
  // Compared on the stored values, shown with credential values (password hints and
  // the like) hidden, so a changed secret still reads as changed.
  const was = hasBefore ? settings(before) : new Map<string, unknown>();
  const now = hasAfter ? settings(after) : new Map<string, unknown>();
  const wasShown = hasBefore ? settings(maskCredentials(before)) : new Map<string, unknown>();
  const nowShown = hasAfter ? settings(maskCredentials(after)) : new Map<string, unknown>();
  // A setting that is empty on its only side is no setting: "Not set -> not set" never shows.
  const paths = [...new Set([...was.keys(), ...now.keys()])].filter((path) => (was.has(path) && now.has(path)) || !isEmptyValue(was.has(path) ? was.get(path) : now.get(path)));
  const rows: SettingRow[] = paths.map((path) => {
    const inWas = was.has(path);
    const inNow = now.has(path);
    const old = was.get(path);
    const value = now.get(path);
    const diff: Diff = !hasBefore && !beforeKnown ? "unknown"
      : !inWas ? "added"
        : !inNow ? "removed"
          : same(old, value) ? "same" : "changed";
    const oldShown = wasShown.get(path);
    const valueShown = nowShown.get(path);
    const listy = Array.isArray(old) || Array.isArray(value);
    const entries = listy && diff !== "same" && diff !== "unknown"
      ? listDiff(Array.isArray(oldShown) ? oldShown : [], Array.isArray(valueShown) ? valueShown : [], names)
      : null;
    return {
      path, ...placed(path), diff,
      before: inWas ? sideWords(oldShown, names) : null,
      after: inNow ? sideWords(valueShown, names) : null,
      // A list whose entries are only plain words reads fine as two sides when short.
      entries: entries && entries.length ? entries : null,
    };
  });
  rows.sort((a, b) => (a.section === b.section ? a.path.localeCompare(b.path) : a.section === "General" ? -1 : b.section === "General" ? 1 : a.section.localeCompare(b.section)));
  for (const row of rows) counts[row.diff] += 1;
  return { rows, counts, differing: rows.length - counts.same };
}

/** One setting already known to differ (Compare, Activity), as a comparison row. */
export function fieldRow(path: string, before: unknown, after: unknown, change: "changed" | "added" | "removed", names: Readonly<Record<string, string>> = {}): SettingRow {
  const listy = Array.isArray(before) || Array.isArray(after);
  const entries = listy ? listDiff(change === "added" || !Array.isArray(before) ? [] : before, change === "removed" || !Array.isArray(after) ? [] : after, names) : null;
  return {
    path, section: "General", label: fieldWords(path), diff: change,
    before: change === "added" ? null : sideWords(before, names),
    after: change === "removed" ? null : sideWords(after, names),
    entries: entries && entries.length ? entries : null,
  };
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;

/** "3 settings differ: 1 changed, 1 added and 1 removed." */
export function comparisonSentence(comparison: Comparison, against: string): string {
  const { counts, differing } = comparison;
  if (!comparison.rows.length) return "Keel holds no settings for this item.";
  if (counts.unknown) return `${plural(counts.unknown, "setting is", "settings are")} set now. Keel did not keep the earlier copy, so nothing is shown as removed.`;
  if (!differing) return `Every setting matches ${against}.`;
  if (wholeItem(comparison) === "added") return `Not in ${against}. It holds ${plural(counts.added, "setting", "settings")}.`;
  if (wholeItem(comparison) === "removed") return `In ${against} but no longer in the tenant. It held ${plural(counts.removed, "setting", "settings")}.`;
  const kinds = (["changed", "added", "removed"] as const).filter((kind) => counts[kind]);
  if (kinds.length === 1) return `${plural(differing, "setting", "settings")} ${kinds[0]} since ${against}.`;
  const parts = ([["changed", "changed"], ["added", "added"], ["removed", "removed"]] as const)
    .filter(([kind]) => counts[kind])
    .map(([kind, word]) => `${counts[kind].toLocaleString("en-GB")} ${word}`);
  const list = parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `${plural(differing, "setting differs", "settings differ")} from ${against}: ${list}.`;
}

/** "added" when every setting is new (the whole item is new), "removed" when every
 *  setting is gone (the whole item is gone), else null. A whole item reads as one line
 *  with its settings folded away, never as a before/after row per setting. */
export function wholeItem(comparison: Pick<Comparison, "rows" | "counts">): "added" | "removed" | null {
  if (!comparison.rows.length) return null;
  if (comparison.counts.added === comparison.rows.length) return "added";
  if (comparison.counts.removed === comparison.rows.length) return "removed";
  return null;
}

/** The word an empty side reads: "Not known" when the earlier copy was not kept,
 *  else "Not set" (or the row's own word, such as "Not in the team"). */
export function absentWords(row: Pick<SettingRow, "diff" | "absent">, which: "before" | "after"): string {
  if (row.absent) return row.absent;
  return which === "before" && row.diff === "unknown" ? "Not known" : "Not set";
}
