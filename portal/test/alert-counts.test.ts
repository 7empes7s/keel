import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { grantRole } from "../../engine/authz/administration.mjs";
import { alertStateCounts } from "../../engine/notify/alerts.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { guardedAlertInbox } from "@/lib/alerts";
import { alertCounts, alertsVerdict, listedNote, liveCounts, type AlertCounts, type AlertInboxData, type AlertItem } from "@/lib/alerts-view";
import { waitingFor } from "@/lib/portal-data";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

// Audit 31 Oct 2026: the Overview and the bell said 722 alerts were waiting while the
// Alerts page said 197, because the page counted only the 200 alerts it listed. Every
// place now shows one count, alertStateCounts, whatever the list holds.

type TestClient = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> };
let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
let viewer: string;

const TENANT = "alert-counts-test";
// Set relative to the run: "resolved this week" and "overdue" compare with now.
const NOW = new Date();
const hoursAgo = (hours: number) => new Date(NOW.valueOf() - hours * 3_600_000);

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
  const { rows: [person] } = await client.query("INSERT INTO principal (email, display_name) VALUES ('vic@test.example', 'Vic Viewer') RETURNING id::text AS id");
  viewer = String(person.id);
  await grantRole(client, { principalId: viewer, role: "viewer", grantedBy: viewer, activeFrom: hoursAgo(1).toISOString() });
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

// Many alerts in one insert: `count` alerts in `state`, last updated `updatedHoursAgo`.
async function insertAlerts(tenant: string, state: string, count: number, extra: { deadline?: Date; resolvedAt?: Date; updatedHoursAgo?: number } = {}) {
  await client.query(
    `INSERT INTO alert (tenant_ref, resource_key, control, condition, state, condition_active, severity,
       first_opened_at, occurrence_started_at, last_firing_at, last_observed_at, last_event_id,
       ack_deadline_at, resolved_at, updated_at)
     SELECT $1, $2 || '-' || n, 'baseline', 'drift', $3, $3 IN ('open','reopened','acknowledged'), 'warning',
            $4, $4, $4, $4, 'e-' || n, $5, $6, $7
       FROM generate_series(1, $8) AS n`,
    [tenant, `${state}-${count}-${extra.updatedHoursAgo ?? 0}`, state, hoursAgo(48), extra.deadline ?? null, extra.resolvedAt ?? null, hoursAgo(extra.updatedHoursAgo ?? 0), count],
  );
}

function request() {
  return new Request("http://localhost/api/alerts", { headers: { [PRINCIPAL_ID_HEADER]: viewer, [CAPABILITIES_HEADER]: "read" } });
}

test("the Alerts page, the Overview and the bell show one count, even past the old 200-alert list", async () => {
  // 250 waiting alerts, updated longer ago than 250 resolved ones: the old page read the
  // 200 most recently updated alerts and so counted no waiting alert at all.
  await insertAlerts(TENANT, "open", 230, { updatedHoursAgo: 30 });
  await insertAlerts(TENANT, "reopened", 5, { updatedHoursAgo: 30 });
  await insertAlerts(TENANT, "open", 15, { deadline: hoursAgo(2), updatedHoursAgo: 30 });
  await insertAlerts(TENANT, "acknowledged", 7, { updatedHoursAgo: 30 });
  await insertAlerts(TENANT, "suppressed", 3, { updatedHoursAgo: 1 });
  await insertAlerts(TENANT, "resolved", 240, { resolvedAt: hoursAgo(2), updatedHoursAgo: 1 });
  await insertAlerts(TENANT, "resolved", 10, { resolvedAt: hoursAgo(24 * 9), updatedHoursAgo: 1 });
  await insertAlerts("someone-else", "open", 4);

  const counts = await alertStateCounts(client, { tenantRef: TENANT, now: NOW });
  assert.deepEqual(counts, { waiting: 250, overdue: 15, acknowledged: 7, muted: 3, resolved: 250, resolvedWeek: 240, total: 510 });

  // The Overview and the bell read waitingFor.
  assert.equal((await waitingFor(client as never, TENANT)).openAlerts, counts.waiting);

  // The Alerts page reads the inbox route: the same counts, and every open alert listed.
  const inbox = guardedAlertInbox({ connect: () => database.connect(), databaseUrl: () => database.url, tenantRef: () => TENANT });
  const response = await inbox(request());
  assert.equal(response.status, 200);
  const body = await response.json() as AlertInboxData;
  assert.deepEqual(body.counts, counts);
  const listed = alertCounts(body.alerts, body.generatedAt);
  assert.equal(listed.waiting, 250, "every waiting alert is in the list");
  assert.equal(listed.acknowledged, 7);
  assert.equal(listed.resolved + listed.muted, 200, "only the most recently closed alerts are listed");
  assert.equal(alertsVerdict(body.counts).text, "250 alerts need someone to acknowledge them; 15 are past the deadline.");

  // The list holds fewer closed alerts than the count, and says so; a waiting view does not.
  assert.match(listedNote(body.counts, listed, []) ?? "", /^This list shows 457 of 510 alerts/);
  assert.equal(listedNote(body.counts, listed, ["waiting"]), null);
  assert.ok(listedNote(body.counts, listed, ["resolved"]));
});

const alert = (id: string, state: AlertItem["state"]): AlertItem => ({
  id, resourceKey: `k-${id}`, name: null, object: null, control: "baseline", condition: "drift", state, conditionActive: true, severity: "warning",
  occurrence: 1, firstOpenedAt: "2026-10-01T00:00:00Z", occurrenceStartedAt: "2026-10-01T00:00:00Z", lastFiringAt: "2026-10-01T00:00:00Z",
  ackDeadlineAt: null, acknowledgedAt: null, acknowledgedByName: null, owner: null, escalated: false, escalationError: null,
  cause: { changeType: null, resourceType: null, snapshotId: null }, lastEventId: "e", history: [],
} as unknown as AlertItem);

test("acknowledging on the page moves the whole count at once, before the next read", () => {
  const server: AlertCounts = { waiting: 722, overdue: 0, acknowledged: 3, resolved: 900, resolvedWeek: 12, muted: 0, total: 1625 };
  const read = [alert("a", "open"), alert("b", "open")];
  const changed = [{ ...read[0], state: "acknowledged" as const }, read[1]];
  const live = liveCounts(server, read, changed, "2026-10-31T18:00:00Z");
  assert.equal(live.waiting, 721);
  assert.equal(live.acknowledged, 4);
  assert.equal(live.total, 1625);
  assert.deepEqual(liveCounts(server, read, read, "2026-10-31T18:00:00Z"), server);
});
