"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { ListPager, SortControl, useListPaging, type ListSort } from "@/components/list/list-paging";
import { MultiOptionPicker, OptionPicker } from "@/components/pickers/option-picker";
import { Icon, type IconName } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import {
  recordBadges, recordFields, recordKind, recordNote, recordService, recordTime, recordTitle, recordTone, sourceLabel, windowSentence,
  type AnswerRecord,
} from "@/lib/ask-view";
import { byText, byTime, pageGroups } from "@/lib/paging";
import { serviceOrder } from "@/lib/services";

// The records an answer rests on, as one table: filter tiles (the same kind adds up,
// search narrows), grouping with groups that fold away, headers that sort, columns the
// reader picks, and the shared Order by, rows per page and pages.

const TONE_RANK: Record<string, number> = { urgent: 0, soon: 1, low: 2, fine: 3, neutral: 4 };

type GroupKey = "service" | "kind" | "risk" | "none";

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: "service", label: "Service" },
  { key: "kind", label: "Kind of setting" },
  { key: "risk", label: "Risk" },
  { key: "none", label: "No grouping" },
];

interface Row {
  record: AnswerRecord;
  title: string;
  badges: { tone: string; label: string }[];
  tone: string;
  time: string;
  service: { code: string; name: string; icon: string };
  kind: string;
  fields: string;
}

type ColumnKey = "what" | "kind" | "service" | "state" | "fields" | "when" | "source";

interface Column { key: ColumnKey; label: string; sort?: string; optional: boolean }

// "What" always shows; the rest the reader may hide. Kind and service are off at first:
// the name and the group already say them.
const COLUMNS: readonly Column[] = [
  { key: "what", label: "What", sort: "name", optional: false },
  { key: "kind", label: "Kind", sort: "kind", optional: true },
  { key: "service", label: "Service", sort: "service", optional: true },
  { key: "state", label: "State", sort: "risk", optional: true },
  { key: "fields", label: "Settings changed", sort: "fields", optional: true },
  { key: "when", label: "When", sort: "when", optional: true },
  { key: "source", label: "Where it comes from", optional: true },
];
const DEFAULT_COLUMNS: readonly ColumnKey[] = ["what", "state", "fields", "when", "source"];
const COLUMNS_KEY = "keel-ask-columns";

// Within a service, kinds follow the portal's order: people, groups, memberships, roles,
// then policies and rules, then everything else.
function kindRank(kind: string): number {
  const text = kind.toLowerCase();
  const order = [/\buser|person|people/, /\bgroup/, /member/, /\brole/, /polic|rule/];
  const index = order.findIndex((pattern) => pattern.test(text));
  return index === -1 ? order.length : index;
}

function groupOf(row: Row, by: GroupKey): { key: string; label: string; icon?: string; rank: number | string } {
  switch (by) {
    case "service": return { key: row.service.code, label: row.service.name, icon: row.service.icon, rank: serviceOrder(row.service.code) };
    case "kind": return { key: row.kind, label: row.kind, icon: row.service.icon, rank: `${String(serviceOrder(row.service.code)).padStart(3, "0")}${row.kind}` };
    case "risk": {
      const risk = row.badges.at(-1) ?? { tone: "neutral", label: "Not rated" };
      return { key: risk.label, label: risk.label, rank: TONE_RANK[risk.tone] ?? 9 };
    }
    default: return { key: "all", label: "", rank: 0 };
  }
}

// Sorts within each group. With no sort chosen the newest change comes first.
const SORTS: readonly ListSort<Row>[] = [
  { key: "when", label: "When", desc: true, compare: (a, b) => byTime(a.time, b.time) },
  { key: "risk", label: "Risk", desc: true, compare: (a, b) => (TONE_RANK[b.tone] ?? 9) - (TONE_RANK[a.tone] ?? 9) },
  { key: "name", label: "Name", compare: (a, b) => byText(a.title, b.title) },
  { key: "kind", label: "Kind", compare: (a, b) => byText(a.kind, b.kind) },
  { key: "service", label: "Service", compare: (a, b) => byText(a.service.name, b.service.name) },
  { key: "fields", label: "Settings changed", compare: (a, b) => byText(a.fields || "\uffff", b.fields || "\uffff") },
];

/** The columns this reader chose last time, kept in this browser only. */
function useColumns(hasFields: boolean): [ColumnKey[], (next: ColumnKey[]) => void] {
  const fallback = DEFAULT_COLUMNS.filter((key) => hasFields || key !== "fields");
  const [chosen, setChosen] = useState<ColumnKey[] | null>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(COLUMNS_KEY) ?? "null");
      if (Array.isArray(saved)) setChosen(COLUMNS.filter((column) => saved.includes(column.key)).map((column) => column.key));
    } catch { /* no saved choice */ }
  }, []);
  const save = (next: ColumnKey[]) => {
    const keys = COLUMNS.filter((column) => !column.optional || next.includes(column.key)).map((column) => column.key);
    setChosen(keys);
    try { window.localStorage.setItem(COLUMNS_KEY, JSON.stringify(keys)); } catch { /* storage off */ }
  };
  const keys = (chosen ?? fallback).filter((key) => key !== "what");
  return [["what", ...keys], save];
}
const SUGGESTED = (a: Row, b: Row) => byTime(b.time, a.time) || byText(a.title, b.title);

export function AskRecords({ records }: { records: AnswerRecord[] }) {
  const rows = useMemo<Row[]>(() => records.map((record) => ({
    record, title: recordTitle(record), badges: recordBadges(record), tone: recordTone(record),
    time: recordTime(record), service: recordService(record), kind: recordKind(record), fields: recordFields(record),
  })), [records]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<GroupKey>(records.some((record) => record.kind === "job") ? "none" : "service");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const paging = useListPaging<Row>({ prefix: "rec-", sorts: SORTS });
  const hasFields = rows.some((row) => row.fields);
  const [columns, setColumns] = useColumns(hasFields);
  const shownColumns = COLUMNS.filter((column) => columns.includes(column.key));

  // Filter tiles: one per badge label, counted over every row. Tiles of the same column
  // (what changed, or risk) add up; the search box narrows what they keep.
  const tiles = useMemo(() => {
    const map = new Map<string, { label: string; tone: string; count: number; column: number }>();
    for (const row of rows) row.badges.forEach((badge, column) => {
      const entry = map.get(badge.label) ?? { label: badge.label, tone: badge.tone, count: 0, column };
      entry.count += 1;
      map.set(badge.label, entry);
    });
    return [...map.values()].sort((a, b) => a.column - b.column || (TONE_RANK[a.tone] ?? 9) - (TONE_RANK[b.tone] ?? 9));
  }, [rows]);
  const badgeColumns = useMemo(() => [...new Set(tiles.map((tile) => tile.column))], [tiles]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => badgeColumns.every((column) => {
      const picked = tiles.filter((tile) => tile.column === column && chosen.has(tile.label));
      return !picked.length || picked.some((tile) => row.badges[column]?.label === tile.label);
    }) && (!needle || `${row.title} ${row.kind} ${row.service.name} ${row.fields}`.toLowerCase().includes(needle)));
  }, [rows, badgeColumns, tiles, chosen, query]);

  // Groups in order, each with its rows sorted: by the header or Order by chosen, else newest first.
  const groups = useMemo(() => {
    const sign = paging.dir === "desc" ? -1 : 1;
    const byRow = (a: Row, b: Row) => (group === "service" && !paging.sort ? kindRank(a.kind) - kindRank(b.kind) || a.kind.localeCompare(b.kind) : 0)
      || (paging.sort ? sign * paging.sort.compare(a, b) : 0) || SUGGESTED(a, b);
    const map = new Map<string, { key: string; label: string; icon?: string; rank: number | string; rows: Row[] }>();
    for (const row of shown) {
      const entry = groupOf(row, group);
      const found = map.get(entry.key) ?? { ...entry, rows: [] };
      found.rows.push(row);
      map.set(entry.key, found);
    }
    return [...map.values()].map((entry) => ({ ...entry, rows: [...entry.rows].sort(byRow) })).sort((a, b) => (
      typeof a.rank === "number" && typeof b.rank === "number" ? a.rank - b.rank : String(a.rank).localeCompare(String(b.rank))
    ));
  }, [shown, group, paging.sort, paging.dir]);

  const grouped = group !== "none";
  const isClosed = (entry: { key: string }) => grouped && closed.has(entry.key);
  const { groups: paged, total: open } = pageGroups(groups, (entry) => entry.rows.length, isClosed, paging.pageOf(groups.reduce((sum, entry) => sum + (isClosed(entry) ? 0 : entry.rows.length), 0)), paging.size);
  const restart = () => paging.setPage(1);

  const toggle = (label: string) => {
    setChosen((before) => {
      const next = new Set(before);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
    restart();
  };
  const toggleGroup = (key: string) => setClosed((before) => {
    const next = new Set(before);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // A header sorts by its column; the same header again flips the direction.
  const sortBy = (key: string) => {
    if (paging.sort?.key === key) paging.setDir(paging.dir === "desc" ? "asc" : "desc");
    else paging.setSort(key);
  };

  const cell = (row: Row, key: ColumnKey) => {
    const record = row.record;
    switch (key) {
      case "kind": return <td data-label="Kind" key={key}>{row.kind}</td>;
      case "service": return <td data-label="Service" key={key}><span className="ak-service"><Icon name={row.service.icon as IconName} />{row.service.name}</span></td>;
      case "state": return (
        <td data-label="State" key={key}>
          <span className="ask-badges">{row.badges.map((badge) => <Badge key={badge.label} tone={badge.tone as "urgent"}>{badge.label}</Badge>)}</span>
          {recordNote(record) ? <small>{recordNote(record)}</small> : null}
        </td>
      );
      case "fields": return <td data-label="Settings changed" key={key}>{row.fields ? <span className="ak-fields">{row.fields}</span> : <span className="ak-none">{record.kind === "change" && record.changeType !== "modified" ? "The whole item" : "Not recorded"}</span>}</td>;
      case "when": return <td data-label="When" key={key}><span className="ask-record-window">{windowSentence(record)}</span></td>;
      case "source": return <td data-label="Source" key={key}><Link href={record.source.href}>{sourceLabel(record)}</Link></td>;
      default: return null;
    }
  };

  return (
    <div className="ak-records">
      <div aria-label="Filter the records" className="ak-filters" role="group">
        {tiles.map((tile) => (
          <button aria-pressed={chosen.has(tile.label)} className="ak-filter" data-tone={tile.tone} key={tile.label} onClick={() => toggle(tile.label)} type="button">
            <span>{tile.label}</span><b>{tile.count}</b>
          </button>
        ))}
        {chosen.size ? <button className="btn btn-sm ak-clear" onClick={() => { setChosen(new Set()); restart(); }} type="button">Clear filters</button> : null}
      </div>
      <div className="ak-controls">
        <label className="filter-field ak-search"><span>Find</span>
          <input onChange={(event) => { setQuery(event.target.value); restart(); }} placeholder="Name, kind, service or setting" type="search" value={query} />
        </label>
        <OptionPicker label="Group by" onChange={(next) => { setGroup(next); setClosed(new Set()); restart(); }} options={GROUPS.map((option) => ({ value: option.key, label: option.label }))} value={group} />
        <SortControl paging={paging} sorts={SORTS} />
        <MultiOptionPicker
          anyLabel="Only the name"
          label="Columns"
          onChange={(next) => setColumns(next as ColumnKey[])}
          options={COLUMNS.filter((column) => column.optional).map((column) => ({ value: column.key, label: column.label }))}
          values={columns.filter((key) => key !== "what")}
        />
        {grouped && groups.length > 1 ? (
          <button className="btn ak-fold" onClick={() => setClosed(closed.size === groups.length ? new Set() : new Set(groups.map((entry) => entry.key)))} type="button">
            <Icon name={closed.size === groups.length ? "chevron-down" : "chevron"} />{closed.size === groups.length ? "Open all groups" : "Fold all groups"}
          </button>
        ) : null}
      </div>
      {paged.length ? (
        <div className="pg-table-wrap">
          <table aria-label="Records this answer rests on" className="pg-table ak-table">
            <thead>
              <tr>
                {shownColumns.map((column) => {
                  const active = column.sort && paging.sort?.key === column.sort;
                  return (
                    <th aria-sort={active ? (paging.dir === "desc" ? "descending" : "ascending") : undefined} key={column.key} scope="col">
                      {column.sort ? (
                        <button className="ak-sort" data-active={active || undefined} onClick={() => sortBy(column.sort!)} title={`Order by ${column.label.toLowerCase()}`} type="button">
                          {column.label}<Icon name={active ? (paging.dir === "desc" ? "down" : "up") : "swap"} />
                        </button>
                      ) : column.label}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {paged.flatMap(({ group: entry, start, end, continued }) => {
                const out = [];
                const folded = isClosed(entry);
                if (grouped) {
                  out.push(
                    <tr className="pg-group" data-closed={folded || undefined} key={`group-${entry.key}`}>
                      <th colSpan={shownColumns.length} scope="colgroup">
                        <button aria-expanded={!folded} className="ak-group ak-group-toggle" onClick={() => { toggleGroup(entry.key); }} type="button">
                          <Icon className="ak-group-chevron" name="chevron-down" />
                          {entry.icon ? <Icon name={entry.icon as IconName} /> : null}{entry.label}<small>{entry.rows.length}</small>
                          {continued && !folded ? <em className="ak-continued">continued</em> : null}
                        </button>
                      </th>
                    </tr>,
                  );
                }
                for (const row of entry.rows.slice(start, end)) {
                  const record = row.record;
                  out.push(
                    <tr className={`ask-record ask-record-${record.kind}`} data-tone={row.tone} key={record.id}>
                      <th scope="row"><span className="pg-row-name">{row.title}</span>{!columns.includes("kind") && group !== "kind" && record.kind !== "job" && !row.title.toLowerCase().includes(`(${row.kind.toLowerCase()})`) ? <small>{row.kind}</small> : null}</th>
                      {shownColumns.filter((column) => column.key !== "what").map((column) => cell(row, column.key))}
                    </tr>,
                  );
                }
                return out;
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="pg-empty"><Icon name="filter" />No record matches these filters.</p>}
      <ListPager label="Records this answer rests on" noun={{ one: "record", many: "records" }} paging={paging} total={open} />
    </div>
  );
}
