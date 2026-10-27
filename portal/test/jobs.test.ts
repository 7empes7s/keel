import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { JobDetail } from "@/components/job-detail";
import { jobErrorCause, jobProgressPercent, jobTypeGroups, jobTypeRows, typeProblemsAlert } from "@/lib/job-view";
import { JobTable } from "@/components/job-table";
import { guardedJobList, guardedJobShow, normalizeJob } from "@/lib/action";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { recordValues } from "./record-fields";

const row = {
  id: "00000000-0000-0000-0000-000000000001",
  kind: "restore",
  status: "failed",
  requested_by: "operator",
  error: "refuseUnsafeDeletion: blocked\n  resource: example",
  params: { mode: "enforce" },
  result: { restored: 0 },
  worker_id: "worker-1",
  heartbeat_at: "2026-09-13T12:00:00Z",
  created_at: "2026-09-13T11:59:00Z",
  finished_at: "2026-09-13T12:01:00Z",
};

test("the jobs table displays failed-job error text and a detail link", () => {
  const html = renderToStaticMarkup(createElement(JobTable, {
    headingId: "jobs", jobs: [normalizeJob(row)], title: "Jobs",
  }));
  // Task-130: the first line of the error is the explanation; the job reads as a sentence.
  assert.ok(html.includes(row.error.split("\n")[0]));
  assert.ok(html.includes(`href="/jobs/${row.id}"`));
  assert.ok(html.includes("Restore of a dry run that is no longer readable"), "a plan the reader could not resolve is named, never shown by id");
  assert.ok(html.includes("operator"), "the requester is in the record");
  assert.ok(html.includes("Failed"));
  const succeeded = renderToStaticMarkup(createElement(JobTable, {
    headingId: "jobs", jobs: [normalizeJob({ ...row, status: "succeeded" })], title: "Jobs",
  }));
  assert.ok(!succeeded.includes(row.error));
});

test("job details preserve the full error and expose params, result, worker and heartbeat", () => {
  const job = normalizeJob(row);
  const html = renderToStaticMarkup(createElement(JobDetail, { job }));
  // Task-130: the full error, params, result, worker and heartbeat are in the record.
  // A multi-line error keeps its line breaks in a block.
  assert.ok(recordValues(html, "Full error").some((value) => value.includes(`<pre class="technical-block"><code>${row.error}</code></pre>`)), "the full error is kept, behind a click");
  assert.ok(html.includes('data-alert="error"'), "the error alert renders because there is an error");
  assert.ok(/<details class="ui-alert-more"[^>]*><summary>Show details<\/summary>/.test(html), "the raw error waits behind Show details");
  assert.ok(!renderToStaticMarkup(createElement(JobDetail, { job: normalizeJob({ ...row, status: "succeeded", error: null }) })).includes('data-alert="error"'),
    "no error alert without an error");
  for (const text of ["Params", "enforce", "Result", "restored", "worker-1", "Heartbeat"]) {
    assert.ok(html.includes(text), text);
  }
  assert.equal(job.heartbeatAt, "2026-09-13T12:00:00.000Z");
  const escaped = renderToStaticMarkup(createElement(JobDetail, {
    job: normalizeJob({ ...row, error: "<script>alert(1)</script>" }),
  }));
  assert.ok(!escaped.includes("<script>"));
  assert.ok(escaped.includes("&lt;script&gt;"));
});

test("existing guarded job handlers serve the requested history limit and job detail", async () => {
  const queries: { sql: string; values?: unknown[] }[] = [];
  const deps = {
    databaseUrl: () => "unused",
    tenantRef: () => "tenant-a",
    connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [row] };
      },
      end: async () => {},
    }),
  };
  const headers = new Headers([
    [PRINCIPAL_ID_HEADER, "viewer"], [CAPABILITIES_HEADER, "read"],
  ]);
  const list = await guardedJobList(deps)(new Request("http://localhost/api/jobs?limit=50", { headers }));
  assert.equal(list.status, 200);
  // Task-130: each job arrives with its references resolved (here, a system requester).
  const [listed] = (await list.json()).jobs;
  assert.deepEqual({ ...listed, references: undefined }, { ...normalizeJob(row), references: undefined });
  assert.equal(listed.references.people.requested_by.name, "operator");
  assert.match(queries[0].sql, /ORDER BY created_at DESC/);
  assert.deepEqual(queries[0].values, [50, null, null]);
  for (const limit of ["-1", "invalid", "1.5", "0"]) {
    await guardedJobList(deps)(new Request(`http://localhost/api/jobs?limit=${limit}`, { headers }));
    assert.deepEqual(queries.at(-1)?.values, [100, null, null]);
  }
  // Activity: kind and status narrow the query itself; an unknown status is refused.
  const filtered = await guardedJobList(deps)(new Request("http://localhost/api/jobs?limit=20&kind=backup,collect&status=failed", { headers }));
  assert.equal(filtered.status, 200);
  assert.match(queries.at(-1)?.sql ?? "", /status = ANY/);
  assert.deepEqual(queries.at(-1)?.values, [20, ["backup", "collect"], ["failed"]]);
  const refused = await guardedJobList(deps)(new Request("http://localhost/api/jobs?status=exploded", { headers }));
  assert.equal(refused.status, 400);
  assert.equal((await guardedJobList(deps)(new Request("http://localhost/api/jobs?kind=drop%20table", { headers }))).status, 400);
  const show = await guardedJobShow(deps)(new Request(`http://localhost/api/jobs/${row.id}`, { headers }));
  assert.equal(show.status, 200);
  const shown = (await show.json()).job;
  assert.deepEqual({ ...shown, references: undefined }, { ...normalizeJob(row), references: undefined });
  assert.deepEqual(queries.at(-1)?.values, [row.id]);
});

test("a failed job leads with a plain cause and one next step, never the raw error", () => {
  const cause = (error: string, kind = "backup") => jobErrorCause({ kind, error, params: { artifactId: "a1" } });
  assert.equal(cause("Graph 429: throttled after 5 retries on /deviceManagement/deviceConfigurations").title, "Microsoft 365 slowed Keel down");
  assert.equal(cause("Graph 403: Authorization_RequestDenied on PATCH /groups/x").title, "Keel is missing a permission in Microsoft 365");
  assert.equal(cause("Graph 400: the update to Finance was rejected", "restore").title, "Microsoft 365 refused the change");
  assert.equal(cause("fetch failed: ECONNRESET").title, "Keel could not reach Microsoft 365");
  assert.equal(cause("restore refused: blocked-content-effect", "restore").action?.href, "/approvals/content-effects/a1");
  assert.equal(cause("something odd").title, "The job stopped with an error");
  for (const text of ["Graph 429: throttled", "Graph 403: x", "something odd"]) {
    const plain = cause(text);
    assert.doesNotMatch(`${plain.title} ${plain.todo}`, /Graph|\b4\d\d\b|\//, "the cause and next step are plain words");
  }
  const job = normalizeJob({ ...row, status: "failed", error: "Graph 429: throttled after 5 retries on /deviceManagement/deviceConfigurations" });
  const html = renderToStaticMarkup(createElement(JobDetail, { job }));
  const [beforeDetails] = html.split("<details");
  assert.ok(!beforeDetails.includes("Graph 429"), "the raw error is not in plain view");
  assert.ok(html.indexOf('data-alert="error"') < html.indexOf('id="job-heading"'), "the error comes before the summary");
});

test("a restore that stops on a settings file names the file and the fix, even with HTTP-like line numbers in the stack", () => {
  const error = [
    "exit code 1",
    "stderr: ConfigFileError: Keel can't read the Exchange restorer settings file (/etc/keel/exchange-restorer.json): it is not valid JSON. Fix the file on the Keel server, or remove it from workload-scope.json.",
    "    at readConfigFile (file:///opt/keel-live/engine/config/configFile.mjs:403:11) {",
    "  code: undefined",
    "}",
  ].join("\n");
  const cause = jobErrorCause({ kind: "restore", error, params: { artifactId: "a1" } });
  assert.equal(cause.title, "Keel can't read the Exchange restorer settings file: it is not valid JSON.");
  assert.equal(cause.todo, "Fix the file on the Keel server, or remove it from workload-scope.json. Run the restore again after that.");
  assert.equal(cause.tone, "urgent");
  assert.equal(cause.action, null);
  const graph = jobErrorCause({ kind: "restore", error: "Keel can't read the restorer settings file (/etc/keel/restorer.json): the file is missing. Fix the file on the Keel server, then try again.", params: {} });
  assert.equal(graph.todo, "Fix the file on the Keel server. Run the restore again after that.");
  // Older raw text, from before the engine named the file.
  assert.equal(jobErrorCause({ kind: "workload-collect", error: "Error: ENOENT: no such file or directory, open '/etc/keel/purview-collector.json'", params: {} }).title,
    "A settings file Keel needs on its server is missing.");
  for (const plain of [cause, graph]) assert.doesNotMatch(`${plain.title} ${plain.todo}`, /\/etc|ENOENT|ConfigFileError|\b4\d\d\b/);
});

test("a backup job lists every kind it reads by service, with state, count, time and a plain problem", () => {
  const progress = {
    source: "live" as const, updatedAt: "2026-10-22T10:05:00Z",
    types: {
      group: { outcome: "complete", itemCount: 214, startedAt: "2026-10-22T10:00:00Z", completedAt: "2026-10-22T10:00:08Z", httpStatus: 200, error: null },
      conditionalAccessPolicy: { outcome: "reading", startedAt: "2026-10-22T10:01:00Z" },
      deviceCompliancePolicy: { outcome: "failed", itemCount: null, startedAt: "2026-10-22T10:00:10Z", completedAt: "2026-10-22T10:00:16Z", httpStatus: 429, error: "Graph 429: throttled after 5 retries" },
      namedLocation: { outcome: "waiting" },
    },
  };
  const now = "2026-10-22T10:02:00Z";
  const running = { status: "running", progress };
  const rows = jobTypeRows(running, now);
  const byType = Object.fromEntries(rows.map((row) => [row.type, row]));
  assert.equal(byType.group.label, "Backed up");
  assert.equal(byType.group.count, 214);
  assert.equal(byType.group.took, "8 seconds");
  assert.equal(byType.conditionalAccessPolicy.label, "Reading now");
  assert.equal(byType.deviceCompliancePolicy.tone, "urgent");
  assert.equal(byType.deviceCompliancePolicy.problem, "Microsoft 365 slowed Keel down");
  assert.equal(byType.deviceCompliancePolicy.raw, "Graph 429: throttled after 5 retries");
  assert.equal(byType.namedLocation.label, "Waiting");
  // Grouped by service in Microsoft's order: Entra ID before Intune.
  assert.deepEqual(jobTypeGroups(rows).map((group) => group.name), ["Entra ID", "Intune"]);
  assert.equal(jobProgressPercent(rows), 50);
  // A kind still being read when the job ended stopped there, and says so.
  const ended = jobTypeRows({ status: "failed", progress }, now).find((row) => row.type === "conditionalAccessPolicy")!;
  assert.equal(ended.label, "Stopped before it finished");
  assert.equal(ended.tone, "urgent");
  // The problems lead the page as one alert; specifics behind Show details.
  const alert = typeProblemsAlert(rows)!;
  assert.equal(alert.title, "1 kind was not backed up in full");
  assert.deepEqual(alert.more, ["Device compliance policy: Microsoft 365 slowed Keel down"]);
  const html = renderToStaticMarkup(createElement(JobDetail, { job: { ...normalizeJob({ ...row, kind: "backup", status: "running", error: null, finished_at: null }), progress }, now }));
  assert.match(html, /role="progressbar"/);
  assert.match(html, /What it backs up/);
  assert.ok(!html.split("<details")[0].includes("Graph 429"), "raw errors wait behind Show details");
});

test("a running service or content backup shows each workload as waiting, reading or done", () => {
  // The shape cli/keel-workload-collect.mjs and cli/keel-content-collect.mjs write live.
  const progress = {
    source: "live" as const, updatedAt: "2026-10-22T10:05:00Z",
    types: {
      "content:exchange-mail": { outcome: "complete", itemCount: 120, startedAt: "2026-10-22T10:00:00Z", completedAt: "2026-10-22T10:01:00Z", httpStatus: null, error: null },
      "content:onedrive": { outcome: "reading", startedAt: "2026-10-22T10:01:00Z" },
      "content:teams": { outcome: "waiting" },
      "workload:sharepoint-site-settings": { outcome: "failed", itemCount: null, startedAt: "2026-10-22T10:00:00Z", completedAt: "2026-10-22T10:00:05Z", httpStatus: null, error: "HTTP 403 Forbidden" },
    },
  };
  const rows = jobTypeRows({ status: "running", progress }, "2026-10-22T10:02:00Z");
  const byType = Object.fromEntries(rows.map((row) => [row.type, row]));
  assert.equal(byType["content:exchange-mail"].label, "Backed up");
  assert.equal(byType["content:exchange-mail"].name, "Mail, calendars and contacts");
  assert.equal(byType["content:onedrive"].label, "Reading now");
  assert.equal(byType["content:onedrive"].took, "1 minute");
  assert.equal(byType["content:teams"].label, "Waiting");
  assert.equal(byType["sharepoint-site-settings"].tone, "urgent");
  assert.equal(jobProgressPercent(rows), 50);
  const html = renderToStaticMarkup(createElement(JobDetail, { job: { ...normalizeJob({ ...row, kind: "content-collect", status: "running", error: null, finished_at: null }), progress }, now: "2026-10-22T10:02:00Z" }));
  assert.match(html, /role="progressbar"/);
  assert.match(html, /Reading now/);
  assert.match(html, /Waiting/);
});
