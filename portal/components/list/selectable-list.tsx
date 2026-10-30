"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { ListPager, SortControl, useListPaging, type ListSort } from "@/components/list/list-paging";
import { SavedFilters } from "@/components/list/saved-filters";
import { Segmented } from "@/components/pickers/segmented";
import { StatusBadge } from "@/components/shell/menu";
import { Icon, type IconName } from "@/components/shell/icons";
import { Popover } from "@/components/shell/popover";
import { worstTone, type RiskTone } from "@/lib/menu-status";
import { byRisk, byText, pageGroups, sortRows, type PageSize } from "@/lib/paging";
import { groupCheck, NO_SELECTION, picksTray, prune, selectRange, setMany, span, toggleOne, type PickGroup, type Selection } from "@/lib/selection";
import { readList, useViewState } from "@/lib/use-view-state";

export interface ListGroup<T> {
  key: string;
  label: string;
  icon?: IconName;
  // One plain line under the name: what the group holds.
  about?: string;
  items: T[];
  // Sub-groups inside the group, such as the kinds of setting inside a service. When
  // set, `items` is every part's rows in order; each part has its own count, select-all
  // and open/close (kept in the URL as `<group>.<part>`).
  parts?: ListGroup<T>[];
  // What else the group holds that is not a row here, such as kinds of setting backed
  // up and put back on their own. Shown at the end of the open group; a group with no
  // rows still shows when it has this.
  extra?: ReactNode;
  // The header's count, when rows alone do not say what the group holds.
  count?: string;
}

export interface Grouping<T> {
  key: string;
  label: string;
  groupsOf: (items: T[]) => ListGroup<T>[];
}

export interface ListAction {
  // Names the action with the count, in plain words: "Restore 12 settings". `ids` are
  // the chosen rows, for a list whose action depends on which rows they are.
  label: (count: number, ids: string[]) => string;
  // What happens, before it happens. `ids` are the chosen rows, for a detail that
  // depends on which rows they are.
  detail: (count: number, ids: string[]) => string;
  run: (ids: string[]) => void;
}

interface Props<T> {
  label: string;
  items: T[];
  getId: (item: T) => string;
  // The checkbox's accessible name for one row.
  rowName: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  groupings: Grouping<T>[];
  toneOf?: (item: T) => RiskTone | null | undefined;
  noun: { one: string; many: string };
  action: ListAction;
  more?: { label: string; run: (ids: string[]) => void }[];
  // Free-text find, kept in the URL as `q`.
  matches?: (item: T, query: string) => boolean;
  // Ways to order the rows inside each group (and each part), kept in the URL as `sort`
  // and `dir`. "Suggested" (the order `items` and the grouping give) is always first;
  // Name (by `rowName`) and Risk (by `toneOf`) are always offered.
  sorts?: ListSort<T>[];
  // Rows per page to start with; the viewer can pick 25, 50, 100 or all (`size`). Group
  // and part headers repeat on each page that shows their rows. Selecting a whole group
  // still selects the rows on other pages.
  pageSize?: PageSize;
  // A control in a group's header that acts on the group, such as "Undo all 4".
  groupAction?: (group: ListGroup<T>) => ReactNode;
  // Groups that start closed (count still shown) until someone opens them, such as
  // resolved alerts. Opening every group keeps `closed=none` in the URL.
  closedByDefault?: string[];
  // Shown instead of the plain line when no row matches, such as a page's filter chips
  // with Clear all. Without it the list still offers to clear its own find.
  empty?: ReactNode;
  // Picks that outlive the view: a row picked from `pool` stays picked when a filter,
  // a tile or the find hides it, and the bar becomes a tray that counts the picks by
  // `groupOf` (such as the service), says how many the view hides, and lists them with
  // a remove button each. The actions run on every pick, shown or not.
  keepPicks?: { pool: T[]; groupOf: (item: T) => PickGroup };
  // Every row the find leaves, in the order the list shows them (grouping and sort), for
  // a details panel's previous and next.
  onOrder?: (ids: string[]) => void;
}

// What paging counts: a group, or one part of a group that has parts.
interface ListUnit<T> {
  group: ListGroup<T>;
  part: ListGroup<T> | null;
  closed: boolean;
}

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 10;

function plural(count: number, noun: { one: string; many: string }) {
  return `${count} ${count === 1 ? noun.one : noun.many}`;
}

/** The shared list: grouped rows with a checkbox each, Shift+click ranges, Ctrl or Cmd
 * +click toggles, Ctrl or Cmd+A and Esc, select all or a whole group, long-press and
 * drag on a phone, and a bar that names the action with its count. Grouping, find and
 * closed groups live in the URL. */
export function SelectableList<T>({ label, items, getId, rowName, renderRow, groupings, toneOf, noun, action, more = [], matches, sorts = [], pageSize = "25", groupAction, closedByDefault = [], empty, keepPicks, onOrder }: Props<T>) {
  const view = useViewState();
  const groupKey = view.get("group", groupings[0]?.key ?? "");
  const grouping = groupings.find((entry) => entry.key === groupKey) ?? groupings[0];
  const query = view.get("q");
  const closed = readList(view.get("closed", closedByDefault.join(",")));
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [touchMode, setTouchMode] = useState(false);
  // Every list can be ordered by name and, when its rows carry a risk, by risk; a list
  // adds its own sorts (such as by time) in front.
  const allSorts = useMemo<ListSort<T>[]>(() => {
    const own = new Set(sorts.map((entry) => entry.key));
    const builtIn: ListSort<T>[] = [{ key: "name", label: "Name", compare: (a, b) => byText(rowName(a), rowName(b)) }];
    if (toneOf) builtIn.push({ key: "risk", label: "Risk", desc: true, compare: (a, b) => byRisk(toneOf(a), toneOf(b)) });
    return [...sorts, ...builtIn.filter((entry) => !own.has(entry.key))];
  }, [sorts, rowName, toneOf]);
  const paging = useListPaging<T>({ defaultSize: pageSize, sorts: allSorts });
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => (matches && query ? items.filter((item) => matches(item, query.toLowerCase())) : items), [items, matches, query]);
  const { sort, dir } = paging;
  // A sort reorders rows inside each group, and inside each part, never the groups.
  const groups = useMemo(() => {
    const grouped = grouping.groupsOf(filtered);
    if (!sort) return grouped;
    return grouped.map((group) => {
      if (!group.parts?.length) return { ...group, items: sortRows(group.items, sort.compare, dir) };
      const parts = group.parts.map((part) => ({ ...part, items: sortRows(part.items, sort.compare, dir) }));
      return { ...group, parts, items: parts.flatMap((part) => part.items) };
    });
  }, [grouping, filtered, sort, dir]);
  const allIds = useMemo(() => groups.flatMap((group) => group.items.map(getId)), [groups, getId]);
  // Reported only when the order itself changes: `allIds` is a new array on most renders
  // (pages pass an inline `getId`), and reporting each one re-rendered the page forever.
  const orderRef = useRef(onOrder);
  orderRef.current = onOrder;
  const orderKey = allIds.join("\u0000");
  const sentKey = useRef<string | null>(null);
  useEffect(() => {
    if (sentKey.current === orderKey) return;
    sentKey.current = orderKey;
    orderRef.current?.(allIds);
  }, [orderKey, allIds]);
  // A list that goes away (nothing matches) leaves no order behind for the panel.
  useEffect(() => () => { orderRef.current?.([]); }, []);
  const partsOf = (group: ListGroup<T>) => (group.parts && group.parts.length ? group.parts.map((part) => ({ ...part, key: `${group.key}.${part.key}` })) : null);
  // Paging counts rows in open groups and open parts; a page shows a slice of each.
  const units = useMemo<ListUnit<T>[]>(() => groups.flatMap((group): ListUnit<T>[] => {
    const parts = closed.includes(group.key) ? null : partsOf(group);
    return parts ? parts.map((part) => ({ group, part, closed: closed.includes(part.key) })) : [{ group, part: null, closed: closed.includes(group.key) }];
  }), [groups, closed.join(",")]);
  const unitRows = (unit: ListUnit<T>) => (unit.part ?? unit.group).items.length;
  const openRows = units.reduce((sum, unit) => sum + (unit.closed ? 0 : unitRows(unit)), 0);
  const page = paging.pageOf(openRows);
  const paged = useMemo(() => pageGroups(units, unitRows, (unit) => unit.closed, page, paging.size).groups, [units, page, paging.size]);
  const visibleIds = useMemo(() => paged.flatMap(({ group: unit, start, end }) => (unit.part ?? unit.group).items.slice(start, end).map(getId)), [paged, getId]);
  // The page's units, gathered under their group in order.
  const pageGroupsShown = useMemo(() => {
    const out: { group: ListGroup<T>; units: typeof paged }[] = [];
    for (const entry of paged) {
      const last = out.at(-1);
      if (last && last.group.key === entry.group.group.key) last.units.push(entry);
      else out.push({ group: entry.group.group, units: [entry] });
    }
    return out;
  }, [paged]);
  // Rows of a group on later pages, for the line under its last row here.
  const laterIn = (group: ListGroup<T>) => {
    const own = paged.filter((entry) => entry.group.group.key === group.key);
    const last = own.at(-1);
    if (!last) return 0;
    const rest = units.slice(units.indexOf(last.group) + 1).filter((unit) => unit.group.key === group.key && !unit.closed);
    return last.more + rest.reduce((sum, unit) => sum + unitRows(unit), 0);
  };
  const toggleClosed = (key: string, isClosed: boolean) => view.set({ closed: (isClosed ? closed.filter((entry) => entry !== key) : [...closed, key]).join(",") || (closedByDefault.length ? "none" : null) });

  function rowsOf(group: ListGroup<T>, start: number, end: number, later = 0, owner = group) {
    return (
      <ul className="sel-rows">
        {group.items.slice(start, end).map((item) => {
          const id = getId(item);
          const selected = selection.ids.has(id);
          return (
            <li className="sel-row" data-row-id={id} data-selected={selected || undefined} data-tone={toneOf?.(item) ?? undefined} key={id} onClick={(event) => onRowClick(event, id)}>
              <input aria-label={`Select ${rowName(item)}`} checked={selected} className="sel-check" onChange={() => {}} type="checkbox" />
              <div className="sel-row-body">{renderRow(item)}</div>
            </li>
          );
        })}
        {later > 0 ? (
          <li className="sel-more">
            <span>{plural(later, noun)} more in {owner.label} on the next page</span>
          </li>
        ) : null}
      </ul>
    );
  }

  // Rows the selection may hold: what the list shows, or the whole pool when picks
  // outlive the view. A filter that hides rows drops them from the selection unless
  // picks are kept; a row that leaves the pool (accepted, resolved) always drops out.
  const pool = keepPicks?.pool;
  const poolIds = useMemo(() => (pool ? pool.map(getId) : null), [pool, getId]);
  const keptIds = poolIds ?? allIds;
  useEffect(() => { setSelection((current) => prune(current, keptIds)); }, [keptIds]);
  useEffect(() => { if (selection.ids.size === 0) setTouchMode(false); }, [selection.ids.size]);

  useEffect(() => {
    if (!selection.ids.size) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector(".popover-panel")) setSelection(NO_SELECTION); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selection.ids.size]);

  function onRowClick(event: MouseEvent, id: string) {
    const target = event.target as HTMLElement;
    const isBox = target.closest("input[type='checkbox']");
    if (!isBox && target.closest("a, button, input, select, textarea, summary, label")) return;
    if (event.shiftKey) {
      event.preventDefault();
      // Shift+click must not also select the page's text.
      window.getSelection()?.removeAllRanges();
      setSelection((current) => selectRange(current, visibleIds, id));
    } else if (event.metaKey || event.ctrlKey || isBox || touchMode) {
      setSelection((current) => toggleOne(current, id));
    }
  }

  // Phone: hold a row to start selecting, then drag over rows to add them. A move
  // before the hold ends is a scroll, and cancels it.
  const press = useRef<{ id: string; x: number; y: number; timer: number; dragging: boolean; base: Selection } | null>(null);
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const rowAt = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-row-id]")?.dataset.rowId ?? null;
    function start(event: TouchEvent) {
      const touch = event.touches[0];
      const id = (event.target as HTMLElement).closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
      if (!touch || !id || event.touches.length > 1) return;
      const timer = window.setTimeout(() => {
        if (!press.current) return;
        press.current.dragging = true;
        setTouchMode(true);
        setSelection((current) => {
          press.current!.base = current;
          return { ...setMany(current, [id], true), anchor: id };
        });
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
      press.current = { id, x: touch.clientX, y: touch.clientY, timer, dragging: false, base: NO_SELECTION };
    }
    function move(event: TouchEvent) {
      const current = press.current;
      const touch = event.touches[0];
      if (!current || !touch) return;
      if (!current.dragging) {
        if (Math.hypot(touch.clientX - current.x, touch.clientY - current.y) > MOVE_TOLERANCE) {
          window.clearTimeout(current.timer);
          press.current = null;
        }
        return;
      }
      event.preventDefault();
      const over = rowAt(touch.clientX, touch.clientY);
      if (over) setSelection({ ...setMany(current.base, span(visibleIds, current.id, over), true), anchor: current.id });
    }
    function end(event: TouchEvent) {
      const current = press.current;
      if (!current) return;
      window.clearTimeout(current.timer);
      // The hold already selected; keep the tap that ends it from toggling it back.
      if (current.dragging) event.preventDefault();
      press.current = null;
    }
    root.addEventListener("touchstart", start, { passive: true });
    root.addEventListener("touchmove", move, { passive: false });
    root.addEventListener("touchend", end);
    root.addEventListener("touchcancel", end);
    return () => {
      root.removeEventListener("touchstart", start);
      root.removeEventListener("touchmove", move);
      root.removeEventListener("touchend", end);
      root.removeEventListener("touchcancel", end);
    };
  }, [visibleIds]);

  const shownSet = useMemo(() => new Set(allIds), [allIds]);
  // Picks the current view hides, in the pool's order, after the shown ones.
  const hiddenIds = poolIds ? poolIds.filter((id) => selection.ids.has(id) && !shownSet.has(id)) : [];
  const selectedIds = [...allIds.filter((id) => selection.ids.has(id)), ...hiddenIds];
  const count = selectedIds.length;
  const allShownPicked = allIds.length > 0 && allIds.every((id) => selection.ids.has(id));
  const tray = keepPicks && pool && count ? picksTray(pool, getId, keepPicks.groupOf, selection.ids) : null;

  return (
    <div className="sel-list" data-touch-mode={touchMode || undefined}>
      <div className="sel-toolbar">
        {groupings.length > 1 ? (
          <Segmented
            label="Group by"
            onChange={(value) => view.set({ group: value, closed: null, ...paging.resetPage }, { group: groupings[0].key })}
            options={groupings.map((entry) => ({ value: entry.key, label: entry.label }))}
            value={grouping.key}
          />
        ) : null}
        {matches ? (
          <label className="picker-field sel-find">
            <span className="picker-label">Find</span>
            <span className="sel-find-box">
              <Icon name="search" />
              <input className="bare-input" onChange={(event) => view.set({ q: event.target.value, ...paging.resetPage })} placeholder={`Find ${noun.many}`} type="search" value={query} />
            </span>
          </label>
        ) : null}
        <SortControl paging={paging} sorts={allSorts} />
        <SavedFilters />
      </div>
      <div className="sel-summary">
        <button
          aria-pressed={allShownPicked}
          className="btn btn-sm"
          disabled={!allIds.length}
          onClick={() => setSelection((current) => setMany(current, allIds, !allShownPicked))}
          type="button"
        >
          {!allShownPicked ? `Select all ${plural(allIds.length, noun)}` : hiddenIds.length ? `Unselect these ${plural(allIds.length, noun)}` : "Clear selection"}
        </button>
        <span className="sel-help">
          Shift+click selects a range. On a phone, hold a row, then drag.
        </span>
      </div>
      <div
        aria-label={label}
        className="sel-groups"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && !(event.target as HTMLElement).closest("input:not([type='checkbox'])")) {
            event.preventDefault();
            setSelection((current) => setMany(current, visibleIds, true));
          }
        }}
        ref={listRef}
        role="group"
      >
        {pageGroupsShown.map(({ group, units: shownUnits }) => {
          const first = shownUnits[0];
          const continued = first.start > 0 || units.indexOf(first.group) > units.findIndex((unit) => unit.group.key === group.key);
          const later = laterIn(group);
          const ids = group.items.map(getId);
          const check = groupCheck(selection, ids);
          const isClosed = closed.includes(group.key);
          const parts = partsOf(group);
          const tone = toneOf ? worstTone(group.items.map((item) => toneOf(item) ?? undefined)) : null;
          // The number counts only the rows at the badge's colour; the rest go in its note.
          const attention = toneOf && (tone === "urgent" || tone === "soon") ? group.items.filter((item) => toneOf(item) === tone).length : 0;
          const soonToo = tone === "urgent" && toneOf ? group.items.filter((item) => toneOf(item) === "soon").length : 0;
          return (
            <section className="sel-group" data-closed={isClosed || undefined} key={group.key}>
              <header className="sel-group-head">
                {ids.length ? (
                  <input
                    aria-label={`Select all ${plural(ids.length, noun)} in ${group.label}`}
                    checked={check === "all"}
                    className="sel-check"
                    onChange={() => setSelection((current) => setMany(current, ids, check !== "all"))}
                    ref={(element) => { if (element) element.indeterminate = check === "some"; }}
                    type="checkbox"
                  />
                ) : <span aria-hidden="true" className="sel-check-space" />}
                <button
                  aria-expanded={!isClosed}
                  className="sel-group-toggle"
                  onClick={() => toggleClosed(group.key, isClosed)}
                  type="button"
                >
                  {group.icon ? <Icon name={group.icon} /> : null}
                  <span className="sel-group-name"><b>{group.label}</b>{group.about ? <small>{group.about}</small> : null}</span>
                  <span className="sel-group-count">{group.count ?? plural(ids.length, noun)}{continued && !isClosed ? <small className="sel-group-continued">continued</small> : null}</span>
                  {tone && attention ? <StatusBadge status={{ tone, count: attention, note: `${attention} ${tone === "urgent" ? "urgent" : "to check soon"}${soonToo ? `, and ${soonToo} to check soon` : ""}` }} /> : null}
                  <Icon className="sel-group-chevron" name="chevron-down" />
                </button>
                {groupAction ? groupAction(group) : null}
              </header>
              {isClosed ? null : parts ? (
                <div className="sel-parts">
                  {shownUnits.map(({ group: unit, start, end, more: partMore }, index) => {
                    const part = unit.part!;
                    const partIds = part.items.map(getId);
                    const partCheck = groupCheck(selection, partIds);
                    const partClosed = closed.includes(part.key);
                    return (
                      <section className="sel-part" data-closed={partClosed || undefined} key={part.key}>
                        <header className="sel-part-head">
                          <input
                            aria-label={`Select all ${plural(partIds.length, noun)} in ${group.label}: ${part.label}`}
                            checked={partCheck === "all"}
                            className="sel-check"
                            onChange={() => setSelection((current) => setMany(current, partIds, partCheck !== "all"))}
                            ref={(element) => { if (element) element.indeterminate = partCheck === "some"; }}
                            type="checkbox"
                          />
                          <button aria-expanded={!partClosed} className="sel-part-toggle" onClick={() => toggleClosed(part.key, partClosed)} type="button">
                            <span className="sel-part-name">{part.label}</span>
                            <span className="sel-group-count">{plural(partIds.length, noun)}{start > 0 && !partClosed ? <small className="sel-group-continued">continued</small> : null}</span>
                            <Icon className="sel-group-chevron" name="chevron-down" />
                          </button>
                        </header>
                        {partClosed ? null : rowsOf(part, start, end, index === shownUnits.length - 1 ? later : partMore, index === shownUnits.length - 1 ? group : part)}
                      </section>
                    );
                  })}
                </div>
              ) : ids.length ? rowsOf(group, first.start, first.end, later) : null}
              {/* The group's other kinds follow its last row, on the page that shows it. */}
              {!isClosed && group.extra && later === 0 ? <div className="sel-extra">{group.extra}</div> : null}
            </section>
          );
        })}
        {groups.length === 0 ? (empty ?? (
          <p className="sel-empty">
            No {noun.many} match {query ? `“${query}”` : "this view"}.
            {query ? <button className="btn btn-sm" onClick={() => view.set({ q: null })} type="button">Clear the search</button> : null}
          </p>
        )) : null}
      </div>
      <ListPager label={label} noun={noun} paging={paging} total={openRows} />
      {count ? (
        <div aria-label="Selection" className="sel-bar" data-tray={tray ? true : undefined} role="region">
          <span className="sel-bar-count"><b>{plural(count, noun)}</b> selected</span>
          {tray ? (
            <span className="sel-tray-sum">
              {tray.groups.map((group) => (
                <span className="sel-tray-chip" key={group.key}>{group.icon ? <Icon name={group.icon} /> : null}{group.label}{" "}<b>{group.items.length}</b></span>
              ))}
              {hiddenIds.length ? (
                <span className="sel-tray-chip" data-tone="soon" title="Picked earlier; the current filters hide them. They stay picked.">
                  <Icon name="filter" />{hiddenIds.length} not shown here
                </span>
              ) : null}
            </span>
          ) : null}
          <span className="sel-bar-detail">{action.detail(count, selectedIds)}</span>
          <span className="sel-bar-actions">
            <button className="btn btn-primary" onClick={() => action.run(selectedIds)} type="button">{action.label(count, selectedIds)}</button>
            {more.length ? (
              <Popover button={<>More<Icon name="chevron-down" /></>} buttonClassName="btn" label="More actions" title="More actions">
                {(close) => (
                  <ul className="more-list">
                    {more.map((entry) => (
                      <li key={entry.label}><button className="more-item" onClick={() => { close(); entry.run(selectedIds); }} type="button">{entry.label}</button></li>
                    ))}
                  </ul>
                )}
              </Popover>
            ) : null}
            {tray
              ? <button className="btn" onClick={() => setSelection(NO_SELECTION)} title="Clear every pick (Esc)" type="button"><Icon name="close" />Clear</button>
              : <button aria-label="Clear selection" className="icon-button" onClick={() => setSelection(NO_SELECTION)} title="Clear selection (Esc)" type="button"><Icon name="close" /></button>}
          </span>
          {tray ? (
            <details className="sel-tray-picks">
              <summary>See every pick<Icon className="sel-group-chevron" name="chevron-down" /></summary>
              <ul aria-label="Picked" className="sel-tray-list">
                {tray.groups.flatMap((group) => group.items.map((item) => {
                  const id = getId(item);
                  return (
                    <li data-hidden={!shownSet.has(id) || undefined} data-tone={toneOf?.(item) ?? undefined} key={id}>
                      <span className="sel-tray-name">{rowName(item)}</span>
                      <small>{group.label}{shownSet.has(id) ? "" : " · not shown here"}</small>
                      <button aria-label={`Remove ${rowName(item)} from the picks`} className="icon-button" onClick={() => setSelection((current) => toggleOne(current, id))} title="Remove from the picks" type="button"><Icon name="close" /></button>
                    </li>
                  );
                }))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
