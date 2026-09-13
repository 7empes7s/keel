import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { JobDetail } from "@/components/job-detail";
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
    headingId: "jobs", jobs: [normalizeJob(row)], kicker: "Queue", title: "Jobs",
  }));
  assert.ok(html.includes(row.error));
  assert.ok(html.includes(`href="/jobs/${row.id}"`));
  assert.ok(html.includes("operator"));
  assert.ok(html.includes("Failed"));
  const succeeded = renderToStaticMarkup(createElement(JobTable, {
    headingId: "jobs", jobs: [normalizeJob({ ...row, status: "succeeded" })], kicker: "Queue", title: "Jobs",
  }));
  assert.ok(!succeeded.includes(row.error));
});

test("job details preserve the full error and expose params, result, worker and heartbeat", () => {
  const job = normalizeJob(row);
  const html = renderToStaticMarkup(createElement(JobDetail, { job }));
  assert.ok(html.includes(`<pre class="job-error job-payload">${row.error}</pre>`));
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
  assert.deepEqual((await list.json()).jobs, [normalizeJob(row)]);
  assert.match(queries[0].sql, /ORDER BY created_at DESC/);
  assert.deepEqual(queries[0].values, [50]);
  for (const limit of ["-1", "invalid", "1.5", "0"]) {
    await guardedJobList(deps)(new Request(`http://localhost/api/jobs?limit=${limit}`, { headers }));
    assert.deepEqual(queries.at(-1)?.values, [100]);
  }
  const show = await guardedJobShow(deps)(new Request(`http://localhost/api/jobs/${row.id}`, { headers }));
  assert.equal(show.status, 200);
  assert.deepEqual((await show.json()).job, normalizeJob(row));
  assert.deepEqual(queries.at(-1)?.values, [row.id]);
});
