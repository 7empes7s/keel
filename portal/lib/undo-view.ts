// The undo plan of a restore (roadmap task-70) in words. The engine's reasons carry
// codes ("concurrent-change: …") and natural keys; the panel shows these sentences and
// keeps every raw reason, key and id in its record layer.
import { resourceLabel } from "@/lib/presentation";

const FAMILY_WORDS: Record<string, string> = { member: "member", owner: "owner" };

/** A resource or a relationship edge ("parent|family|target") as a person reads it. */
export function undoSubject(naturalKey: string): string {
  const [parent, family, target] = naturalKey.split("|");
  if (family && target) return `${resourceLabel(target)} as ${FAMILY_WORDS[family] ?? family} of ${resourceLabel(parent)}`;
  return resourceLabel(naturalKey);
}

/** "description, visibility" from ["description", "visibility"]; camelCase split into words. */
export function fieldList(fields: string[]): string {
  return fields.map((field) => field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()).join(", ");
}

/** Why a changed-since resource is left alone. */
export function conflictSentence(reason: string): string {
  if (reason.startsWith("uncertain-outcome")) return "KEEL could not tell whether this restore's change landed, so it will not guess.";
  if (/no longer present/.test(reason)) return "It no longer exists, so there is nothing to put back.";
  if (/held by a different object/.test(reason)) return "Something else now has this name, so KEEL leaves it alone.";
  const changed = reason.match(/^concurrent-change: (.+?) changed after this restore/);
  if (changed) return `${fieldList(changed[1].split(", "))} changed after this restore, so KEEL will not overwrite the later change.`;
  return "It changed after this restore, so KEEL leaves it alone.";
}

/** Why something needs a person. */
export function manualSentence(reason: string): string {
  if (reason.startsWith("relationship edge")) return "KEEL cannot undo membership changes on its own; check this one by hand.";
  if (/predates operation journaling/.test(reason)) return "KEEL has no record of what this change intended; check it by hand.";
  return "Check this one by hand.";
}

/** Why there is nothing to undo. */
export function notAppliedSentence(reason: string): string {
  if (reason.startsWith("Graph rejected")) return "Microsoft rejected this change, so there is nothing to undo.";
  if (/did not land/.test(reason)) return "The change did not land, so there is nothing to undo.";
  if (reason.startsWith("already absent")) return "It is already gone, so there is nothing to undo.";
  if (/changed no writable field/.test(reason)) return "The change altered nothing KEEL can write, so there is nothing to undo.";
  return "There is nothing to undo.";
}

/** What cannot be undone; a content effect keeps its own disclosure. */
export function irrecoverableSentence(item: { naturalKey: string; effect: string; reason: string }): string {
  if (item.effect === "object-deleted") {
    return "This restore deleted it. Undo cannot bring it back with the same ID; restore it again instead, while it is still in deleted items.";
  }
  return item.reason.split(item.naturalKey).join(resourceLabel(item.naturalKey));
}

export const UNDO_STATEMENT = "Undo is not atomic: each change is reversed and checked on its own, and only changes this restore actually made are undone. It never brings back erased or disclosed content.";
