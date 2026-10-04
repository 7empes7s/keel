import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  COUNTING_RULES, classifyChangeRemediation, classifyRestoreOutcome, estimateHours, readEstimate, summarizeOutcomes,
} from "../../engine/reports/value.mjs";
import { ValueReportView } from "@/components/value-report-view";
import {
  OUTCOME_STATE_ORDER, estimateNote, findingSentence, outcomeName, outcomeReason, outcomeSentence, parseEntity, parsePeriod,
  recoverySentence, valueVerdict, type OutcomeRow, type ValueReport,
} from "@/lib/value-report-view";
import { reportScope } from "@/lib/value-report";

// Roadmap task-100: the value report's words and rendering, fed by the engine's own
// classifiers and counters (engine/reports/value.mjs) so the view reads the shapes the
// reader returns.

const NOW = "2026-10-03T12:00:00.000Z";
const PLAN = "5a2be911-0000-4000-8000-000000000100";
const DRIFT = "d1f70000-0000-4000-8000-000000000100";

const job = (id: string, status: string, createdAt: string, finishedAt: string | null = null) => ({ id, kind: "restore", status, created_at: createdAt, finished_at: finishedAt });

function outcomes() {
  const verified = classifyRestoreOutcome({
    planId: PLAN,
    jobs: [job("a0000000-0000-4000-8000-000000000001", "failed", "2026-09-20T10:00:00Z", "2026-09-20T10:01:00Z"), job("a0000000-0000-4000-8000-000000000002", "succeeded", "2026-09-20T11:00:00Z", "2026-09-20T11:02:00Z")],
    journal: [{ id: "e", natural_key: "group:finance", outcome: "succeeded", recorded_at: "2026-09-20T11:01:00Z" }],
    to: NOW,
  });
  const queued = classifyChangeRemediation({
    driftId: DRIFT,
    jobs: [{ id: "a0000000-0000-4000-8000-000000000003", kind: "remediate", status: "queued", created_at: "2026-09-25T00:00:00Z" }],
    observations: [{ snapshotId: "s", completedAt: "2026-09-26T00:00:00Z", verdict: "matches" }],
    to: NOW,
  });
  return [{ ...verified, resources: 3 }, { ...queued, resourceType: "group", changeType: "modified", resources: 1 }];
}

function row(outcome: ReturnType<typeof outcomes>[number]): OutcomeRow {
  return {
    id: outcome.id, family: outcome.family, state: outcome.state, reason: outcome.reason,
    attempts: outcome.attempts.length, retries: outcome.attempts.length - 1,
    firstRequestedAt: outcome.attempts[0]?.requestedAt ?? null, lastEventAt: outcome.verifiedAt ?? outcome.attempts.at(-1)?.requestedAt ?? null,
    verifiedAt: outcome.verifiedAt ?? null, reopenedAt: null, resources: outcome.resources ?? null,
    resourceType: (outcome as { resourceType?: string }).resourceType ?? null, changeType: (outcome as { changeType?: string }).changeType ?? null,
    planId: (outcome as { planId?: string }).planId ?? null, driftId: (outcome as { driftId?: string }).driftId ?? null,
    attemptEventIds: outcome.attempts.map((attempt: { eventId: string }) => attempt.eventId),
  } as OutcomeRow;
}

function report({ estimate = null, central = true }: { estimate?: unknown; central?: boolean } = {}): ValueReport {
  const list = outcomes();
  const restore = list.filter((outcome) => outcome.family === "restore");
  const remediation = list.filter((outcome) => outcome.family === "remediation");
  const summary = summarizeOutcomes(list);
  const configured = readEstimate(estimate, { source: estimate ? "/etc/keel/value-estimate.json" : null });
  const findings = central
    ? { withheld: false as const, total: 3, states: { resolved: 1, open: 1, unchecked: 1 }, reopened: 1, percentResolved: 33.3, rows: [], rowsShown: 0 }
    : { withheld: true as const };
  return {
    version: 1,
    tenantRef: "sha256:portal-value",
    generatedAt: NOW,
    period: { from: "2026-09-03T12:00:00.000Z", to: NOW, days: 30 },
    scope: central ? { central: true, entities: [] } : { central: false, entities: ["FIN"] },
    outcomes: {
      ...summary,
      byFamily: { restore: summarizeOutcomes(restore), remediation: summarizeOutcomes(remediation) },
      rows: list.map(row),
      rowsShown: list.length,
      undoRunsExcluded: central ? 0 : null,
    },
    findings,
    recovery: central
      ? { withheld: false, recoveryTime: { state: "unmeasured", samples: 0, medianMs: null, worstMs: null, notCounted: 1, drills: 0, restores: 0 }, freshness: { state: "measured", achievedRpoMs: 3_600_000, gaps: 0, asOf: NOW }, recoverablePoint: { state: "unmeasured", ageMs: null, asOf: NOW } }
      : { withheld: true },
    estimate: configured.state === "configured" ? { state: "configured", source: configured.source } : { state: configured.state, source: configured.source, problems: configured.problems ?? [] },
    hoursSaved: estimateHours(configured, { restore: summarizeOutcomes(restore).states.verified, remediation: 0, finding: findings.withheld ? 0 : 1 }),
    complianceClaim: null,
    provenance: {
      reportVersion: 1, countingRules: [...COUNTING_RULES],
      sources: { restoreJobsRead: 2, remediateJobsRead: 1, collectionsChecked: 1, evaluationsRead: 4 },
      complete: true, evidenceHead: { seq: "41", hash: "a".repeat(64), records: "41" }, digest: "b".repeat(64),
    },
  } as ValueReport;
}

function render(value: ValueReport): string {
  return renderToStaticMarkup(createElement(ValueReportView, { data: { report: value, period: "30d", entity: null } }));
}

/** Visible text: everything outside the "Technical details" record layer and the style block. */
function visible(markup: string): string {
  return markup
    .replace(/<details[\s\S]*?<\/details>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ");
}

test("counts read from the engine: a retry is one outcome, a queued job is not put back", () => {
  const value = report();
  assert.equal(value.outcomes.total, 2);
  assert.equal(value.outcomes.states.verified, 1);
  assert.equal(value.outcomes.states.queued, 1, "a matching collection does not verify a queued job");
  assert.equal(value.outcomes.retries, 1);
  assert.equal(outcomeSentence(value.outcomes), "KEEL put back and checked 1 item of 2 it was asked to (50%). 1 retry counted once each.");
  const verdict = valueVerdict(value);
  assert.equal(verdict.headline, "50% checked");
  assert.ok(verdict.text.split(/\s+/).length <= 25);
  assert.equal(outcomeName(value.outcomes.rows[0]), "Restore of 3 settings");
  assert.equal(outcomeName(value.outcomes.rows[1]), "Undo a group that was changed");
  for (const reason of ["journal-and-completion-verified", "collection-shows-baseline", "changed-again", "no-write-record", "write-not-confirmed", "completion-pending", "no-later-collection", "collection-still-differs", "attempt-pending", "all-attempts-failed"]) {
    assert.notEqual(outcomeReason(reason), "the result could not be confirmed", reason);
  }
});

test("the summary table adds up and the page states no compliance claim", () => {
  const markup = render(report());
  const totals = [...markup.matchAll(/<tr data-state="(\w+)"><th scope="row">[^<]+<\/th><td class="value-number">(\d+)<\/td><td class="value-number">(\d+)<\/td><td class="value-number">(\d+)<\/td><\/tr>/g)];
  assert.equal(totals.length, OUTCOME_STATE_ORDER.length);
  for (const [, , restores, changes, total] of totals) assert.equal(Number(restores) + Number(changes), Number(total));
  assert.equal(totals.reduce((sum, match) => sum + Number(match[4]), 0), 2);
  assert.match(markup, /value-total">2</);
  assert.match(visible(markup), /It is not a statement of compliance with any regulation or framework\./);
  assert.doesNotMatch(visible(markup), /\bcomplian(t|ce) with\b(?! any regulation)/i);
});

test("without a configured estimate the page shows no hours; with one, the assumptions sit beside them", () => {
  const none = report();
  assert.equal(none.hoursSaved, null);
  const markup = visible(render(none));
  assert.doesNotMatch(markup, /\d+(\.\d+)?\s*hours/i, "no invented hours");
  assert.match(markup, /No time-saving estimate is set, so this report shows no hours saved\./);
  assert.equal(estimateNote(none), "No time-saving estimate is set, so this report shows no hours saved.");

  const incomplete = report({ estimate: { minutesPerVerifiedOutcome: { restore: 90 }, owner: "IT lead" } });
  assert.equal(incomplete.hoursSaved, null);
  assert.match(visible(render(incomplete)), /incomplete \(no written assumptions\)/);
  assert.doesNotMatch(visible(render(incomplete)), /\d+(\.\d+)?\s*hours/i);

  const configured = report({ estimate: { minutesPerVerifiedOutcome: { restore: 90, finding: 30 }, assumptions: ["A manual group restore takes about 90 minutes."], owner: "IT lead" } });
  const shown = visible(render(configured));
  assert.match(shown, /About 2 hours saved, using the estimate set by IT lead\. It counts checked results only, never tries\./);
  assert.match(shown, /1 checked restore × 90 minutes = 1\.5 hours/);
  assert.match(shown, /1 fixed control × 30 minutes = 0\.5 hours/);
  assert.match(shown, /Assumptions[\s\S]*A manual group restore takes about 90 minutes\./);
  assert.match(shown, /not a measurement/);
});

test("an entity-scoped report withholds tenant-wide sections, and identifiers stay in the record layer", () => {
  const scoped = report({ central: false });
  assert.match(findingSentence(scoped.findings), /whole tenant/);
  assert.match(recoverySentence(scoped.recovery), /whole tenant/);
  const markup = render(scoped);
  const shown = visible(markup);
  assert.match(shown, /Showing only what FIN owns\./);
  assert.doesNotMatch(shown, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "no ids in visible text");
  assert.doesNotMatch(shown, /\b[a-z]+_[a-z_]+\b/, "no snake_case codes");
  assert.doesNotMatch(shown, /\b[a-z]+:[A-Za-z]/, "no resource keys");
  assert.match(markup, new RegExp(`restore-plan:${PLAN}`), "the canonical id is in Technical details");
});

test("period and entity parameters are validated; an entity never widens a reader's scope", () => {
  assert.equal(parsePeriod("90d"), "90d");
  assert.equal(parsePeriod("10y"), "30d");
  assert.equal(parsePeriod(undefined), "30d");
  assert.equal(parseEntity("FIN"), "FIN");
  assert.equal(parseEntity("fin; DROP"), null);
  assert.deepEqual(reportScope({ central: true, entities: [] }, null), { central: true, entities: [] });
  assert.deepEqual(reportScope({ central: true, entities: [] }, "HR"), { central: false, entities: ["HR"] });
  assert.deepEqual(reportScope({ central: false, entities: ["FIN"] }, "HR"), { central: false, entities: [] });
  assert.deepEqual(reportScope({ central: false, entities: ["FIN", "HR"] }, "HR"), { central: false, entities: ["HR"] });
});
