import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { JobDetail } from "@/components/job-detail";
import { JobRow } from "@/components/job-table";
import { normalizeJob } from "@/lib/action";
import { incompleteTypesLine, jobDisplayStatus, jobIncompleteTypes } from "@/lib/job-names";
import { contentGapItem, jobAlerts, jobTypeRows } from "@/lib/job-view";
import { jobStatusSentence } from "@/lib/sentences";

// A settings-by-service backup that saved every workload but read some only in part (one
// refused family, one not licensed, a read limit) is "Partly done", and the Job page lists
// each part with a plain cause. Shapes match what cli/keel-workload-collect.mjs prints and
// writes as progress (engine/collect/workloads/gaps.mjs words the parts).

const now = "2026-10-23T03:00:00Z";
const flowGaps = ["Transport rule: access denied: HTTP 403: Access is denied", "ATP policy: not licensed in this tenant (Defender for Office 365)"];
const mailboxGaps = ["More objects than one run reads (the limit is 50)", "KEEL-RT-mailbox-51@example.com: more than 50 mailboxes were named"];
const incompleteTypes = [
  { type: "workload:exchange-mail-flow", outcome: "partial", httpStatus: null, items: 40, reasonCount: 2, reasons: flowGaps },
  { type: "workload:exchange-mailbox-settings", outcome: "partial", httpStatus: null, items: 50, reasonCount: 2, reasons: mailboxGaps },
];
const entry = (outcome: string, itemCount: number, reasons: string[] = []) => ({
  outcome, itemCount, startedAt: "2026-10-23T02:00:05Z", completedAt: "2026-10-23T02:04:00Z", httpStatus: null,
  error: reasons.length ? reasons.join("\n").slice(0, 500) : null,
  ...(reasons.length ? { reasons, reasonCount: reasons.length } : {}),
});
const progress = {
  source: "live" as const, updatedAt: "2026-10-23T02:20:00Z",
  types: {
    "workload:exchange-mail-flow": entry("partial", 40, flowGaps),
    "workload:exchange-mailbox-settings": entry("partial", 50, mailboxGaps),
    "workload:teams-settings": entry("complete", 12),
    "workload:purview-labels": entry("disabled", 0),
  },
};
const base = {
  id: "c8d034ce-0000-4000-8000-000000000002", kind: "workload-collect", params: {}, requested_by: "principal-scheduler",
  created_at: "2026-10-23T02:00:00Z", started_at: "2026-10-23T02:00:05Z", finished_at: "2026-10-23T02:20:00Z", error: null,
};
const partial = normalizeJob({ ...base, status: "succeeded", progress, result: { stdout: "", stderr: "", durationMs: 1195000, partial: true, incompleteTypes } });

test("a service backup with only partial workloads reads Partly done, never Failed", () => {
  assert.deepEqual(jobIncompleteTypes(partial), ["workload:exchange-mail-flow", "workload:exchange-mailbox-settings"]);
  assert.equal(jobDisplayStatus(partial), "partial");
  const line = incompleteTypesLine(jobIncompleteTypes(partial));
  assert.match(line, /^Not backed up: /);
  assert.doesNotMatch(line, /workload:|exchange-mail-flow/, "workload keys are named in words");
  assert.match(jobStatusSentence(partial, now), /^Partly done .*: 2 kinds incomplete$/);
  const row = renderToStaticMarkup(createElement(JobRow, { job: partial, now }));
  assert.match(row, /Partly done/);
  assert.doesNotMatch(row, />Failed</);
});

test("each part a service backup could not read gets a name and a plain cause", () => {
  assert.deepEqual(contentGapItem(flowGaps[0]), { name: "Transport rule", why: "Access refused", tone: "urgent", raw: flowGaps[0] });
  assert.equal(contentGapItem(flowGaps[1]).why, "Not licensed in this tenant");
  assert.equal(contentGapItem("Journal rule: not switched on yet, so it was not read").why, "Not switched on yet");
  assert.equal(contentGapItem(mailboxGaps[0]).why, "Too many to read in one run");
  assert.equal(contentGapItem(mailboxGaps[0]).name, "Part of this backup");
  assert.equal(contentGapItem(mailboxGaps[1]).why, "Too many to read in one run");
  assert.equal(contentGapItem("https://x-my.sharepoint.com/personal/a: outside the backup scope").why, "Outside the backup scope");
  assert.equal(contentGapItem("3 settings: not read (access denied)").why, "Access refused");
  // Keel's own read-only guard and a user's missing licence are not service gaps.
  assert.equal(contentGapItem("Finance: refused a next page outside /drives/x/root/delta").why, "Could not be read in full");
  assert.equal(contentGapItem("Ann Lee: HTTP 403 user not licensed").why, "Access refused");

  const rows = Object.fromEntries(jobTypeRows(partial, now).map((row) => [row.type, row]));
  assert.equal(rows["exchange-mail-flow"].label, "Partly read");
  assert.equal(rows["exchange-mail-flow"].items.length, 2);
  assert.equal(rows["exchange-mail-flow"].problem, "2 parts could not be read in full");
  assert.equal(rows["exchange-mailbox-settings"].problem, "2 parts could not be read in full: too many to read in one run");
  assert.deepEqual(rows["teams-settings"].items, []);
  assert.equal(rows["teams-settings"].problem, null);
});

test("the Job page lists every part not read, errors behind a click", () => {
  const alerts = jobAlerts(partial);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].tone, "soon");
  assert.equal(alerts[0].action?.href, "#job-gaps");
  const html = renderToStaticMarkup(createElement(JobDetail, { job: partial, now }));
  assert.match(html, /job-summary-partial/);
  assert.match(html, /What was not backed up/);
  assert.match(html, /2 parts not read/);
  for (const name of ["Transport rule", "ATP policy", "KEEL-RT-mailbox-51@example.com"]) assert.ok(html.includes(name), name);
  const gaps = html.slice(html.indexOf('id="job-gaps"'));
  assert.ok(!gaps.split("<details")[0].includes("Access is denied"), "raw errors wait behind a click");
  assert.doesNotMatch(html, />Failed</);
});

test("a service backup with a failed workload stays failed, with its one error line", () => {
  const failed = normalizeJob({
    ...base, status: "failed", error: "exit code 1",
    progress: { ...progress, types: { ...progress.types, "workload:sharepoint-site-settings": entry("failed", 0, ["the scope file names no SharePoint host"]) } },
  });
  assert.equal(jobDisplayStatus(failed), "failed");
  assert.match(jobStatusSentence(failed, now), /^Failed /);
  assert.equal(jobAlerts(failed)[0].tone, "urgent");
  const failedRow = jobTypeRows(failed, now).find((row) => row.type === "sharepoint-site-settings");
  assert.deepEqual(failedRow?.items, []);
  assert.ok(failedRow?.problem);
});
