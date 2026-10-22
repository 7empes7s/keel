import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { JobDetail } from "@/components/job-detail";
import { jobErrorCause } from "@/lib/job-view";
import { JobTable } from "@/components/job-table";
import { guardedJobList, guardedJobShow, normalizeJob } from "@/lib/action";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

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
  assert.ok(html.includes(`Full error</dt><dd><pre class="technical-block"><code>${row.error}</code></pre>`));
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
