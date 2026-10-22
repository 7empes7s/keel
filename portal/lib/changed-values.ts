// The setting that changed, with its value before and after, in words. Shared by the
// Activity panel and Compare, so a value reads the same on both. Pure, so the UI
// harness and the unit tests use the real code.
import { entryWords, fieldWords, valueWords } from "@/lib/changes-view";
import { holdsObjectId, replaceObjectIds } from "@/lib/object-ids";
import { resourceTypeLabel } from "@/lib/presentation";

export type ChangeKind = "changed" | "added" | "removed";

export interface ChangedField {
  path: string;
  before: unknown;
  after: unknown;
}

/** One object that changed, with the settings that differ. */
export interface ChangedObject {
  name: string;
  resourceType: string;
  change: ChangeKind;
  fields: ChangedField[];
  // Every setting that differs; more than `fields` when the list was cut.
  fieldsTotal: number;
}

/** What a job or an audit entry changed, as GET /api/activity/changes serves it. */
export interface ActivityChanges {
  // backup: this backup against the one before it. rollback: what a roll back puts
  // back. restore: the restored backup against the last backup before the restore.
  // found: a change Keel found against the approved setup.
  basis: "backup" | "rollback" | "restore" | "found";
  // How the two sides read: "Before", "After" and the like.
  sides: { before: string; after: string };
  // One plain sentence on what the two sides are.
  about: string;
  changes: ChangedObject[];
  // Every object that differs; more than `changes` when the list was cut.
  total: number;
  // Ids in the values, named as the backups name them (lower-case id to name).
  names: Record<string, string>;
  // The two backups, for "See every difference" on Compare.
  compare: { from: string; to: string } | null;
}

/** An object's name, or a plain stand-in when its key is an id or a composed key. */
export function objectName(naturalKey: string, resourceType: string, name?: string | null): string {
  const saved = name?.trim();
  if (saved && !holdsObjectId(saved)) return saved;
  const rest = naturalKey.slice(naturalKey.indexOf(":") + 1);
  return !rest || holdsObjectId(rest) || /[a-z][A-Za-z]+:/.test(rest) ? `An unnamed ${resourceTypeLabel(resourceType)}` : rest;
}

export const CHANGE_LABELS: Record<ChangeKind, string> = { changed: "Changed", added: "Added", removed: "Removed" };

/** A value with ids read as the names Keel has for them; an id with no name is said so. */
export function readableValue(value: unknown, names: Readonly<Record<string, string>> = {}): unknown {
  if (typeof value === "string") {
    if (value === "<id>") return "an object Keel could not name";
    const ref = /^ref:([A-Za-z]+):(.+)$/.exec(value);
    if (ref) return `${ref[2]} (${resourceTypeLabel(ref[1])})`;
    if (value === "ref:unresolved") return "an object Keel could not name";
    // Exchange writes addresses with their type ("smtp:a@b.example"); the type reads after.
    const address = /^(smtp|sip|x500|eum):(.+)$/i.exec(value);
    if (address) return `${address[2]} (${address[1].toUpperCase()} address)`;
    return replaceObjectIds(value, (id) => names[id.toLowerCase()] ?? "an object Keel has no name for");
  }
  if (Array.isArray(value)) return value.map((entry) => readableValue(entry, names));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, readableValue(inner, names)]));
  return value;
}

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isScalar = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);

export interface ValueLine {
  // The setting inside the value, in words ("State", "Conditions › users"), or "" for the value itself.
  label: string;
  text: string;
}

export const MAX_VALUE_LINES = 12;

/**
 * A value as lines a person can read: a plain value is one line; an object or a list
 * of objects is one line per setting inside it ("Conditions › users: All users"), so
 * nothing hides behind "3 settings". Lists of objects number their entries. At most
 * `limit` lines; `more` counts the rest.
 */
export function valueLines(value: unknown, names: Readonly<Record<string, string>> = {}, limit = MAX_VALUE_LINES): { lines: ValueLine[]; more: number } {
  const readable = readableValue(value, names);
  const lines: ValueLine[] = [];
  let count = 0;
  const push = (label: string, inner: unknown) => {
    count += 1;
    if (lines.length < limit) lines.push({ label, text: valueWords(inner) });
  };
  const walk = (inner: unknown, path: string[]) => {
    const label = path.length ? path.map((part, index) => (/^#\d+$/.test(part) ? part : index === 0 ? fieldWords(part) : fieldWords(part).toLowerCase())).join(" › ") : "";
    if (isScalar(inner) || inner === undefined) { push(label, inner); return; }
    if (Array.isArray(inner)) {
      if (inner.length === 0 || inner.every(isScalar)) { push(label, inner); return; }
      // A list of objects (grants, rules, members) reads one line per entry, by its name.
      if (inner.every(isPlain)) { for (const entry of inner) { count += 1; if (lines.length < limit) lines.push({ label, text: entryWords(entry) }); } return; }
      inner.forEach((entry, index) => walk(entry, [...path, `#${index + 1}`]));
      return;
    }
    const keys = Object.keys(inner as Record<string, unknown>).sort();
    if (!keys.length) { push(label, "none"); return; }
    for (const key of keys) walk((inner as Record<string, unknown>)[key], [...path, key]);
  };
  if (isScalar(readable) || readable === undefined || (Array.isArray(readable) && (readable.length === 0 || readable.every(isScalar)))) {
    return { lines: [{ label: "", text: valueWords(readable) }], more: 0 };
  }
  walk(readable, []);
  return { lines, more: Math.max(0, count - lines.length) };
}

/** The value as one line of text, for a spreadsheet or a screen reader. */
export function valueText(value: unknown, names: Readonly<Record<string, string>> = {}): string {
  const { lines, more } = valueLines(value, names);
  const text = lines.map((line) => (line.label ? `${line.label}: ${line.text}` : line.text)).join("; ");
  return more ? `${text}; and ${more} more` : text;
}

/** Whether a value needs several lines (an object or a list of objects). */
export function isStructured(value: unknown): boolean {
  return isPlain(value) || (Array.isArray(value) && value.some((entry) => !isScalar(entry)));
}

/** "3 settings changed" / "Added with 5 settings" for a changed object, as one line. */
export function changeLine(change: ChangedObject): string {
  const settings = (count: number) => `${count.toLocaleString("en-GB")} ${count === 1 ? "setting" : "settings"}`;
  if (change.change === "added") return change.fieldsTotal ? `Added, with ${settings(change.fieldsTotal)}` : "Added";
  if (change.change === "removed") return change.fieldsTotal ? `Removed; it had ${settings(change.fieldsTotal)}` : "Removed";
  return change.fieldsTotal ? `${settings(change.fieldsTotal)} changed` : "Only settings Microsoft sets itself changed";
}

/** Which activity rows can say what they changed, and the address that tells it. */
export function changesQuery(row: { job?: { id: string; kind: string; status: string; params: unknown } | null; entry?: { subject: unknown } | null }): string | null {
  const job = row.job;
  if (job) {
    const params = (job.params ?? {}) as Record<string, unknown>;
    if ((job.kind === "collect" || job.kind === "backup") && job.status === "succeeded") return `job=${encodeURIComponent(job.id)}`;
    if (job.kind === "remediate" && Array.isArray(params.driftIds) && params.driftIds.length) return `job=${encodeURIComponent(job.id)}`;
    if (job.kind === "restore" && typeof params.compensates !== "string" && (typeof params.artifactId === "string" || (typeof params.snapshotId === "string" && Array.isArray(params.selection)))) return `job=${encodeURIComponent(job.id)}`;
    return null;
  }
  const subject = (row.entry?.subject ?? {}) as Record<string, unknown>;
  return typeof subject.driftId === "string" && subject.driftId ? `drift=${encodeURIComponent(subject.driftId)}` : null;
}
