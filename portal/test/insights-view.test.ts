import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";

import type { FeedRow } from "@/lib/change-feed-view";
import { getFlaggedThisWeek } from "@/lib/insights";
import {
  changeHref, changesByDay, changesByService, insightsRecord, insightsVerdict, quietServices, readInsightsPeriod, startSentence, topPeople, whereToStart,
} from "@/lib/insights-view";
import { attentionRows, flaggedChangesRow } from "@/lib/overview-view";
import { DATA_SURFACES, readAccess } from "@/lib/read";
import { CAPABILITIES_HEADER, ENTITY_CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";
import type { DashboardData } from "@/lib/types";

// Insights (A7 and A8): the verdict, where to start, the shape of the period and the record
// layer are built from one change feed; the Overview adds one row for flagged changes that
// no open alert shows yet. No id ever reaches a sentence.

const NOW = "2026-10-29T12:00:00.000Z";
const AMARA = { kind: "user" as const, id: "a0a00000-0000-4000-8000-0000000000a1", name: "Amara Okafor" };
const APP = { kind: "servicePrincipal" as const, id: "c0c00000-0000-4000-8000-0000000000c3", name: "Sync app" };

const row = (id: string, occurredAt: string, rest: Partial<FeedRow> = {}): FeedRow => ({
  id, source: "audit", occurredAt, day: occurredAt.slice(0, 10), type: "group", typeName: "Group", service: "Entra", priority: "normal",
  priorityReason: null, object: { key: `group:${id}`, name: `Group ${id}`, status: "found" }, change: "modified", activity: null, person: null, ...rest,
});
const critical = (sentence: string) => ({ key: "ca-report-only", severity: "critical" as const, sentence });
const high = (sentence: string) => ({ key: "location-trusted", severity: "high" as const, sentence });

const ROWS: FeedRow[] = [
  row("a", "2026-10-29T10:00:00.000Z", { person: AMARA, flags: [high("Now trusted for sign-in: Branch offices.")], priority: "high", typeName: "Named location", object: { key: "namedLocation:Branch offices", name: "Branch offices", status: "found" } }),
  row("b", "2026-10-28T10:00:00.000Z", { source: "drift", person: AMARA, flags: [critical("Switched to report-only: Block legacy auth.")], priority: "critical", typeName: "Conditional Access policy", object: { key: "conditionalAccessPolicy:Block legacy auth", name: "Block legacy auth", status: "found" } }),
  row("c", "2026-10-29T09:00:00.000Z", { source: "drift", flags: [critical("Leaves out more groups: Require MFA.")], priority: "critical", typeName: "Conditional Access policy", object: { key: "conditionalAccessPolicy:Require MFA", name: "Require MFA", status: "found" } }),
  row("d", "2026-10-27T10:00:00.000Z", { person: APP, priority: "high", service: "Intune", typeName: "Device compliance policy", change: "added" }),
  row("e", "2026-10-29T08:00:00.000Z", { person: APP, priority: "critical", change: "removed" }),
  row("f", "2026-10-26T10:00:00.000Z", { source: "service", service: "SharePoint", typeName: "SharePoint sharing settings", flags: [] }),
  row("g", "2026-10-25T10:00:00.000Z", { person: AMARA }),
];

test("the verdict: none flagged, some flagged, a feed that hit its limit, an empty tenant", () => {
  const plain = ROWS.map((entry) => ({ ...entry, flags: [] }));
  assert.deepEqual(insightsVerdict({ rows: plain, truncated: false }, "7"), { text: "7 changes in the last 7 days; none flagged.", tone: "fine" });
  assert.deepEqual(insightsVerdict({ rows: ROWS, truncated: false }, "7"), { text: "7 changes in the last 7 days; 3 need a look.", tone: "urgent" });
  // Only high flags: check soon, not urgent.
  assert.deepEqual(insightsVerdict({ rows: [ROWS[0], ROWS[6]], truncated: false }, "30"), { text: "2 changes in the last 30 days; 1 needs a look.", tone: "soon" });
  assert.deepEqual(insightsVerdict({ rows: ROWS, truncated: true }, "90"), { text: "At least 7 changes in the last 90 days; 3 need a look.", tone: "urgent" });
  assert.deepEqual(insightsVerdict({ rows: [], truncated: false }, "7"), { text: "No changes in the last 7 days.", tone: "fine" });
  assert.equal(insightsRecord({ rows: ROWS, since: "s", until: "u", truncated: true }).limitNote, "Showing the newest 7 changes.");
  assert.equal(insightsRecord({ rows: ROWS, since: "s", until: "u", truncated: false }).limitNote, null);
});

test("where to start: flagged changes most severe then newest, then unflagged critical or high kinds", () => {
  const start = whereToStart(ROWS, "7", NOW);
  assert.deepEqual(start.flagged.map((item) => item.id), ["c", "b", "a"]);
  assert.deepEqual(start.flagged.map((item) => item.tone), ["urgent", "urgent", "soon"]);
  assert.deepEqual(start.watch.map((item) => item.id), ["e", "d"]);
  assert.equal(start.flagged[1].sentence, "Amara Okafor changed Block legacy auth, a Conditional Access policy, 26 hours ago.");
  assert.equal(start.flagged[0].sentence, "Someone Keel could not name changed Require MFA, a Conditional Access policy, 3 hours ago.");
  assert.equal(start.watch[1].sentence, "Sync app added Group d, a device compliance policy, 2 days ago.");
  assert.equal(start.flagged[1].href, "/changes?view=feed&days=7&q=block+legacy+auth");
  assert.equal(changeHref(ROWS[0], "30"), "/changes?view=feed&q=branch+offices");
  // An unnamed object is named by its kind, never by its id.
  const unnamed = startSentence(row("x", "2026-10-29T11:00:00.000Z", { object: { key: "dead0000-0000-4000-8000-000000000009", name: null, status: "unknown" }, typeName: "App registration" }), NOW);
  assert.equal(unnamed, "Someone Keel could not name changed Unnamed app registration, an app registration, 1 hour ago.");
  const sharing = startSentence(row("s", "2026-10-29T11:00:00.000Z", { typeName: "SharePoint sharing settings", object: { key: "k", name: "Sharing settings", status: "found" } }), NOW);
  assert.equal(sharing, "Someone Keel could not name changed Sharing settings (SharePoint sharing settings) 1 hour ago.");
  assert.doesNotMatch(JSON.stringify(start.flagged.concat(start.watch).map((item) => item.sentence)), /[0-9a-f]{8}-[0-9a-f]{4}/);
});

test("the shape of the period: every day, services busiest first, top people, quiet services", () => {
  const days = changesByDay(ROWS, "7", NOW);
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((day) => day.day), ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]);
  assert.deepEqual(days.map((day) => day.count), [0, 0, 1, 1, 1, 1, 3]);
  assert.deepEqual(changesByService(ROWS, "7").map((bar) => [bar.key, bar.count, bar.flagged]), [["Entra", 5, 3], ["Intune", 1, 0], ["SharePoint", 1, 0]]);
  assert.deepEqual(topPeople(ROWS).map((person) => [person.name, person.count, person.app, person.flagged]), [["Amara Okafor", 3, false, 2], ["Sync app", 2, true, 0]]);
  assert.deepEqual(quietServices(ROWS), ["Exchange", "Teams", "Purview", "Power Platform", "Defender", "Microsoft 365 apps"]);
  assert.deepEqual(insightsRecord({ rows: ROWS, since: "s", until: "u", truncated: false }).sources, { drift: 2, service: 1, backup: 0, audit: 4 });
  assert.equal(readInsightsPeriod("90"), "90");
  assert.equal(readInsightsPeriod("14"), "7");
  assert.equal(readInsightsPeriod(undefined), "7");
});

const OVERVIEW: Pick<DashboardData, "alerts" | "headline" | "openDriftByBlastRadius" | "waiting"> = {
  alerts: [],
  headline: { state: "protected", tone: "good", headline: "Protected", sentence: "All good.", action: null, counts: {}, proof: {} } as unknown as DashboardData["headline"],
  openDriftByBlastRadius: [],
  waiting: { openAlerts: 0, openIncidents: 0, restoreFollowUps: 0 },
};

test("the Overview row appears only for flagged changes that no open alert shows", () => {
  assert.equal(flaggedChangesRow(null), null);
  assert.equal(flaggedChangesRow(undefined), null);
  assert.equal(flaggedChangesRow({ flagged: 0, alerted: 0 }), null);
  assert.equal(flaggedChangesRow({ flagged: 2, alerted: 2 }), null, "every flagged change already has an open alert");
  const row3 = flaggedChangesRow({ flagged: 4, alerted: 1 });
  assert.equal(row3?.title, "3 flagged changes this week");
  assert.equal(row3?.href, "/insights");
  assert.equal(flaggedChangesRow({ flagged: 1, alerted: 0 })?.title, "1 flagged change this week");

  assert.deepEqual(attentionRows(OVERVIEW, null).map((entry) => entry.key), []);
  assert.deepEqual(attentionRows({ ...OVERVIEW, flaggedThisWeek: { flagged: 3, alerted: 0 } }, null).map((entry) => entry.key), ["flagged-changes"]);
  assert.deepEqual(attentionRows({ ...OVERVIEW, flaggedThisWeek: { flagged: 3, alerted: 3 } }, null).map((entry) => entry.key), []);
  assert.deepEqual(attentionRows({ ...OVERVIEW, flaggedThisWeek: null }, null).map((entry) => entry.key), []);
});

test("the read-access check: tenant-wide readers read the page; entity readers get the sentence; others are refused", () => {
  const headers = (central: string, entity = "") => new Headers([[PRINCIPAL_ID_HEADER, "p1"], [CAPABILITIES_HEADER, central], [ENTITY_CAPABILITIES_HEADER, entity]]);
  assert.equal(readAccess(headers("read"), DATA_SURFACES.insightsPage)?.scope.central, true);
  // Entity-scoped: admitted, but not central, so the page shows the sentence and reads no feed.
  assert.deepEqual(readAccess(headers("", "read:CREOS"), DATA_SURFACES.insightsPage)?.scope, { central: false, entities: ["CREOS"] });
  assert.equal(readAccess(headers("collect"), DATA_SURFACES.insightsPage), null);
  assert.equal(readAccess(new Headers([[CAPABILITIES_HEADER, "read"]]), DATA_SURFACES.insightsPage), null);
  // The same access as Every change, which reads the feed for central readers only.
  assert.equal(DATA_SURFACES.insightsPage.capability, DATA_SURFACES.driftPage.capability);
});

// The Overview's loader against a real database: flagged audit rows of the last week, one of
// them with an open alert on its setting and one with a resolved alert.
interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
const APPS = ["a1000000-0000-4000-8000-000000000001", "a1000000-0000-4000-8000-000000000002", "a1000000-0000-4000-8000-000000000003"];

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
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-insights-test-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "insights-portal-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("the Overview loader counts flagged changes of the last week and those an open alert shows", async () => {
  const ref = tenantRef();
  assert.deepEqual(await getFlaggedThisWeek(), { flagged: 0, alerted: 0 });
  for (const [index, app] of APPS.entries()) {
    await client.query(
      `INSERT INTO audit_change_fact (tenant_ref, source_event_id, occurred_at, target_type, target_id, operation, activity, actor_kind, actor_id)
       VALUES ($1, $2, $3, 'ServicePrincipal', $4, 'update', 'Add service principal credentials', 'user', 'b0b00000-0000-4000-8000-0000000000b2')`,
      [ref, `entra:cred${index}:0`, hoursAgo(10 + index), app],
    );
  }
  // Older than a week: not counted.
  await client.query(
    `INSERT INTO audit_change_fact (tenant_ref, source_event_id, occurred_at, target_type, target_id, operation, activity, actor_kind, actor_id)
     VALUES ($1, 'entra:old:0', $2, 'ServicePrincipal', $3, 'update', 'Add service principal credentials', 'user', 'b0b00000-0000-4000-8000-0000000000b2')`,
    [ref, hoursAgo(24 * 9), APPS[2]],
  );
  // An unflagged change.
  await client.query(
    `INSERT INTO audit_change_fact (tenant_ref, source_event_id, occurred_at, target_type, target_id, operation, activity, actor_kind, actor_id)
     VALUES ($1, 'entra:plain:0', $2, 'Group', 'a2000000-0000-4000-8000-000000000009', 'update', 'Update group', 'user', 'b0b00000-0000-4000-8000-0000000000b2')`,
    [ref, hoursAgo(3)],
  );
  assert.deepEqual(await getFlaggedThisWeek(), { flagged: 3, alerted: 0 });

  const alert = (key: string, state: string) => client.query(
    `INSERT INTO alert (tenant_ref, resource_key, control, condition, state, condition_active, severity, first_opened_at, occurrence_started_at, last_firing_at, last_observed_at, last_event_id)
     VALUES ($1, $2, 'insights.flag', 'app-credential-added', $3, true, 'warning', now(), now(), now(), now(), 'e1')`,
    [ref, key, state],
  );
  await alert(APPS[0], "open");
  await alert(APPS[1], "resolved");
  assert.deepEqual(await getFlaggedThisWeek(), { flagged: 3, alerted: 1 });
  assert.equal(flaggedChangesRow(await getFlaggedThisWeek())?.title, "2 flagged changes this week");
  // A10 normalizes an audited object's id to its natural key. A source link must
  // still prevent a second Needs attention row for that same flagged change.
  const { rows: [linked] } = await client.query(`UPDATE alert SET resource_key='servicePrincipal:Payroll'
    WHERE tenant_ref=$1 AND resource_key=$2 RETURNING id`, [ref, APPS[0]]);
  await client.query(`INSERT INTO change_flag_event
    (tenant_ref,source_id,flag_key,resource_key,observed_at,evaluation,alert_id,alert_occurrence)
    VALUES ($1,'audit:entra:cred0:0','app-credential-added-audit','servicePrincipal:Payroll',$2,'{}',$3,1)`,
  [ref, hoursAgo(10), linked.id]);
  assert.deepEqual(await getFlaggedThisWeek(), { flagged: 3, alerted: 1 });
  await client.query("UPDATE alert SET state='suppressed' WHERE id=$1", [linked.id]);
  assert.deepEqual(await getFlaggedThisWeek(), { flagged: 3, alerted: 0 });
  await client.query("UPDATE alert SET state='open' WHERE id=$1", [linked.id]);
  await client.query("UPDATE change_flag_event SET resolved_at=now() WHERE alert_id=$1", [linked.id]);
  assert.deepEqual(await getFlaggedThisWeek(), { flagged: 3, alerted: 0 });
});
