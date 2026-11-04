"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { Sparkline } from "@/components/dashboard/sparkline";
import { Segmented } from "@/components/pickers/segmented";
import { Icon } from "@/components/shell/icons";
import { ScopeNote } from "@/components/scope-note";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { Verdict } from "@/components/verdict";
import { SOURCE_WORDS, feedScopeNote, type ChangeFeedData, type FeedPeriod } from "@/lib/change-feed-view";
import {
  DEFAULT_INSIGHTS_PERIOD, INSIGHTS_PERIODS, changesByDay, changesByService, insightsRecord, insightsVerdict, quietServices, topPeople, whereToStart,
  type StartItem,
} from "@/lib/insights-view";
import { serviceFor } from "@/lib/services";

// Insights (insights track A7 and A8): one sentence on the period, where to start (flagged
// changes, then unflagged changes to critical or high kinds), and the shape of the period:
// changes by day and by service, who made the most, and which services had none. Built from
// one change feed read; every row opens the change under Changes › Every change.

// The list stays short enough to act on; the rest is one click away in Every change.
const MOST_FLAGGED = 10;
const MOST_WATCH = 5;

const changes = (count: number) => `${count.toLocaleString("en-GB")} ${count === 1 ? "change" : "changes"}`;

function feedHref(period: FeedPeriod, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ view: "feed", ...(period !== "30" ? { days: period } : {}), ...extra });
  return `/changes?${params.toString()}`;
}

function StartRow({ item }: { item: StartItem }) {
  return (
    <li>
      <Link className="ov-row ins-row" data-tone={item.tone} href={item.href}>
        <span aria-hidden="true" className="ov-kind" data-tone={item.tone}><Icon name={item.reason === "flagged" ? "alert" : "clock"} /></span>
        <span className="ov-row-name">
          {item.flags.length ? (
            <span className="ins-flags">{item.flags.map((flag) => <b data-severity={flag.severity} key={flag.key}>{flag.sentence}</b>)}</span>
          ) : null}
          <span className={item.flags.length ? "ins-sentence" : "ins-sentence ins-lead"}>{item.sentence}</span>
        </span>
        <Badge tone={item.tone}>{item.tone === "urgent" ? "Critical" : "High"}</Badge>
        <Icon name="chevron" />
      </Link>
    </li>
  );
}

export function InsightsBody({ feed, period }: { feed: ChangeFeedData; period: FeedPeriod }) {
  const router = useRouter();
  const now = feed.generatedAt;
  const verdict = insightsVerdict(feed, period);
  const start = whereToStart(feed.rows, period, now);
  const days = changesByDay(feed.rows, period, now);
  const services = changesByService(feed.rows, period);
  const people = topPeople(feed.rows);
  const quiet = quietServices(feed.rows);
  const record = insightsRecord(feed);
  const busiest = Math.max(1, ...services.map((service) => service.count));
  // A reader scoped to some entities gets only drift rows for settings they own; the page
  // says what is left out and counts nothing else.
  const scoped = Boolean(feed.scope);

  function choosePeriod(next: FeedPeriod) {
    const params = new URLSearchParams(window.location.search);
    if (next === DEFAULT_INSIGHTS_PERIOD) params.delete("days"); else params.set("days", next);
    const query = params.toString();
    router.push(`${window.location.pathname}${query ? `?${query}` : ""}`);
  }

  return (
    <div className="ins-page">
      <style href="keel-insights" precedence="default">{CSS}</style>
      <Verdict
        action={start.flagged.length ? { label: "See every flagged change", href: feedHref(period, { flagged: "1" }) } : null}
        detail={record.limitNote ? `${record.limitNote} Pick a shorter period to count all of them.` : undefined}
        text={verdict.text}
        tone={verdict.tone}
      />
      <ScopeNote text={feedScopeNote(feed.scope)} />

      <div className="ins-tools">
        <Segmented label="Period" onChange={choosePeriod} options={INSIGHTS_PERIODS.map((value) => ({ value, label: `${value} days` }))} value={period} />
      </div>

      <div data-layer="explanation">
        <section aria-labelledby="ins-start-heading" className="ov-attention ins-start">
          <h2 id="ins-start-heading">Where to start</h2>
          {start.flagged.length || start.watch.length ? (
            <>
              {start.flagged.length ? (
                <>
                  <p className="ov-sub">Flagged: a rule knows what these changes do. Most severe and newest first.</p>
                  <ul aria-label="Flagged changes" className="ov-rows">
                    {start.flagged.slice(0, MOST_FLAGGED).map((item) => <StartRow item={item} key={item.id} />)}
                  </ul>
                  {start.flagged.length > MOST_FLAGGED ? (
                    <Link className="ins-more" href={feedHref(period, { flagged: "1" })}>See all {start.flagged.length.toLocaleString("en-GB")} flagged changes</Link>
                  ) : null}
                </>
              ) : null}
              {start.watch.length ? (
                <>
                  <p className="ov-sub">Changes to critical or high priority settings that no rule flagged.</p>
                  <ul aria-label="Other changes to look at" className="ov-rows">
                    {start.watch.slice(0, MOST_WATCH).map((item) => <StartRow item={item} key={item.id} />)}
                  </ul>
                  {start.watch.length > MOST_WATCH ? (
                    <Link className="ins-more" href={feedHref(period, { priority: "critical,high" })}>See all {start.watch.length.toLocaleString("en-GB")} of them</Link>
                  ) : null}
                </>
              ) : null}
            </>
          ) : (
            <p className="ov-calm"><Icon name="check-circle" />{feed.rows.length ? "No change needs a look first: none is flagged or critical or high priority." : "Nothing to look at: Keel found no changes in this period."}</p>
          )}
        </section>

        <section aria-labelledby="ins-shape-heading" className="ins-shape">
          <h2 id="ins-shape-heading">Shape of the period</h2>
          <div className="ins-cards">
            <section aria-labelledby="ins-days-heading" className="ov-card ins-card-wide">
              <div className="ov-card-head">
                <div>
                  <h3 className="ins-card-title" id="ins-days-heading"><Icon name="calendar" />Changes per day</h3>
                  <p className="ov-sub">{changes(feed.rows.length)} over the last {period} days. Times are UTC days.</p>
                </div>
              </div>
              <Link aria-label="Open every change by day" className="ov-chart-link" href={feedHref(period)}>
                <Sparkline label="Changes per day" points={days} />
              </Link>
            </section>

            <section aria-labelledby="ins-services-heading" className="ov-card">
              <div className="ov-card-head">
                <div>
                  <h3 className="ins-card-title" id="ins-services-heading"><Icon name="cloud" />By service</h3>
                  <p className="ov-sub">The busiest first.</p>
                </div>
              </div>
              {services.length ? (
                <ul className="ov-legend ins-bars">
                  {services.map((service) => {
                    const name = serviceFor(service.key === "other" ? null : service.key).name;
                    return (
                      <li key={service.key}>
                        <Link className="ov-legend-link ins-bar" href={service.href}>
                          <span className="ov-legend-label">{name}{service.flagged ? <small> · {service.flagged.toLocaleString("en-GB")} flagged</small> : null}</span>
                          <b>{service.count.toLocaleString("en-GB")}</b>
                          <span aria-hidden="true" className="ins-bar-track"><span data-tone={service.flagged ? "soon" : "low"} style={{ width: `${(service.count / busiest) * 100}%` }} /></span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="ov-sub">No service had a change.</p>}
            </section>

            <section aria-labelledby="ins-people-heading" className="ov-card">
              <div className="ov-card-head">
                <div>
                  <h3 className="ins-card-title" id="ins-people-heading"><Icon name="person" />Who made the most changes</h3>
                  <p className="ov-sub">People and apps, as this page names them.</p>
                </div>
              </div>
              {people.length ? (
                <ul className="ov-legend">
                  {people.map((person) => (
                    <li key={person.key}>
                      <Link className="ov-legend-link" href={feedHref(period, { group: "person" })}>
                        <Icon name={person.app ? "settings" : "person"} />
                        <span className="ov-legend-label">{person.name}{person.app ? <small> · app</small> : null}{person.flagged ? <small> · {person.flagged.toLocaleString("en-GB")} flagged</small> : null}</span>
                        <b>{person.count.toLocaleString("en-GB")}</b>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <p className="ov-sub">Keel could not tie any change in this period to a person or app.</p>}
            </section>

            <section aria-labelledby="ins-quiet-heading" className="ov-card">
              <div className="ov-card-head">
                <div>
                  <h3 className="ins-card-title" id="ins-quiet-heading"><Icon name="check-circle" />No changes</h3>
                  <p className="ov-sub">{scoped ? "Services with no change to your settings in this period." : "Services with no change in this period."}</p>
                </div>
              </div>
              {quiet.length ? (
                <ul className="ins-quiet">
                  {quiet.map((service) => <li key={service}><Icon name={serviceFor(service).icon} />{serviceFor(service).name}</li>)}
                </ul>
              ) : <p className="ov-sub">Every service had at least one change.</p>}
            </section>
          </div>
        </section>
      </div>

      <TechnicalDetails summary="Technical details: this period">
        <RecordField copy={false} label="Read with" value={`GET /api/changes/feed?days=${period}`} />
        <RecordField label="Window" value={record.window} />
        <RecordField label="Rows shown" value={feed.rows.length} />
        <RecordField label="Changes from backups" usage={SOURCE_WORDS.drift.about} value={record.sources.drift} />
        {scoped ? null : (
          <>
            <RecordField label="Changes from service reads" usage={SOURCE_WORDS.service.about} value={record.sources.service} />
            <RecordField label="Changes from content backups" usage={SOURCE_WORDS.backup.about} value={record.sources.backup} />
            <RecordField label="Changes from the audit log" usage={SOURCE_WORDS.audit.about} value={record.sources.audit} />
          </>
        )}
        <RecordField label="Feed limit reached" value={record.limitNote ?? "No: every change in the period is counted."} />
      </TechnicalDetails>
    </div>
  );
}

const CSS = `
.ins-page { display: grid; gap: var(--space-md); min-width: 0; }
.ins-page > [data-layer="explanation"] { display: grid; gap: var(--space-lg); min-width: 0; }
.ins-tools .segmented { display: inline-flex; width: auto; }
.ins-start .ov-sub { margin-top: var(--space-2xs); }
.ins-row .ov-row-name { gap: var(--space-2xs); }
.ins-flags { display: grid; gap: 2px; }
.ins-flags b { color: var(--check-soon); overflow-wrap: anywhere; }
.ins-flags b[data-severity="critical"] { color: var(--urgent); }
.ins-sentence { color: var(--text-soft); font-size: 0.8125rem; line-height: 1.35; overflow-wrap: anywhere; }
.ins-sentence.ins-lead { color: var(--text); font-size: 0.9375rem; font-weight: 600; }
.ins-more { justify-self: start; font-size: 0.875rem; }
.ins-shape { display: grid; gap: var(--space-xs); min-width: 0; }
.ins-shape > h2 { margin: 0; font-size: 1rem; font-weight: 650; }
.ins-cards { display: grid; gap: var(--space-sm); grid-template-columns: repeat(3, minmax(0, 1fr)); min-width: 0; }
.ins-cards > * { min-width: 0; }
.ins-card-wide { grid-column: 1 / -1; }
.ins-cards .ov-legend, .ins-quiet { align-content: start; }
.ins-card-title { display: inline-flex; align-items: center; gap: var(--space-xs); margin: 0; font-size: 1rem; font-weight: 650; }
.ins-card-title .icon { width: 1.125rem; height: 1.125rem; flex: none; color: var(--text-soft); }
.ins-bar { flex-wrap: wrap; row-gap: 0.25rem; }
.ins-bar small, .ov-legend-label small { color: var(--text-soft); font-size: 0.75rem; }
.ins-bar-track { display: block; flex-basis: 100%; height: 0.375rem; overflow: hidden; border-radius: 999px; background: var(--surface-muted); }
.ins-bar-track span { display: block; height: 100%; min-width: 4px; border-radius: 999px; background: var(--low-risk); }
.ins-bar-track span[data-tone="soon"] { background: var(--check-soon); }
.ins-quiet { display: grid; gap: var(--space-2xs); margin: 0; padding: 0; list-style: none; }
.ins-quiet li { display: flex; align-items: center; gap: var(--space-xs); color: var(--text-soft); font-size: 0.875rem; overflow-wrap: anywhere; }
.ins-quiet .icon { width: 0.875rem; height: 0.875rem; flex: none; }
@media (max-width: 64rem) {
  .ins-cards { grid-template-columns: minmax(0, 1fr); }
}
`;
