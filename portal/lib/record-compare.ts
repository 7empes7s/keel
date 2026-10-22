// Two sides of one setting for the "Technical details" comparison: each side as
// plain lines, the lines that differ marked and listed first, the matching ones
// counted. Pure, so it is unit tested.
import { valueLines } from "@/lib/changed-values";

export type CompareLine = { label: string; text: string; differs: boolean };
export type Compared = {
  change: "same" | "changed" | "added" | "removed";
  before: CompareLine[] | null;
  after: CompareLine[] | null;
  /** Settings that match on both sides and are not listed. */
  same: number;
};

/** The most lines shown per side; the rest of the differences are counted in "And N more". */
export const MAX_COMPARE_LINES = 12;

function lines(value: unknown): { label: string; text: string }[] {
  return valueLines(value, {}, 500).lines;
}

const absent = (value: unknown) => value === undefined || value === null;

export function compareSides(before: unknown, after: unknown): Compared {
  if (absent(before) && absent(after)) return { change: "same", before: null, after: null, same: 0 };
  if (absent(before)) return { change: "added", before: null, after: lines(after).slice(0, MAX_COMPARE_LINES).map((line) => ({ ...line, differs: true })), same: 0 };
  if (absent(after)) return { change: "removed", before: lines(before).slice(0, MAX_COMPARE_LINES).map((line) => ({ ...line, differs: true })), after: null, same: 0 };
  const left = lines(before);
  const right = lines(after);
  const leftBy = new Map(left.map((line) => [line.label, line.text]));
  const rightBy = new Map(right.map((line) => [line.label, line.text]));
  const differs = (line: { label: string; text: string }, other: Map<string, string>) => other.get(line.label) !== line.text;
  const leftDiff = left.filter((line) => differs(line, rightBy));
  const rightDiff = right.filter((line) => differs(line, leftBy));
  if (!leftDiff.length && !rightDiff.length) {
    // Equal: show the value once on each side so the reader sees what matched.
    const shown = left.slice(0, 3).map((line) => ({ ...line, differs: false }));
    return { change: "same", before: shown, after: right.slice(0, 3).map((line) => ({ ...line, differs: false })), same: Math.max(0, left.length - shown.length) };
  }
  const same = left.length - leftDiff.length;
  return {
    change: "changed",
    before: leftDiff.slice(0, MAX_COMPARE_LINES).map((line) => ({ ...line, differs: true })),
    after: rightDiff.slice(0, MAX_COMPARE_LINES).map((line) => ({ ...line, differs: true })),
    same,
  };
}
