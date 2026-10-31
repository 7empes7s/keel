import Link from "next/link";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { AskRecords } from "@/components/ask-records";
import { Icon, type IconName } from "@/components/shell/icons";
import { AlertList } from "@/components/ui/alert-list";
import { Badge } from "@/components/ui/badge";
import { StatTiles } from "@/components/ui/stat-tiles";
import {
  ASK_INTENTS, ASK_PERIODS, answerBadge, answerSummary, askAlerts, coverageAnswerSummary, askTiles, understoodAs, understoodFilters,
  type AskData, type GroundedAnswer, type SummaryRow,
} from "@/lib/ask-view";
import { RESOURCE_TYPE_LABELS, formatTimestamp } from "@/lib/presentation";

// Roadmap task-99: the Ask page. Both forms submit with GET, so asking never changes
// anything. Every answer lists the records it rests on, each with a link to where it
// came from and the window it covers; the plan, ids and raw values sit in the record.
const CSS = `
.ask-forms { display: contents; }
.ask-form-card { display: grid; gap: var(--space-sm); min-width: 0; padding: var(--space-md); border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); }
.ask-form-card h2 { display: inline-flex; align-items: center; gap: var(--space-xs); margin: 0; font-size: 1rem; font-weight: 650; }
.ask-form-card h2 .icon { width: 1rem; height: 1rem; color: var(--text-soft); }
.ask-form { display: grid; gap: var(--space-sm); }
.ask-form .filter-field > span { color: var(--text-soft); font-size: 0.8125rem; font-weight: 600; letter-spacing: normal; text-transform: none; }
.ask-form-row { display: grid; gap: var(--space-sm); grid-template-columns: repeat(4, minmax(0, 1fr)) auto; align-items: end; }
.ask-question { display: grid; gap: var(--space-sm); grid-template-columns: minmax(0, 1fr) auto; align-items: end; }
.ask-examples { display: flex; flex-wrap: wrap; gap: var(--space-2xs); margin: 0; padding: 0; list-style: none; }
.ask-examples a { display: inline-flex; padding: 0.25rem var(--space-sm); border: 1px solid var(--line-strong); border-radius: 999px; color: var(--text); font-size: 0.8125rem; text-decoration: none; }
.ask-examples a:hover { border-color: var(--accent, var(--check-soon)); }
.ask-examples a:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.ask-answer { display: grid; gap: var(--space-md); min-width: 0; }
.ask-asked { display: grid; gap: var(--space-2xs); margin: 0; padding: var(--space-sm) var(--space-md); border-left: 3px solid var(--line-strong); background: var(--surface-muted); border-radius: var(--radius-md); }
.ask-asked p { margin: 0; overflow-wrap: anywhere; }
.ask-question-text { font-weight: 650; }
.ask-understood { color: var(--text-soft); font-size: 0.875rem; }
.ask-badges { display: flex; flex-wrap: wrap; gap: var(--space-2xs); }
.ask-foot { margin: 0; color: var(--text-soft); font-size: 0.8125rem; }
@media (max-width: 64rem) {
  .ask-form-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 40rem) {
  .ask-question, .ask-form-row { grid-template-columns: minmax(0, 1fr); }
}
`;

function AskStyles() {
  return <style href="keel-ask" precedence="default">{CSS}</style>;
}

const EXAMPLES = [
  "What changed this week?",
  "Which groups were removed in the last 7 days?",
  "What is covered in the latest backup?",
  "Which jobs failed yesterday?",
];

function AnswerRecordLayer({ answer }: { answer: GroundedAnswer }) {
  return (
    <TechnicalDetails>
      <RecordField label="Answer status" value={answer.status} />
      <RecordField label="Read by" value={answer.readBy ?? null} usage="rules: KEEL's built-in reading of the question; form: the structured form" />
      {answer.refusal ? <RecordField label="Refusal code" value={answer.refusal.code} /> : null}
      {answer.plan ? <RecordField label="Query plan" value={JSON.stringify(answer.plan)} usage="A fixed, read-only query with these values as parameters" /> : null}
      <RecordField label="Reader scope" value={answer.scope.central ? "central" : answer.scope.entities.join(",")} usage="From your grants; never from the question" />
      {answer.window ? <RecordField label="Window" value={`${answer.window.from} / ${answer.window.to}`} /> : null}
      <RecordField label="Compared history" value={answer.known ? `${answer.known.from} / ${answer.known.to}` : null} />
      {answer.gaps.map((gap, index) => <RecordField key={`gap-${index}`} label={`Unknown period ${index + 1}`} value={`${gap.reason} ${gap.from} / ${gap.to}`} />)}
      <RecordField label="Records" value={`${answer.shown} of ${answer.total}`} copy={false} />
      {answer.records.map((record) => (
        <RecordField
          key={record.id}
          label={record.kind === "change" ? `Change ${record.naturalKey}` : record.kind === "job" ? `Job (${record.jobKind})` : `Coverage ${record.resourceType}`}
          value={record.kind === "job" && record.error ? `${record.id} ${record.error}` : record.kind === "change" ? `${record.id} seen in ${record.source.collectionId ?? "an unknown collection"}` : record.kind === "coverage" ? `${record.source.id} ${record.outcome}` : record.id}
        />
      ))}
    </TechnicalDetails>
  );
}

function SummaryList({ title, icon, rows, total, limit = 6 }: { title: string; icon: IconName; rows: SummaryRow[]; total: number; limit?: number }) {
  const shown = rows.slice(0, limit);
  const rest = rows.slice(limit).reduce((sum, row) => sum + row.count, 0);
  return (
    <section className="ak-sum-card">
      <h3><Icon name={icon} />{title}</h3>
      <ul>
        {shown.map((row) => (
          <li data-tone={row.tone} key={row.key}>
            <span className="ak-sum-label">{row.icon ? <Icon name={row.icon as IconName} /> : null}{row.tone !== "neutral" ? <Badge tone={row.tone}>{row.label}</Badge> : row.label}</span>
            <span className="ak-sum-bar"><i style={{ width: `${Math.max(4, Math.round((row.count / Math.max(1, total)) * 100))}%` }} /></span>
            <b>{row.count.toLocaleString("en-GB")}</b>
          </li>
        ))}
        {rest ? <li className="ak-sum-rest"><span className="ak-sum-label">{`${rows.length - limit} more`}</span><span /><b>{rest.toLocaleString("en-GB")}</b></li> : null}
      </ul>
    </section>
  );
}

/** Every match counted by service, kind, risk and change, before any row. */
function AnswerSummary({ answer }: { answer: GroundedAnswer }) {
  const summary = answerSummary(answer);
  if (!summary) return null;
  const total = summary.services.reduce((sum, row) => sum + row.count, 0);
  return (
    <section aria-label="Summary of every match" className="ak-summary">
      <SummaryList icon="service-keel" rows={summary.services} title="By service" total={total} />
      <SummaryList icon="filter" rows={summary.kinds} title="By kind of setting" total={total} />
      <SummaryList icon="alert" rows={summary.risks} title="By risk" total={total} />
      <SummaryList icon="swap" rows={summary.changes} title="By change" total={total} />
    </section>
  );
}

/** A coverage answer's kinds by state, in the shared buckets, and by service. */
function CoverageSummaryCards({ answer }: { answer: GroundedAnswer }) {
  const summary = coverageAnswerSummary(answer);
  if (!summary) return null;
  return (
    <section aria-label="Summary of every kind" className="ak-summary">
      <SummaryList icon="backup" rows={summary.states} title="By state" total={summary.total} />
      {summary.services.length ? <SummaryList icon="service-keel" rows={summary.services} title="By service" total={summary.total} /> : null}
    </section>
  );
}

export function AnswerView({ answer }: { answer: GroundedAnswer }) {
  const understood = understoodAs(answer);
  const badge = answerBadge(answer);
  return (
    <section aria-labelledby="ask-answer-heading" className="ask-answer">
      <div className="rs-section-head">
        <h2 id="ask-answer-heading"><Icon name="search" />Answer</h2>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {answer.question || understood ? (
        <div className="ask-asked">
          {answer.question ? <p className="ask-question-text">“{answer.question}”</p> : null}
          {understood ? <p className="ask-understood">Understood as: {understood}</p> : null}
          <ul aria-label="What KEEL understood" className="ak-understood">
            {understoodFilters(answer).map((filter) => (
              <li data-filter={filter.key} key={filter.key}>
                <span><small>{filter.label}</small>{filter.value}</span>
                {filter.removeHref ? <Link aria-label={`Ask again without ${filter.label.toLowerCase()}: ${filter.value}`} className="ak-remove" href={filter.removeHref}><Icon name="close" /></Link> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <AlertList calm="KEEL has records for the whole period." items={askAlerts(answer)} />
      {answer.intent ? <StatTiles label="The answer at a glance" tiles={askTiles(answer)} /> : null}
      {answer.intent && answer.status !== "unknown" && answer.records.length === 0 ? (
        <p className="pg-empty"><Icon name="info" />Nothing matched in the part of this period KEEL has records for.</p>
      ) : null}
      <AnswerSummary answer={answer} />
      <CoverageSummaryCards answer={answer} />
      {answer.records.length ? <AskRecords records={answer.records} /> : null}
      {answer.truncated ? <p className="pg-help ask-truncated"><Icon name="info" />The table lists the newest {answer.shown.toLocaleString("en-GB")} of {answer.total.toLocaleString("en-GB")}; the summary counts all of them. Narrow the question to list the rest.</p> : null}
      <p className="ask-foot">Answered {formatTimestamp(answer.generatedAt)} from KEEL&apos;s own records. Nothing was changed.</p>
      <AnswerRecordLayer answer={answer} />
    </section>
  );
}

export function AskView({ data, question = "" }: { data: AskData; question?: string }) {
  const typeOptions = Object.entries(RESOURCE_TYPE_LABELS).filter(([type]) => type !== "retentionLabel");
  return (
    <div className="pg-page ask-view">
      <AskStyles />
      <div className="ask-forms">
        <section aria-labelledby="ask-question-heading" className="ask-form-card">
          <h2 id="ask-question-heading"><Icon name="search" />Ask a question</h2>
          <form action="/ask" className="ask-form" method="get" role="search">
            <div className="ask-question">
              <label className="filter-field">
                <span>Question</span>
                <input defaultValue={question} maxLength={500} name="q" placeholder="What changed this week?" type="search" />
              </label>
              <button className="btn btn-primary" type="submit">Ask</button>
            </div>
          </form>
          <ul aria-label="Example questions" className="ask-examples">
            {EXAMPLES.map((example) => <li key={example}><Link href={`/ask?q=${encodeURIComponent(example)}`}>{example}</Link></li>)}
          </ul>
        </section>
        <section aria-labelledby="ask-form-heading" className="ask-form-card">
          <h2 id="ask-form-heading"><Icon name="filter" />Or choose</h2>
          <form action="/ask" className="ask-form" method="get">
            <div className="ask-form-row">
              <label className="filter-field">
                <span>Question</span>
                <select defaultValue="changes" name="intent">
                  {ASK_INTENTS.map((intent) => <option key={intent.value} value={intent.value}>{intent.label}</option>)}
                </select>
              </label>
              <label className="filter-field">
                <span>Period</span>
                <select defaultValue="this-week" name="period">
                  {ASK_PERIODS.map((period) => <option key={period.value} value={period.value}>{period.label}</option>)}
                </select>
              </label>
              <label className="filter-field">
                <span>Owned by</span>
                <select defaultValue="" name="entity">
                  <option value="">{data.scope.central ? "Any owner" : "Any entity you can see"}</option>
                  {data.entities.map((entity) => <option key={entity} value={entity}>{entity}</option>)}
                </select>
              </label>
              <label className="filter-field">
                <span>Kind of resource</span>
                <select defaultValue="" name="type">
                  <option value="">Any kind</option>
                  {typeOptions.map(([type, label]) => <option key={type} value={type}>{label[0].toUpperCase() + label.slice(1)}</option>)}
                </select>
              </label>
              <button className="btn" type="submit">Answer</button>
            </div>
          </form>
        </section>
        {data.answer ? <AnswerView answer={data.answer} /> : null}
      </div>
    </div>
  );
}
