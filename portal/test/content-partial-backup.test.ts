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

// A whole-tenant content backup that saved every workload but could not read some items
// (OneDrives locked by Microsoft, one refused group mailbox, one missing site page) is
// "Partly done", and the Job page lists each item with a plain cause. Shapes match what
// cli/keel-content-collect.mjs prints and writes as progress.

const now = "2026-10-23T03:00:00Z";
const locked = Array.from({ length: 10 }, (_, i) => `KEEL-RT-user-${i}: HTTP 423 notAllowed for /v1.0/users/x/drive`);
const mail = ["KEEL-RT-group (group): 1 read(s) failed (403 ErrorAccessDenied Access is denied)"];
const sites = ["KEEL-RT-search: 1 part(s) not fully read, first pages: failed (HTTP 404 …/pages/microsoft.graph.sitePage)"];
const incompleteTypes = [
  { type: "content:exchange-mail", outcome: "partial", httpStatus: null, items: 43, reasonCount: 1, reasons: mail },
  { type: "content:onedrive", outcome: "partial", httpStatus: null, items: 2996, reasonCount: 10, reasons: locked },
  { type: "content:sharepoint-sites", outcome: "partial", httpStatus: null, items: 5328, reasonCount: 1, reasons: sites },
];
const entry = (outcome: string, itemCount: number, reasons: string[] = []) => ({
  outcome, itemCount, startedAt: "2026-10-23T01:02:15Z", completedAt: "2026-10-23T01:10:00Z", httpStatus: null,
  error: reasons.length ? reasons.join("\n").slice(0, 500) : null,
  ...(reasons.length ? { reasons, reasonCount: reasons.length } : {}),
});
const progress = {
  source: "live" as const, updatedAt: "2026-10-23T01:49:31Z",
  types: {
    "content:exchange-mail": entry("partial", 43, mail),
    "content:onedrive": entry("partial", 2996, locked),
    "content:sharepoint-sites": entry("partial", 5328, sites),
    "content:teams": entry("complete", 11),
    "content:planner": entry("complete", 80),
  },
};
const base = {
  id: "c8d034ce-0000-4000-8000-000000000001", kind: "content-collect", params: {}, requested_by: "principal-scheduler",
  created_at: "2026-10-23T01:00:01Z", started_at: "2026-10-23T01:02:15Z", finished_at: "2026-10-23T01:49:31Z", error: null,
};
const partial = normalizeJob({ ...base, status: "succeeded", progress, result: { stdout: "", stderr: "", durationMs: 2836000, partial: true, incompleteTypes } });

test("a content backup with only partial workloads reads Partly done, never Failed", () => {
  assert.deepEqual(jobIncompleteTypes(partial), ["content:exchange-mail", "content:onedrive", "content:sharepoint-sites"]);
  assert.equal(jobDisplayStatus(partial), "partial");
  assert.equal(incompleteTypesLine(jobIncompleteTypes(partial)), "Not backed up: mail, OneDrive files, SharePoint sites");
  assert.equal(jobStatusSentence(partial, now), "Partly done 1 hour ago after 47 minutes: 3 types of content not backed up in full");
  const row = renderToStaticMarkup(createElement(JobRow, { job: partial, now }));
  assert.match(row, /Partly done/);
  assert.doesNotMatch(row, />Failed</);
  assert.match(row, /Not backed up: mail, OneDrive files, SharePoint sites/);
});

test("each item a content backup could not read gets a name and a plain cause", () => {
  assert.deepEqual(contentGapItem(locked[0]), { name: "KEEL-RT-user-0", why: "Locked by Microsoft", tone: "soon", raw: locked[0] });
  assert.equal(contentGapItem(mail[0]).name, "KEEL-RT-group (group)");
  assert.equal(contentGapItem(mail[0]).why, "Access refused");
  assert.equal(contentGapItem(mail[0]).tone, "urgent");
  assert.equal(contentGapItem(sites[0]).why, "Not found: deleted or moved during the backup");
  assert.equal(contentGapItem("more sites than one run reads; the rest was not read").why, "Too many to read in one run");
  assert.equal(contentGapItem("something odd").why, "Could not be read in full");
  // An object id is never shown as a name.
  assert.equal(contentGapItem("group 3f2c9a1e-1111-4a2b-9c3d-123456789abc: HTTP 403").name, "Unnamed content item");
  // A site address reads as its last part; a name holding a status code never sets the cause.
  assert.equal(contentGapItem("https://contoso.sharepoint.com/sites/hr: 1 part(s) not fully read, first pages: failed (HTTP 404)").name, "Hr");
  assert.equal(contentGapItem("Room 403: 1 part(s) not fully read, first pages: failed (HTTP 404)").why, "Not found: deleted or moved during the backup");

  const rows = Object.fromEntries(jobTypeRows(partial, now).map((row) => [row.type, row]));
  assert.equal(rows["content:onedrive"].label, "Partly read");
  assert.equal(rows["content:onedrive"].items.length, 10);
  assert.equal(rows["content:onedrive"].problem, "10 OneDrives could not be read in full: locked by Microsoft");
  assert.equal(rows["content:exchange-mail"].problem, "1 mailbox could not be read in full: access refused");
  assert.deepEqual(rows["content:teams"].items, []);
  assert.equal(rows["content:teams"].problem, null);

  // A job written before the list existed still lists its items, from the error lines.
  const older = { ...partial, progress: { ...progress, types: { "content:onedrive": entry("partial", 2996, locked.slice(0, 3)) } } };
  delete (older.progress.types["content:onedrive"] as { reasons?: unknown }).reasons;
  assert.equal(jobTypeRows(older, now)[0].items.length, 3);
  // An error cut at 500 characters drops its cut-short last line.
  const longLines = Array.from({ length: 12 }, (_, i) => `KEEL-RT-user-${i}: HTTP 423 notAllowed for /v1.0/users/x/drive`).join("\n").slice(0, 500);
  const cut = { ...partial, progress: { ...progress, types: { "content:onedrive": { ...entry("partial", 1), error: longLines } } } };
  assert.equal(jobTypeRows(cut, now)[0].items.length, longLines.split("\n").length - 1);
  // More than the 50 listed: the count is the full one.
  const many = { ...partial, progress: { ...progress, types: { "content:onedrive": { ...entry("partial", 1, locked), reasonCount: 64 } } } };
  assert.equal(jobTypeRows(many, now)[0].problem, "64 OneDrives could not be read in full: locked by Microsoft");
});

test("the Job page leads with the gaps and lists every item not read, errors behind a click", () => {
  const alerts = jobAlerts(partial);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].tone, "soon");
  assert.equal(alerts[0].action?.href, "#job-gaps");
  const html = renderToStaticMarkup(createElement(JobDetail, { job: partial, now }));
  assert.match(html, /job-summary-partial/);
  assert.match(html, /3 types were not backed up in full/);
  assert.match(html, /What was not backed up/);
  assert.match(html, /10 OneDrives not read/);
  assert.match(html, /1 mailbox not read/);
  assert.match(html, /1 site not read/);
  for (const name of ["KEEL-RT-user-0", "KEEL-RT-user-9", "KEEL-RT-group (group)", "KEEL-RT-search"]) assert.ok(html.includes(name), name);
  assert.equal(html.match(/Locked by Microsoft/g)?.length, 10);
  // The engine's text waits behind "Show the error text".
  const gaps = html.slice(html.indexOf('id="job-gaps"'));
  assert.ok(!gaps.split("<details")[0].includes("notAllowed"), "raw errors wait behind a click");
  assert.doesNotMatch(html, />Failed</);
});

test("a content backup with a failed workload stays failed", () => {
  const failed = normalizeJob({
    ...base, status: "failed", error: "exit code 1",
    progress: { ...progress, types: { ...progress.types, "content:planner": entry("failed", 0, ["token refused (HTTP 401)"]) } },
  });
  assert.equal(jobDisplayStatus(failed), "failed");
  assert.match(jobStatusSentence(failed, now), /^Failed /);
  const alerts = jobAlerts(failed);
  assert.equal(alerts[0].tone, "urgent");
  // The workload that failed outright keeps its plain cause and lists no items.
  const planner = jobTypeRows(failed, now).find((row) => row.type === "content:planner")!;
  assert.deepEqual(planner.items, []);
  assert.equal(planner.problem, "Keel is missing a permission in Microsoft 365");
  const html = renderToStaticMarkup(createElement(JobDetail, { job: failed, now }));
  assert.doesNotMatch(html, /Everything else in this backup was saved/);
});
