"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Icon, type IconName } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import {
  recordBadges, recordKind, recordNote, recordService, recordTime, recordTitle, recordTone, sourceLabel, windowSentence,
  type AnswerRecord,
} from "@/lib/ask-view";
import { serviceOrder } from "@/lib/services";

// The records an answer rests on, as one table: filter tiles (the same kind adds up,
// search narrows), grouping, sorting, and pages with a page-size picker.

const PAGE_SIZES = [10, 25, 50, 100] as const;
const TONE_RANK: Record<string, number> = { urgent: 0, soon: 1, low: 2, fine: 3, neutral: 4 };

type GroupKey = "service" | "kind" | "risk" | "none";
type SortKey = "newest" | "oldest" | "risk" | "name";

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: "service", label: "Service" },
  { key: "kind", label: "Kind of setting" },
  { key: "risk", label: "Risk" },
  { key: "none", label: "No grouping" },
];
const SORTS: { key: SortKey; label: string }[] = [
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "risk", label: "Highest risk first" },
  { key: "name", label: "Name, A to Z" },
];

interface Row {
  record: AnswerRecord;
  title: string;
  badges: { tone: string; label: string }[];
  tone: string;
  time: string;
  service: { code: string; name: string; icon: string };
  kind: string;
}

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

function compare(a: Row, b: Row, sort: SortKey): number {
  switch (sort) {
    case "oldest": return a.time.localeCompare(b.time) || a.title.localeCompare(b.title);
    case "risk": return (TONE_RANK[a.tone] ?? 9) - (TONE_RANK[b.tone] ?? 9) || b.time.localeCompare(a.time);
    case "name": return a.title.localeCompare(b.title);
    default: return b.time.localeCompare(a.time) || a.title.localeCompare(b.title);
  }
}

export function AskRecords({ records }: { records: AnswerRecord[] }) {
  const rows = useMemo<Row[]>(() => records.map((record) => ({
    record, title: recordTitle(record), badges: recordBadges(record), tone: recordTone(record),
    time: recordTime(record), service: recordService(record), kind: recordKind(record),
  })), [records]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<GroupKey>(records.some((record) => record.kind === "job") ? "none" : "service");
  const [sort, setSort] = useState<SortKey>("newest");
  const [size, setSize] = useState<number>(25);
  const [page, setPage] = useState(0);

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
  const columns = useMemo(() => [...new Set(tiles.map((tile) => tile.column))], [tiles]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => columns.every((column) => {
      const picked = tiles.filter((tile) => tile.column === column && chosen.has(tile.label));
      return !picked.length || picked.some((tile) => row.badges[column]?.label === tile.label);
    }) && (!needle || `${row.title} ${row.kind} ${row.service.name}`.toLowerCase().includes(needle)));
  }, [rows, columns, tiles, chosen, query]);

  const ordered = useMemo(() => [...shown].sort((a, b) => {
    const left = groupOf(a, group).rank;
    const right = groupOf(b, group).rank;
    const byGroup = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    const byKind = group === "service" ? kindRank(a.kind) - kindRank(b.kind) || a.kind.localeCompare(b.kind) : 0;
    return byGroup || byKind || compare(a, b, sort);
  }), [shown, group, sort]);

  const pages = Math.max(1, Math.ceil(ordered.length / size));
  const current = Math.min(page, pages - 1);
  const slice = ordered.slice(current * size, current * size + size);
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of ordered) counts.set(groupOf(row, group).key, (counts.get(groupOf(row, group).key) ?? 0) + 1);
    return counts;
  }, [ordered, group]);

  const toggle = (label: string) => {
    setChosen((before) => {
      const next = new Set(before);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
    setPage(0);
  };

  let lastGroup: string | null = null;
  return (
    <div className="ak-records">
      <div aria-label="Filter the records" className="ak-filters" role="group">
        {tiles.map((tile) => (
          <button aria-pressed={chosen.has(tile.label)} className="ak-filter" data-tone={tile.tone} key={tile.label} onClick={() => toggle(tile.label)} type="button">
            <span>{tile.label}</span><b>{tile.count}</b>
          </button>
        ))}
        {chosen.size ? <button className="btn btn-sm ak-clear" onClick={() => { setChosen(new Set()); setPage(0); }} type="button">Clear filters</button> : null}
      </div>
      <div className="ak-controls">
        <label className="filter-field ak-search"><span>Find</span>
          <input onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Name, kind or service" type="search" value={query} />
        </label>
        <label className="filter-field"><span>Group by</span>
          <select onChange={(event) => { setGroup(event.target.value as GroupKey); setPage(0); }} value={group}>
            {GROUPS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </label>
        <label className="filter-field"><span>Sort</span>
          <select onChange={(event) => setSort(event.target.value as SortKey)} value={sort}>
            {SORTS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </label>
      </div>
      {slice.length ? (
        <div className="pg-table-wrap">
          <table aria-label="Records this answer rests on" className="pg-table">
            <thead><tr><th scope="col">What</th><th scope="col">State</th><th scope="col">When</th><th scope="col">Where it comes from</th></tr></thead>
            <tbody>
              {slice.flatMap((row) => {
                const entry = groupOf(row, group);
                const out = [];
                if (group !== "none" && entry.key !== lastGroup) {
                  lastGroup = entry.key;
                  out.push(
                    <tr className="pg-group" key={`group-${entry.key}`}>
                      <th colSpan={4} scope="colgroup"><span className="ak-group">{entry.icon ? <Icon name={entry.icon as IconName} /> : null}{entry.label}<small>{groupCounts.get(entry.key) ?? 0}</small></span></th>
                    </tr>,
                  );
                }
                const record = row.record;
                out.push(
                  <tr className={`ask-record ask-record-${record.kind}`} data-tone={row.tone} key={record.id}>
                    <th scope="row"><span className="pg-row-name">{row.title}</span>{group !== "kind" && record.kind !== "job" && !row.title.toLowerCase().includes(`(${row.kind.toLowerCase()})`) ? <small>{row.kind}</small> : null}</th>
                    <td data-label="State">
                      <span className="ask-badges">{row.badges.map((badge) => <Badge key={badge.label} tone={badge.tone as "urgent"}>{badge.label}</Badge>)}</span>
                      {recordNote(record) ? <small>{recordNote(record)}</small> : null}
                    </td>
                    <td data-label="When"><span className="ask-record-window">{windowSentence(record)}</span></td>
                    <td data-label="Source"><Link href={record.source.href}>{sourceLabel(record)}</Link></td>
                  </tr>,
                );
                return out;
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="pg-empty"><Icon name="filter" />No record matches these filters.</p>}
      <div className="ak-pager">
        <span className="ak-range" role="status">{ordered.length ? `${current * size + 1}–${Math.min(ordered.length, (current + 1) * size)} of ${ordered.length}` : "0 of 0"}</span>
        <label className="filter-field ak-size"><span>Rows per page</span>
          <select onChange={(event) => { setSize(Number(event.target.value)); setPage(0); }} value={size}>
            {PAGE_SIZES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button className="btn btn-sm" disabled={current === 0} onClick={() => setPage(current - 1)} type="button">Previous</button>
        <button className="btn btn-sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} type="button">Next</button>
      </div>
    </div>
  );
}
