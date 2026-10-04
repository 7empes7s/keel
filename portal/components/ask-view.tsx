import Link from "next/link";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import {
  ASK_INTENTS, ASK_PERIODS, gapSentence, recordSentence, recordTitle, sourceLabel, understoodAs, windowSentence,
  type AskData, type AnswerRecord, type GroundedAnswer,
} from "@/lib/ask-view";
import { RESOURCE_TYPE_LABELS, formatTimestamp } from "@/lib/presentation";

// Roadmap task-99: the Ask page. Both forms submit with GET, so asking never changes
// anything. Every answer lists the records it rests on, each with a link to where it
// came from and the window it covers; the plan, ids and raw values sit in the record.
const CSS = `
.ask-forms { display: grid; gap: var(--space-md); grid-template-columns: minmax(0, 1fr); }
.ask-form { display: grid; gap: var(--space-sm); }
.ask-form-row { display: grid; gap: var(--space-sm); grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); align-items: end; }
.ask-question { display: grid; gap: var(--space-sm); grid-template-columns: minmax(0, 1fr) auto; align-items: end; }
.ask-examples { margin: 0; padding-left: var(--space-lg); display: grid; gap: var(--space-2xs); }
.ask-answer { display: grid; gap: var(--space-sm); }
.ask-understood, .ask-scope, .ask-refusal { margin: 0; }
.ask-gaps { margin: 0; padding-left: var(--space-lg); display: grid; gap: var(--space-2xs); }
.ask-gap { color: var(--text-soft); font-weight: 600; }
.ask-records { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-sm); }
.ask-record { display: grid; gap: var(--space-2xs); padding: var(--space-sm) var(--space-md); border-left: 3px solid var(--line-strong); overflow-wrap: anywhere; }
.ask-record p { margin: 0; }
.ask-record-title { font-weight: 600; }
.ask-record-window { color: var(--text-soft); }
.ask-truncated { margin: 0; }
@media (max-width: 40rem) {
  .ask-question { grid-template-columns: minmax(0, 1fr); }
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

function RecordItem({ record }: { record: AnswerRecord }) {
  return (
    <li className={`ask-record ask-record-${record.kind}`}>
      <p className="ask-record-title">{recordTitle(record)}</p>
      <p>{recordSentence(record)}</p>
      <p className="ask-record-window">{windowSentence(record)}</p>
      <p><Link href={record.source.href}>{sourceLabel(record)}</Link></p>
    </li>
  );
}

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

export function AnswerView({ answer }: { answer: GroundedAnswer }) {
  const understood = understoodAs(answer);
  return (
    <section aria-labelledby="ask-answer-heading" className="item-card ask-answer">
      <h2 id="ask-answer-heading">Answer</h2>
      {answer.question ? <p className="ask-understood">You asked: “{answer.question}”</p> : null}
      {understood ? <p className="ask-understood">Understood as: {understood}</p> : null}
      {answer.refusal ? <p className="ask-refusal">{answer.refusal.message}</p> : null}
      {!answer.scope.central ? (
        <p className="ask-scope">Only resources owned by {answer.scope.entities.join(" and ")} are included. Other resources in this tenant are answered for a central administrator.</p>
      ) : null}
      {answer.status === "unknown" && answer.intent ? (
        <p className="ask-gap">KEEL has no record for this, so it cannot say whether anything happened. This is not the same as nothing happening.</p>
      ) : null}
      {answer.gaps.length && answer.status !== "unknown" ? (
        <ul aria-label="Periods KEEL cannot answer for" className="ask-gaps">
          {answer.gaps.map((gap, index) => <li className="ask-gap" key={index}>{gapSentence(gap)}</li>)}
        </ul>
      ) : null}
      {answer.intent && answer.status !== "unknown" && answer.records.length === 0 ? (
        <p>Nothing matched in the part of this period KEEL has records for.</p>
      ) : null}
      {answer.records.length ? (
        <ul aria-label="Records this answer rests on" className="ask-records">
          {answer.records.map((record) => <RecordItem key={record.id} record={record} />)}
        </ul>
      ) : null}
      {answer.truncated ? <p className="ask-truncated">Showing the newest {answer.shown} of {answer.total}. Narrow the question to see the rest.</p> : null}
      <p className="ask-record-window">Answered {formatTimestamp(answer.generatedAt)} from KEEL&apos;s own records. Nothing was changed.</p>
      <AnswerRecordLayer answer={answer} />
    </section>
  );
}

export function AskView({ data, question = "" }: { data: AskData; question?: string }) {
  const typeOptions = Object.entries(RESOURCE_TYPE_LABELS).filter(([type]) => type !== "retentionLabel");
  return (
    <div className="ask-view">
      <AskStyles />
      <div className="ask-forms">
        <section aria-labelledby="ask-question-heading" className="item-card">
          <h2 id="ask-question-heading">Ask a question</h2>
          <form action="/ask" className="ask-form" method="get" role="search">
            <div className="ask-question">
              <label className="filter-field">
                <span>Question</span>
                <input defaultValue={question} maxLength={500} name="q" placeholder="What changed this week?" type="search" />
              </label>
              <button className="btn btn-primary" type="submit">Ask</button>
            </div>
          </form>
          <p className="ask-understood">For example:</p>
          <ul className="ask-examples">
            {EXAMPLES.map((example) => <li key={example}><Link href={`/ask?q=${encodeURIComponent(example)}`}>{example}</Link></li>)}
          </ul>
        </section>
        <section aria-labelledby="ask-form-heading" className="item-card">
          <h2 id="ask-form-heading">Or choose</h2>
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
      </div>
      {data.answer ? <AnswerView answer={data.answer} /> : null}
    </div>
  );
}
