"use client";

import { useRef } from "react";

import { Segmented } from "@/components/pickers/segmented";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Icon } from "@/components/shell/icons";
import { PAGE_SIZES, pageCount, rangeWords, readPage, readPageSize, type PageSize, type SortChoice, type SortDir } from "@/lib/paging";
import { useViewState } from "@/lib/use-view-state";

export interface ListSort<T> extends SortChoice {
  compare: (a: T, b: T) => number;
}

const SUGGESTED = "";

/** Page size, page, sort and direction for one list, kept in the address. `prefix`
 * keeps two lists on one page apart ("jobs-page"). Defaults stay out of the URL. */
export function useListPaging<T>({ prefix = "", defaultSize = "25", sorts = [] }: { prefix?: string; defaultSize?: PageSize; sorts?: readonly ListSort<T>[] }) {
  const view = useViewState();
  const key = (name: string) => `${prefix}${name}`;
  const size = readPageSize(view.get(key("size")), defaultSize);
  const sort = sorts.find((entry) => entry.key === view.get(key("sort"))) ?? null;
  const dir: SortDir = (view.get(key("dir")) as SortDir) || (sort?.desc ? "desc" : "asc");
  return {
    size,
    sort,
    dir,
    pageOf: (total: number) => readPage(view.get(key("page")), total, size),
    setPage: (page: number) => view.set({ [key("page")]: String(page) }, { [key("page")]: "1" }),
    setSize: (next: PageSize) => view.set({ [key("size")]: next, [key("page")]: null }, { [key("size")]: defaultSize }),
    setSort: (next: string) => view.set({ [key("sort")]: next, [key("dir")]: null, [key("page")]: null }),
    setDir: (next: SortDir) => view.set({ [key("dir")]: next, [key("page")]: null }, { [key("dir")]: sort?.desc ? "desc" : "asc" }),
    // A filter change should start again from page 1.
    resetPage: { [key("page")]: null } as Record<string, null>,
  };
}

export type ListPaging<T> = ReturnType<typeof useListPaging<T>>;

const SIZE_OPTIONS = PAGE_SIZES.map((value) => ({ value, label: value === "all" ? "All" : value }));

/** "Order by" with the list's sorts, and a button that flips the direction. */
export function SortControl<T>({ sorts, paging }: { sorts: readonly ListSort<T>[]; paging: ListPaging<T> }) {
  if (!sorts.length) return null;
  const options = [{ value: SUGGESTED, label: "Suggested", hint: "Most urgent first, as KEEL orders them" }, ...sorts.map((entry) => ({ value: entry.key, label: entry.label }))];
  const desc = paging.dir === "desc";
  return (
    <div className="list-sort">
      <OptionPicker label="Order by" onChange={paging.setSort} options={options} value={paging.sort?.key ?? SUGGESTED} />
      {paging.sort ? (
        <button
          aria-label={`Order: ${desc ? "descending" : "ascending"}. Switch to ${desc ? "ascending" : "descending"}`}
          className="btn list-sort-dir"
          onClick={() => paging.setDir(desc ? "asc" : "desc")}
          title={desc ? "Descending: switch to ascending" : "Ascending: switch to descending"}
          type="button"
        >
          <Icon name={desc ? "down" : "up"} />{desc ? "Desc" : "Asc"}
        </button>
      ) : null}
    </div>
  );
}

/** Under a list: which rows are showing, how many per page, and the page buttons. Hidden
 * when everything fits on one page at the smallest size. */
export function ListPager<T>({ total, paging, noun, label }: { total: number; paging: ListPaging<T>; noun: { one: string; many: string }; label: string }) {
  const ref = useRef<HTMLElement>(null);
  if (total <= Number(PAGE_SIZES[0])) return null;
  const page = paging.pageOf(total);
  const pages = pageCount(total, paging.size);
  // A new page starts at the top of its list, not where the pager was.
  const go = (next: number) => {
    paging.setPage(next);
    const list = ref.current?.parentElement;
    if (list && list.getBoundingClientRect().top < 0) list.scrollIntoView({ block: "start" });
  };
  return (
    <nav aria-label={`Pages of ${label}`} className="list-pager" ref={ref}>
      <span className="list-pager-range" role="status">Showing {rangeWords(page, total, paging.size)} {total === 1 ? noun.one : noun.many}</span>
      <Segmented label="Rows per page" onChange={paging.setSize} options={SIZE_OPTIONS} value={paging.size} />
      {pages > 1 ? (
        <span className="list-pager-pages">
          <button aria-label="First page" className="btn btn-sm" disabled={page === 1} onClick={() => go(1)} title="First page" type="button"><Icon name="hide" /></button>
          <button className="btn btn-sm" disabled={page === 1} onClick={() => go(page - 1)} type="button"><Icon className="list-pager-prev" name="chevron" />Previous</button>
          <span className="list-pager-of"><span className="list-pager-word">Page </span>{page} of {pages}</span>
          <button className="btn btn-sm" disabled={page === pages} onClick={() => go(page + 1)} type="button">Next<Icon name="chevron" /></button>
          <button aria-label="Last page" className="btn btn-sm" disabled={page === pages} onClick={() => go(pages)} title="Last page" type="button"><Icon name="show" /></button>
        </span>
      ) : null}
    </nav>
  );
}
