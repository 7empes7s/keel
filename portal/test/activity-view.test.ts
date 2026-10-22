import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  activityCounts,
  activityCsv,
  activityRows,
  activityStatus,
  activityVerdict,
  dayLabel,
  filterChips,
  filterWords,
  integrityWords,
  jobOutcome,
  kindOfJob,
  kindOfRecord,
  parseFilters,
  peopleIn,
  rangeBounds,
  recordOutcome,
  retryOf,
  rowHref,
  rowMatches,
} from "@/lib/activity-view";
import { normalizeJob } from "@/lib/action";
import { EMPTY_REFERENCES, type EngineRef, evidenceSentence } from "@/lib/sentences";
import { renderActivityAt } from "./render-activity";

// The Activity page in words: every job and audit entry is one row with a kind and an
// outcome, the tiles count the same day the verdict does, a failed backup offers to run
// again, filters round-trip through the address, and no id or email leaks.

const NOW = "2026-10-02T09:40:00Z";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MARO: EngineRef = { kind: "person", id: "8c1e0000-0000-4000-8000-0000000000a1", name: "maro.defili@contoso.example", email: "maro.defili@contoso.example", readable: true, system: false };
const AMARA: EngineRef = { kind: "person", id: "8c1e0000-0000-4000-8000-0000000000a2", name: "Amara Okafor", email: "amara.okafor@contoso.example", readable: true, system: false };
const SCHEDULER: EngineRef = { kind: "person", id: "scheduler", name: "scheduler", email: null, readable: true, system: true };
const PEOPLE = { [MARO.id]: MARO, [AMARA.id]: AMARA, scheduler: SCHEDULER };

const job = (id: string, kind: string, status: string, extra: Record<string, unknown> = {}) => normalizeJob({
  id: `a${id}000000-0000-4000-8000-00000000000${id}`, kind, status, params: { tier: "tier1" }, requested_by: MARO.id,
  created_at: "2026-10-02T09:30:00Z", started_at: "2026-10-02T09:31:00Z", finished_at: status === "running" || status === "queued" ? null : "2026-10-02T09:34:00Z",
  references: { ...EMPTY_REFERENCES, people: { requested_by: MARO } }, ...extra,
});
const JOBS = [
  job("1", "backup", "running"),
  job("2", "collect", "queued", { params: {} }),
  job("3", "backup", "failed", { error: "Graph 429: throttled after 5 retries on /deviceManagement/deviceConfigurations" }),
  job("4", "restore", "failed", { requested_by: AMARA.id, references: { ...EMPTY_REFERENCES, people: { requested_by: AMARA } }, params: { mode: "enforce" }, error: "Graph 400: rejected", created_at: "2026-10-01T16:50:00Z", finished_at: "2026-10-01T16:52:00Z" }),
  job("5", "backup", "succeeded", { requested_by: "scheduler", references: { ...EMPTY_REFERENCES, people: { requested_by: SCHEDULER } }, created_at: "2026-09-28T02:00:00Z", finished_at: "2026-09-28T02:03:00Z" }),
];
const ENTRIES = [
  { seq: "18205", occurred_at: "2026-10-02T09:39:02Z", kind: "approval-decision", actor: AMARA.id, subject: { requestId: "a9e10000-0000-4000-8000-000000000100", action: "restore", decision: "approved", jobId: "a3000000-0000-4000-8000-000000000003" } },
  { seq: "18200", occurred_at: "2026-10-02T08:52:30Z", kind: "action-attempt", actor: MARO.id, subject: { action: "restore", decision: "denied", reason: "capability" } },
  { seq: "18190", occurred_at: "2026-10-01T14:05:00Z", kind: "policy-evaluation", actor: "policy-automation", subject: { naturalKey: "group:5d1c0000-0000-4000-8000-0000000000f1", matched: true } },
  { seq: "18170", occurred_at: "2026-09-28T05:00:00Z", kind: "offsite-copy", actor: "scheduler", subject: { dumpSha256: "4c".repeat(32), remoteSha256: "4c".repeat(32), verification: { ok: true } } },
];
const NAMES = { "group:5d1c0000-0000-4000-8000-0000000000f1": { name: "Finance approvers", resourceType: "group" } };

test("every job and audit entry is one row with a kind, an outcome and a person, without ids", () => {
  const rows = activityRows(JOBS, ENTRIES, PEOPLE, NAMES, NOW);
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.slice(0, 3).map((row) => row.id), ["record:18205", "job:a3000000-0000-4000-8000-000000000003", "job:a1000000-0000-4000-8000-000000000001"]);
  const failed = rows.find((row) => row.id === "job:a3000000-0000-4000-8000-000000000003")!;
  assert.equal(failed.title, "Backup of Tier 1");
  assert.equal(failed.line, "Backup · Graph 429: throttled after 5 retries on /deviceManagement/deviceConfigurations");
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.kind, "backup");
  assert.equal(failed.who, MARO.id);
  const approved = rows[0];
  assert.equal(approved.title, "Amara Okafor approved a restore");
  assert.equal(approved.line, "Audit record · Approval decision");
  assert.equal(rowHref(approved), "/jobs/a3000000-0000-4000-8000-000000000003");
  const refused = rows.find((row) => row.id === "record:18200")!;
  assert.equal(refused.title, "Maro Defili was refused a restore: that account is not allowed to");
  assert.equal(refused.outcome, "refused");
  assert.equal(rows.find((row) => row.id === "record:18190")!.title, "Policies checked a change to Finance approvers (group), and one applied");
  for (const row of rows) {
    assert.doesNotMatch(row.title, UUID, row.title);
    assert.doesNotMatch(row.line, UUID, row.line);
    assert.ok(!row.title.includes("@"), row.title);
  }
  assert.equal(kindOfJob("remediate"), "rollback");
  assert.equal(kindOfJob("something-new"), "other");
  assert.equal(kindOfRecord("recovery-drill"), "drill");
  assert.equal(jobOutcome("queued"), "waiting");
  assert.equal(recordOutcome({ kind: "recovery-drill", subject: { mode: "live", outcome: "failed" } }), "failed");
  assert.equal(recordOutcome({ kind: "offsite-copy", subject: { dumpSha256: "a", remoteSha256: "b" } }), "failed");
  assert.equal(recordOutcome(ENTRIES[3]), "recorded");
});

test("audit sentences name the request and the reason, and have one per kind", () => {
  assert.equal(evidenceSentence({ kind: "approval-decision", actor: "x", subject: { decision: "rejected", action: "remediate" } }, "Sam Ortiz"), "Sam Ortiz rejected a roll back changes");
  assert.equal(evidenceSentence({ kind: "approval-decision", actor: "x", subject: { decision: "approve" } }, "Sam Ortiz"), "Sam Ortiz approved a request");
  assert.equal(evidenceSentence({ kind: "action-attempt", actor: "x", subject: { action: "backup", decision: "denied", reason: "no-principal" } }, "Someone"), "Someone was refused a backup: no account was signed in");
  assert.equal(evidenceSentence({ kind: "action-attempt", actor: "x", subject: { action: "undo", decision: "attempted" } }, "Lee Chen"), "Lee Chen started an undo");
  assert.equal(evidenceSentence({ kind: "approval-signoff", actor: "x", subject: { action: "restore" } }, "Lee Chen"), "Lee Chen signed off a restore; another approval is still needed");
  assert.equal(evidenceSentence({ kind: "baseline-resnapshot", actor: "x", subject: {} }, "Lee Chen"), "Lee Chen re-captured an approved setup from a newer backup");
  assert.equal(evidenceSentence({ kind: "benchmark-evaluation", actor: "x", subject: { verdict: "fail" } }, "Keel"), "A control check failed");
  assert.equal(evidenceSentence({ kind: "benchmark-exception", actor: "x", subject: {} }, "Lee Chen"), "Lee Chen granted an exception to a control");
});

test("tiles, status and verdict count the last day by when a job was asked for", () => {
  const counts = activityCounts(JOBS, NOW);
  assert.equal(counts.jobsDay, 4);
  assert.equal(counts.failedDay, 2);
  assert.equal(counts.failedWeek, 2);
  assert.equal(counts.running, 1);
  assert.equal(counts.waiting, 1);
  assert.equal(counts.days.length, 7);
  assert.deepEqual(counts.days.at(-1), { day: "2026-10-02", jobs: 3, failed: 1 });
  assert.deepEqual(counts.days[0], { day: "2026-09-26", jobs: 0, failed: 0 });
  assert.equal(counts.newestFailed?.id, JOBS[2].id);
  assert.deepEqual(activityStatus(counts), { tone: "urgent", label: "2 failed today" });
  assert.deepEqual(activityStatus(activityCounts([JOBS[0]], NOW)), { tone: "low", label: "1 running" });
  assert.deepEqual(activityStatus(activityCounts([JOBS[4]], NOW)), { tone: "fine", label: "Nothing ran today" });
  const verdict = activityVerdict(counts, true, { ok: true, status: "verified" });
  assert.equal(verdict.text, "Keel ran 4 jobs in the last day; the backup of Tier 1 failed, and 1 more.");
  assert.ok(verdict.text.split(/\s+/).length <= 25);
  assert.equal(verdict.detail, "Graph 429: throttled after 5 retries on /deviceManagement/deviceConfigurations");
  assert.deepEqual(verdict.retry, { kind: "backup", tier: "tier1" });
  assert.equal(activityVerdict(activityCounts([JOBS[0], JOBS[4]], NOW), true, null).text, "Keel ran 1 job in the last day, none failed; 1 is still running or waiting.");
  assert.equal(activityVerdict(counts, false, { ok: false, status: "broken-at-sequence" }).tone, "urgent");
  assert.equal(activityVerdict(counts, false, null).text, "Showing the audit record: who did what, newest first.");
  assert.deepEqual(retryOf(JOBS[1]), null);
  assert.deepEqual(retryOf({ ...JOBS[1], status: "failed" }), { kind: "collect" });
  assert.deepEqual(retryOf(JOBS[3]), { kind: "plan", href: "/restore", label: "Plan it again" });
  assert.equal(integrityWords({ ok: true, status: "verified", unanchoredRecords: 4 }).sentence, "Verified against the off-site copy. 4 newer entries wait for the next copy.");
  assert.equal(integrityWords({ ok: false, status: "unanchored" }).label, "Not copied yet");
  assert.equal(integrityWords(null).tone, "neutral");
});

test("filters live in the address, narrow the rows, and read back as words", () => {
  const filters = parseFilters((key) => ({ show: "jobs", range: "2026-10-01..2026-10-02", who: AMARA.id, what: "restore", outcome: "failed" }[key] ?? null));
  assert.deepEqual(filters, { show: "jobs", range: { from: "2026-10-01", to: "2026-10-02" }, who: [AMARA.id], what: ["restore"], outcomes: ["failed"] });
  assert.deepEqual(rangeBounds(filters.range), { from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T23:59:59.999Z" });
  assert.deepEqual(parseFilters(() => null), { show: "all", range: null, who: [], what: [], outcomes: [] });
  assert.deepEqual(parseFilters((key) => (key === "what" ? "nonsense" : key === "outcome" ? "exploded" : null)).what, []);
  const rows = activityRows(JOBS, ENTRIES, PEOPLE, NAMES, NOW);
  assert.deepEqual(rows.filter((row) => rowMatches(row, filters)).map((row) => row.id), ["job:a4000000-0000-4000-8000-000000000004"]);
  assert.equal(rows.filter((row) => rowMatches(row, { ...filters, show: "all", what: [], outcomes: ["refused"] })).length, 0);
  assert.equal(rows.filter((row) => rowMatches(row, { show: "records", range: null, who: [], what: [], outcomes: ["refused"] })).length, 1);
  assert.equal(rows.filter((row) => rowMatches(row, { show: "all", range: { from: "2026-09-28" }, who: [], what: [], outcomes: [] })).length, 2);
  assert.equal(filterWords(filters, PEOPLE, "2026-10-02"), "failed restores by Amara Okafor from 1 Oct to 2 Oct");
  assert.equal(filterWords({ show: "records", range: { from: "2026-10-02" }, who: [], what: [], outcomes: [] }, PEOPLE, "2026-10-02"), "audit entries today");
  assert.deepEqual(peopleIn(rows, PEOPLE, []).map((person) => person.name), ["Amara Okafor", "Maro Defili", "Keel's scheduler"]);
  assert.equal(dayLabel("2026-10-01T16:52:00Z", NOW), "Yesterday");

  // Every dropdown filter takes several values, and they add up (OR); other filters narrow (AND).
  const several = parseFilters((key) => ({ who: `${AMARA.id},${MARO.id},${AMARA.id}`, what: "restore,backup,nonsense", outcome: "finished,failed" }[key] ?? null));
  assert.deepEqual(several.who, [AMARA.id, MARO.id], "accounts kept as given, repeats dropped");
  assert.deepEqual(several.what, ["backup", "restore"], "kinds kept in their usual order, unknowns dropped");
  assert.deepEqual(several.outcomes, ["failed", "finished"]);
  const either = rows.filter((row) => rowMatches(row, { show: "all", range: null, who: [AMARA.id, MARO.id], what: [], outcomes: [] }));
  assert.equal(either.length, rows.filter((row) => row.who === AMARA.id).length + rows.filter((row) => row.who === MARO.id).length, "either account shows");
  assert.ok(either.some((row) => row.who === AMARA.id) && either.some((row) => row.who === MARO.id));
  const kinds = rows.filter((row) => rowMatches(row, { show: "all", range: null, who: [], what: ["backup", "approval"], outcomes: [] }));
  assert.deepEqual([...new Set(kinds.map((row) => row.kind))].sort(), ["approval", "backup"]);
  assert.equal(filterWords({ ...several, show: "all", range: null }, PEOPLE, "2026-10-02"), "failed or finished backups or restores by Amara Okafor or Maro Defili");
  const chips = filterChips({ ...several, show: "all", range: null }, PEOPLE, "2026-10-02");
  assert.deepEqual(chips.map((chip) => chip.label), ["Failed", "Finished", "Backups", "Restores", "By Amara Okafor", "By Maro Defili"]);
  assert.deepEqual(chips.find((chip) => chip.label === "Backups")?.clear, { what: "restore" }, "a chip removes only its own value");
  assert.deepEqual(chips.find((chip) => chip.label === "By Amara Okafor")?.clear, { who: MARO.id });
  assert.deepEqual(peopleIn([], PEOPLE, [AMARA.id, MARO.id]).map((person) => person.name).sort(), ["Amara Okafor", "Maro Defili"], "picked accounts stay in the list");
  const csv = activityCsv(rows.slice(0, 2));
  assert.match(csv, /^When,What,Kind,Outcome,Who,Source,Job ID,Audit sequence,Account\n/);
  assert.match(csv, /"Amara Okafor approved a restore","Approval","Recorded","Amara Okafor","Audit record","","18205"/);
});

test("the page body renders rows by day, filters by address, and keeps ids in the record", async () => {
  const props = { canBackup: true, jobs: JOBS, entries: ENTRIES, integrity: { ok: true, status: "verified" as const, unanchoredRecords: 4 }, people: PEOPLE, names: NAMES, now: NOW };
  const html = await renderActivityAt("", props);
  const visible = html.replace(/<details[\s\S]*?<\/details>/g, "").replace(/ title="[^"]*"/g, "").replace(/<[^>]*>/g, " ").replaceAll("&#x27;", "'");
  assert.doesNotMatch(visible, UUID);
  assert.ok(!visible.includes("@"), visible);
  for (const text of ["Keel ran 4 jobs in the last day; the backup of Tier 1 failed, and 1 more.", "Run the Tier 1 backup again", "Today", "Yesterday", "Monday 28 September", "Amara Okafor approved a restore", "Run again"]) {
    assert.ok(visible.includes(text), text);
  }
  assert.ok(html.indexOf("Today") < html.indexOf("Yesterday") && html.indexOf("Yesterday") < html.indexOf("Monday 28 September"), "newest day first");
  assert.ok(html.includes(`href="/activity?outcome=failed"`), "the Failed tile links to the failed filter");
  const record = html.match(/<details[\s\S]*<\/details>/)?.[0] ?? "";
  for (const id of [JOBS[2].id, "18205", MARO.id, "GET /api/evidence/verify"]) assert.ok(record.includes(id), `record keeps ${id}`);

  const failedOnly = await renderActivityAt("show=jobs&outcome=failed", props);
  assert.equal((failedOnly.match(/class="sel-row"/g) ?? []).length, 2);
  assert.match(failedOnly, /Showing <b>2<\/b> of 9 entries loaded/);
  assert.match(failedOnly, /Remove filter: Failed/);
  assert.match(failedOnly, /Remove filter: Jobs only/);
  // Outcome tiles add up: the Running or waiting tile adds to Failed, it does not replace it.
  assert.ok(failedOnly.includes(`href="/activity?show=jobs&amp;outcome=failed%2Crunning%2Cwaiting"`), "Running or waiting adds to Failed");
  const viewer = await renderActivityAt("", { ...props, canBackup: false });
  assert.ok(!viewer.includes("Run again"), "a viewer cannot run a backup");
  assert.ok(!viewer.includes("btn-primary"), "no amber action without the backup capability");
  const records = await renderActivityAt("show=records", { ...props, jobs: [] });
  assert.ok(records.includes("Showing the audit record: who did what, newest first."));
});
