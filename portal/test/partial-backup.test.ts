import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { JobDetail } from "@/components/job-detail";
import { JobRow } from "@/components/job-table";
import { incompleteTypesLine, jobDisplayStatus, jobIncompleteTypes } from "@/lib/job-names";
import { normalizeJob } from "@/lib/action";
import { jobStatusSentence } from "@/lib/sentences";

// Issue #447: an hourly backup that saved its snapshot but could not read one type
// shows as "Partly done" and names that type. It never reads as "Finished" or "Failed".

const now = "2026-10-22T10:00:00Z";
const base = {
  id: "47f0a20a-2f45-4eb0-9b4b-253d469c82a5", kind: "collect", params: {}, requested_by: "principal-scheduler",
  created_at: "2026-10-22T09:00:00Z", started_at: "2026-10-22T09:00:03Z", finished_at: "2026-10-22T09:02:07Z", error: null,
};
const partial = normalizeJob({
  ...base, status: "succeeded",
  result: { stdout: "", stderr: "", durationMs: 124000, partial: true, incompleteTypes: [{ type: "deviceManagementSettings", outcome: "failed", httpStatus: 400 }] },
});
const finished = normalizeJob({ ...base, status: "succeeded", result: { stdout: "", stderr: "", durationMs: 124000 } });

test("the types a partial backup did not read come from its result", () => {
  assert.deepEqual(jobIncompleteTypes(partial), ["deviceManagementSettings"]);
  assert.equal(jobDisplayStatus(partial), "partial");
  assert.deepEqual(jobIncompleteTypes(finished), []);
  assert.equal(jobDisplayStatus(finished), "succeeded");
  // A failed job keeps its status even if its result carries a list.
  assert.equal(jobDisplayStatus({ status: "failed", result: partial.result }), "failed");
  // A malformed result is not partial.
  assert.equal(jobDisplayStatus({ status: "succeeded", result: { partial: true, incompleteTypes: "x" } }), "succeeded");
  assert.equal(incompleteTypesLine(["deviceManagementSettings"]), "Not backed up: Intune tenant settings");
  assert.equal(incompleteTypesLine(["a", "b", "c", "d", "e"]), "Not backed up: a, b, c and 2 more");
  assert.equal(jobStatusSentence(partial, now), "Partly done 57 minutes ago after 2 minutes: 1 type not backed up");
  assert.match(jobStatusSentence(finished, now), /^Finished /);
});

test("the backups list and the job page say Partly done and name the type", () => {
  const row = renderToStaticMarkup(createElement(JobRow, { job: partial, now }));
  assert.match(row, /Partly done/);
  assert.doesNotMatch(row, />Failed</);
  assert.doesNotMatch(row, />Finished</);
  assert.match(row, /Not backed up: Intune tenant settings/);
  assert.match(row, /data-tone="soon"/);

  const page = renderToStaticMarkup(createElement(JobDetail, { job: partial, now }));
  assert.match(page, /job-summary-partial/);
  assert.match(page, /What was not backed up/);
  assert.match(page, /<li>Intune tenant settings<\/li>/);

  const plain = renderToStaticMarkup(createElement(JobRow, { job: finished, now }));
  assert.match(plain, />Finished</);
  assert.doesNotMatch(plain, /Not backed up/);
});
