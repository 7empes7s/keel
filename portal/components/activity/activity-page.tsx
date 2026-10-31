"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { useBackup } from "@/components/backup-controls";
import { ChangedObjects, ChangedValuesStyles } from "@/components/changed-values";
import { DetailsSheet } from "@/components/baselines/details-sheet";
import { BaselinesStyles } from "@/components/baselines/styles";
import { ActiveFilters, NoMatches } from "@/components/list/active-filters";
import { type ListSort } from "@/components/list/list-paging";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { DatePicker } from "@/components/pickers/date-picker";
import { MultiOptionPicker } from "@/components/pickers/option-picker";
import { Segmented, type ChoiceOption } from "@/components/pickers/segmented";
import { Icon, type IconName } from "@/components/shell/icons";
import { JobRecordFields } from "@/components/job-table";
import { RecordField, RecordGroup, TechnicalDetails, type RecordValue } from "@/components/technical-details";
import { ErrorNotice } from "@/components/ui/error-notice";
import { Badge } from "@/components/ui/badge";
import { Person } from "@/components/ui/person";
import { Verdict } from "@/components/verdict";
import { postAction } from "@/lib/action-client";
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_ORDER,
  OUTCOMES,
  OUTCOME_ORDER,
  type ActivityKind,
  type Outcome,
  activityCounts,
  activityCsv,
  activityRows,
  activityVerdict,
  clockWords,
  dayKey,
  dayLabel,
  filterChips,
  integrityWords,
  isSelfApproved,
  outcomeTone,
  parseFilters,
  peopleIn,
  retryOf,
  rowHref,
  rowHrefLabel,
  rowMatches,
  tierWords,
  type ActivityPeople,
  type ActivityRow,
  type Retry,
} from "@/lib/activity-view";
import { changesQuery, type ActivityChanges } from "@/lib/changed-values";
import { rangeToParam, toDay, type DayRange } from "@/lib/date-range";
import type { ChainIntegrity, EvidenceEntry } from "@/lib/evidence";
import type { NamedKeys } from "@/lib/job-names";
import type { JobRecord } from "@/lib/portal-jobs";
import { byRisk, byText, byTime } from "@/lib/paging";
import { formatTimestamp } from "@/lib/presentation";
import { displayAccount } from "@/lib/record-refs";
import { type EngineRef, jobStatusSentence, personLabel } from "@/lib/sentences";
import { toast } from "@/lib/toast";
import { pushUrl } from "@/lib/url-history";
import { useViewState } from "@/lib/use-view-state";

// Activity (portal audit, pick A): a timeline by day. Four tiles count the last day's
// jobs, what failed, what is running or waiting, and whether the audit record is intact;
// each is a link that sets a filter in the address. Under them, one list of jobs and
// audit-record entries grouped by day (or kind, person, outcome), with a details panel
// per row (`open=`, pushed so Back closes it). Filters live in the address too, so the
// server page narrows what it loads to them and a reload or a saved view brings them
// back. Ids stay in one record at the foot of the page and in the panel.

const SHOW: ChoiceOption<"all" | "jobs" | "records">[] = [
  { value: "all", label: "Everything" },
  { value: "jobs", label: "Jobs" },
  { value: "records", label: "Audit record" },
];

// Order by: when, outcome (failures first) and what happened.
const SORTS: ListSort<ActivityRow>[] = [
  { key: "when", label: "When", desc: true, compare: (a, b) => byTime(a.at, b.at) },
  { key: "outcome", label: "Outcome", desc: true, compare: (a, b) => byRisk(outcomeTone(a.outcome), outcomeTone(b.outcome)) },
  { key: "what", label: "What happened", compare: (a, b) => byText(a.title, b.title) },
];

const SERVER_KEYS = { show: null, range: null, who: null, what: null, outcome: null, before: null };

export function ActivityPage({ canBackup, jobs, entries, integrity, people = {}, names = {}, now = new Date().toISOString(), nextBefore = null, notice = null }: {
  canBackup: boolean;
  // A page-wide note shown under the verdict, such as "Names hidden".
  notice?: ReactNode;
  jobs: JobRecord[];
  entries: EvidenceEntry[];
  integrity: ChainIntegrity | null;
  people?: ActivityPeople;
  names?: NamedKeys;
  now?: string;
  // The cursor for older audit entries, when the loaded page is not the last.
  nextBefore?: string | null;
}) {
  const router = useRouter();
  const view = useViewState();
  const pathname = usePathname() ?? "/activity";
  const params = useSearchParams();
  const get = (key: string) => params?.get(key) ?? null;
  const filters = useMemo(() => parseFilters(get), [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const opened = view.get("open");
  const before = view.get("before");
  const today = toDay(new Date(now));

  const rows = useMemo(() => activityRows(jobs, entries, people, names, now), [jobs, entries, people, names, now]);
  const shown = useMemo(() => rows.filter((row) => rowMatches(row, filters)), [rows, filters]);
  const counts = useMemo(() => activityCounts(jobs, now), [jobs, now]);
  const verdict = useMemo(() => activityVerdict(counts, filters.show !== "records", integrity), [counts, filters.show, integrity]);
  const record = integrityWords(integrity);
  const who = useMemo(() => peopleIn(rows, people, filters.who), [rows, people, filters.who]);

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    const text = next.toString();
    return text ? `${pathname}?${text}` : pathname;
  };
  // Filters the server applies go through the router, so it loads the narrowed page;
  // the open panel only moves the address.
  const navigate = (changes: Record<string, string | null>) => router.push(href({ open: null, before: null, ...changes }));
  const openPanel = (event: MouseEvent, id: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    pushUrl(href({ open: id }));
  };
  const closePanel = () => view.set({ open: null });

  // "Run again": a failed backup runs its tier again; a failed backup of every type
  // runs that again. Each is the same request the Backup page makes.
  const { backUp, busy: backupBusy, feedback } = useBackup();
  const collectKey = useRef<string | null>(null);
  const [collectBusy, setCollectBusy] = useState(false);
  async function runAgain(retry: Retry) {
    if (!retry || retry.kind === "plan") return;
    if (retry.kind === "backup" && retry.tier) { await backUp([retry.tier], "activity"); return; }
    setCollectBusy(true);
    collectKey.current ??= crypto.randomUUID();
    try {
      const { payload } = await postAction("/api/actions/collect", {}, collectKey.current);
      const job = payload.job as { id: string } | undefined;
      toast({ title: "Backup of every type queued", detail: "It only reads your tenant; nothing changes.", href: job ? `/jobs/${encodeURIComponent(job.id)}` : undefined, hrefLabel: job ? "View job" : undefined });
      collectKey.current = crypto.randomUUID();
      router.refresh();
    } catch {
      toast({ tone: "warning", title: "Keel could not queue the backup", detail: "Try again in a minute." });
    } finally {
      setCollectBusy(false);
    }
  }
  const retryBusy = backupBusy !== null || collectBusy;
  const retryLabel = (retry: Retry) => (retry?.kind === "backup" && retry.tier ? `Run the ${tierWords(retry.tier)} backup again` : "Run the backup again");

  const verdictAction = opened ? null
    : verdict.retry?.kind === "plan" ? { label: verdict.retry.label, href: verdict.retry.href }
    : verdict.retry && canBackup ? { label: retryLabel(verdict.retry), onClick: () => void runAgain(verdict.retry), busy: retryBusy }
    : null;

  // Tiles: the outcome tiles add up (`outcome=failed,running,waiting`); Audit record
  // narrows to the audit record; the first tile clears every filter. Each reloads the page.
  const outcomeTile = (keys: Outcome[]) => {
    const on = keys.some((key) => filters.outcomes.includes(key));
    const next = on ? filters.outcomes.filter((key) => !keys.includes(key)) : [...filters.outcomes, ...keys];
    return { changes: { outcome: OUTCOME_ORDER.filter((key) => next.includes(key)).join(",") || null, before: null }, active: on };
  };
  const failedTile = outcomeTile(["failed"]);
  const activeTile = outcomeTile(["running", "waiting"]);
  const tiles: { key: string; label: string; icon: IconName; value: string; small: string; changes: Record<string, string | null>; tone?: "urgent" | "soon"; active: boolean }[] = [
    { key: "jobs", label: "Jobs in the last day", icon: "swap", value: String(counts.jobsDay), small: "Each bar is a day; red is what failed", changes: { ...SERVER_KEYS }, active: filters.show === "all" && !filters.outcomes.length && !filters.what.length && !filters.who.length && !filters.range },
    { key: "failed", label: "Failed", icon: "x-circle", value: String(counts.failedDay), small: counts.failedWeek ? `${counts.failedWeek} failed in the last 7 days` : "Nothing failed in the last 7 days", changes: failedTile.changes, tone: counts.failedDay ? "urgent" : undefined, active: failedTile.active },
    { key: "active", label: "Running or waiting", icon: "play", value: String(counts.running + counts.waiting), small: counts.running + counts.waiting ? `${counts.running} running, ${counts.waiting} waiting to start` : "Nothing is running", changes: activeTile.changes, active: activeTile.active },
    { key: "record", label: "Audit record", icon: "audit", value: record.label, small: record.sentence, changes: { show: filters.show === "records" ? null : "records", before: null }, tone: record.state === "broken" ? "urgent" : record.state === "unchecked" ? "soon" : undefined, active: filters.show === "records" },
  ];

  const whoOptions: ChoiceOption<string>[] = who.map((person) => ({ value: person.id, label: person.name, icon: (person.system ? "clock" : undefined) as IconName | undefined }));
  const whatOptions: ChoiceOption<ActivityKind>[] = ACTIVITY_KIND_ORDER.map((kind) => ({ value: kind, label: ACTIVITY_KINDS[kind].label, icon: ACTIVITY_KINDS[kind].icon }));
  const outcomeOptions: ChoiceOption<Outcome>[] = OUTCOME_ORDER.map((outcome) => ({ value: outcome, label: OUTCOMES[outcome].plural, icon: OUTCOMES[outcome].icon }));
  const chips = filterChips(filters, people, today);
  const filtering = chips.length > 0;

  const groupings = useMemo<Grouping<ActivityRow>[]>(() => [
    { key: "day", label: "Day", groupsOf: (items) => groupBy(items, (item) => dayKey(item.at), (key, list) => ({ label: dayLabel(list[0].at, now), icon: "calendar", about: failedWords(list) }), (key) => (key === "unknown" ? Infinity : -Date.parse(key))) },
    { key: "kind", label: "Kind", groupsOf: (items) => groupBy(items, (item) => item.kind, (key, list) => ({ label: ACTIVITY_KINDS[key as keyof typeof ACTIVITY_KINDS].label, icon: ACTIVITY_KINDS[key as keyof typeof ACTIVITY_KINDS].icon, about: failedWords(list) }), (key) => ACTIVITY_KIND_ORDER.indexOf(key as never)) },
    { key: "who", label: "Person", groupsOf: (items) => groupBy(items, (item) => item.who ?? "nobody", (key, list) => ({ label: list[0].person ? capital(personLabel(list[0].person)) : "Keel", icon: list[0].person?.system || !list[0].person ? "clock" : undefined, about: failedWords(list) })) },
    { key: "outcome", label: "Outcome", groupsOf: (items) => groupBy(items, (item) => item.outcome, (key) => ({ label: OUTCOMES[key as keyof typeof OUTCOMES].plural, icon: OUTCOMES[key as keyof typeof OUTCOMES].icon }), (key) => OUTCOME_ORDER.indexOf(key as never)) },
  ], [now]);

  function exportCsv(ids: string[]) {
    const chosen = shown.filter((row) => ids.includes(row.id));
    const blob = new Blob([activityCsv(chosen)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `keel-activity-${today}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    toast({ tone: "success", title: `${chosen.length} ${chosen.length === 1 ? "entry" : "entries"} exported` });
  }

  const renderRow = (row: ActivityRow) => {
    const outcome = OUTCOMES[row.outcome];
    const tone = outcomeTone(row.outcome);
    const retry = canBackup ? retryOf(row.job) : null;
    return (
      <div className="ac-row" data-type={row.type}>
        <span className="ac-when"><time dateTime={row.at ?? undefined} title={formatTimestamp(row.at)}>{clockWords(row.at) || "—"}</time></span>
        <span aria-hidden="true" className="ac-kind" data-tone={tone ?? (row.outcome === "finished" ? "fine" : undefined)}><Icon name={ACTIVITY_KINDS[row.kind].icon} /></span>
        <span className="ac-row-name">
          <Link className="ac-row-link" href={href({ open: row.id })} onClick={(event) => openPanel(event, row.id)}>{row.title}</Link>
          <small>{row.line}</small>
        </span>
        <span className="ac-row-mid">
          <Badge icon={outcome.icon} tone={outcome.tone}>{outcome.label}</Badge>
          {isSelfApproved(row.entry) ? <Badge icon="person" tone="soon" title="The person who asked approved it, under solo approval mode">Self-approved</Badge> : null}
          <span className="ac-row-who">{row.person ? <Person capitalise person={row.person} /> : <span className="ac-keel"><Icon name="clock" />Keel</span>}</span>
        </span>
        <span className="ac-row-acts">
          {retry && retry.kind !== "plan" ? <button aria-busy={retryBusy || undefined} className="btn btn-sm" disabled={retryBusy} onClick={() => void runAgain(retry)} type="button"><Icon name="refresh" />Run again</button> : null}
          {retry?.kind === "plan" ? <Link className="btn btn-sm" href={retry.href}>{retry.label}</Link> : null}
        </span>
      </div>
    );
  };

  const openRow = opened ? rows.find((row) => row.id === opened) ?? null : null;

  return (
    <div className="ac-page">
      <Verdict action={verdictAction} detail={verdict.detail} text={verdict.text} tone={verdict.tone} />
      {notice}
      <div data-layer="explanation">
        <section aria-label="Activity at a glance" className="ac-tiles">
          {tiles.map((tile) => (
            <Link aria-current={tile.active || undefined} className="ac-tile" data-tone={tile.tone} href={href({ open: null, ...tile.changes })} key={tile.key} title={tile.key === "jobs" ? "Show everything" : tile.active ? "Picked: click to remove it from the view" : "Click to add these to the view"}>
              <span className="ac-tile-label"><Icon name={tile.icon} />{tile.label}{tile.active && tile.key !== "jobs" ? <Icon className="tile-check" name="check" /> : null}</span>
              <b className="ac-tile-count" data-word={/[a-z]/i.test(tile.value) || undefined}>{tile.value}</b>
              {tile.key === "jobs" ? <Spark days={counts.days} /> : null}
              <small>{tile.small}</small>
            </Link>
          ))}
        </section>

        <div className="ac-filters">
          <Segmented label="Show" onChange={(value) => navigate({ show: value === "all" ? null : value })} options={SHOW} value={filters.show} />
          <DatePicker allowClear label="When" onChange={(range: DayRange | null) => navigate({ range: rangeToParam(range) || null })} today={today} value={filters.range} />
          <MultiOptionPicker anyLabel="Anyone" label="Who" onChange={(values) => navigate({ who: values.join(",") || null })} options={whoOptions} values={filters.who} />
          <MultiOptionPicker anyLabel="All kinds" label="What" onChange={(values) => navigate({ what: values.join(",") || null })} options={whatOptions} values={filters.what} />
          <MultiOptionPicker anyLabel="Any outcome" label="Outcome" onChange={(values) => navigate({ outcome: values.join(",") || null })} options={outcomeOptions} values={filters.outcomes} />
        </div>
        {feedback}
        <ActiveFilters extra={{ open: null, before: null }} filters={chips} noun={{ one: "entry", many: "entries" }} onChange={navigate} shown={shown.length} total={rows.length} totalWords="loaded" />

        <section aria-labelledby="ac-timeline-heading" className="ac-section">
          <h2 className="visually-hidden" id="ac-timeline-heading">Timeline</h2>
          {rows.length ? (
            <SelectableList
              action={{ label: (count) => `Export ${count === 1 ? "1 entry" : `${count} entries`}`, detail: () => "A spreadsheet file of these entries: when, what, who and the outcome, with ids in extra columns for an auditor.", run: exportCsv }}
              empty={filtering ? <NoMatches extra={{ open: null, before: null }} filters={chips} noun={{ one: "entry", many: "entries" }} onChange={navigate} /> : undefined}
              getId={(item) => item.id}
              groupings={groupings}
              items={shown}
              label="Activity"
              matches={(item, text) => `${item.title} ${item.line} ${item.person ? personLabel(item.person) : "keel"} ${OUTCOMES[item.outcome].label}`.toLowerCase().includes(text)}
              noun={{ one: "entry", many: "entries" }}
              renderRow={renderRow}
              sorts={SORTS}
              rowName={(item) => `${item.title} at ${clockWords(item.at) || "an unknown time"}`}
              toneOf={(item) => outcomeTone(item.outcome)}
            />
          ) : (
            filtering ? <NoMatches extra={{ open: null, before: null }} filters={chips} noun={{ one: "entry", many: "entries" }} onChange={navigate} /> : <p className="sel-empty">Nothing has happened yet. The first backup shows here once it runs.</p>
          )}
          {filters.show !== "jobs" && (nextBefore || before) ? (
            <nav aria-label="Older audit entries" className="ac-paging">
              {before ? <Link className="btn btn-sm" href={href({ before: null, open: null })}>Newest entries</Link> : null}
              {nextBefore ? <Link className="btn btn-sm" href={href({ before: nextBefore, open: null })}>Show older audit entries</Link> : null}
              <span className="ac-paging-note">Jobs show the newest 100; audit entries page 50 at a time.</span>
            </nav>
          ) : null}
        </section>

        <TechnicalDetails summary="Technical details for these entries">
          <RecordGroup title="Audit record check">
            <RecordField copy={false} label="Status" value={integrity?.status ?? "unavailable"} />
            {integrity?.anchoredThroughSeq ? <RecordField copy={false} label="Checked off-site through entry" value={integrity.anchoredThroughSeq} /> : null}
            {integrity?.unanchoredRecords !== undefined ? <RecordField copy={false} label="Entries not yet checked off-site" value={integrity.unanchoredRecords} /> : null}
            {integrity?.brokenAtSeq ? <RecordField copy={false} label="Broken at entry" value={integrity.brokenAtSeq} /> : null}
            {integrity?.reason ? <RecordField copy={false} label="Reason" value={integrity.reason} /> : null}
            <RecordField copy={false} label="Checked with" value="GET /api/evidence/verify" />
          </RecordGroup>
          {jobs.map((job) => (
            <RecordGroup key={job.id} note={`job · ${job.kind} · ${job.status}`} title={rows.find((row) => row.job === job)?.title ?? job.kind}>
              <JobRecordFields job={job} />
            </RecordGroup>
          ))}
          {entries.map((entry) => (
            <RecordGroup key={entry.seq} note={`audit entry ${entry.seq} · ${entry.kind}`} title={rows.find((row) => row.entry === entry)?.title ?? entry.kind}>
              <EntryRecordFields entry={entry} person={people[entry.actor]} />
            </RecordGroup>
          ))}
        </TechnicalDetails>
      </div>

      {openRow ? <BaselinesStyles /> : null}
      {openRow ? (
        <RowPanel
          canBackup={canBackup}
          now={now}
          onClose={closePanel}
          onRetry={(retry) => void runAgain(retry)}
          retryBusy={retryBusy}
          retryLabel={retryLabel}
          row={openRow}
        />
      ) : null}
    </div>
  );
}

function capital(text: string): string {
  return text.replace(/^./, (letter) => letter.toUpperCase());
}

function failedWords(list: ActivityRow[]): string {
  const failed = list.filter((row) => row.outcome === "failed").length;
  const refused = list.filter((row) => row.outcome === "refused").length;
  const parts = [failed ? `${failed} failed` : null, refused ? `${refused} refused` : null].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing failed";
}

/** Seven bars, one per day, drawn to scale: all jobs that day, and what failed in red. */
function Spark({ days }: { days: { day: string; jobs: number; failed: number }[] }) {
  const max = Math.max(1, ...days.map((day) => day.jobs));
  const width = 96;
  const height = 28;
  const gap = 3;
  const bar = (width - gap * (days.length - 1)) / days.length;
  const total = days.reduce((sum, day) => sum + day.jobs, 0);
  const failed = days.reduce((sum, day) => sum + day.failed, 0);
  return (
    <svg aria-label={`${total} jobs over the last 7 days, ${failed} failed`} className="ac-spark" role="img" viewBox={`0 0 ${width} ${height}`}>
      <line className="ac-spark-base" x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} />
      {days.map((day, index) => {
        const h = day.jobs ? Math.max(2, (day.jobs / max) * (height - 4)) : 1;
        const f = day.failed ? Math.max(2, (day.failed / max) * (height - 4)) : 0;
        return (
          <g key={day.day}>
            <rect className="ac-spark-bar" data-empty={!day.jobs || undefined} height={h} rx="1" width={bar} x={index * (bar + gap)} y={height - 1 - h} />
            {f ? <rect className="ac-spark-failed" height={f} rx="1" width={bar} x={index * (bar + gap)} y={height - 1 - f} /> : null}
          </g>
        );
      })}
    </svg>
  );
}

function RowPanel({ row, now, canBackup, retryBusy, retryLabel, onRetry, onClose }: {
  row: ActivityRow;
  now: string;
  canBackup: boolean;
  retryBusy: boolean;
  retryLabel: (retry: Retry) => string;
  onRetry: (retry: Retry) => void;
  onClose: () => void;
}) {
  const outcome = OUTCOMES[row.outcome];
  const retry = canBackup ? retryOf(row.job) : null;
  const target = rowHref(row);
  const job = row.job;
  const entry = row.entry;
  return (
    <DetailsSheet
      footer={retry || target ? <>
        {retry && retry.kind !== "plan" ? <button aria-busy={retryBusy || undefined} className="btn btn-primary" disabled={retryBusy} onClick={() => onRetry(retry)} type="button"><Icon name="refresh" />{retryLabel(retry)}</button> : null}
        {retry?.kind === "plan" ? <Link className="btn btn-primary" href={retry.href}>{retry.label}</Link> : null}
        {target ? <Link className="btn" href={target}>{rowHrefLabel(row)}</Link> : null}
        {retry && retry.kind !== "plan" ? <p className="bl-help">Starts a new backup now. It only reads your tenant; nothing changes.</p> : null}
        {retry?.kind === "plan" ? <p className="bl-help">A restore or roll back is never re-run from here: plan it again, and it goes through a dry run and approval.</p> : null}
      </> : undefined}
      kicker={<span className="ac-sheet-kicker"><Badge icon={outcome.icon} tone={outcome.tone}>{outcome.label}</Badge><span>{row.type === "job" ? ACTIVITY_KINDS[row.kind].one : row.line.replace(/^Audit record · /, "Audit record: ")}</span></span>}
      onClose={onClose}
      title={row.title}
    >
      <div className="ac-sheet">
        <dl className="ac-facts">
          <div><dt>When</dt><dd><time dateTime={row.at ?? undefined}>{formatTimestamp(row.at)}</time></dd></div>
          <div><dt>{row.type === "job" ? "Asked for by" : "Who"}</dt><dd>{row.person ? <Person capitalise person={row.person} /> : "Keel"}</dd></div>
          {job ? <div><dt>Status</dt><dd>{capital(jobStatusSentence(job, now))}</dd></div> : null}
        </dl>
        {job?.status === "failed" && job.error ? (
          <ErrorNotice
            error={job.error}
            id="activity-error"
            todo={retry && retry.kind !== "plan" ? "Run it again: it usually works, and Keel only reads your tenant." : retry?.kind === "plan" ? "Nothing was changed by the failed part. Plan it again to try once more." : undefined}
          />
        ) : null}
        {row.outcome === "refused" ? (
          <div className="ac-note" data-tone="soon">
            <Icon name="alert" />
            <div><b>Nothing was changed.</b><p>Keel refused it before anything ran, and recorded who asked.</p></div>
          </div>
        ) : null}
        <WhatChanged row={row} />
        {entry ? <p className="ac-plain ac-muted">Audit entries cannot be changed or removed. Each one is chained to the one before it, and the chain is checked against an off-site copy.</p> : null}
        <TechnicalDetails>
          {job ? <JobRecordFields job={job} /> : null}
          {entry ? <EntryRecordFields entry={entry} person={row.person} /> : null}
        </TechnicalDetails>
      </div>
    </DetailsSheet>
  );
}

type ChangesState = { state: "loading" } | { state: "failed" } | { state: "none" } | { state: "read"; data: ActivityChanges };

/** What the row changed: each setting with its value before and after, read when the panel opens. */
function WhatChanged({ row }: { row: ActivityRow }) {
  const query = changesQuery(row);
  const [result, setResult] = useState<ChangesState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!query) return;
    let live = true;
    setResult({ state: "loading" });
    fetch(`/api/activity/changes?${query}`, { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as { changes: ActivityChanges | null };
        if (live) setResult(body.changes ? { state: "read", data: body.changes } : { state: "none" });
      })
      .catch(() => { if (live) setResult({ state: "failed" }); });
    return () => { live = false; };
  }, [query, attempt]);
  if (!query) return null;
  const heading = <h3 className="ac-changes-heading">What changed</h3>;
  if (result.state === "loading") return <section aria-busy="true" className="ac-changes">{heading}<p className="ac-muted" role="status">Reading the settings this changed…</p></section>;
  if (result.state === "failed") {
    return <section className="ac-changes">{heading}<p className="ac-muted" role="status">Keel could not read what this changed. <button className="ac-inline-link" onClick={() => setAttempt((value) => value + 1)} type="button">Try again</button></p></section>;
  }
  if (result.state === "none") return <section className="ac-changes">{heading}<p className="ac-muted">Keel has no record of the settings this changed.</p></section>;
  const { data } = result;
  const more = data.total - data.changes.length;
  return (
    <section aria-labelledby="ac-changes-heading" className="ac-changes">
      <ChangedValuesStyles />
      <h3 className="ac-changes-heading" id="ac-changes-heading">What changed{data.total ? ` (${data.total.toLocaleString("en-GB")})` : ""}</h3>
      <p className="ac-muted">{data.total || data.basis !== "backup" ? data.about : data.compare ? "Nothing changed since the backup before this one." : data.about}</p>
      {data.changes.length ? <ChangedObjects changes={data.changes} names={data.names} sides={data.sides} /> : null}
      {more > 0 ? <p className="ac-muted">And {more.toLocaleString("en-GB")} more {more === 1 ? "object" : "objects"}.</p> : null}
      {data.compare && data.total ? <Link className="btn btn-sm" href={`/compare?from=${encodeURIComponent(data.compare.from)}&to=${encodeURIComponent(data.compare.to)}`}><Icon name="swap" />See every difference in Compare</Link> : null}
    </section>
  );
}

function groupBy<T>(items: T[], key: (item: T) => string, meta: (key: string, list: T[]) => Omit<ListGroup<T>, "items" | "key">, rank?: (key: string) => number): ListGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  const groups = [...map.entries()].map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey, list), items: list }));
  return rank ? groups.sort((a, b) => rank(a.key) - rank(b.key)) : groups.sort((a, b) => a.label.localeCompare(b.label));
}

/** Every stored field of one audit entry. */
function EntryRecordFields({ entry, person }: { entry: EvidenceEntry; person?: EngineRef | null }) {
  return <>
    <RecordField copy={false} label="Entry number" usage="entries are numbered in order; each is chained to the one before it" value={entry.seq} />
    <RecordField copy={false} label="Kind" value={entry.kind} />
    <RecordField label="Done by (account)" value={displayAccount(entry.actor, person)} />
    <RecordField copy={false} label="When" value={entry.occurred_at} />
    <RecordField label="Subject" value={entry.subject as RecordValue} />
  </>;
}
