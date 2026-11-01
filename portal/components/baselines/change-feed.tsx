"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { RiskChip } from "@/components/baselines/parts";
import { BaselinesStyles } from "@/components/baselines/styles";
import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { SelectableList, type Grouping } from "@/components/list/selectable-list";
import { Segmented } from "@/components/pickers/segmented";
import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Verdict } from "@/components/verdict";
import {
  CHANGE_WORDS, FEED_GROUPING_KEYS, FEED_GROUPING_LABELS, PRIORITY_WORDS, SOURCE_WORDS, feedCsv, feedGroupLabel, feedGroups, feedObjectName, feedPersonName, feedSummary,
  type ChangeFeedData, type FeedPeriod, type FeedPriority, type FeedRow, FEED_PERIODS,
} from "@/lib/change-feed-view";
import { addsWords, applyFilters, readPicked, tileCounts, tileParam, withoutTile, type FilterTile } from "@/lib/filter-set";
import type { RiskTone } from "@/lib/menu-status";
import { byText, byTime } from "@/lib/paging";
import { ago, formatTimestamp } from "@/lib/presentation";
import { serviceFor, serviceOrder } from "@/lib/services";
import { useViewState } from "@/lib/use-view-state";

// Changes > Every change (insights track, IN-FEED): every change Keel knows about, from
// backups, service reads and the Microsoft audit log, as one list. Grouped by day, type,
// service, priority or who (kept in the address as `group`); the priority tiles add up
// (`priority=critical,high`). Read-only: deciding on a change happens under Open changes.

const PRIORITY_TONES: Record<FeedPriority, RiskTone | null> = { critical: "urgent", high: "soon", normal: "low", low: null };
const PRIORITY_ICONS: Record<FeedPriority, IconName> = { critical: "alert", high: "clock", normal: "info", low: "check" };
const PRIORITY_ABOUT: Record<FeedPriority, string> = {
  critical: "Can lock admins or users out of the tenant",
  high: "Changes who can sign in or reach data",
  normal: "Changes access to some apps, devices or data",
  low: "Labels, templates or records",
};
const PRIORITIES = Object.keys(PRIORITY_WORDS) as FeedPriority[];
const toneOf = (row: FeedRow): RiskTone | null => PRIORITY_TONES[row.priority] ?? null;
const NOUN = { one: "change", many: "changes" };
const changesWord = (count: number) => `${count} ${count === 1 ? "change" : "changes"}`;

const TILES: FilterTile<FeedRow>[] = PRIORITIES.map((priority) => ({ key: priority, test: (row) => row.priority === priority }));

function groupAbout(group: { count: number; priorities: Record<FeedPriority, number> }): string {
  const urgent = PRIORITIES.filter((priority) => priority === "critical" || priority === "high")
    .filter((priority) => group.priorities[priority] > 0)
    .map((priority) => `${group.priorities[priority]} ${PRIORITY_WORDS[priority].toLowerCase()}`);
  return [changesWord(group.count), ...urgent].join(" · ");
}

function groupIcon(by: (typeof FEED_GROUPING_KEYS)[number], key: string, rows: FeedRow[]): IconName {
  if (by === "service") return serviceFor(key === "other" ? null : key).icon;
  if (by === "priority") return PRIORITY_ICONS[key as FeedPriority] ?? "info";
  if (by === "person") return key === "unknown" ? "info" : rows[0]?.person?.kind === "servicePrincipal" ? "settings" : "person";
  if (by === "day") return "calendar";
  return serviceFor(rows[0]?.service).icon;
}

function groupings(now: string): Grouping<FeedRow>[] {
  return FEED_GROUPING_KEYS.map((by) => ({
    key: by,
    label: FEED_GROUPING_LABELS[by],
    groupsOf: (items: FeedRow[]) => {
      const groups = feedGroups(items, by).map((group) => ({
        key: group.key,
        label: by === "service" ? serviceFor(group.key === "other" ? null : group.key).name : feedGroupLabel(group, by, now),
        icon: groupIcon(by, group.key, group.rows),
        about: groupAbout(group),
        items: group.rows,
      }));
      // Services in the order every other list uses.
      return by === "service" ? groups.sort((a, b) => serviceOrder(a.key === "other" ? null : a.key) - serviceOrder(b.key === "other" ? null : b.key)) : groups;
    },
  }));
}

const SORTS = [
  { key: "when", label: "When", desc: true, compare: (a: FeedRow, b: FeedRow) => byTime(a.occurredAt, b.occurredAt) },
  { key: "who", label: "Who", compare: (a: FeedRow, b: FeedRow) => byText(feedPersonName(a), feedPersonName(b)) },
];

function rowText(row: FeedRow): string {
  return [feedObjectName(row), row.typeName, row.service ?? "", CHANGE_WORDS[row.change], row.activity ?? "", feedPersonName(row), SOURCE_WORDS[row.source].label].join(" ").toLowerCase();
}

export function ChangeFeed({ feed, period }: { feed: ChangeFeedData; period: FeedPeriod }) {
  const router = useRouter();
  const view = useViewState();
  const now = feed.generatedAt;
  const picked = readPicked(TILES, view.get("priority"));
  const shown = useMemo(() => applyFilters(feed.rows, TILES, picked), [feed.rows, picked.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => new Map(tileCounts(feed.rows, TILES, picked).map((entry) => [entry.key, entry])), [feed.rows, picked.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const lists = useMemo(() => groupings(now), [now]);
  const summary = feedSummary(feed.rows);
  const activeFilters: ActiveFilter[] = picked.map((priority) => ({ key: `priority:${priority}`, label: `${PRIORITY_WORDS[priority as FeedPriority]} priority`, clear: { priority: withoutTile(picked, priority) } }));

  function choosePeriod(next: FeedPeriod) {
    const params = new URLSearchParams(window.location.search);
    if (next === "30") params.delete("days"); else params.set("days", next);
    params.delete("page");
    router.push(`${window.location.pathname}?${params.toString()}`);
  }

  function exportCsv(ids: string[]) {
    const chosen = feed.rows.filter((row) => ids.includes(row.id));
    const blob = new Blob([feedCsv(chosen)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `keel-changes-${now.slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="bl-page cf-page">
      <BaselinesStyles />
      <style href="keel-change-feed" precedence="default">{CSS}</style>
      <Verdict
        detail={feed.truncated ? `Only the newest ${feed.rows.length} are listed. Pick a shorter period to see all of them.` : undefined}
        text={summary.text}
        tone={summary.tone}
      />

      <div className="cf-tools">
        <Segmented label="Period" onChange={choosePeriod} options={FEED_PERIODS.map((value) => ({ value, label: `${value} days` }))} value={period} />
        <p className="bl-help"><Icon name="info" /> Every change from backups, service reads and the Microsoft audit log. To accept or undo one, use Open changes.</p>
      </div>

      <section aria-label="Changes by priority" className="cf-tiles">
        {PRIORITIES.map((priority) => {
          const entry = counts.get(priority);
          const active = picked.includes(priority);
          const adds = addsWords(entry, picked.length);
          return (
            <button
              aria-current={active || undefined}
              aria-pressed={active}
              className="cf-tile"
              data-tone={PRIORITY_TONES[priority] ?? undefined}
              key={priority}
              onClick={() => view.set({ priority: tileParam(TILES, picked, priority), page: null })}
              title={active ? "Picked: click to remove it from the view" : "Click to add these to the view"}
              type="button"
            >
              <span className="cf-tile-label"><Icon name={PRIORITY_ICONS[priority]} />{PRIORITY_WORDS[priority]}{active ? <Icon className="tile-check" name="check" /> : null}</span>
              <b className="cf-tile-count">{entry?.count ?? 0}</b>
              <small>{PRIORITY_ABOUT[priority]}</small>
              {adds ? <small className="tile-adds">{adds}</small> : null}
            </button>
          );
        })}
      </section>

      <ActiveFilters filters={activeFilters} noun={NOUN} shown={shown.length} total={feed.rows.length} />

      <section aria-labelledby="feed-heading" className="bl-section">
        <h2 className="visually-hidden" id="feed-heading">Every change</h2>
        {feed.rows.length === 0 ? (
          <div className="bl-card bl-empty">
            <span aria-hidden="true" className="bl-kind-icon" data-tone="fine"><Icon name="check" /></span>
            <div><h3>No changes in the last {period} days</h3><p>Keel lists a change here once a backup, a service read or the audit log finds it.</p></div>
          </div>
        ) : (
          <SelectableList
            action={{
              label: (count) => `Export ${changesWord(count)} as CSV`,
              detail: () => "Saves a spreadsheet of the chosen changes, with names as this page shows them.",
              run: exportCsv,
            }}
            empty={<NoMatches filters={activeFilters} noun={NOUN} />}
            getId={(row) => row.id}
            groupings={lists}
            items={shown}
            label="Every change"
            matches={(row, text) => rowText(row).includes(text.trim())}
            noun={NOUN}
            partial={feed.truncated ? `Only the newest ${feed.rows.length} are listed. Pick a shorter period to see all of them.` : null}
            renderRow={(row) => (
              <div className="bl-row cf-row" data-source={row.source}>
                <span aria-hidden="true" className="bl-kind-icon" data-tone={toneOf(row) ?? undefined}><Icon name={serviceFor(row.service).icon} /></span>
                <span className="bl-row-name">
                  <span className="cf-row-title"><b>{feedObjectName(row)}</b>{row.object.status === "deleted" ? <span className="cf-gone"> (deleted)</span> : null}</span>
                  <small>{[row.typeName, CHANGE_WORDS[row.change], row.activity].filter(Boolean).join(" · ")}</small>
                </span>
                <RiskChip tone={toneOf(row)}>{PRIORITY_WORDS[row.priority]}</RiskChip>
                <span className="bl-row-who">
                  <span>{feedPersonName(row)}</span>
                  <small><time dateTime={row.occurredAt} title={`${formatTimestamp(row.occurredAt)} · ${SOURCE_WORDS[row.source].about}`}>{ago(row.occurredAt, now)}</time> · {SOURCE_WORDS[row.source].label}</small>
                </span>
              </div>
            )}
            rowName={(row) => `${feedObjectName(row)}, ${CHANGE_WORDS[row.change].toLowerCase()}`}
            sorts={SORTS}
            toneOf={toneOf}
          />
        )}
        <TechnicalDetails summary="Technical details: these changes">
          <RecordField copy={false} label="Read with" value="GET /api/changes/feed?by=day|type|service|priority|person&days=30" />
          {feed.rows.map((row) => (
            <RecordField key={row.id} label={`Change feed ID · ${row.type}`} usage={`${SOURCE_WORDS[row.source].label}. Setting ${row.object.key}${row.person ? `, by ${row.person.kind} ${row.person.id}` : ""}, at ${row.occurredAt}`} value={row.id} />
          ))}
        </TechnicalDetails>
      </section>
    </div>
  );
}

const CSS = `
.cf-tools { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: var(--space-sm) var(--space-md); }
.cf-tools .segmented { display: inline-flex; width: auto; }
.cf-tools .bl-help { display: flex; align-items: center; gap: var(--space-2xs); max-width: 36rem; }
.cf-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-sm); }
.cf-tile { display: grid; gap: var(--space-2xs); padding: var(--space-sm) var(--space-md); border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.cf-tile:hover { border-color: var(--line-strong); background: var(--surface-raised); }
.cf-tile:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.cf-tile[aria-current] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.cf-tile-label { display: flex; align-items: center; gap: var(--space-2xs); color: var(--text-soft); font-size: 0.8125rem; font-weight: 600; }
.cf-tile[data-tone="urgent"] .cf-tile-label { color: var(--urgent); }
.cf-tile[data-tone="soon"] .cf-tile-label { color: var(--check-soon); }
.cf-tile[data-tone="low"] .cf-tile-label { color: var(--low-risk); }
.cf-tile-count { font-size: 1.5rem; font-weight: 700; line-height: 1.1; }
.cf-tile small { color: var(--text-soft); font-size: 0.75rem; line-height: 1.35; }
.cf-row-title { overflow-wrap: anywhere; }
.cf-gone { color: var(--text-soft); font-weight: 400; }
@media (max-width: 40rem) {
  .cf-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;
