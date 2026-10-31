"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent, type MouseEvent } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { BaselinesStyles } from "@/components/baselines/styles";
import { ConfirmSheet } from "@/components/incidents/confirm-sheet";
import { Segmented } from "@/components/pickers/segmented";
import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { Verdict } from "@/components/verdict";
import { addsWords, applyFilters, readPicked, tileCounts, tileParam, withoutTile, type FilterTile } from "@/lib/filter-set";
import { ago, formatTimestamp } from "@/lib/presentation";
import { scheduleName } from "@/lib/protect-view";
import { changeSchedule, runScheduleNow, type ScheduleChange } from "@/lib/schedule-calls";
import {
  acknowledgedAtTitle, acknowledgementSentence, businessHoursSentence, FORECAST_CAVEAT, forecastRecord,
  forecastSentence, openWarnings, proposalSentence, warningSentence,
} from "@/lib/schedule-forecast-view";
import type { Schedule, ScheduleForecast, SchedulesData } from "@/lib/schedules";
import {
  KIND_ICONS, SCHEDULE_FILTERS, SCHEDULE_GROUPS, SCHEDULE_GROUP_ORDER, STATE_ORDER, STATE_WORDS,
  cadenceUtc, cadenceWords, forecastFor, lastResult, loadChip, nextRunWords, previewNextRun,
  runNowRoute, runsFilter, scheduleCounts, scheduleGroup, scheduleMatches, scheduleState, scheduleTitle, scheduleTone,
  schedulesVerdict, turnOffEffect, turnOnEffect, utcTime, utcToZoned, waitingSentence, zoneName, zonedTime, zonedToUtc,
  zonedWithUtc, type ScheduleFilter, type ScheduleGroup, type ScheduleState,
} from "@/lib/schedules-view";
import { toast } from "@/lib/toast";
import { pushUrl } from "@/lib/url-history";
import { readList, useLiveSearchParams, useViewState } from "@/lib/use-view-state";

// Schedules (portal audit, one design): a verdict, four tiles that set `status=` or
// `load=` in the address (Next run opens that schedule), then every schedule in a
// SelectableList grouped by what it does (default) or by state. A row opens its panel
// (`open=<scheduleId>`, Back closes it): how often and when, the last run, the load on
// Microsoft with "Use suggested timetable" and "Accept warning", the editor in the
// business time zone, Run now, and Turn off or on. Turning off asks first (`do=off`,
// with `pick=` for several). The server keeps UTC; ids stay in Technical details.

const plural = (count: number) => `${count} ${count === 1 ? "schedule" : "schedules"}`;
const TILE_LABELS: Record<ScheduleFilter, string> = { on: "On", off: "Off", failed: "Failed last run", partial: "Partly done last run", warning: "Load warnings" };

export function SchedulesPage({ schedules, deferrals, forecasts, now, timeZone, canEdit, canRun }: Pick<SchedulesData, "schedules" | "deferrals" | "forecasts"> & {
  now: string;
  timeZone: string;
  canEdit: boolean;
  canRun: boolean;
}) {
  const router = useRouter();
  const view = useViewState();
  const pathname = usePathname() ?? "/schedules";
  const params = useLiveSearchParams();
  const openId = view.get("open");
  const step = (["off"] as const).find((value) => value === view.get("do")) ?? null;
  const picked = readList(view.get("pick"));
  const [busy, setBusy] = useState(false);

  // What this page changed, until the server's next read says where each schedule stands.
  const [changed, setChanged] = useState<Record<string, Partial<Schedule>>>({});
  const [accepted, setAccepted] = useState<Record<string, true>>({});
  useEffect(() => { setChanged({}); setAccepted({}); }, [schedules, forecasts]);
  const items = useMemo(() => schedules.map((schedule) => (changed[schedule.id] ? { ...schedule, ...changed[schedule.id] } : schedule)), [schedules, changed]);
  const loads = useMemo(() => forecasts?.map((forecast) => (accepted[forecast.scheduleId]
    ? { ...forecast, warnings: forecast.warnings.map((warning) => ({ ...warning, acknowledged: true })) }
    : forecast)), [forecasts, accepted]);
  const loadOf = (schedule: Schedule) => forecastFor(loads, schedule);
  // The tiles add up: `status=failed,warning` shows schedules in either. Old `load=warning` links still work.
  const stateTiles = useMemo<FilterTile<Schedule>[]>(() => SCHEDULE_FILTERS.map((key) => ({ key, test: (schedule: Schedule) => scheduleMatches(schedule, forecastFor(loads, schedule), key) })), [loads]);
  const filter = readPicked(stateTiles, [params?.get("status"), params?.get("load")].filter(Boolean).join(","));
  const pickTile = (key: string) => ({ status: tileParam(stateTiles, filter, key), load: null, open: null, do: null, pick: null, closed: null });

  const counts = useMemo(() => scheduleCounts(items, loads), [items, loads]);
  const verdict = useMemo(() => schedulesVerdict(items, now, loads), [items, now, loads]);
  const shown = useMemo(() => applyFilters(items, stateTiles, filter), [items, stateTiles, filter]);
  const tileTotals = useMemo(() => new Map(tileCounts(items, stateTiles, filter).map((entry) => [entry.key, entry])), [items, stateTiles, filter]);
  const opened = items.find((schedule) => schedule.id === openId) ?? null;
  const pickedItems = items.filter((schedule) => picked.includes(schedule.id));

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    const text = next.toString();
    return text ? `${pathname}?${text}` : pathname;
  };
  const openHref = (id: string, action: "off" | null = null) => href({ open: id, do: action, pick: null });
  const follow = (event: MouseEvent, to: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    pushUrl(to);
  };
  const closeAll = () => view.set({ open: null, do: null, pick: null });
  const back = () => (picked.length || !opened ? closeAll() : view.set({ do: null }));

  // One call per schedule; one toast that names what did not change.
  async function change(ids: string[], next: ScheduleChange, words: { done: (count: number) => string; local: Partial<Schedule> | ((schedule: Schedule) => Partial<Schedule>) }): Promise<string | null> {
    const chosen = items.filter((schedule) => ids.includes(schedule.id));
    if (!chosen.length) return null;
    setBusy(true);
    try {
      const failed: { schedule: Schedule; why: string }[] = [];
      const local: Record<string, Partial<Schedule>> = {};
      for (const schedule of chosen) {
        const result = await changeSchedule(schedule.id, next);
        if (result.error) failed.push({ schedule, why: result.error });
        else local[schedule.id] = typeof words.local === "function" ? words.local(schedule) : words.local;
      }
      setChanged((current) => {
        const merged = { ...current };
        for (const [id, value] of Object.entries(local)) merged[id] = { ...merged[id], ...value };
        return merged;
      });
      router.refresh();
      if (failed.length === chosen.length) {
        toast({ tone: "warning", title: "Not changed", detail: failed[0].why });
        return failed[0].why;
      }
      if (failed.length) toast({ tone: "warning", title: words.done(chosen.length - failed.length), detail: `Not changed: ${failed.map((entry) => scheduleName(entry.schedule)).join(", ")}.` });
      else toast({ title: words.done(chosen.length), detail: chosen.length === 1 ? scheduleName(chosen[0]) : undefined });
      return null;
    } finally {
      setBusy(false);
    }
  }

  const turnOff = (ids: string[]) => change(ids, { enabled: false }, { done: (count) => (count === 1 ? "Turned off" : `${plural(count)} turned off`), local: { enabled: false } });
  const turnOn = (ids: string[]) => change(ids, { enabled: true }, { done: (count) => (count === 1 ? "Turned on" : `${plural(count)} turned on`), local: { enabled: true } });

  async function runNow(schedule: Schedule) {
    setBusy(true);
    try {
      const result = await runScheduleNow(schedule);
      if (result.error) { toast({ tone: "warning", title: "Not started", detail: result.error }); return; }
      setChanged((current) => ({ ...current, [schedule.id]: { ...current[schedule.id], last_status: "queued", last_run_at: now, ...(result.jobId ? { last_job_id: result.jobId } : {}) } }));
      toast({ title: `${scheduleName(schedule)} started`, detail: "It runs now; the timetable does not change.", ...(result.jobId ? { href: `/jobs/${encodeURIComponent(result.jobId)}`, hrefLabel: "Open the run" } : {}) });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function acceptWarning(schedule: Schedule, forecast: ScheduleForecast) {
    setBusy(true);
    try {
      const result = await changeSchedule(schedule.id, { acknowledgeForecast: openWarnings(forecast).map((warning) => warning.code) });
      if (result.error) { toast({ tone: "warning", title: "Not accepted", detail: result.error }); return; }
      setAccepted((current) => ({ ...current, [schedule.id]: true }));
      toast({ title: "Warning accepted", detail: `${scheduleName(schedule)} keeps its timetable.` });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const failedOne = items.filter((schedule) => schedule.last_status === "failed" && schedule.last_job_id);
  const partialOne = items.filter((schedule) => schedule.last_status === "partial" && schedule.last_job_id);
  const warned = items.find((schedule) => schedule.enabled && openWarnings(loadOf(schedule)).length > 0);
  const verdictAction = failedOne.length === 1
    ? { label: "Open the failed run", href: `/jobs/${encodeURIComponent(failedOne[0].last_job_id!)}` }
    : failedOne.length > 1 ? { label: "Show the failed ones", href: href({ status: "failed", load: null, closed: null }) }
    : partialOne.length === 1 && !counts.failed ? { label: "Open the partly done run", href: `/jobs/${encodeURIComponent(partialOne[0].last_job_id!)}` }
    : partialOne.length > 1 && !counts.failed ? { label: "Show the partly done ones", href: href({ status: "partial", load: null, closed: null }) }
    : warned && canEdit ? { label: "Review the load warning", href: openHref(warned.id) }
    : null;

  const tiles: { key: ScheduleFilter | "next"; label: string; icon: IconName; value: string; small: string; to: string; tone?: "urgent" | "soon" }[] = [
    { key: "on", label: "On", icon: "play", value: `${counts.on} of ${counts.total}`, small: counts.on === counts.total ? "Every schedule runs" : `${counts.total - counts.on} turned off`, to: href(pickTile("on")) },
    { key: "failed", label: "Failed last run", icon: "x-circle", value: String(counts.failed), small: counts.failed ? "Open one to see why" : "No last run failed", to: href(pickTile("failed")), tone: counts.failed ? "urgent" : undefined },
    { key: "partial", label: "Partly done last run", icon: "alert", value: String(counts.partial), small: counts.partial ? "Some types were not backed up" : "Every last run read everything", to: href(pickTile("partial")), tone: counts.partial ? "soon" : undefined },
    { key: "warning", label: "Load warnings", icon: "clock", value: String(counts.warnings), small: counts.warnings ? "A slower timetable is suggested" : "Microsoft keeps up", to: href(pickTile("warning")), tone: counts.warnings ? "soon" : undefined },
    { key: "next", label: "Next run", icon: "calendar", value: counts.next ? nextRunWords(counts.next, now).replace(/^Next run /, "").replace(/^in /, "In ") : "None", small: counts.next ? scheduleName(counts.next) : "Everything is off", to: counts.next ? openHref(counts.next.id) : href({}) },
  ];

  const activeFilters: ActiveFilter[] = filter.map((key) => ({ key: `status:${key}`, label: TILE_LABELS[key as ScheduleFilter], clear: { status: withoutTile(filter, key), load: null, closed: null } }));

  const groupings = useMemo<Grouping<Schedule>[]>(() => [
    { key: "kind", label: "What it does", groupsOf: (list) => groupBy(list, (schedule) => scheduleGroup(schedule), (key, group) => ({ label: SCHEDULE_GROUPS[key as ScheduleGroup].label, icon: SCHEDULE_GROUPS[key as ScheduleGroup].icon, about: `${SCHEDULE_GROUPS[key as ScheduleGroup].about} · ${plural(group.length)}` }), (key, group) => (group.some((schedule) => schedule.last_status === "failed") ? -2 : group.some((schedule) => schedule.last_status === "partial") ? -1 : 0) * 10 + SCHEDULE_GROUP_ORDER.indexOf(key as ScheduleGroup)) },
    { key: "status", label: "State", groupsOf: (list) => groupBy(list, (schedule) => scheduleState(schedule, forecastFor(loads, schedule)), (key, group) => ({ label: STATE_WORDS[key as ScheduleState].label, icon: STATE_WORDS[key as ScheduleState].icon, about: plural(group.length) }), (key) => STATE_ORDER.indexOf(key as ScheduleState)) },
  ], [loads]);

  const renderRow = (schedule: Schedule) => {
    const forecast = loadOf(schedule);
    const result = lastResult(schedule, now);
    const load = loadChip(schedule, forecast);
    const group = scheduleGroup(schedule);
    return (
      <div className="sc-row" data-off={schedule.enabled ? undefined : ""}>
        <span aria-hidden="true" className="sc-kind" data-tone={scheduleTone(schedule, forecast) ?? undefined}><Icon name={KIND_ICONS[group]} /></span>
        <span className="sc-row-name">
          <Link className="sc-row-link" href={openHref(schedule.id)} onClick={(event) => follow(event, openHref(schedule.id))} title={scheduleTitle(schedule)}>{scheduleName(schedule)}</Link>
          <small title={cadenceUtc(schedule)}>{cadenceWords(schedule, timeZone)}</small>
        </span>
        <span className="sc-row-next">
          {schedule.enabled ? (
            <>
              <b>{nextRunWords(schedule, now)}</b>
              <small><time dateTime={schedule.next_due_at} title={utcTime(schedule.next_due_at)}>{zonedTime(schedule.next_due_at, timeZone)}</time></small>
            </>
          ) : <Badge icon="pause" tone="neutral">Off</Badge>}
        </span>
        <span className="sc-row-chips">
          {schedule.last_job_id && schedule.last_status ? (
            <Link className="sc-chip-link" href={`/jobs/${encodeURIComponent(schedule.last_job_id)}`} title={result.title}><Badge icon={result.icon} tone={result.tone}>{result.label}</Badge></Link>
          ) : <Badge icon={result.icon} tone={result.tone}>{result.label}</Badge>}
          <Badge icon={load.icon} tone={load.tone}>{load.label}</Badge>
        </span>
      </div>
    );
  };

  const sheetOpen = Boolean(opened || step);

  return (
    <div className="sc-page">
      <Verdict action={verdictAction} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <section aria-label="Schedules at a glance" className="sc-tiles">
          {tiles.map((tile) => {
            const active = filter.includes(tile.key);
            const adds = tile.key === "next" ? null : addsWords(tileTotals.get(tile.key), filter.length);
            return (
              <Link aria-current={active || undefined} className="sc-tile" data-tone={tile.tone} href={tile.to} key={tile.key} onClick={tile.key === "next" && counts.next ? (event) => follow(event, tile.to) : undefined} title={tile.key === "next" ? undefined : active ? "Picked: click to remove it from the view" : "Click to add these to the view"}>
                <span className="sc-tile-label"><Icon name={tile.icon} />{tile.label}{active ? <Icon className="tile-check" name="check" /> : null}</span>
                <b className="sc-tile-count">{tile.value}</b>
                <small>{tile.small}</small>
                {adds ? <small className="tile-adds">{adds}</small> : null}
              </Link>
            );
          })}
        </section>

        <ActiveFilters extra={{ load: null, closed: null, open: null }} filters={activeFilters} noun={{ one: "schedule", many: "schedules" }} shown={shown.length} total={items.length} />

        {deferrals.length ? (
          <p className="sc-note" role="note">
            <Icon name="clock" />
            <span>
              {waitingSentence(deferrals.length)}
              {deferrals.map((job, index) => <Link className="sc-inline-link" href={`/jobs/${encodeURIComponent(job.id)}`} key={job.id}>{deferrals.length === 1 ? "Open the waiting check" : `Open waiting check ${index + 1}`}</Link>)}
            </span>
          </p>
        ) : null}

        <section aria-labelledby="sc-list-heading" className="sc-section">
          <h2 className="visually-hidden" id="sc-list-heading">Schedules</h2>
          {items.length === 0 ? (
            <p className="sel-empty">No schedules are set up. Keel adds one for each backup tier and upkeep task when it is installed.</p>
          ) : shown.length === 0 ? (
            <NoMatches extra={{ load: null, closed: null, open: null }} filters={activeFilters} noun={{ one: "schedule", many: "schedules" }} />
          ) : canEdit ? (
            <SelectableList
              action={{
                label: (count) => `Turn off ${plural(count)}`,
                detail: (_count, ids) => turnOffEffect(items.filter((schedule) => ids.includes(schedule.id))),
                run: (ids) => pushUrl(href({ do: "off", pick: ids.join(","), open: null })),
              }}
              getId={(schedule) => schedule.id}
              groupings={groupings}
              items={shown}
              key={filter.join(",") || "all"}
              label="Schedules"
              matches={(schedule, text) => `${scheduleName(schedule)} ${cadenceWords(schedule, timeZone)} ${SCHEDULE_GROUPS[scheduleGroup(schedule)].label}`.toLowerCase().includes(text)}
              more={[{ label: "Turn on", run: (ids) => { if (!busy) void turnOn(ids); } }]}
              noun={{ one: "schedule", many: "schedules" }}
              renderRow={renderRow}
              rowName={(schedule) => scheduleName(schedule)}
              toneOf={(schedule) => scheduleTone(schedule, loadOf(schedule))}
            />
          ) : (
            <ul className="sc-plain-list">{shown.map((schedule) => <li className="sel-row" key={schedule.id}><div className="sel-row-body">{renderRow(schedule)}</div></li>)}</ul>
          )}
        </section>

        <TechnicalDetails summary="Technical details for these schedules">
          {items.map((schedule) => (
            <RecordGroup key={schedule.id} note={`${schedule.job_kind}${schedule.tier ? ` · ${schedule.tier}` : ""}`} title={scheduleName(schedule)}>
              <ScheduleRecord forecast={loadOf(schedule)} schedule={schedule} />
            </RecordGroup>
          ))}
          {deferrals.map((job) => (
            <RecordGroup key={job.id} note="drift-detect · deferred" title="Waiting change check">
              <RecordField label="Job ID" value={job.id} />
              <RecordField copy={false} label="Reason" value={job.error} />
            </RecordGroup>
          ))}
        </TechnicalDetails>
      </div>

      {sheetOpen ? <BaselinesStyles /> : null}

      {opened && !step ? (
        <SchedulePanel
          busy={busy}
          canEdit={canEdit}
          canRun={canRun}
          forecast={loadOf(opened)}
          key={opened.id}
          now={now}
          offHref={openHref(opened.id, "off")}
          onAccept={(forecast) => void acceptWarning(opened, forecast)}
          onClose={closeAll}
          onFollow={follow}
          onRun={() => void runNow(opened)}
          onSave={(next, local) => change([opened.id], next, { done: () => "Schedule saved", local })}
          onTurnOn={() => void turnOn([opened.id])}
          schedule={opened}
          timeZone={timeZone}
        />
      ) : null}

      {step === "off" && canEdit && (opened || pickedItems.length) ? (
        <ConfirmSheet
          confirmLabel={opened ? "Turn off" : `Turn off ${plural(pickedItems.filter((schedule) => schedule.enabled).length)}`}
          effect={turnOffEffect(opened ? [opened] : pickedItems)}
          kicker={opened ? scheduleName(opened) : `${plural(pickedItems.length)} selected`}
          onClose={back}
          onConfirm={async () => {
            const failed = await turnOff(opened ? [opened.id] : picked);
            if (!failed) closeAll();
            return failed;
          }}
          title={opened ? "Turn off this schedule?" : "Turn off these schedules?"}
        >
          {opened ? null : <p className="sc-confirm-list">{pickedItems.map((schedule) => scheduleName(schedule)).join(", ")}</p>}
        </ConfirmSheet>
      ) : null}
    </div>
  );
}

const UNIT_OPTIONS = [
  { value: "hour", label: "Hours" },
  { value: "day", label: "Days" },
  { value: "week", label: "Weeks" },
] as const;

function SchedulePanel({ schedule, forecast, now, timeZone, canEdit, canRun, busy, offHref, onClose, onFollow, onSave, onRun, onTurnOn, onAccept }: {
  schedule: Schedule;
  forecast: ScheduleForecast | undefined;
  now: string;
  timeZone: string;
  canEdit: boolean;
  canRun: boolean;
  busy: boolean;
  offHref: string;
  onClose: () => void;
  onFollow: (event: MouseEvent, to: string) => void;
  onSave: (next: ScheduleChange, local: Partial<Schedule>) => Promise<string | null>;
  onRun: () => void;
  onTurnOn: () => void;
  onAccept: (forecast: ScheduleForecast) => void;
}) {
  const state = scheduleState(schedule, forecast);
  const result = lastResult(schedule, now);
  const zone = zoneName(timeZone);
  const onDate = new Date(schedule.next_due_at);
  const day = Number.isFinite(onDate.valueOf()) ? onDate : new Date(now);
  const [every, setEvery] = useState<Schedule["cadence"]["every"]>(schedule.cadence.every);
  const [n, setN] = useState(String(schedule.cadence.n));
  const savedTime = schedule.cadence.atTime ? utcToZoned(schedule.cadence.atTime, timeZone, day) : "";
  const [time, setTime] = useState(savedTime);
  const [custom, setCustom] = useState(schedule.cron_override !== null);
  const [cron, setCron] = useState(schedule.cron_override ?? "");
  const [error, setError] = useState<string | null>(null);
  const warnings = openWarnings(forecast);
  const suggestion = forecast ? proposalSentence(forecast) : null;
  const proposal = forecast?.proposal && !forecast.proposal.unchanged ? forecast.proposal : null;
  const running = runNowRoute(schedule);
  const business = businessHoursSentence(forecast);
  const ack = forecast ? acknowledgementSentence(forecast, now) : null;

  // Keep the saved UTC value unless the time is changed here.
  const cadence: Schedule["cadence"] = {
    every, n: Number(n),
    atTime: time === savedTime ? schedule.cadence.atTime : time ? zonedToUtc(time, timeZone, day) : null,
  };
  const preview = custom ? null : previewNextRun(cadence, new Date(now));

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!custom && !(Number.isSafeInteger(cadence.n) && cadence.n >= 1 && cadence.n <= 10_000)) { setError("Choose a whole number from 1 to 10,000."); return; }
    if (custom && !cron.trim()) { setError("Write the custom timetable, or turn it off."); return; }
    const next: ScheduleChange = custom
      ? { cadence: schedule.cadence, cron_override: cron.trim() }
      : { cadence, cron_override: null };
    const failed = await onSave(next, { cadence: next.cadence, cron_override: next.cron_override, ...(preview ? { next_due_at: preview.toISOString() } : {}) });
    if (failed) setError(failed);
  }

  return (
    <DetailsSheet
      footer={canEdit ? (
        <div className="sc-sheet-actions">
          <button aria-busy={busy || undefined} className="btn btn-primary" disabled={busy} form="sc-edit" type="submit">Save</button>
          <button className="btn" onClick={onClose} type="button">Cancel</button>
        </div>
      ) : undefined}
      kicker={<span className="sc-sheet-kicker"><Badge icon={STATE_WORDS[state].icon} tone={STATE_WORDS[state].tone}>{STATE_WORDS[state].label}</Badge><span>{SCHEDULE_GROUPS[scheduleGroup(schedule)].label}</span></span>}
      onClose={onClose}
      title={scheduleName(schedule)}
    >
      <div className="sc-panel">
        <dl className="sc-facts">
          <div>
            <dt><Icon name="refresh" />How often</dt>
            <dd title={cadenceUtc(schedule)}>{cadenceWords(schedule, timeZone)}</dd>
          </div>
          <div>
            <dt><Icon name="calendar" />Next run</dt>
            <dd>{schedule.enabled ? <time dateTime={schedule.next_due_at} title={formatTimestamp(schedule.next_due_at)}>{zonedWithUtc(schedule.next_due_at, timeZone)}</time> : "Turned off. It runs only when someone starts it."}</dd>
          </div>
          <div>
            <dt><Icon name="clock" />Last run</dt>
            <dd>
              {schedule.last_job_id && schedule.last_status
                ? <Link className="sc-chip-link" href={`/jobs/${encodeURIComponent(schedule.last_job_id)}`}><Badge icon={result.icon} tone={result.tone}>{result.label}</Badge></Link>
                : <Badge icon={result.icon} tone={result.tone}>{result.label}</Badge>}
              <Link className="sc-inline-link" href={`/activity?what=${runsFilter(schedule)}`}>All runs</Link>
            </dd>
          </div>
        </dl>

        {schedule.last_status === "failed" ? (
          <p className="sc-note" data-tone="urgent" role="note"><Icon name="alert" /><span>The last run failed {schedule.last_run_at ? ago(schedule.last_run_at, now) : ""}. The run&apos;s page says why and what to try.</span></p>
        ) : schedule.last_status === "partial" ? (
          <p className="sc-note" data-tone="soon" role="note"><Icon name="alert" /><span>The last run was only partly done {schedule.last_run_at ? ago(schedule.last_run_at, now) : ""}: some types were not backed up. The run&apos;s page names them.</span></p>
        ) : null}

        <section aria-labelledby="sc-load-heading" className="sc-load">
          <h3 id="sc-load-heading">Load on Microsoft</h3>
          <p>{forecastSentence(forecast, schedule.job_kind)}</p>
          {forecast?.warnings.map((warning) => <p className="sc-warning" data-accepted={warning.acknowledged ? "" : undefined} key={warning.code}><Icon name={warning.acknowledged ? "check" : "clock"} />{warningSentence(warning, forecast)}</p>)}
          {suggestion ? <p>{suggestion}</p> : null}
          {ack ? <p title={forecast ? acknowledgedAtTitle(forecast) : undefined}>{ack}</p> : null}
          {business ? <small>{business}</small> : null}
          {forecast && forecast.status !== "unknown" ? <small>{FORECAST_CAVEAT}</small> : null}
          {canEdit && (proposal || warnings.length) ? (
            <div className="sc-load-actions">
              {proposal ? (
                <button className="btn btn-sm" disabled={busy} onClick={() => void onSave({ cadence: proposal.cadence, cron_override: null }, { cadence: proposal.cadence, cron_override: null })} type="button">
                  Use suggested timetable ({cadenceWords({ cadence: proposal.cadence, cron_override: null, next_due_at: schedule.next_due_at }, timeZone).replace(/^Every/, "every")})
                </button>
              ) : null}
              {warnings.length && forecast ? <button className="btn btn-sm" disabled={busy} onClick={() => onAccept(forecast)} type="button">Accept warning</button> : null}
            </div>
          ) : null}
        </section>

        {canEdit ? (
          <form className="sc-editor" id="sc-edit" onSubmit={save}>
            <h3>Change when it runs</h3>
            {!custom ? (
              <>
                <div className="sc-editor-row">
                  <label className="filter-field sc-every">
                    <span>Every</span>
                    <input inputMode="numeric" max="10000" min="1" onChange={(event) => setN(event.target.value)} step="1" type="number" value={n} />
                  </label>
                  <Segmented label="Unit" onChange={(value) => setEvery(value)} options={UNIT_OPTIONS} value={every} />
                </div>
                <label className="filter-field sc-time">
                  <span>{every === "hour" ? "At the minute of (optional)" : `At (${zone === "UTC" ? "UTC" : `${zone} time`}, optional)`}</span>
                  <input onChange={(event) => setTime(event.target.value)} type="time" value={time} />
                </label>
                <small className="sc-help">
                  {preview ? `Next run would be ${zonedWithUtc(preview.toISOString(), timeZone)}.` : "Choose a whole number from 1 to 10,000."}
                  {zone !== "UTC" ? " Keel stores the time in UTC, so it stays fixed when the clocks change." : ""}
                </small>
              </>
            ) : null}
            <details className="sc-advanced" onToggle={(event) => setCustom((event.target as HTMLDetailsElement).open)} open={custom}>
              <summary>Advanced: custom timetable</summary>
              <label className="filter-field">
                <span title="A cron expression with five fields, in UTC">Custom timetable (UTC)</span>
                <input onChange={(event) => setCron(event.target.value)} placeholder="0 */4 * * *" value={cron} />
              </label>
              <small className="sc-help">Five fields: minute, hour, day of month, month, day of week. Close this to go back to the simple timetable.</small>
            </details>
            {error ? <p className="sc-error" role="alert">{error}</p> : null}
          </form>
        ) : null}

        {(canRun && running) || canEdit ? (
          <div className="sc-panel-actions">
            {canRun && running && schedule.enabled ? <button className="btn btn-sm" disabled={busy} onClick={onRun} type="button"><Icon name="play" />Run now</button> : null}
            {canEdit && schedule.enabled ? <Link className="btn btn-sm" href={offHref} onClick={(event) => onFollow(event, offHref)}><Icon name="pause" />Turn off</Link> : null}
            {canEdit && !schedule.enabled ? <button className="btn btn-sm" disabled={busy} onClick={onTurnOn} type="button"><Icon name="play" />Turn on</button> : null}
          </div>
        ) : null}

        <TechnicalDetails>
          <ScheduleRecord forecast={forecast} schedule={schedule} />
        </TechnicalDetails>
      </div>
    </DetailsSheet>
  );
}

function ScheduleRecord({ schedule, forecast }: { schedule: Schedule; forecast: ScheduleForecast | undefined }) {
  return (
    <>
      <RecordField label="Schedule ID" usage={<>Use with <code>POST /api/schedules</code></>} value={schedule.id} />
      <RecordField copy={false} label="Job kind" value={`${schedule.job_kind}${schedule.tier ? ` · ${schedule.tier}` : ""}`} />
      <RecordField copy={false} label="Cadence" value={schedule.cron_override !== null ? `cron ${schedule.cron_override} (UTC)` : JSON.stringify(schedule.cadence)} />
      <RecordField copy={false} label="Next due" value={schedule.next_due_at} />
      <RecordField copy={false} label="Enabled" value={String(schedule.enabled)} />
      {schedule.last_job_id ? <RecordField label="Last job ID" usage={<code>GET /api/jobs/{schedule.last_job_id}</code>} value={schedule.last_job_id} /> : null}
      {schedule.last_status ? <RecordField copy={false} label="Last status" value={`${schedule.last_status}${schedule.last_run_at ? ` at ${schedule.last_run_at}` : ""}`} /> : null}
      {schedule.last_status === "failed" && schedule.last_error !== null ? <RecordField copy={false} label="Last error" value={schedule.last_error} /> : null}
      {forecast ? forecastRecord(forecast).map(([label, value]) => <RecordField copy={false} key={label} label={label} value={value} />) : null}
    </>
  );
}

function groupBy<T>(items: T[], key: (item: T) => string, meta: (key: string, list: T[]) => Omit<ListGroup<T>, "items" | "key">, rank: (key: string, list: T[]) => number): ListGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return [...map.entries()]
    .map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey, list), items: list, rank: rank(groupKey, list) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank: _rank, ...group }) => group);
}
