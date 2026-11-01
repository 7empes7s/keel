"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MouseEvent } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { BaselinesStyles } from "@/components/baselines/styles";
import { CoverageRing } from "@/components/dashboard/coverage-ring";
import { RiskBar } from "@/components/dashboard/risk-bar";
import { Sparkline } from "@/components/dashboard/sparkline";
import { Icon } from "@/components/shell/icons";
import { coverageSegments, trendDay, trendSummary } from "@/lib/overview-view";
import { pushUrl } from "@/lib/url-history";
import { useLiveSearchParams, useViewState } from "@/lib/use-view-state";
import type { DashboardData } from "@/lib/types";

type ChartKey = "changes" | "coverage";

// The Overview's two chart cards: changes since the approved setup (2/3) and what Keel
// backs up (1/3), equal height. Every legend row is a link to its filtered list, and each
// chart opens full screen (`chart=changes|coverage`, Back closes it) with a bigger chart
// and the numbers as a table.
export function OverviewCharts({ data }: { data: Pick<DashboardData, "driftTrend" | "openDriftTotal" | "openDriftByBlastRadius" | "coverage"> }) {
  const view = useViewState();
  const pathname = usePathname() ?? "/";
  const params = useLiveSearchParams();
  const open = view.get("chart");
  const chart: ChartKey | null = open === "changes" || open === "coverage" ? open : null;
  const href = (key: ChartKey) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    next.set("chart", key);
    return `${pathname}?${next.toString()}`;
  };
  const openChart = (key: ChartKey) => (event: MouseEvent) => {
    event.preventDefault();
    pushUrl(href(key));
  };
  const { total, peak } = trendSummary(data.driftTrend);
  const days = data.driftTrend.length;
  const knownKinds = coverageSegments(data.coverage).total;

  return (
    <>
      <section aria-label="Charts" className="ov-charts">
        <section aria-labelledby="ov-changes-heading" className="ov-card ov-card-wide">
          <div className="ov-card-head">
            <div>
              <h2 id="ov-changes-heading"><Icon name="baselines" />Changes since your approved setup</h2>
              <p className="ov-sub">Found per day, last {days} days. {data.openDriftTotal.toLocaleString("en-GB")} {data.openDriftTotal === 1 ? "is" : "are"} still open.</p>
            </div>
            <button aria-label="Changes since your approved setup: open full screen" className="btn btn-sm btn-ghost ov-full" onClick={openChart("changes")} type="button"><Icon name="show" /><span>Full screen</span></button>
          </div>
          <Link aria-label="Open all changes" className="ov-chart-link" href="/drift">
            <Sparkline label="Changes found per day" points={data.driftTrend} />
          </Link>
          <RiskBar items={data.openDriftByBlastRadius} />
        </section>

        <section aria-labelledby="ov-coverage-heading" className="ov-card">
          <div className="ov-card-head">
            <div>
              <h2 id="ov-coverage-heading"><Icon name="backup" />What Keel backs up</h2>
              <p className="ov-sub" title="A restore counts as proven only after a test restore on this tenant.">{knownKinds.toLocaleString("en-GB")} setting types Keel knows</p>
            </div>
            <button aria-label="What Keel backs up: open full screen" className="btn btn-sm btn-ghost ov-full ov-full-icon" onClick={openChart("coverage")} type="button"><Icon name="show" /></button>
          </div>
          <CoverageRing coverage={data.coverage} />
        </section>
      </section>

      {chart ? <BaselinesStyles /> : null}
      {chart === "changes" ? (
        <DetailsSheet kicker="Overview" onClose={() => view.set({ chart: null })} title="Changes since your approved setup" wide>
          <div className="ov-sheet">
            <p className="ov-sub">{total.toLocaleString("en-GB")} found over the last {days} days{peak && peak.count ? `, the most on ${trendDay(peak.day)} (${peak.count})` : ""}. Times are UTC days.</p>
            <TrendBars points={data.driftTrend} />
            <RiskBar items={data.openDriftByBlastRadius} />
            <table className="ov-table">
              <caption className="visually-hidden">Changes found per day, as numbers</caption>
              <thead><tr><th scope="col">Day</th><th className="ov-num" scope="col">Found</th></tr></thead>
              <tbody>
                {[...data.driftTrend].reverse().map((point) => (
                  <tr key={point.day}><th scope="row">{trendDay(point.day)}</th><td className="ov-num">{point.count}</td></tr>
                ))}
              </tbody>
            </table>
            <Link className="btn btn-secondary" href="/drift">Open all changes</Link>
          </div>
        </DetailsSheet>
      ) : null}
      {chart === "coverage" ? (
        <DetailsSheet kicker="Overview" onClose={() => view.set({ chart: null })} title="What Keel backs up" wide>
          <div className="ov-sheet">
            <p className="ov-sub">A restore counts as proven only after a test restore on this tenant.</p>
            <CoverageRing big coverage={data.coverage} />
            <table className="ov-table">
              <caption className="visually-hidden">Setting types by backup state, as numbers</caption>
              <thead><tr><th scope="col">State</th><th className="ov-num" scope="col">Types</th></tr></thead>
              <tbody>
                <tr><th scope="row">Backed up</th><td className="ov-num">{data.coverage.covered}</td></tr>
                <tr><th scope="row">Failed</th><td className="ov-num">{data.coverage.failed}</td></tr>
                <tr><th scope="row">Partly done</th><td className="ov-num">{data.coverage.partial}</td></tr>
                <tr><th scope="row">Out of date</th><td className="ov-num">{data.coverage.stale}</td></tr>
                <tr><th scope="row">Never backed up</th><td className="ov-num">{data.coverage.neverCollected}</td></tr>
                <tr><th scope="row">Not backed up by Keel yet</th><td className="ov-num">{data.coverage.notCovered}</td></tr>
                <tr><th scope="row">Not on this tenant</th><td className="ov-num">{data.coverage.unavailable}</td></tr>
              </tbody>
              <tfoot><tr><th scope="row">All types</th><td className="ov-num">{knownKinds}</td></tr></tfoot>
            </table>
            <Link className="btn btn-secondary" href="/protect">Open What&apos;s protected</Link>
          </div>
        </DetailsSheet>
      ) : null}
    </>
  );
}

// The full-screen trend: one bar per day drawn to scale, with gridlines at 0, half and
// the peak, and the first, middle and last day labelled. Labels are HTML so they keep
// their size at 390 px.
function TrendBars({ points }: { points: DashboardData["driftTrend"] }) {
  const max = Math.max(1, ...points.map((point) => point.count));
  const top = Math.ceil(max / 2) * 2;
  const middle = Math.floor(points.length / 2);
  return (
    <figure className="ov-bars">
      <div className="ov-bars-axis" aria-hidden="true">
        <span>{top}</span><span>{top / 2}</span><span>0</span>
      </div>
      <div className="ov-bars-plot" role="img" aria-label={`Changes found per day: ${points.map((point) => `${trendDay(point.day)} ${point.count}`).join(", ")}`}>
        {points.map((point) => (
          <span className="ov-bar" key={point.day} style={{ height: `${(point.count / top) * 100}%` }} title={`${point.count} on ${trendDay(point.day)}`} />
        ))}
      </div>
      <figcaption className="ov-bars-days" aria-hidden="true">
        <span>{points[0] ? trendDay(points[0].day) : ""}</span>
        <span>{points[middle] ? trendDay(points[middle].day) : ""}</span>
        <span>{points.length ? trendDay(points[points.length - 1].day) : ""}</span>
      </figcaption>
    </figure>
  );
}
