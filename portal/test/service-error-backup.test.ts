import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeJob } from "@/lib/action";
import { jobAlerts, jobProgressTiles, jobTypeRows } from "@/lib/job-view";

// A setting kind whose read kept failing with a 500, 502 or 504 is a fault on Microsoft's
// side (To Do settings: GET /beta/admin/todo answered 500 UnknownError with no message).
// It stays a gap in the backup, but reads "Microsoft service error" in amber, never a red
// "Failed" with no cause.

const now = "2026-10-28T22:00:00Z";
const read = (outcome: string, httpStatus: number | null, error: string | null, itemCount: number | null = null) => ({
  outcome, itemCount, startedAt: "2026-10-28T21:40:51Z", completedAt: "2026-10-28T21:40:59Z", httpStatus, error,
});
const serviceText = "Microsoft service error: Microsoft 365 answered HTTP 500 UnknownError on all 3 tries. This is a fault on Microsoft's side, not a missing permission. The next backup tries again.";
const job = (types: Record<string, ReturnType<typeof read> & { requestId?: string; clientRequestId?: string; requestAt?: string }>) => normalizeJob({
  id: "c8d034ce-0000-4000-8000-000000000099", kind: "collect", params: {}, requested_by: "principal-scheduler",
  created_at: "2026-10-28T21:40:50Z", started_at: "2026-10-28T21:40:51Z", finished_at: "2026-10-28T21:43:42Z", error: null,
  status: "succeeded",
  progress: { source: "snapshot", updatedAt: "2026-10-28T21:43:42Z", types },
  result: { partial: true, incompleteTypes: Object.entries(types).filter(([, entry]) => entry.outcome === "failed").map(([type, entry]) => ({ type, outcome: entry.outcome, httpStatus: entry.httpStatus })) },
});

test("a kind that kept failing with a 500 reads Microsoft service error, amber, with a plain cause", () => {
  const backup = job({ todoSettings: read("failed", 500, serviceText), formsSettings: read("complete", 200, null, 1) });
  const row = jobTypeRows(backup, now).find((entry) => entry.type === "todoSettings");
  assert.equal(row?.label, "Microsoft service error");
  assert.equal(row?.tone, "soon");
  assert.match(row?.problem ?? "", /fault on its side/);
  assert.match(row?.problem ?? "", /next backup tries again/);
  assert.equal(row?.raw, serviceText, "the engine's text stays behind Show details");
  const alert = jobAlerts(backup).find((entry) => entry.key === "types");
  assert.equal(alert?.tone, "soon", "a Microsoft fault alone is not urgent");
  assert.equal(jobProgressTiles(backup, jobTypeRows(backup, now), now).find((tile) => tile.key === "problems")?.tone, "soon");
});

test("an older backup with an empty error text and HTTP 500 reads the same", () => {
  const row = jobTypeRows(job({ todoSettings: read("failed", 500, "") }), now)[0];
  assert.equal(row.label, "Microsoft service error");
  assert.match(row.problem ?? "", /fault on its side/);
});

test("502 and 504 count; 403, 404 and a 503 throttle give-up do not", () => {
  for (const status of [502, 504]) assert.equal(jobTypeRows(job({ todoSettings: read("failed", status, "x") }), now)[0].label, "Microsoft service error");
  for (const status of [403, 404, 503]) {
    const row = jobTypeRows(job({ todoSettings: read("failed", status, "x") }), now)[0];
    assert.equal(row.label, "Failed", String(status));
    assert.equal(row.tone, "urgent", String(status));
  }
});

test("a refused read next to a Microsoft fault keeps the alert urgent", () => {
  const backup = job({ todoSettings: read("failed", 500, serviceText), formsSettings: read("failed", 403, "Insufficient privileges") });
  assert.equal(jobAlerts(backup).find((entry) => entry.key === "types")?.tone, "urgent");
});

// Operator queue Q301: Microsoft support asks for the request ids of a failed call. They sit
// behind Show details with the engine's text, and only GUIDs are shown.
test("a failed kind shows Microsoft's request ids and time behind Show details", () => {
  const ids = { requestId: "df497c08-8f9b-4950-9a7a-e3fdde7457d5", clientRequestId: "965fbbd0-0f48-4b94-8d30-1f0407312efe", requestAt: "2026-10-31T21:38:07.000Z" };
  const row = jobTypeRows(job({ todoSettings: { ...read("failed", 500, serviceText), ...ids } }), now)[0];
  assert.equal(row.raw, serviceText);
  assert.deepEqual(row.support, [
    "Microsoft request ID: df497c08-8f9b-4950-9a7a-e3fdde7457d5",
    "Client request ID: 965fbbd0-0f48-4b94-8d30-1f0407312efe",
    "Microsoft answered at: 2026-10-31 21:38:07 UTC",
    "Quote these in a Microsoft support case.",
  ]);
  const junk = jobTypeRows(job({ todoSettings: { ...read("failed", 500, serviceText), requestId: "Bearer abc", requestAt: ids.requestAt } }), now)[0];
  assert.deepEqual(junk.support, [], "nothing but a GUID is shown");
  const older = jobTypeRows(job({ todoSettings: read("failed", 500, serviceText), formsSettings: { ...read("complete", 200, null, 1), ...ids } }), now);
  assert.deepEqual(older.find((entry) => entry.type === "todoSettings")?.support, [], "an older backup without ids shows none");
  assert.deepEqual(older.find((entry) => entry.type === "formsSettings")?.support, [], "a kind read in full shows no problem details");
});
