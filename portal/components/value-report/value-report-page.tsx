"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, type MouseEvent } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { BaselinesStyles } from "@/components/baselines/styles";
import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { DatePicker } from "@/components/pickers/date-picker";
import { MultiOptionPicker } from "@/components/pickers/option-picker";
import { Icon } from "@/components/shell/icons";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Verdict } from "@/components/verdict";
import { ValueReportRecord } from "@/components/value-report/value-report-record";
import { plainControlTitle } from "@/lib/compliance-view";
import {
  CHART_ORDER,
  FAMILY_WORDS,
  FINDING_STATE_LABELS,
  FINDING_WORDS,
  HOURS_FAMILY_WORDS,
  NO_COMPLIANCE_CLAIM,
  OUTCOME_STATE_LABELS,
  OUTCOME_WORDS,
  attemptsWord,
  estimateNote,
  estimateOwner,
  findingLine,
  findingSentence,
  findingTitle,
  freshnessSentence,
  hoursShort,
  isWithheld,
  needsLook,
  orderOutcomes,
  outcomeHref,
  outcomeMeta,
  outcomeName,
  outcomeSentence,
  outcomeWhen,
  ownerName,
  periodParam,
  periodPresets,
  periodRange,
  periodWords,
  reasonSentence,
  recoverySentence,
  BACKUP_AREA_WORDS,
  backupView,
  scopeSentence,
  shortDuration,
  valueVerdict,
  type BackupArea,
  type BackupSection,
  type FindingsSection,
  type RecoverySection,
  type BackupTile,
  type OutcomeRow,
  type OutcomeState,
  type OutcomeSummary,
  type ValueReportData,
  type Withheld,
} from "@/lib/value-report-view";
import { failedRestoresLine } from "@/lib/failed-restores";
import { addsWords, applyFilters, readPicked, tileCounts, tileParam, withoutTile, type FilterTile } from "@/lib/filter-set";
import { formatTimestamp } from "@/lib/presentation";
import { pushUrl } from "@/lib/url-history";
import { useViewState } from "@/lib/use-view-state";
import { csvLine } from "@/lib/csv";

// Value report (portal audit, pick A: dashboard of charts). Four count tiles, one
// results chart drawn to scale (opens full screen with `chart=full`), cards for
// security checks, recovery and time saved, then every request (each opens its job)
// and the security checks by title. Period (`period=`) and owner (`entity=`) are read by
// the server; the result filter (`result=`) is the page's own. Ids stay in the record.

type ResultFilter = "verified" | "open" | "attention";
const FILTERS: Record<ResultFilter, { label: string; test: (state: OutcomeState) => boolean }> = {
  verified: { label: "put back and checked", test: (state) => state === "verified" },
  open: { label: "still open", test: (state) => state !== "verified" },
  attention: { label: "failed or changed again", test: (state) => state === "failed" || state === "reopened" },
};

// The result tiles add up: `result=verified,attention` shows requests in either.
const RESULT_TILES: FilterTile<OutcomeRow>[] = (Object.keys(FILTERS) as ResultFilter[]).map((key) => ({ key, test: (row: OutcomeRow) => FILTERS[key].test(row.state) }));
const FILTER_LABELS: Record<ResultFilter, string> = { verified: "Put back and checked", open: "Still open", attention: "Failed or changed again" };

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function ValueReportPage({ data }: { data: ValueReportData }) {
  const { report, period, entities, owners = [] } = data;
  const { outcomes, findings, recovery, hoursSaved } = report;
  const router = useRouter();
  const view = useViewState();
  const pathname = usePathname() ?? "/reports";
  const params = useSearchParams();
  const today = report.generatedAt.slice(0, 10);
  const verdict = valueVerdict(report);
  const look = needsLook(outcomes);
  const resultParam = params?.get("result") ?? null;
  const filter = readPicked(RESULT_TILES, resultParam) as ResultFilter[];
  const filterKey = filter.join(",");
  const rows = useMemo(() => orderOutcomes(outcomes.rows), [outcomes.rows]);
  const shown = useMemo(() => applyFilters(rows, RESULT_TILES, filterKey ? filterKey.split(",") : []), [rows, filterKey]);
  const tileTotals = useMemo(() => new Map(tileCounts(rows, RESULT_TILES, filterKey ? filterKey.split(",") : []).map((entry) => [entry.key, entry])), [rows, filterKey]);
  const activeFilters: ActiveFilter[] = filter.map((key) => ({ key: `result:${key}`, label: FILTER_LABELS[key], clear: { result: withoutTile(filter, key) } }));
  const tileAdds = (key: ResultFilter) => {
    const words = addsWords(tileTotals.get(key), filter.length);
    return words ? <small className="tile-adds">{words}</small> : null;
  };
  const tileTitle = (key: ResultFilter) => (filter.includes(key) ? "Picked: click to remove it from the view" : "Click to add these to the view");
  const chartOpen = view.get("chart") === "full";
  const shownFindings = isWithheld(findings) ? null : findings;
  const shownRecovery = isWithheld(recovery) ? null : recovery;

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    const text = next.toString();
    return text ? `${pathname}?${text}` : pathname;
  };
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const openChart = (event: MouseEvent) => {
    event.preventDefault();
    pushUrl(href({ chart: "full" }));
  };

  const groupings = useMemo<Grouping<OutcomeRow>[]>(() => [
    { key: "result", label: "Result", groupsOf: (items) => groupBy(items, (item) => item.state, (key, list) => ({ label: OUTCOME_STATE_LABELS[key as OutcomeState], icon: OUTCOME_WORDS[key as OutcomeState].icon, about: plural(list.length, "request") }), (key) => OUTCOME_WORDS[key as OutcomeState].rank) },
    { key: "kind", label: "Kind", groupsOf: (items) => groupBy(items, (item) => item.family, (key, list) => ({ label: FAMILY_WORDS[key as OutcomeRow["family"]].label, icon: FAMILY_WORDS[key as OutcomeRow["family"]].icon, about: plural(list.length, "request") }), (key) => (key === "restore" ? 0 : 1)) },
  ], []);

  const renderRow = (row: OutcomeRow) => {
    const words = OUTCOME_WORDS[row.state];
    const to = outcomeHref(row);
    return (
      <div className="vr-row" data-state={row.state}>
        <span aria-hidden="true" className="vr-kind" data-tone={words.tone ?? undefined}><Icon name={FAMILY_WORDS[row.family].icon} /></span>
        <span className="vr-row-name">
          <Link className="vr-row-link" href={to}>{outcomeName(row)}</Link>
          <small>{outcomeMeta(row, today)}</small>
        </span>
        <span className="vr-row-mid">
          <Badge icon={words.icon} tone={words.badge}>{OUTCOME_STATE_LABELS[row.state]}</Badge>
          <small className="vr-reason">{reasonSentence(row.reason)}</small>
          <small>{attemptsWord(row.attempts)}</small>
        </span>
        <span className="vr-row-acts"><Link className="btn btn-sm" href={to}><Icon name="link" />Open job</Link></span>
      </div>
    );
  };

  function downloadRows(ids: string[]) {
    const chosen = shown.filter((row) => ids.includes(row.id));
    const lines = [["What was asked", "Kind", "Result", "Why", "Attempts", "Last activity", "Job ID"].join(",")];
    for (const row of chosen) lines.push(csvLine([outcomeName(row), FAMILY_WORDS[row.family].one, OUTCOME_STATE_LABELS[row.state], reasonSentence(row.reason), row.attempts, (outcomeWhen(row) ?? "").slice(0, 10), row.lastJobId ?? ""]));
    const url = URL.createObjectURL(new Blob([`${lines.join("\n")}\n`], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `keel-value-report-requests-${today}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const ownerOptions = owners.map((code) => ({ value: code, label: ownerName(code) }));

  return (
    <div className="vr-page">
      <div className="vr-toolbar">
        <DatePicker
          label="Period"
          onChange={(range) => { if (range) router.push(href({ period: periodParam(range, today), result: null })); }}
          presets={periodPresets(today)}
          today={today}
          value={periodRange(period, today)}
        />
        {owners.length ? (
          <MultiOptionPicker
            anyLabel="Everyone"
            label="Owned by"
            onChange={(values) => router.push(href({ entity: values.join(",") || null, result: null }))}
            options={ownerOptions}
            values={entities}
          />
        ) : null}
      </div>
      <p className="vr-scope">
        {scopeSentence(report)}
        {!report.provenance.complete ? " This period has more records than one report reads, so the counts are incomplete." : ""}
      </p>

      <Verdict action={look ? { label: `Open the ${look} that need${look === 1 ? "s" : ""} a look`, href: href({ result: "attention" }) } : null} text={verdict.text} tone={verdict.tone} />

      <div className="vr-explain" data-layer="explanation">
        <section aria-label="Results at a glance" className="vr-tiles">
          <Link aria-current={filter.includes("verified") || undefined} className="vr-tile" data-tone={outcomes.states.verified ? "fine" : undefined} href={href({ result: tileParam(RESULT_TILES, filter, "verified") })} title={tileTitle("verified")}>
            <span className="vr-tile-label"><Icon name="check-circle" />Put back and checked{filter.includes("verified") ? <Icon className="tile-check" name="check" /> : null}</span>
            <b className="vr-tile-count">{outcomes.states.verified}<small> of {outcomes.total}</small></b>
            <small>Read back after writing</small>
            <Meter parts={[{ tone: "fine", value: outcomes.states.verified }]} total={outcomes.total} />
            {tileAdds("verified")}
          </Link>
          <Link aria-current={filter.includes("open") || undefined} className="vr-tile" data-tone={look ? "soon" : undefined} href={href({ result: tileParam(RESULT_TILES, filter, "open") })} title={tileTitle("open")}>
            <span className="vr-tile-label"><Icon name="clock" />Still open{filter.includes("open") ? <Icon className="tile-check" name="check" /> : null}</span>
            <b className="vr-tile-count">{outcomes.total - outcomes.states.verified}</b>
            <small>{stillOpenWords(outcomes)}</small>
            <Meter parts={[{ tone: "urgent", value: outcomes.states.failed }, { tone: "soon", value: outcomes.states.reopened }, { tone: "neutral", value: outcomes.states.queued + outcomes.states.unconfirmed }]} total={outcomes.total} />
            {tileAdds("open")}
          </Link>
          <button className="vr-tile" data-tone={shownFindings?.states.open ? "urgent" : undefined} onClick={() => scrollTo("vr-checks")} type="button">
            <span className="vr-tile-label"><Icon name="baselines" />Security checks fixed</span>
            {shownFindings ? <b className="vr-tile-count">{shownFindings.states.resolved}<small> of {shownFindings.total}</small></b> : <b className="vr-tile-count vr-tile-word">Hidden</b>}
            <small>{shownFindings ? checksWords(shownFindings.states.open, shownFindings.states.unchecked) : "Needs whole-tenant access"}</small>
            {shownFindings ? <Meter parts={[{ tone: "fine", value: shownFindings.states.resolved }]} total={shownFindings.total} /> : null}
          </button>
          <button className="vr-tile" onClick={() => scrollTo("vr-hours")} type="button">
            <span className="vr-tile-label"><Icon name="clock" />Time saved</span>
            <b className={hoursSaved ? "vr-tile-count" : "vr-tile-count vr-tile-word"}>{hoursSaved ? hoursShort(hoursSaved.hours) : "No estimate"}</b>
            <small>{hoursSaved ? `Estimate set by ${estimateOwner(hoursSaved)}` : "Hours show once an estimate is set"}</small>
          </button>
        </section>

        <div className="vr-grid vr-grid-wide">
          <section aria-labelledby="vr-chart-heading" className="vr-card">
            <div className="vr-card-head">
              <h2 id="vr-chart-heading"><Icon name="reports" />Results by kind</h2>
              <Badge tone={resultsBadge(outcomes).tone}>{resultsBadge(outcomes).label}</Badge>
              <a className="btn btn-sm btn-ghost vr-full" href={href({ chart: "full" })} onClick={openChart}><Icon name="show" />Full screen</a>
            </div>
            <a aria-label="Results by kind: open full screen" className="vr-chart-open" href={href({ chart: "full" })} onClick={openChart}>
              <ResultsChart outcomes={outcomes} />
            </a>
            <p className="vr-muted">{outcomeSentence(outcomes)}</p>
          </section>

          <section aria-labelledby="vr-fixed-heading" className="vr-card">
            <div className="vr-card-head">
              <h2 id="vr-fixed-heading"><Icon name="baselines" />Security checks fixed</h2>
              <Badge tone={checksBadge(shownFindings).tone}>{checksBadge(shownFindings).label}</Badge>
            </div>
            <div className="vr-ring-row">
              {shownFindings && shownFindings.total ? <Ring label="fixed" value={shownFindings.percentResolved ?? 0} /> : null}
              <p className="vr-muted">{findingSentence(findings)} A check counts as fixed only while its newest result passes. An exception does not fix it.</p>
            </div>
            <Link className="vr-link" href="/benchmarks">Open Compliance</Link>
          </section>
        </div>

        <BackupsCard backups={report.backups} />

        <div className="vr-grid">

          <section aria-labelledby="vr-recovery-heading" className="vr-card">
            <div className="vr-card-head">
              <h2 id="vr-recovery-heading"><Icon name="restore" />How fast we recovered</h2>
              <Badge tone={recoveryBadge(shownRecovery).tone}>{recoveryBadge(shownRecovery).label}</Badge>
            </div>
            {shownRecovery ? (
              <>
                <dl className="vr-figures">
                  <div><dt>Middle restore</dt><dd>{shortDuration(shownRecovery.recoveryTime.medianMs)}</dd></div>
                  <div><dt>Slowest restore</dt><dd>{shortDuration(shownRecovery.recoveryTime.worstMs)}</dd></div>
                  <div><dt>Oldest backup at the end</dt><dd>{shownRecovery.freshness.state === "measured" ? shortDuration(shownRecovery.freshness.achievedRpoMs) : "Not measured"}</dd></div>
                </dl>
                {failedRestoresLine(shownRecovery.failedRestores) ? (
                  <p className="vr-muted" data-line="failed-restores">
                    <Badge tone={shownRecovery.failedRestores.period?.count ? "urgent" : "neutral"}>{shownRecovery.failedRestores.period?.count ?? 0} failed in this period</Badge>{" "}
                    <Link href={shownRecovery.failedRestores.href}>{failedRestoresLine(shownRecovery.failedRestores)}</Link>, counted the same way on Resilience and Restore.
                  </p>
                ) : null}
                <p className="vr-muted">{recoverySentence(recovery)} {freshnessSentence(shownRecovery)}</p>
                {shownRecovery.recoveryTime.notCounted ? <p className="vr-muted">{plural(shownRecovery.recoveryTime.notCounted, "other attempt was", "other attempts were")} not counted because {shownRecovery.recoveryTime.notCounted === 1 ? "it" : "they"} failed or {shownRecovery.recoveryTime.notCounted === 1 ? "was" : "were"} not checked.</p> : null}
              </>
            ) : <p className="vr-muted">{recoverySentence(recovery)}</p>}
            <Link className="vr-link" href="/resilience">Open Resilience</Link>
          </section>

          <section aria-labelledby="vr-hours-heading" className="vr-card" id="vr-hours">
            <div className="vr-card-head">
              <h2 id="vr-hours-heading"><Icon name="clock" />Time saved</h2>
              <Badge icon={null} tone={hoursSaved ? "neutral" : "soon"}>{hoursSaved ? "Estimate" : "No estimate set"}</Badge>
            </div>
            {hoursSaved ? (
              <>
                <p className="vr-big">About {hoursSaved.hours} hours</p>
                <table className="vr-table vr-hours-table">
                  <caption className="visually-hidden">How the hours add up</caption>
                  <thead><tr><th scope="col">What</th><th className="vr-num" scope="col">Count</th><th className="vr-num" scope="col">Minutes each</th><th className="vr-num" scope="col">Hours</th></tr></thead>
                  <tbody>
                    {hoursSaved.byFamily.map((row) => (
                      <tr data-family={row.family} key={row.family}>
                        <th data-label="What" scope="row">{HOURS_FAMILY_WORDS[row.family]}</th>
                        <td className="vr-num" data-label="Count">{row.verified}</td>
                        <td className="vr-num" data-label="Minutes each">{row.minutesEach}</td>
                        <td className="vr-num" data-label="Hours">{row.hours}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h3 className="vr-sub">Assumptions</h3>
                <ul className="vr-assumptions">{hoursSaved.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
                <p className="vr-muted">An estimate set by {estimateOwner(hoursSaved)}{hoursSaved.setAt ? ` on ${formatTimestamp(hoursSaved.setAt)}` : ""}, not a measurement. It counts checked results only, never attempts.</p>
              </>
            ) : <p className="vr-muted">{estimateNote(report)}</p>}
          </section>
        </div>

        <section aria-labelledby="vr-requests-heading" className="vr-section" id="vr-requests">
          <div className="vr-section-head">
            <h2 id="vr-requests-heading">What was asked</h2>
            <small>{plural(outcomes.total, "request")} · each opens its job</small>
          </div>
          <ActiveFilters filters={activeFilters} noun={{ one: "request", many: "requests" }} shown={shown.length} total={rows.length} />
          {outcomes.total === 0 ? (
            <p className="sel-empty">Keel was not asked to put anything back in this period.</p>
          ) : shown.length === 0 ? (
            <NoMatches filters={activeFilters} noun={{ one: "request", many: "requests" }} />
          ) : (
            <SelectableList
              action={{
                label: (count) => `Download ${plural(count, "request")}`,
                detail: () => "Saves these requests as a spreadsheet file (.csv).",
                run: downloadRows,
              }}
              getId={(item) => item.id}
              groupings={groupings}
              items={shown}
              label="Requests"
              matches={(item, text) => `${outcomeName(item)} ${outcomeMeta(item, today)} ${OUTCOME_STATE_LABELS[item.state]}`.toLowerCase().includes(text)}
              noun={{ one: "request", many: "requests" }}
              renderRow={renderRow}
              rowName={(item) => outcomeName(item)}
              toneOf={(item) => OUTCOME_WORDS[item.state].tone}
            />
          )}
          {outcomes.rowsShown < outcomes.total ? <p className="vr-muted">Showing {outcomes.rowsShown} of {outcomes.total}. The tiles and the downloads count every request.</p> : null}
        </section>

        <section aria-labelledby="vr-checks-heading" className="vr-section" id="vr-checks">
          <div className="vr-section-head">
            <h2 id="vr-checks-heading">Security checks</h2>
            {shownFindings ? <small>{plural(shownFindings.total, "check")} that failed during the period</small> : null}
          </div>
          {!shownFindings ? <p className="vr-muted">{findingSentence(findings)}</p> : shownFindings.total === 0 ? <p className="sel-empty">No security check was failing in this period.</p> : (
            <ul className="vr-checks">
              {shownFindings.rows.map((row) => {
                const words = FINDING_WORDS[row.state];
                return (
                  <li className="vr-row vr-check" data-state={row.state} key={row.id}>
                    <span aria-hidden="true" className="vr-kind" data-tone={row.state === "open" ? "urgent" : row.state === "resolved" ? "fine" : undefined}><Icon name="baselines" /></span>
                    <span className="vr-row-name"><b>{findingTitle(row, plainControlTitle)}</b><small>Security check</small></span>
                    <span className="vr-row-mid">
                      <Badge icon={words.icon} tone={words.badge}>{FINDING_STATE_LABELS[row.state]}</Badge>
                      <small>{findingLine(row, today)}</small>
                    </span>
                    <span className="vr-row-acts"><Link className="btn btn-sm btn-ghost" href="/benchmarks">Open in Compliance</Link></span>
                  </li>
                );
              })}
            </ul>
          )}
          {shownFindings && shownFindings.rowsShown < shownFindings.total ? <p className="vr-muted">Showing {shownFindings.rowsShown} of {shownFindings.total}.</p> : null}
        </section>

        <p className="vr-claim">{NO_COMPLIANCE_CLAIM}</p>
        <details className="vr-method">
          <summary>How Keel counts</summary>
          <ul>
            <li>A restore or undo request counts once, however many times it was tried.</li>
            <li>Waiting, running, failed and cancelled attempts never count as put back.</li>
            <li>Put back means checked afterwards: each setting read back and follow-up tasks closed, or a later backup showing the approved value.</li>
            <li>Something that changed again, or a security check that failed again, is not counted as fixed.</li>
          </ul>
        </details>

        <ValueReportRecord report={report} />
      </div>

      {chartOpen ? <BaselinesStyles /> : null}
      {chartOpen ? (
        <DetailsSheet kicker="Value report" onClose={() => view.set({ chart: null })} title="Results by kind" wide>
          <div className="vr-sheet">
            <p className="vr-muted">{periodWords(period, today)}. {scopeSentence(report)}</p>
            <ResultsChart big outcomes={outcomes} />
            <table className="vr-table vr-chart-table">
              <caption className="visually-hidden">Results by kind, as numbers</caption>
              <thead><tr><th scope="col">Result</th><th className="vr-num" scope="col">Restores</th><th className="vr-num" scope="col">Undo changes</th><th className="vr-num" scope="col">All</th></tr></thead>
              <tbody>
                {CHART_ORDER.map((state) => (
                  <tr data-state={state} key={state}>
                    <th data-label="Result" scope="row">{OUTCOME_STATE_LABELS[state]}</th>
                    <td className="vr-num" data-label="Restores">{outcomes.byFamily.restore.states[state]}</td>
                    <td className="vr-num" data-label="Undo changes">{outcomes.byFamily.remediation.states[state]}</td>
                    <td className="vr-num" data-label="All">{outcomes.states[state]}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><th data-label="Result" scope="row">All requests</th><td className="vr-num" data-label="Restores">{outcomes.byFamily.restore.total}</td><td className="vr-num" data-label="Undo changes">{outcomes.byFamily.remediation.total}</td><td className="vr-num vr-total" data-label="All">{outcomes.total}</td></tr>
                <tr><th data-label="Result" scope="row">Attempts</th><td className="vr-num" data-label="Restores">{outcomes.byFamily.restore.attempts}</td><td className="vr-num" data-label="Undo changes">{outcomes.byFamily.remediation.attempts}</td><td className="vr-num" data-label="All">{outcomes.attempts}</td></tr>
              </tfoot>
            </table>
          </div>
        </DetailsSheet>
      ) : null}
    </div>
  );
}

function stillOpenWords(outcomes: OutcomeSummary): string {
  const waiting = outcomes.states.queued + outcomes.states.unconfirmed;
  const parts = [];
  if (outcomes.states.failed) parts.push(`${plural(outcomes.states.failed, "request")} failed`);
  if (outcomes.states.reopened) parts.push(`${outcomes.states.reopened} changed again`);
  if (waiting) parts.push(`${waiting} waiting`);
  return parts.length ? parts.join(" · ") : "Nothing open";
}

function resultsBadge(outcomes: OutcomeSummary): { tone: BadgeTone; label: string } {
  if (!outcomes.total) return { tone: "neutral", label: "Nothing asked" };
  if (outcomes.states.failed) return { tone: "urgent", label: `${plural(outcomes.states.failed, "request")} failed` };
  if (outcomes.states.reopened) return { tone: "soon", label: `${outcomes.states.reopened} changed again` };
  const waiting = outcomes.total - outcomes.states.verified;
  return waiting ? { tone: "low", label: `${waiting} waiting` } : { tone: "fine", label: "All checked" };
}

function checksBadge(findings: FindingsSection | null): { tone: BadgeTone; label: string } {
  if (!findings) return { tone: "neutral", label: "Not shown" };
  if (findings.states.open) return { tone: "urgent", label: `${findings.states.open} still failing` };
  if (findings.states.unchecked) return { tone: "soon", label: `${findings.states.unchecked} not checked` };
  return { tone: "fine", label: findings.total ? "All fixed" : "None failing" };
}

function recoveryBadge(recovery: RecoverySection | null): { tone: BadgeTone; label: string } {
  if (!recovery) return { tone: "neutral", label: "Not shown" };
  if (recovery.recoveryTime.state === "unmeasured") return { tone: "soon", label: "Not measured" };
  return recovery.freshness.state === "measured" ? { tone: "fine", label: "Measured" } : { tone: "soon", label: "Backup age not measured" };
}

function checksWords(open: number, unchecked: number): string {
  const parts = [`${open} still failing`];
  if (unchecked) parts.push(`${unchecked} not checked`);
  return parts.join(", ");
}

/** What we backed up: one tile per family, problems first, then every area in one compact table. */
function BackupsCard({ backups }: { backups: BackupSection | Withheld | undefined }) {
  const view = backupView(backups);
  return (
    <section aria-labelledby="vr-backups-heading" className="vr-card vr-backups" id="vr-backups">
      <div className="vr-card-head">
        <h2 id="vr-backups-heading"><Icon name="backup" />What we backed up</h2>
        {view.state === "shown" ? <Badge tone={view.headline.tone}>{view.headline.text}</Badge> : <Badge tone="neutral">Not shown</Badge>}
      </div>
      {view.state !== "shown" ? <p className="vr-muted">{view.text}</p> : (
        <>
          <div className="vr-stats">
            {view.tiles.map((tile) => <BackupStat key={tile.key} tile={tile} />)}
          </div>
          {view.groups.length ? (
            <table className="vr-table vr-areas">
              <caption className="visually-hidden">Every backed-up area in this period, problems first</caption>
              <thead><tr><th scope="col">Area</th><th scope="col">Result</th></tr></thead>
              {view.groups.map((group) => (
                <tbody data-family={group.family} key={group.family}>
                  <tr className="vr-area-group"><th colSpan={2} scope="colgroup">{group.label}<small>{group.rows.filter((row) => row.state === "good").length} of {group.rows.length} backed up</small></th></tr>
                  {group.rows.map((row) => {
                    const words = BACKUP_AREA_WORDS[row.state];
                    return (
                      <tr data-state={row.state} key={row.workload}>
                        <th scope="row">
                          <span className="vr-area-name">{row.name}</span>
                          <small>{areaLine(row)}</small>
                        </th>
                        <td><Badge icon={words.icon} tone={words.badge}>{words.label}</Badge></td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          ) : null}
          {view.note ? <p className="vr-muted">{view.note}</p> : null}
        </>
      )}
      <Link className="vr-link" href="/protect">Open What&apos;s protected</Link>
    </section>
  );
}

function areaLine(row: BackupArea): string {
  if (row.state === "good") return `${plural(row.goodRuns, "good run")}${row.lastGoodAt ? ` · last ${formatTimestamp(row.lastGoodAt)}` : ""}`;
  if (row.state === "partial") return `${plural(row.partialRuns, "run")} read only part of it · no full backup in this period`;
  if (row.state === "failed") return `${plural(row.failedRuns, "run")} failed · no good backup in this period`;
  return "No run finished in this period";
}

function BackupStat({ tile }: { tile: BackupTile }) {
  const total = tile.of ?? 0;
  return (
    <div className="vr-stat" data-family={tile.key} data-tone={tile.tone}>
      <span className="vr-tile-label"><Icon name={tile.icon} />{tile.label}</span>
      {tile.count === null
        ? <b className="vr-tile-count vr-tile-word">{tile.word}</b>
        : <b className="vr-tile-count">{tile.count}{tile.of ? <small> of {tile.of}</small> : null}</b>}
      <small>{tile.detail}</small>
      {tile.meter ? <Meter parts={tile.meter} total={total} /> : null}
      {tile.problem ? <Badge tone={tile.problemTone}>{tile.problem}</Badge> : null}
    </div>
  );
}

function Meter({ parts, total }: { parts: { tone: string; value: number }[]; total: number }) {
  return (
    <span aria-hidden="true" className="vr-meter">
      {total ? parts.filter((part) => part.value > 0).map((part) => <i data-tone={part.tone} key={part.tone} style={{ width: `${(part.value / total) * 100}%` }} />) : null}
    </span>
  );
}

/** One stacked bar per kind, drawn to the same scale, with a legend that carries the numbers. */
function ResultsChart({ outcomes, big = false }: { outcomes: ValueReportData["report"]["outcomes"]; big?: boolean }) {
  const families = (["restore", "remediation"] as const).map((family) => ({ family, summary: outcomes.byFamily[family] }));
  const most = Math.max(1, ...families.map((entry) => entry.summary.total));
  return (
    <span className="vr-chart" data-size={big ? "big" : undefined}>
      {families.map(({ family, summary }) => (
        <span className="vr-bar-row" key={family}>
          <span className="vr-bar-label">{FAMILY_WORDS[family].label}<b>{summary.total}</b></span>
          <span className="vr-bar-track">
            <span className="vr-bar" style={{ width: `${(summary.total / most) * 100}%` }}>
              {CHART_ORDER.filter((state) => summary.states[state] > 0).map((state) => (
                <i data-tone={OUTCOME_WORDS[state].swatch} key={state} style={{ width: `${(summary.states[state] / summary.total) * 100}%` }} title={`${OUTCOME_STATE_LABELS[state]}: ${summary.states[state]}`} />
              ))}
            </span>
          </span>
        </span>
      ))}
      <span className="vr-legend">
        {CHART_ORDER.map((state) => (
          <span className="vr-legend-item" key={state}><i aria-hidden="true" data-tone={OUTCOME_WORDS[state].swatch} />{OUTCOME_STATE_LABELS[state]}<b>{outcomes.states[state]}</b></span>
        ))}
      </span>
    </span>
  );
}

function Ring({ value, label }: { value: number; label: string }) {
  const radius = 26;
  const length = 2 * Math.PI * radius;
  return (
    <span className="vr-ring">
      <svg aria-hidden="true" viewBox="0 0 64 64">
        <circle className="vr-ring-track" cx="32" cy="32" r={radius} />
        <circle className="vr-ring-fill" cx="32" cy="32" r={radius} strokeDasharray={`${(Math.max(0, Math.min(100, value)) / 100) * length} ${length}`} />
      </svg>
      <span className="vr-ring-text"><b>{Math.round(value)}%</b><small>{label}</small></span>
    </span>
  );
}

function groupBy<T>(items: T[], key: (item: T) => string, meta: (key: string, list: T[]) => Omit<ListGroup<T>, "items" | "key">, rank: (key: string) => number): ListGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return [...map.entries()].map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey, list), items: list })).sort((a, b) => rank(a.key) - rank(b.key));
}
