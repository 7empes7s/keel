"use client";

import { Fragment, useMemo, type ReactNode } from "react";

import { FindInput } from "@/components/list/find-input";
import { ListPager, SortControl, useListPaging, type ListSort } from "@/components/list/list-paging";
import { Icon } from "@/components/shell/icons";
import { byText, pageWindow, sortRows, type SortChoice } from "@/lib/paging";
import { useViewState } from "@/lib/use-view-state";

export interface PagedRow {
  id: string;
  node: ReactNode;
  // What Find looks in.
  text: string;
  // The values each sort reads, by sort key: text, a number, or an ISO time.
  values?: Record<string, string | number>;
}

function compareValues(key: string) {
  return (a: PagedRow, b: PagedRow) => {
    const x = a.values?.[key] ?? "";
    const y = b.values?.[key] ?? "";
    return typeof x === "number" && typeof y === "number" ? x - y : byText(String(x), String(y));
  };
}

/** A plain list (no selection) with Find, Order by, rows per page and pages, for lists
 * a server page renders, such as recent jobs. The rows arrive already drawn; `prefix`
 * keeps its address keys apart from another list on the same page. */
export function PagedRows({ rows, label, noun, prefix, sorts = [], listClassName }: { rows: PagedRow[]; label: string; noun: { one: string; many: string }; prefix: string; sorts?: SortChoice[]; listClassName: string }) {
  const view = useViewState();
  const listSorts = useMemo<ListSort<PagedRow>[]>(() => sorts.map((entry) => ({ ...entry, compare: compareValues(entry.key) })), [sorts]);
  const paging = useListPaging<PagedRow>({ prefix, sorts: listSorts });
  const query = view.get(`${prefix}q`);
  const shown = useMemo(() => {
    const text = query.trim().toLowerCase();
    const found = text ? rows.filter((row) => row.text.toLowerCase().includes(text)) : rows;
    return paging.sort ? sortRows(found, paging.sort.compare, paging.dir) : found;
  }, [rows, query, paging.sort, paging.dir]);
  const { start, end } = pageWindow(paging.pageOf(shown.length), shown.length, paging.size);

  return (
    <div className="paged-rows">
      {rows.length > 1 ? (
        <div className="sel-toolbar">
          <label className="picker-field sel-find">
            <span className="picker-label">Find</span>
            <span className="sel-find-box">
              <Icon name="search" />
              <FindInput onChange={(text) => view.set({ [`${prefix}q`]: text, ...paging.resetPage })} placeholder={`Find ${noun.many}`} value={query} />
            </span>
          </label>
          <SortControl paging={paging} sorts={listSorts} />
        </div>
      ) : null}
      {shown.length ? (
        <ul aria-label={label} className={listClassName}>{shown.slice(start, end).map((row) => <Fragment key={row.id}>{row.node}</Fragment>)}</ul>
      ) : (
        <p className="sel-empty">No {noun.many} match “{query}”.</p>
      )}
      <ListPager label={label} noun={noun} paging={paging} total={shown.length} />
    </div>
  );
}

