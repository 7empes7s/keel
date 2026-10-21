import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { emitCompletionItems } from "../../engine/restore/completion.mjs";
import { enqueue } from "../../engine/jobs/queue.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { RestoreFollowUps } from "@/components/restore-follow-ups";
import { getRestoreFollowUps, waitingFor } from "@/lib/portal-data";
import { tenantRef } from "@/lib/runtime-config";
import type { DashboardData } from "@/lib/types";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

// Work that waits on a person outside the approvals inbox is counted on the Overview
// and listed where it is done, so none of it is reachable only by a direct link.

type TestClient = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> };
let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    for (const line of readFileSync("/etc/keel/db.env", "utf8").split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  client = await database.connect();
  await client.query(schemaSql());
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-waiting-test-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "waiting-work-portal-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

const DASHBOARD: DashboardData = {
  generatedAt: "2026-10-14T09:00:00Z",
  activeBaseline: null,
  lastCollection: null,
  lastCompletedCollectionAt: null,
  openDriftByBlastRadius: [],
  openDriftTotal: 0,
  driftTrend: [],
  coverage: { covered: 0, failed: 0, stale: 0, notCovered: 0, neverCollected: 0, total: 0 } as DashboardData["coverage"],
  evidence: { ok: true, chainLength: 0 },
  alerts: [],
  headline: {
    state: "collection", tone: "attention", headline: "Not protected yet", sentence: "Nothing backed up.", action: null,
    counts: { backedUp: 0, restorable: 0, failing: 0, failed: 0, stale: 0, neverCollected: 0 }, lastProvenRestoreAt: null, failingSince: null,
  } as DashboardData["headline"],
};

async function insertAlert(state: string, key: string) {
  await client.query(
    `INSERT INTO alert (tenant_ref, resource_key, control, condition, state, condition_active, severity,
       first_opened_at, occurrence_started_at, last_firing_at, last_observed_at, last_event_id)
     VALUES ($1, $2, 'c', 'x', $3, true, 'warning', now(), now(), now(), now(), 'e')`,
    [tenantRef(), key, state],
  );
}

test("open alerts, open incidents and open restore follow-up steps are counted; closed ones are not", async () => {
  const ref = tenantRef();
  assert.deepEqual(await waitingFor(client, ref), { openAlerts: 0, openIncidents: 0, restoreFollowUps: 0 });

  await insertAlert("open", "a");
  await insertAlert("reopened", "b");
  await insertAlert("acknowledged", "c");
  await insertAlert("open", "other-tenant-only");
  await client.query("UPDATE alert SET tenant_ref = 'someone-else' WHERE resource_key = 'other-tenant-only'");
  await client.query("INSERT INTO incident (tenant_ref, title, owner) VALUES ($1, 'Open', 'p'), ($1, 'Closed', 'p')", [ref]);
  await client.query("UPDATE incident SET status = 'closed', closed_at = now() WHERE title = 'Closed'");

  const restoreRef = "72000000-0000-4000-8000-000000000001";
  const job = (await enqueue(client, {
    kind: "restore", params: { artifactId: restoreRef, mode: "enforce" }, requestedBy: "op", idempotencyKey: null, notBefore: null,
  })) as { id: string };
  const items = (await emitCompletionItems(client, {
    tenantRef: ref, restoreRef, owner: null, applied: [{ naturalKey: "group:Finance", resourceType: "group", mechanism: "recreate" }],
  })) as unknown[];

  assert.deepEqual(await waitingFor(client, ref), { openAlerts: 2, openIncidents: 1, restoreFollowUps: items.length });

  const followUps = await getRestoreFollowUps();
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].jobId, job.id);
  const html = renderToStaticMarkup(createElement(RestoreFollowUps, { followUps, now: DASHBOARD.generatedAt }));
  assert.match(html, new RegExp(`href="/jobs/${job.id}"`), "each restore links to the page where its steps are closed");
  assert.match(html, /id="follow-up"/);
});

test("the Overview shows a row for each kind of open work, linked to where it is done, and counts it on the Waiting tile", () => {
  const none = renderToStaticMarkup(createElement(DashboardView, { data: DASHBOARD, pendingApprovals: null }));
  assert.doesNotMatch(none, /href="\/alerts"|href="\/incidents"|href="\/restore#follow-up"/, "nothing waits, so no rows");
  assert.doesNotMatch(none, /Waiting on you/, "a viewer who cannot approve and has nothing waiting sees no Waiting tile");

  const waiting = renderToStaticMarkup(createElement(DashboardView, {
    data: { ...DASHBOARD, waiting: { openAlerts: 3, openIncidents: 1, restoreFollowUps: 2 } }, pendingApprovals: null,
  }));
  assert.match(waiting, /class="ov-row"[^>]*href="\/alerts"[\s\S]*?<b>3 alerts are not acknowledged<\/b>/);
  assert.match(waiting, /class="ov-row"[^>]*href="\/incidents"[\s\S]*?<b>1 incident is open<\/b>/);
  assert.match(waiting, /class="ov-row"[^>]*href="\/restore#follow-up"[\s\S]*?<b>2 restore steps are still open<\/b>/);
  assert.match(waiting, /data-tile="waiting"[^>]*href="\/alerts"[\s\S]*?<b class="ov-tile-count">6<\/b>/, "the tile adds them up and opens the first");

  const approver = renderToStaticMarkup(createElement(DashboardView, { data: DASHBOARD, pendingApprovals: 0 }));
  assert.match(approver, /data-tile="waiting"[^>]*href="\/approvals"[\s\S]*?<b class="ov-tile-count">0<\/b>/, "an approver always sees the tile");
  assert.equal(renderToStaticMarkup(createElement(RestoreFollowUps, { followUps: [], now: DASHBOARD.generatedAt })), "");
});
