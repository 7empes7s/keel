// Names, not ids, on a job's page. The server looks up the saved name of each key
// (lib/saved-names.ts); these helpers turn a key into words with that name and never
// return text that holds an object id. Keys and ids stay in Technical details.
import { edgeKeyType } from "@/lib/app-names";
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

/** A failed job's error as one line for a list; an error that holds an id is not shown. */
export function jobErrorLine(error: unknown): string {
  const first = String(error ?? "").split("\n")[0].replace(/^[A-Za-z]*Error:\s*/, "").trim();
  if (!first || holdsObjectId(first)) return "It stopped with an error. Open the job to see what went wrong.";
  return first;
}
