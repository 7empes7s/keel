"use client";

import { useMemo, useState } from "react";

import { RiskChip, SectionHead } from "@/components/baselines/parts";
import { PagedRows, type PagedRow } from "@/components/list/paged-rows";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Segmented } from "@/components/pickers/segmented";
import {
  HISTORY_RANGES, OVERALL, chartFloor, TRIGGER_WORDS, changeTone, changeWords, historyRows, historyServices, historySummary,
  percentTone, readRange, seriesFor, type HistoryRange, type HistoryRow, type ScorePoint,
} from "@/lib/baseline-history-view";
import { ago, formatTimestamp } from "@/lib/presentation";
import { useViewState } from "@/lib/use-view-state";

const WIDTH = 640;
const HEIGHT = 200;
// The rings' bands: 90% and up is in line, 60% and up needs a look soon.
const BANDS = [
  { from: 90, to: 100, tone: "fine" },
  { from: 60, to: 90, tone: "soon" },
  { from: 0, to: 60, tone: "urgent" },
] as const;

function shortDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(value));
}

/** The line for one series over time: coloured bands behind it, a dot per point, and the
 * nearest point named on hover. The list below holds every value as text. */
function TrendChart({ series, label }: { series: { at: string; percent: number; point: ScorePoint }[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const floor = chartFloor(Math.min(...series.map((entry) => entry.percent)));
  const y = (percent: number) => ((100 - Math.max(floor, percent)) / (100 - floor)) * HEIGHT;
  const marks = [100, 90, 60, floor].filter((mark, index, all) => mark >= floor && all.indexOf(mark) === index);
  const times = series.map((entry) => Date.parse(entry.at));
  const first = times[0];
  const last = times[times.length - 1];
  const x = (index: number) => (series.length === 1 || last === first ? WIDTH / 2 : ((times[index] - first) / (last - first)) * WIDTH);
  const line = series.map((entry, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(entry.percent).toFixed(1)}`).join("");
  const shown = hover ?? series.length - 1;
  const point = series[shown];
  return (
    <figure className="bh-chart">
      <div className="bh-axis" aria-hidden="true">
        {marks.map((mark) => <span key={mark} style={{ top: `${(y(mark) / HEIGHT) * 100}%` }}>{mark}%</span>)}
      </div>
      <div
        className="bh-plot"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const at = ((event.clientX - box.left) / box.width) * WIDTH;
          let best = 0;
          for (let index = 1; index < series.length; index++) if (Math.abs(x(index) - at) < Math.abs(x(best) - at)) best = index;
          setHover(best);
        }}
      >
        <svg aria-label={label} preserveAspectRatio="none" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
          {BANDS.filter((band) => band.to > floor).map((band) => (
            <rect className="bh-band" data-tone={band.tone} height={y(band.from) - y(band.to)} key={band.tone} width={WIDTH} x={0} y={y(band.to)} />
          ))}
          {[90, 60].filter((mark) => mark > floor).map((mark) => <line className="bh-grid" key={mark} x1={0} x2={WIDTH} y1={y(mark)} y2={y(mark)} />)}
          {series.length > 1 ? <path className="bh-line" d={line} /> : null}
          {hover !== null ? <line className="bh-crosshair" x1={x(hover)} x2={x(hover)} y1={0} y2={HEIGHT} /> : null}
        </svg>
        {/* Dots are HTML so they stay round when the chart stretches to the card. */}
        {series.map((entry, index) => (
          <span
            aria-hidden="true"
            className="bh-dot"
            data-current={index === shown ? "" : undefined}
            data-tone={percentTone(entry.percent)}
            key={entry.point.id}
            style={{ left: `${(x(index) / WIDTH) * 100}%`, top: `${(y(entry.percent) / HEIGHT) * 100}%` }}
          />
        ))}
        <span className="bh-tooltip" data-side={x(shown) > WIDTH * 0.6 ? "left" : "right"} role="status" style={{ left: `${(x(shown) / WIDTH) * 100}%`, top: `${(y(point.percent) / HEIGHT) * 100}%` }}>
          <b>{point.percent}%</b> {TRIGGER_WORDS[point.point.trigger].toLowerCase()}, {shortDate(point.at)}
        </span>
      </div>
      <figcaption className="bh-dates">
        <span>{shortDate(series[0].at)}</span>
        {series.length > 1 ? <span>{shortDate(series[series.length - 1].at)}</span> : null}
      </figcaption>
    </figure>
  );
}

function Delta({ change }: { change: number | null }) {
  if (change === null) return <span className="bh-delta" data-tone="neutral">First point</span>;
  if (change === 0) return <span className="bh-delta" data-tone="neutral">No change</span>;
  const size = Math.abs(change);
  return (
    <span className="bh-delta" data-tone={changeTone(change)} title={changeWords(change)}>
      <span aria-hidden="true">{change > 0 ? "▲" : "▼"} </span>
      <span className="visually-hidden">{change > 0 ? "Up " : "Down "}</span>
      {size} {size === 1 ? "point" : "points"}
    </span>
  );
}

function HistoryItem({ row, now }: { row: HistoryRow; now: string }) {
  const { point } = row;
  return (
    <li className="bh-row" data-tone={percentTone(point.percent)}>
      <span className="bh-percent" data-tone={percentTone(point.percent)}>{point.percent}%</span>
      <div className="bh-row-main">
        <p className="bh-row-head">
          <b>{point.matching.toLocaleString("en-GB")} of {point.judged.toLocaleString("en-GB")} settings match</b>
          <Delta change={row.change} />
        </p>
        <p className="bh-row-when">
          <RiskChip tone={null}>{TRIGGER_WORDS[point.trigger]}</RiskChip>
          <time dateTime={point.recordedAt} title={formatTimestamp(point.recordedAt)}>{ago(point.recordedAt, now)}</time>
          {row.newSetup ? <RiskChip tone="low">New approved setup in use</RiskChip> : null}
        </p>
        <ul aria-label="By service" className="bh-services">
          {row.services.map((entry) => (
            <li data-tone={percentTone(entry.count.percent)} key={entry.service.code} title={`${entry.count.matching} of ${entry.count.judged} settings match${entry.change ? ` (${changeWords(entry.change)})` : ""}`}>
              {entry.service.name} <b>{entry.count.percent === null ? "—" : `${entry.count.percent}%`}</b>
              {entry.change ? <span className="bh-moved" data-tone={changeTone(entry.change)}><span aria-hidden="true">{entry.change > 0 ? " ▲" : " ▼"}</span><span className="visually-hidden"> ({changeWords(entry.change)})</span></span> : null}
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

const SORTS = [
  { key: "when", label: "Time", desc: true },
  { key: "match", label: "Match" },
];

/** "Match over time": the trend of the match percentage, overall or for one service, and
 * every stored point newest first. Points come one after each backup and each run of
 * service reads (engine/govern/baselineScore.mjs). */
export function ScoreHistory({ points, now }: { points: ScorePoint[]; now: string }) {
  const view = useViewState();
  const range: HistoryRange = readRange(view.get("bh-range"));
  const services = useMemo(() => historyServices(points), [points]);
  const line = services.some((service) => service.code === view.get("bh-line")) ? view.get("bh-line") : OVERALL;
  const lineName = line === OVERALL ? "Overall" : services.find((service) => service.code === line)?.name ?? "Overall";
  const series = useMemo(() => seriesFor(points, line, range, now), [points, line, range, now]);
  const summary = historySummary(series);
  const rows = useMemo<PagedRow[]>(() => historyRows(points).map((row) => ({
    id: row.point.id,
    node: <HistoryItem key={row.point.id} now={now} row={row} />,
    text: [TRIGGER_WORDS[row.point.trigger], `${row.point.percent}%`, formatTimestamp(row.point.recordedAt), ...row.services.map((entry) => entry.service.name)].join(" "),
    values: { when: row.point.recordedAt, match: row.point.percent ?? -1 },
  })), [points, now]);
  const options = [{ value: OVERALL, label: "Overall" }, ...services.map((service) => ({ value: service.code, label: service.name, icon: service.icon }))];

  return (
    <section aria-labelledby="bh-heading" className="bl-section">
      <SectionHead
        about="One point after each backup and each read of the other services. Accepting or undoing changes moves it at the next point."
        id="bh-heading"
        title="Match over time"
      />
      {points.length ? (
        <div className="bl-card bh-card" data-tone={summary ? percentTone(summary.latest) : undefined}>
          <div className="bh-controls">
            <OptionPicker label="Show" onChange={(value) => view.set({ "bh-line": value }, { "bh-line": OVERALL })} options={options} value={line} />
            <Segmented label="Period" onChange={(value) => view.set({ "bh-range": value }, { "bh-range": "30" })} options={HISTORY_RANGES.map(({ value, label }) => ({ value, label }))} value={range} />
          </div>
          {summary ? (
            <>
              <dl className="bh-facts">
                <div data-fact="latest" data-tone={percentTone(summary.latest)}><dt>Latest</dt><dd>{summary.latest}%</dd></div>
                <div data-fact="change" data-tone={changeTone(summary.change)}><dt>Change in period</dt><dd>{summary.change === null ? "—" : changeWords(summary.change)}</dd></div>
                <div data-fact="lowest" data-tone={percentTone(summary.lowest.percent)}><dt>Lowest</dt><dd>{summary.lowest.percent}%<small>{shortDate(summary.lowest.at)}</small></dd></div>
                <div data-fact="points"><dt>Points</dt><dd>{summary.points}</dd></div>
              </dl>
              <TrendChart label={`${lineName} match over ${range === "all" ? "every point stored" : `the last ${range} days`}: ${summary.latest}% now, lowest ${summary.lowest.percent}%, highest ${summary.highest.percent}%, ${summary.points} points`} series={series} />
            </>
          ) : (
            <p className="bl-help">No points for {lineName} in this period. Choose a longer period.</p>
          )}
        </div>
      ) : (
        <div className="bl-card bh-card bh-empty">
          <p><b>No history yet.</b> Keel stores the first point after the next backup.</p>
        </div>
      )}
      {points.length ? (
        <PagedRows label="Past match points" listClassName="bh-rows" noun={{ one: "point", many: "points" }} prefix="bh-" rows={rows} sorts={SORTS} />
      ) : null}
    </section>
  );
}
