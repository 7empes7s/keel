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
import { getResilienceData, getRestoreFollowUps, notifyRoutesFor, waitingFor } from "@/lib/portal-data";
import { resilienceAlerts, resilienceKinds } from "@/lib/resilience-view";
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
  coverage: { covered: 0, failed: 0, partial: 0, stale: 0, notCovered: 0, neverCollected: 0, total: 0 } as DashboardData["coverage"],
  evidence: { ok: true, chainLength: 0 },
  alerts: [],
  headline: {
    state: "collection", tone: "attention", headline: "Not protected yet", sentence: "Nothing backed up.", action: null,
    counts: { backedUp: 0, restorable: 0, failing: 0, failed: 0, stale: 0, neverCollected: 0 }, proof: { restorable: 0, proven: 0, tested: 0, untested: 0, lastProvenAt: null, href: "/protect?health=proven" }, lastProvenRestoreAt: null, failingSince: null,
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

  const work = await getRestoreFollowUps();
  assert.equal(work.cards.length, 1);
  assert.equal(work.cards[0].jobId, job.id);
  assert.deepEqual([work.steps, work.restores], [items.length, 1]);
  const html = renderToStaticMarkup(createElement(RestoreFollowUps, { work, now: DASHBOARD.generatedAt }));
  assert.match(html, new RegExp(`href="/jobs/${job.id}"`), "each restore links to the page where its steps are closed");
  assert.match(html, /id="follow-up"/);
});

// UI audit B10 and D13: each card is named by its restore (what it put back, from which
// backup), links to the page where its steps close, labels its Technical details with
// that name, and says when the restore ran, not when a step was opened.
test("each follow-up card names and links its restore and shows when the restore ran", async () => {
  const ref = tenantRef();
  await client.query("DELETE FROM recovery_completion_item WHERE tenant_ref = $1", [ref]);
  const { rows: [snapshot] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, started_at, completed_at, status) VALUES ($1, '2026-10-02T09:00:00Z', '2026-10-02T09:12:00Z', 'complete') RETURNING id",
    [ref],
  );
  const plan = async (keys: string[]) => (await client.query(
    `INSERT INTO restore_dry_run (tenant_ref, snapshot_id, selection, closure_keys, target_tenant_id, collector_config_path, target_config_path,
       waves, patches, results, current_state_fingerprint, digest, status, requested_by)
     VALUES ($1, $2, '[]', $3, 't', 'c', 't', '[]', '[]', '{}', 'f', 'd', 'completed', 'op') RETURNING id::text AS id`,
    [ref, snapshot.id, JSON.stringify(keys)],
  )).rows[0].id as string;
  const viaPortal = await plan(["group:Finance", "group:Sales", "group:HR"]);
  const outside = await plan(["group:Finance"]);
  const check = (await enqueue(client, { kind: "restore", params: { artifactId: viaPortal }, requestedBy: "op", idempotencyKey: null, notBefore: null })) as { id: string };
  const restore = (await enqueue(client, { kind: "restore", params: { artifactId: viaPortal, mode: "enforce" }, requestedBy: "op", idempotencyKey: null, notBefore: null })) as { id: string };
  // The check was queued after the restore here, so only the enforce preference picks the restore.
  await client.query("UPDATE job SET created_at = now() + interval '1 minute' WHERE id = $1", [check.id]);
  // Set explicitly: the restore ran three days before "now", its steps were opened later.
  const now = "2026-10-31T17:41:00Z";
  await client.query("UPDATE job SET status = 'succeeded', started_at = '2026-10-28T17:30:00Z', finished_at = '2026-10-28T17:40:00Z' WHERE id = $1", [restore.id]);
  for (const restoreRef of [viaPortal, outside]) {
    await emitCompletionItems(client, { tenantRef: ref, restoreRef, owner: null, applied: [{ naturalKey: `group:KEEL-RT-${restoreRef}`, resourceType: "group", mechanism: "recreate" }] });
  }
  await client.query("UPDATE recovery_completion_item SET created_at = '2026-10-30T14:41:00Z' WHERE tenant_ref = $1", [ref]);

  const work = await getRestoreFollowUps();
  const portalCard = work.cards.find((card) => card.restoreRef === viaPortal);
  const outsideCard = work.cards.find((card) => card.restoreRef === outside);
  assert.equal(portalCard?.jobId, restore.id, "the enforced restore, not its check");
  assert.equal(portalCard?.restoredAt, "2026-10-28T17:40:00.000Z");
  assert.equal(outsideCard?.jobId, null);

  const html = renderToStaticMarkup(createElement(RestoreFollowUps, { work, now }));
  const name = "Restore of 3 settings from the backup of 2 Oct 2026, 09:12";
  assert.match(html, new RegExp(`<a class="activity-title" href="/jobs/${restore.id}">${name}</a>`), "the title names and links its restore");
  assert.match(html, /Restored 3 days ago/, "the time is when the restore ran");
  assert.doesNotMatch(html, /From a restore 27 hours ago/);
  assert.match(html, /Steps opened 27 hours ago/, "a restore run outside the portal says what its time is");
  assert.match(html, /<summary>Show the steps<\/summary>/, "a restore with no job page shows its steps on the card");
  assert.equal((html.match(new RegExp(`<span class="technical-summary-text">Technical details: ${name}</span>`, "g")) ?? []).length, 1, "the card's Technical details names its restore");
  assert.match(html, /<span class="technical-summary-text">Technical details: Restore of 1 setting from the backup of 2 Oct 2026, 09:12<\/span>/, "every card's does");
  assert.doesNotMatch(html, />Technical details</, "no card has the bare label");
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
  // Unlike kinds of work are never added into one number: each has its own count and link.
  assert.doesNotMatch(waiting, /data-tile="waiting"[^>]*>[\s\S]*?<b class="ov-tile-count">6<\/b>/, "the tile never adds alerts, incidents and restore steps together");
  assert.match(waiting, /data-tile="waiting"[\s\S]*?data-part="openAlerts" href="\/alerts"><b>3<\/b> alerts[\s\S]*?data-part="openIncidents" href="\/incidents"><b>1<\/b> incident[\s\S]*?data-part="restoreFollowUps" href="\/restore#follow-up"><b>2<\/b> restore steps/);
  const mixed = renderToStaticMarkup(createElement(DashboardView, { data: { ...DASHBOARD, waiting: { openAlerts: 5, openIncidents: 0, restoreFollowUps: 0 } }, pendingApprovals: 2 }));
  assert.match(mixed, /data-part="approvals" href="\/approvals"><b>2<\/b> approvals[\s\S]*?data-part="openAlerts" href="\/alerts"><b>5<\/b> alerts/, "approvals and alerts each link to their own list");
  const single = renderToStaticMarkup(createElement(DashboardView, { data: { ...DASHBOARD, waiting: { openAlerts: 4, openIncidents: 0, restoreFollowUps: 0 } }, pendingApprovals: null }));
  assert.match(single, /data-tile="waiting"[^>]*href="\/alerts"[\s\S]*?<b class="ov-tile-count">4<\/b><small>Alerts to deal with<\/small>/, "one kind keeps the plain tile, linked to its list");

  const approver = renderToStaticMarkup(createElement(DashboardView, { data: DASHBOARD, pendingApprovals: 0 }));
  assert.match(approver, /data-tile="waiting"[^>]*href="\/approvals"[\s\S]*?<b class="ov-tile-count">0<\/b>/, "an approver always sees the tile");
  assert.equal(renderToStaticMarkup(createElement(RestoreFollowUps, { work: { steps: 0, restores: 0, href: "/restore#follow-up", cards: [] }, now: DASHBOARD.generatedAt })), "");
});

// Audit 2026-10-31: Overview said 273 steps, Restore 233 (it added up only the 50 cards it
// lists) and Resilience "25 restores". With more restores than the list holds, all three
// now read the one engine count.
test("Overview, Restore and Resilience show the same follow-up totals past the card limit", async () => {
  const ref = tenantRef();
  await client.query("DELETE FROM recovery_completion_item WHERE tenant_ref = $1", [ref]);
  let steps = 0;
  for (let n = 1; n <= 52; n++) {
    const restoreRef = `75000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    steps += ((await emitCompletionItems(client, {
      tenantRef: ref, restoreRef, owner: null, applied: [{ naturalKey: `group:KEEL-RT-${n}`, resourceType: "group", mechanism: "recreate" }],
    })) as unknown[]).length;
  }

  const overview = (await waitingFor(client, ref)).restoreFollowUps;
  const work = await getRestoreFollowUps();
  const resilienceData = await getResilienceData();
  const resilience = resilienceData.followUps;
  assert.equal(overview, steps);
  // UI audit B10: every restore is listed, a page of them at a time.
  assert.deepEqual([work.steps, work.restores, work.cards.length], [steps, 52, 52], "the page lists and counts all 52");
  assert.equal(work.cards.reduce((sum, card) => sum + card.pending, 0), steps, "every restore's steps are on a card");
  assert.deepEqual(resilience, { steps, restores: 52, href: "/restore#follow-up" });

  const html = renderToStaticMarkup(createElement(RestoreFollowUps, { work, now: DASHBOARD.generatedAt }));
  assert.match(html, new RegExp(`${steps} steps on 52 restores`));
  assert.doesNotMatch(html, /Showing the newest/, "no restore is left off the list");
  assert.match(html, /Showing 1–25 of 52 restores/, "the list pages past 25");
  assert.equal((html.match(/class="activity-item follow-up-card"/g) ?? []).length, 25, "one page of cards");
  const dashboard = renderToStaticMarkup(createElement(DashboardView, {
    data: { ...DASHBOARD, waiting: { openAlerts: 0, openIncidents: 0, restoreFollowUps: overview } }, pendingApprovals: null,
  }));
  assert.match(dashboard, new RegExp(`<b>${steps} restore steps are still open</b>`));
  const alert = resilienceAlerts({
    generatedAt: DASHBOARD.generatedAt, incidents: [], followUps: resilience, failedRestores: resilienceData.failedRestores, kinds: resilienceKinds([]),
    storage: { configured: true, provider: "local-disk", region: null, boundary: null, immutability: "live-qualified", generatedAt: null, certifies: null, source: null },
    metrics: { freshness: { state: "measured", gaps: [], latestFailures: [], notUsed: [] }, recoverablePoint: { state: "measured", point: DASHBOARD.generatedAt, copies: [] },
      recoveryTime: { state: "measured", attempts: [] }, readiness: { state: "measured" }, services: { settings: [], content: [] } },
  } as never).find((entry) => entry.key === "restore-checks-open");
  assert.equal(alert?.title, `52 restores have ${steps} follow-up steps open`);
});

test("with no channel, or no rule that sends alerts to one, the Overview says first and Urgent that alerts reach nobody", async () => {
  assert.deepEqual(await notifyRoutesFor(client), { channels: 0, routed: 0 });
  const nobody = renderToStaticMarkup(createElement(DashboardView, {
    data: { ...DASHBOARD, notify: await notifyRoutesFor(client), waiting: { openAlerts: 196, openIncidents: 1, restoreFollowUps: 0 } }, pendingApprovals: null,
  }));
  assert.match(nobody, /<ul class="ov-rows"><li><a class="ov-row" data-tone="urgent" href="\/notifications">[\s\S]*?<b>No notification channel<\/b><small>196 open alerts reach nobody\. Add an email or webhook channel so alerts reach someone\.<\/small>[\s\S]*?Urgent/, "it is the first row and opens Notifications");

  const { rows: [disabled] } = await client.query("INSERT INTO channel (kind, config, enabled) VALUES ('email', '{}', false) RETURNING id");
  await client.query("INSERT INTO subscription (channel_id, event_glob, min_severity) VALUES ($1, '*', 'notice')", [disabled.id]);
  assert.deepEqual(await notifyRoutesFor(client), { channels: 0, routed: 0 }, "a turned-off channel sends nothing");

  const { rows: [channel] } = await client.query("INSERT INTO channel (kind, config, enabled) VALUES ('webhook', '{}', true) RETURNING id");
  assert.deepEqual(await notifyRoutesFor(client), { channels: 1, routed: 0 });
  const noRule = renderToStaticMarkup(createElement(DashboardView, { data: { ...DASHBOARD, notify: await notifyRoutesFor(client) }, pendingApprovals: null }));
  assert.match(noRule, /href="\/notifications"[\s\S]*?<b>No rule sends alerts to a channel<\/b><small>Add a rule that sends alerts to one of your channels\.<\/small>/);

  await client.query("INSERT INTO subscription (channel_id, event_glob, min_severity) VALUES ($1, '*', 'warning')", [channel.id]);
  assert.deepEqual(await notifyRoutesFor(client), { channels: 1, routed: 1 });
  const routed = renderToStaticMarkup(createElement(DashboardView, { data: { ...DASHBOARD, notify: await notifyRoutesFor(client) }, pendingApprovals: null }));
  assert.doesNotMatch(routed, /href="\/notifications"/, "once alerts reach someone, the row goes");
  const unknown = renderToStaticMarkup(createElement(DashboardView, { data: DASHBOARD, pendingApprovals: null }));
  assert.doesNotMatch(unknown, /href="\/notifications"/, "when the count could not be read, no row is guessed");
});
