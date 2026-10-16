"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { SavedFilters } from "@/components/list/saved-filters";
import { Segmented } from "@/components/pickers/segmented";
import { StatusBadge } from "@/components/shell/menu";
import { Icon, type IconName } from "@/components/shell/icons";
import { Popover } from "@/components/shell/popover";
import { worstTone, type RiskTone } from "@/lib/menu-status";
import { groupCheck, NO_SELECTION, prune, selectRange, setMany, span, toggleOne, type Selection } from "@/lib/selection";
import { readList, useViewState } from "@/lib/use-view-state";

export interface ListGroup<T> {
  key: string;
  label: string;
  icon?: IconName;
  // One plain line under the name: what the group holds.
  about?: string;
  items: T[];
}

export interface Grouping<T> {
  key: string;
  label: string;
  groupsOf: (items: T[]) => ListGroup<T>[];
}

export interface ListAction {
  // Names the action with the count, in plain words: "Restore 12 settings".
  label: (count: number) => string;
  // What happens, before it happens.
  detail: (count: number) => string;
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
export function SelectableList<T>({ label, items, getId, rowName, renderRow, groupings, toneOf, noun, action, more = [], matches }: Props<T>) {
  const view = useViewState();
  const groupKey = view.get("group", groupings[0]?.key ?? "");
  const grouping = groupings.find((entry) => entry.key === groupKey) ?? groupings[0];
  const query = view.get("q");
  const closed = readList(view.get("closed"));
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [touchMode, setTouchMode] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => (matches && query ? items.filter((item) => matches(item, query.toLowerCase())) : items), [items, matches, query]);
  const groups = useMemo(() => grouping.groupsOf(filtered), [grouping, filtered]);
  const allIds = useMemo(() => groups.flatMap((group) => group.items.map(getId)), [groups, getId]);
  const visibleIds = useMemo(() => groups.filter((group) => !closed.includes(group.key)).flatMap((group) => group.items.map(getId)), [groups, closed, getId]);

  // A filter that hides rows also drops them from the selection.
  useEffect(() => { setSelection((current) => prune(current, allIds)); }, [allIds]);
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

  const count = selection.ids.size;
  const selectedIds = allIds.filter((id) => selection.ids.has(id));

  return (
    <div className="sel-list" data-touch-mode={touchMode || undefined}>
      <div className="sel-toolbar">
        {groupings.length > 1 ? (
          <Segmented
            label="Group by"
            onChange={(value) => view.set({ group: value, closed: null }, { group: groupings[0].key })}
            options={groupings.map((entry) => ({ value: entry.key, label: entry.label }))}
            value={grouping.key}
          />
        ) : null}
        {matches ? (
          <label className="picker-field sel-find">
            <span className="picker-label">Find</span>
            <span className="sel-find-box">
              <Icon name="search" />
              <input className="bare-input" onChange={(event) => view.set({ q: event.target.value })} placeholder={`Find ${noun.many}`} type="search" value={query} />
            </span>
          </label>
        ) : null}
        <SavedFilters />
      </div>
      <div className="sel-summary">
        <button
          aria-pressed={count > 0 && count === allIds.length}
          className="btn btn-sm"
          disabled={!allIds.length}
          onClick={() => setSelection((current) => setMany(current, allIds, count !== allIds.length))}
          type="button"
        >
          {count > 0 && count === allIds.length ? "Clear selection" : `Select all ${plural(allIds.length, noun)}`}
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
        {groups.map((group) => {
          const ids = group.items.map(getId);
          const check = groupCheck(selection, ids);
          const isClosed = closed.includes(group.key);
          const tone = toneOf ? worstTone(group.items.map((item) => toneOf(item) ?? undefined)) : null;
          const attention = toneOf ? group.items.filter((item) => { const t = toneOf(item); return t === "urgent" || t === "soon"; }).length : 0;
          return (
            <section className="sel-group" data-closed={isClosed || undefined} key={group.key}>
              <header className="sel-group-head">
                <input
                  aria-label={`Select all ${plural(ids.length, noun)} in ${group.label}`}
                  checked={check === "all"}
                  className="sel-check"
                  onChange={() => setSelection((current) => setMany(current, ids, check !== "all"))}
                  ref={(element) => { if (element) element.indeterminate = check === "some"; }}
                  type="checkbox"
                />
                <button
                  aria-expanded={!isClosed}
                  className="sel-group-toggle"
                  onClick={() => view.set({ closed: (isClosed ? closed.filter((key) => key !== group.key) : [...closed, group.key]).join(",") })}
                  type="button"
                >
                  {group.icon ? <Icon name={group.icon} /> : null}
                  <span className="sel-group-name"><b>{group.label}</b>{group.about ? <small>{group.about}</small> : null}</span>
                  <span className="sel-group-count">{plural(ids.length, noun)}</span>
                  {tone && attention ? <StatusBadge status={{ tone, count: attention, note: `${attention} need${attention === 1 ? "s" : ""} attention` }} /> : null}
                  <Icon className="sel-group-chevron" name="chevron-down" />
                </button>
              </header>
              {isClosed ? null : (
                <ul className="sel-rows">
                  {group.items.map((item) => {
                    const id = getId(item);
                    const selected = selection.ids.has(id);
                    return (
                      <li className="sel-row" data-row-id={id} data-selected={selected || undefined} data-tone={toneOf?.(item) ?? undefined} key={id} onClick={(event) => onRowClick(event, id)}>
                        <input aria-label={`Select ${rowName(item)}`} checked={selected} className="sel-check" onChange={() => {}} type="checkbox" />
                        <div className="sel-row-body">{renderRow(item)}</div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
        {groups.length === 0 ? <p className="sel-empty">No {noun.many} match {query ? `“${query}”` : "this view"}.</p> : null}
      </div>
      {count ? (
        <div aria-label="Selection" className="sel-bar" role="region">
          <span className="sel-bar-count"><b>{plural(count, noun)}</b> selected</span>
          <span className="sel-bar-detail">{action.detail(count)}</span>
          <span className="sel-bar-actions">
            <button className="btn btn-primary" onClick={() => action.run(selectedIds)} type="button">{action.label(count)}</button>
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
            <button aria-label="Clear selection" className="icon-button" onClick={() => setSelection(NO_SELECTION)} title="Clear selection (Esc)" type="button"><Icon name="close" /></button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
