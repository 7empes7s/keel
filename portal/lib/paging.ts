// Paging for the shared lists: how many rows a page shows, which page is open, and how
// a grouped list splits into pages. Pure, so the same rules hold on every list and are
// tested without a browser.

export const PAGE_SIZES = ["25", "50", "100", "all"] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = "25";

export function readPageSize(value: string, fallback: PageSize = DEFAULT_PAGE_SIZE): PageSize {
  return (PAGE_SIZES as readonly string[]).includes(value) ? (value as PageSize) : fallback;
}

/** Rows per page; Infinity for "all". */
export function rowsPerPage(size: PageSize): number {
  return size === "all" ? Number.POSITIVE_INFINITY : Number(size);
}

export function pageCount(total: number, size: PageSize): number {
  const per = rowsPerPage(size);
  return Number.isFinite(per) ? Math.max(1, Math.ceil(total / per)) : 1;
}

/** The page number from the address (1-based), kept inside the pages that exist. */
export function readPage(value: string, total: number, size: PageSize): number {
  const page = Number.parseInt(value, 10);
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.min(page, pageCount(total, size));
}

/** The rows a page covers, as [start, end) over the whole list. */
export function pageWindow(page: number, total: number, size: PageSize): { start: number; end: number } {
  const per = rowsPerPage(size);
  if (!Number.isFinite(per)) return { start: 0, end: total };
  const start = Math.min((page - 1) * per, total);
  return { start, end: Math.min(start + per, total) };
}

/** "26–50 of 312". */
export function rangeWords(page: number, total: number, size: PageSize): string {
  if (!total) return "0 of 0";
  const { start, end } = pageWindow(page, total, size);
  return start + 1 === end ? `${end} of ${total}` : `${start + 1}–${end} of ${total}`;
}

export interface PagedGroup<G> {
  group: G;
  // The group's rows on this page.
  start: number;
  end: number;
  // The group began on an earlier page, or goes on to a later one.
  continued: boolean;
  more: number;
}

/** Splits a grouped list into pages, keeping each group's header on every page that
 * shows any of its rows. A closed group (or one with no rows) takes no rows, and its
 * header sits on the page where its rows would start, so it is never lost. */
export function pageGroups<G>(groups: readonly G[], rowsOf: (group: G) => number, isClosed: (group: G) => boolean, page: number, size: PageSize): { groups: PagedGroup<G>[]; total: number } {
  const total = groups.reduce((sum, group) => sum + (isClosed(group) ? 0 : rowsOf(group)), 0);
  const { start: from, end: to } = pageWindow(page, total, size);
  const last = pageCount(total, size);
  const out: PagedGroup<G>[] = [];
  let offset = 0;
  for (const group of groups) {
    const rows = isClosed(group) ? 0 : rowsOf(group);
    if (rows === 0) {
      // Headers with no rows: on the page where the next row is, or the last page.
      const onPage = Math.min(Math.floor(offset / rowsPerPage(size)) + 1, last);
      if (onPage === page) out.push({ group, start: 0, end: 0, continued: false, more: 0 });
      continue;
    }
    const start = Math.max(from, offset) - offset;
    const end = Math.min(to, offset + rows) - offset;
    if (end > start) out.push({ group, start, end, continued: start > 0, more: rows - end });
    offset += rows;
  }
  return { groups: out, total };
}

export interface SortChoice {
  key: string;
  label: string;
  // The direction this sort starts in: newest first, worst first, and so on.
  desc?: boolean;
}

export type SortDir = "asc" | "desc";

/** Sorts a copy; equal rows keep their order, so a sort never shuffles ties. */
export function sortRows<T>(rows: readonly T[], compare: ((a: T, b: T) => number) | undefined, dir: SortDir): T[] {
  if (!compare) return [...rows];
  const sign = dir === "desc" ? -1 : 1;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => sign * compare(a.row, b.row) || a.index - b.index).map((entry) => entry.row);
}

/** Text compare that reads numbers as numbers and ignores case. */
export function byText(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

/** Time compare for ISO stamps; a missing time sorts as oldest. */
export function byTime(a: string | null | undefined, b: string | null | undefined): number {
  return (a ? Date.parse(a) || 0 : 0) - (b ? Date.parse(b) || 0 : 0);
}

const RISK: Record<string, number> = { fine: 0, low: 1, soon: 2, urgent: 3 };

/** Risk compare, calmest first; sort it descending for most urgent first. */
export function byRisk(a: string | null | undefined, b: string | null | undefined): number {
  return (RISK[a ?? "fine"] ?? 0) - (RISK[b ?? "fine"] ?? 0);
}
