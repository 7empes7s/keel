// The undo of a restore that created an Intune policy which is assigned now: the
// person chooses to delete the policy with its assignments, or to skip it. These
// choices go with the request to plan the undo again.
export type UndoChoice = "delete" | "skip";

const MAX_UNDO_CHOICES = 500;

/** { naturalKey: "delete" | "skip" }; null when none was sent; false when malformed. */
export function parseUndoChoices(value: unknown): Record<string, UndoChoice> | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_UNDO_CHOICES) return false;
  const out: Record<string, UndoChoice> = {};
  for (const [key, choice] of entries) {
    if (key.length === 0 || key.length > 1024 || key.startsWith("-") || (choice !== "delete" && choice !== "skip")) return false;
    out[key] = choice;
  }
  return entries.length > 0 ? out : null;
}
