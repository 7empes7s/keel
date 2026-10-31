// Field-level difference between a drift row's baseline (before) and observed (after)
// payloads, so the operator reads what changed instead of scanning two JSON blobs.
// Objects are walked by key; arrays and scalars compare as whole values, because an
// index-by-index diff of a reordered list reports every element as changed.
// Empty against missing and list order are not changes, and credential values read
// as hidden (engine/safety/diffHygiene.mjs, shared by every diff view).
import { isEmptyValue, maskCredentials, sameForDiff } from "../../engine/safety/diffHygiene.mjs";

export type FieldChange =
  | { path: string; kind: "changed"; before: unknown; after: unknown }
  | { path: string; kind: "added"; after: unknown }
  | { path: string; kind: "removed"; before: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function diffPayloads(before: unknown, after: unknown, limit = 200): FieldChange[] {
  const changes: FieldChange[] = [];

  function walk(a: unknown, b: unknown, path: string) {
    if (changes.length >= limit) return;
    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) {
        const child = path ? `${path}.${key}` : key;
        if (!(key in b)) { if (!isEmptyValue(a[key])) changes.push({ path: child, kind: "removed", before: maskCredentials(a[key], child) }); }
        else if (!(key in a)) { if (!isEmptyValue(b[key])) changes.push({ path: child, kind: "added", after: maskCredentials(b[key], child) }); }
        else walk(a[key], b[key], child);
        if (changes.length >= limit) return;
      }
      return;
    }
    if (!sameForDiff(a, b)) changes.push({ path: path || "(value)", kind: "changed", before: maskCredentials(a, path), after: maskCredentials(b, path) });
  }

  // A whole-resource add or remove has one side null: say so once rather than
  // listing every field as added or removed.
  if (before === null || before === undefined || after === null || after === undefined) return [];
  walk(before, after, "");
  return changes;
}

export function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value, null, 2) ?? String(value);
}
