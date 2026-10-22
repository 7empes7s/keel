/** Where an opened item sits in the list it was opened from, for the panel's previous and
 *  next buttons ("3 of 12"). Null when the item is not in the list (filtered away) or the
 *  list holds only it. Previous and next stop at the ends; they never wrap. */
export interface SheetStep {
  index: number;
  total: number;
  previous: string | null;
  next: string | null;
}

export function sheetStep(ids: readonly string[], current: string | null | undefined): SheetStep | null {
  if (!current) return null;
  const index = ids.indexOf(current);
  if (index < 0 || ids.length < 2) return null;
  return { index, total: ids.length, previous: index > 0 ? ids[index - 1] : null, next: index < ids.length - 1 ? ids[index + 1] : null };
}

/** "3 of 12". */
export function stepWords(step: Pick<SheetStep, "index" | "total">): string {
  return `${(step.index + 1).toLocaleString("en-GB")} of ${step.total.toLocaleString("en-GB")}`;
}
