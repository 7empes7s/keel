import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COUNTING_RULES, classifyChangeRemediation, classifyRestoreOutcome, estimateHours, readEstimate, summarizeOutcomes,
} from "../../engine/reports/value.mjs";
import {
  backupView, estimateNote, findingLine, findingSentence, findingTitle, orderOutcomes, outcomeHref, outcomeName, outcomeReason, outcomeSentence, ownerName,
  parseEntities, parseEntity, parsePeriod, periodParam, periodRange, recoverySentence, resolvePeriod, valueStatus, valueVerdict, type FindingRow, type OutcomeRow,
  type ValueReport,
} from "@/lib/value-report-view";
import { valueReportSheets, valueReportXlsx } from "@/lib/value-report-export";
import { reportScope } from "@/lib/value-report";
import { crc32 } from "@/lib/xlsx";
import { renderValueReportAt } from "./render-value-report";

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
    lastJobId: (outcome.attempts.at(-1) as { jobId?: string } | undefined)?.jobId ?? null,
  } as OutcomeRow;
}

function report({ estimate = null, central = true }: { estimate?: unknown; central?: boolean } = {}): ValueReport {
  const list = outcomes();
  const restore = list.filter((outcome) => outcome.family === "restore");
  const remediation = list.filter((outcome) => outcome.family === "remediation");
  const summary = summarizeOutcomes(list);
  const configured = readEstimate(estimate, { source: estimate ? "/etc/keel/value-estimate.json" : null });
  const findings = central
    ? { withheld: false as const, total: 3, states: { resolved: 1, open: 1, unchecked: 1 }, reopened: 1, percentResolved: 33.3, rows: FINDINGS, rowsShown: 3 }
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
      ? { withheld: false, recoveryTime: { state: "unmeasured", samples: 0, medianMs: null, worstMs: null, notCounted: 1, drills: 0, restores: 0 }, freshness: { state: "measured", achievedRpoMs: 3_600_000, gaps: 0, asOf: NOW }, recoverablePoint: { state: "unmeasured", ageMs: null, asOf: NOW }, failedRestores: { total: 0, recent: { days: 30, count: 0 }, period: { from: NOW, to: NOW, count: 0 }, newest: null, href: "/restore?jobs=failed#restore-jobs-heading" } }
      : { withheld: true },
    backups: central
      ? {
        withheld: false,
        settings: { backups: 30, lastAt: NOW },
        serviceSettings: { runs: 20, workloads: 1, expected: 2, partial: 0, failed: 1, notRun: 0, lastAt: NOW, areas: [
          { workload: "exchange-mail-flow", state: "good", goodRuns: 20, partialRuns: 0, failedRuns: 0, lastGoodAt: NOW },
          { workload: "teams-org-policies", state: "failed", goodRuns: 0, partialRuns: 0, failedRuns: 2, lastGoodAt: null },
        ] },
        content: { runs: 0, workloads: 0, expected: 1, partial: 1, failed: 0, notRun: 0, lastAt: null, itemsStored: 40, bytesStored: 4096, areas: [
          { workload: "exchange-mail", state: "partial", goodRuns: 0, partialRuns: 1, failedRuns: 0, lastGoodAt: null },
        ] },
      }
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

const finding = (controlId: string, state: FindingRow["state"], title: string | null): FindingRow => ({
  id: `finding:keel-custom|1.0.0|default|${controlId}|1`, controlId, title, framework: "keel-custom", edition: "1.0.0", profile: "default", state,
  reopened: false, resolvedAt: state === "resolved" ? "2026-09-12T00:00:00.000Z" : null, resolvedBy: null, failedAt: "2026-09-05T00:00:00.000Z",
  lastEvaluatedAt: "2026-09-19T00:00:00.000Z", lastVerdict: state === "resolved" ? "pass" : "fail", lastEvaluationId: "e7a10000-0000-4000-8000-000000000204",
});
const FINDINGS: FindingRow[] = [
  finding("keel-custom.role-assignment.admin-count-at-most", "open", "Global Administrator assignment count stays at or below a set limit"),
  finding("keel.groups.owner", "resolved", "Groups have at least two owners"),
  finding("keel.gone", "unchecked", null),
];

function render(value: ValueReport, search = ""): Promise<string> {
  return renderValueReportAt(search, { data: { report: value, period: resolvePeriod("30d", NOW), entities: [], owners: ["FIN", "SALES"] } });
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
  assert.equal(outcomeSentence(value.outcomes), "Keel put back and checked 1 setting of 2 it was asked to (50%). 1 retry counted once each.");
  const verdict = valueVerdict(value);
  assert.equal(verdict.text, "1 of 2 requests put back and checked; none failed.");
  assert.ok(verdict.text.split(/\s+/).length <= 25);
  assert.deepEqual(valueStatus(value), { tone: "low", label: "1 not checked yet" });
  assert.equal(outcomeName(value.outcomes.rows[0]), "Restore of 3 settings");
  assert.equal(outcomeName(value.outcomes.rows[1]), "Undo a change to a group");
  assert.equal(outcomeName({ ...value.outcomes.rows[1], resourceType: "conditionalAccessPolicy" }), "Undo a change to a sign-in rule");
  assert.equal(outcomeHref(value.outcomes.rows[0]), "/jobs/a0000000-0000-4000-8000-000000000002", "a request opens its newest job");
  assert.equal(outcomeHref({ ...value.outcomes.rows[0], lastJobId: undefined }), "/activity");
  assert.deepEqual(orderOutcomes(value.outcomes.rows).map((row) => row.state), ["queued", "verified"], "waiting before checked");
  for (const reason of ["journal-and-completion-verified", "collection-shows-baseline", "changed-again", "no-write-record", "write-not-confirmed", "completion-pending", "no-later-collection", "collection-still-differs", "attempt-pending", "all-attempts-failed"]) {
    assert.notEqual(outcomeReason(reason), "the result could not be confirmed", reason);
  }
});

test("the tiles and the chart add up, every request links to its job, and the page states no compliance claim", async () => {
  const value = report();
  const markup = await render(value);
  const bars = [...markup.matchAll(/class="vr-bar-label">(?:Restores|Undo changes)<b>(\d+)<\/b>/g)].map((match) => Number(match[1]));
  assert.equal(bars.reduce((sum, count) => sum + count, 0), value.outcomes.total, "the chart's bars hold every request");
  const legend = [...markup.matchAll(/class="vr-legend-item">.*?<b>(\d+)<\/b>/g)].map((match) => Number(match[1]));
  assert.equal(legend.reduce((sum, count) => sum + count, 0), value.outcomes.total, "the legend adds up to the total");
  assert.match(markup, /Put back and checked<\/span><b class="vr-tile-count">1<small> of 2<\/small>/);
  assert.match(markup, /href="\/jobs\/a0000000-0000-4000-8000-000000000002"/);
  assert.match(visible(markup), /It is not a statement of compliance with any regulation or framework\./);
  assert.doesNotMatch(visible(markup), /\bcomplian(t|ce) with\b(?! any regulation)/i);
  // Security checks by title, never by code.
  const shown = visible(markup);
  assert.match(shown, /Global Administrator assignment count stays at or below a set limit|No more than 5 people hold the top admin role/);
  assert.match(shown, /Groups have at least two owners/);
  assert.match(shown, /A security check Keel no longer holds/);
  assert.doesNotMatch(shown, /keel\.groups\.owner|keel-custom\./, "no control codes in visible text");
});

test("the result filter narrows the list", async () => {
  const value = report();
  const filtered = await render(value, "result=verified");
  assert.match(filtered, /Showing <b>1<\/b> of 2 requests/);
  const both = await render(value, "result=verified,open");
  assert.match(both, /Showing <b>2<\/b> of 2 requests/, "the tiles add up");
  assert.doesNotMatch(visible(filtered), /Undo a change to a group/);
});

test("without a configured estimate the page shows no hours; with one, the assumptions sit beside them", async () => {
  const none = report();
  assert.equal(none.hoursSaved, null);
  const markup = visible(await render(none));
  assert.doesNotMatch(markup, /\d+(\.\d+)?\s*hours/i, "no invented hours");
  assert.match(markup, /No time-saving estimate is set, so this report shows no hours saved\./);
  assert.equal(estimateNote(none), "No time-saving estimate is set, so this report shows no hours saved.");

  const incomplete = report({ estimate: { minutesPerVerifiedOutcome: { restore: 90 }, owner: "IT lead" } });
  assert.equal(incomplete.hoursSaved, null);
  assert.match(visible(await render(incomplete)), /incomplete \(no written assumptions\)/);
  assert.doesNotMatch(visible(await render(incomplete)), /\d+(\.\d+)?\s*hours/i);

  const configured = report({ estimate: { minutesPerVerifiedOutcome: { restore: 90, finding: 30 }, assumptions: ["A manual group restore takes about 90 minutes."], owner: "IT lead" } });
  const shown = visible(await render(configured));
  assert.match(shown, /About 2 hours/);
  assert.match(shown, /Checked restores\s+1\s+90\s+1\.5/);
  assert.match(shown, /Fixed security checks\s+1\s+30\s+0\.5/);
  assert.match(shown, /Assumptions[\s\S]*A manual group restore takes about 90 minutes\./);
  assert.match(shown, /not a measurement/);
});

test("an entity-scoped report withholds tenant-wide sections, and identifiers stay in the record layer", async () => {
  const scoped = report({ central: false });
  assert.match(findingSentence(scoped.findings), /whole tenant/);
  assert.match(recoverySentence(scoped.recovery), /whole tenant/);
  const markup = await render(scoped);
  const shown = visible(markup.replace(/ (?:href|title|data-row-id|id|for|aria-labelledby|aria-controls)="[^"]*"/g, ""));
  assert.match(shown, /Showing only what Fin owns\./);
  assert.doesNotMatch(shown, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "no ids in visible text");
  assert.doesNotMatch(shown, /\b[a-z]+_[a-z_]+\b/, "no snake_case codes");
  assert.doesNotMatch(shown, /\b[a-z]+:[A-Za-z]/, "no resource keys");
  assert.match(markup, new RegExp(`restore-plan:${PLAN}`), "the canonical id is in Technical details");
});

test("period and entity parameters are validated; an entity never widens a reader's scope", () => {
  assert.equal(parsePeriod("90d"), "90d");
  assert.equal(parsePeriod("10y"), "30d");
  assert.equal(parsePeriod(undefined), "30d");
  // Old bookmarks keep working; a custom range runs whole days and never past now.
  assert.deepEqual(resolvePeriod("90d", NOW), { param: "90d", preset: "90d", from: "2026-07-05T12:00:00.000Z", to: NOW });
  assert.deepEqual(resolvePeriod("2026-09-01..2026-09-30", NOW), { param: "2026-09-01..2026-09-30", preset: null, from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
  assert.equal(resolvePeriod("2026-09-30..2026-09-01", NOW).from, "2026-09-01T00:00:00.000Z", "ends in either order");
  assert.equal(resolvePeriod("2026-10-01..2026-10-09", NOW).to, NOW, "never past now");
  assert.equal(resolvePeriod("2024-01-01..2026-10-03", NOW).param, "2025-10-02..2026-10-03", "cut to the engine's longest period");
  assert.equal(resolvePeriod("2026-02-30..2026-03-01", NOW).param, "30d", "a day that does not exist falls back");
  assert.equal(periodParam(periodRange(resolvePeriod("365d", NOW), "2026-10-03"), "2026-10-03"), "365d", "a preset round-trips");
  assert.equal(periodParam({ from: "2026-09-01", to: "2026-09-30" }, "2026-10-03"), "2026-09-01..2026-09-30");
  assert.equal(ownerName("FIN"), "Fin");
  assert.equal(ownerName("IT_OPS"), "It ops");
  assert.equal(parseEntity("FIN"), "FIN");
  assert.equal(parseEntity("fin; DROP"), null);
  assert.deepEqual(parseEntities("FIN,HR,FIN,fin; DROP"), ["FIN", "HR"], "several owners, repeats and bad codes dropped");
  assert.deepEqual(parseEntities("FIN"), ["FIN"], "an old single-owner link still works");
  assert.deepEqual(parseEntities(undefined), []);
  assert.deepEqual(reportScope({ central: true, entities: [] }, []), { central: true, entities: [] });
  assert.deepEqual(reportScope({ central: true, entities: [] }, ["HR"]), { central: false, entities: ["HR"] });
  assert.deepEqual(reportScope({ central: true, entities: [] }, ["HR", "FIN"]), { central: false, entities: ["HR", "FIN"] }, "several owners add up");
  assert.deepEqual(reportScope({ central: false, entities: ["FIN"] }, ["HR"]), { central: false, entities: [] });
  assert.deepEqual(reportScope({ central: false, entities: ["FIN", "HR"] }, ["HR"]), { central: false, entities: ["HR"] });
  assert.deepEqual(reportScope({ central: false, entities: ["FIN"] }, ["HR", "FIN"]), { central: false, entities: ["FIN"] }, "an owner outside the reader's scope is dropped, never widening it");
});

test("security check rows read in words", () => {
  assert.equal(findingTitle(FINDINGS[0], () => "No more than 5 people hold the top admin role"), "No more than 5 people hold the top admin role", "the portal's plain title wins");
  assert.equal(findingTitle(FINDINGS[1]), "Groups have at least two owners");
  assert.equal(findingTitle(FINDINGS[2]), "A security check Keel no longer holds");
  assert.equal(findingLine(FINDINGS[1], "2026-10-03"), "Passing since 12 Sep");
  assert.equal(findingLine({ ...FINDINGS[0], reopened: true, failedAt: "2026-09-25T00:00:00.000Z" }, "2026-10-03"), "Failed again on 25 Sep after being fixed");
});

test("the Excel workbook is a valid zip with the report's sheets in plain words", () => {
  const value = report({ estimate: { minutesPerVerifiedOutcome: { restore: 90, finding: 30 }, assumptions: ["A manual group restore takes about 90 minutes."], owner: "IT lead" } });
  const sheets = valueReportSheets(value);
  assert.deepEqual(sheets.map((sheet) => sheet.name), ["Summary", "Requests", "Security checks", "Time saved"]);
  assert.deepEqual(sheets[1].rows[0].slice(0, 3), ["What was asked", "Type", "Result"]);
  assert.equal(sheets[1].rows.length, 1 + value.outcomes.rows.length);
  assert.ok(sheets[2].rows.slice(1).every((row) => !String(row[0]).startsWith("keel")), "check titles, not codes, lead each row");
  const bytes = valueReportXlsx(value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50, "starts with a zip entry");
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50, "ends with the zip directory");
  assert.equal(view.getUint16(bytes.length - 12, true), 5 + sheets.length, "one entry per part and sheet");
  // The first entry's stored CRC matches its bytes.
  const nameLength = view.getUint16(26, true);
  const size = view.getUint32(18, true);
  assert.equal(view.getUint32(14, true), crc32(bytes.subarray(30 + nameLength, 30 + nameLength + size)));
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "the standard CRC-32 check value");
});

// Page design rule: no card may be text only. Every card on the Value report carries a
// status badge or a visual (tiles, meter, ring, chart, figures or a table), in every
// state, including sections withheld from a scoped reader.
const VISUALS = /class="(?:badge|vr-meter|vr-ring|vr-chart|vr-figures|vr-table|vr-stat)[ "]/;

test("every Value report card shows a status or a visual, never text alone", async () => {
  for (const [label, value] of [["central", report({ estimate: null })], ["scoped", report({ central: false })]] as const) {
    const markup = await render(value);
    const cards = markup.match(/<section[^>]*class="vr-card[^"]*"[\s\S]*?<\/section>/g) ?? [];
    assert.ok(cards.length >= 5, `${label}: found ${cards.length} cards`);
    for (const card of cards) {
      const title = card.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1].replace(/<[^>]+>/g, "") ?? card.slice(0, 80);
      assert.match(card, VISUALS, `${label}: the "${title}" card is text only`);
      assert.match(card.match(/class="vr-card-head"[\s\S]*?<\/div>/)?.[0] ?? "", /class="badge/, `${label}: the "${title}" card has no status badge`);
    }
  }
});

test("the backups card shows tiles, a problems-first table and explains stored items from runs read in part", async () => {
  const markup = await render(report());
  const card = markup.match(/<section[^>]*id="vr-backups"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.equal((card.match(/class="vr-stat"/g) ?? []).length, 3);
  assert.match(card, /2 areas need a look/);
  const states = [...card.matchAll(/<tr data-state="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(states, ["failed", "good", "partial"], "the group with a failure first, problems first inside it");
  assert.match(card, /Backed up in part/);
  assert.match(card, /including content from areas backed up only in part/);
  assert.doesNotMatch(visible(card), /exchange-mail|teams-org-policies/, "areas are named, never by their codes");
});

test("no report card renders a list of plain text lines", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = join(import.meta.dirname, "..", "components");
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(dir, entry.name));
      else if (entry.name.endsWith(".tsx")) files.push(join(dir, entry.name));
    }
  };
  await walk(root);
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    // A card body made of sentences mapped into muted list items (the old "What we backed up").
    if (/\.map\(\((?:line|text|sentence)\) => <li className="[^"]*(?:muted|soft)[^"]*"/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("failed restores on the value report are the engine's one count, linked to the same list as Resilience and Restore", async () => {
  const value = report();
  if (value.recovery.withheld) throw new Error("fixture is tenant-wide");
  const counts = { total: 47, recent: { days: 30, count: 3 }, period: { from: NOW, to: NOW, count: 2 }, newest: { jobId: "j1", at: NOW }, href: "/restore?jobs=failed#restore-jobs-heading" };
  const text = visible(await render({ ...value, recovery: { ...value.recovery, failedRestores: counts } }));
  assert.match(text, /2 failed in this period/);
  assert.match(text, /47 restores failed · 3 in the last 30 days/);
  const markup = await render({ ...value, recovery: { ...value.recovery, failedRestores: counts } });
  assert.match(markup, /href="\/restore\?jobs=failed#restore-jobs-heading"/);
  // None ever failed: no line.
  const none = visible(await render(value));
  assert.doesNotMatch(none, /restores failed|failed in this period/);
});

test("partly done settings backups are a warning on the value report, never counted as complete (audit issue 2)", () => {
  const section = {
    withheld: false as const,
    settings: { backups: 3, partial: 2, lastAt: "2026-10-01T00:00:00Z" },
    serviceSettings: { runs: 0, workloads: 0, expected: 0, lastAt: null },
    content: { runs: 0, workloads: 0, expected: 0, lastAt: null, itemsStored: 0, bytesStored: 0 },
  };
  const view = backupView(section);
  assert.equal(view.state, "shown");
  if (view.state !== "shown") return;
  const tile = view.tiles.find((entry) => entry.key === "settings")!;
  assert.equal(tile.count, 3);
  assert.equal(tile.tone, "soon");
  assert.equal(tile.problem, "2 more only partly done");
  assert.equal(view.headline.tone, "soon");
  const none = backupView({ ...section, settings: { backups: 0, partial: 1, lastAt: null } });
  if (none.state !== "shown") return assert.fail("shown");
  assert.equal(none.tiles[0].problem, "No complete backup in this period; 1 only partly done");
  assert.equal(none.tiles[0].tone, "urgent");
  // Reports made before partly done backups were counted read as before.
  const old = backupView({ ...section, settings: { backups: 3, lastAt: null } });
  if (old.state !== "shown") return assert.fail("shown");
  assert.equal(old.tiles[0].tone, "fine");
  assert.equal(old.headline.tone, "fine");
});
