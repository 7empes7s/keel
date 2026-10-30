import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { grantRole } from "../../engine/authz/administration.mjs";
import { setAnonymity } from "../../engine/insights/anonymity.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";

import { GET as feedRoute } from "@/app/api/changes/feed/route";
import {
  feedCsv, feedDayLabel, feedGroups, feedObjectName, feedPersonName, feedSummary, readFeedGrouping, type FeedRow,
} from "@/lib/change-feed-view";
import { CAPABILITIES_HEADER, ENTITY_CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";

// Insights A4 (IN-FEED) in the portal: GET /api/changes/feed returns every change, drift
// and audit event as one row, grouped as asked, to tenant-wide readers only; people are
// code-named while names are hidden; the page helpers never show an id.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const ADA = "a0a00000-0000-4000-8000-0000000000a1";
const GROUP = "9a000000-0000-4000-8000-000000000002";
// Times relative to the run, so the test never rots.
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
let reader: string;
let ref: string;

function headers(principalId: string, central: string[], entity: string[] = []): Headers {
  const result = new Headers();
  result.set(PRINCIPAL_ID_HEADER, principalId);
  result.set(CAPABILITIES_HEADER, central.join(" "));
  result.set(ENTITY_CAPABILITIES_HEADER, entity.join(" "));
  return result;
}

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
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-feed-test-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "in-feed-portal-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  ref = tenantRef();
  const { rows: [row] } = await client.query("INSERT INTO principal(email) VALUES ('viewer@example.invalid') RETURNING id");
  reader = String(row.id);
  await grantRole(client, { principalId: reader, role: "viewer", grantedBy: "fixture", activeFrom: "2020-01-01Z" });

  const { rows: [snapshot] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, started_at, completed_at, status) VALUES ($1, $2, $2, 'complete') RETURNING id",
    [ref, hoursAgo(30)],
  );
  for (const [key, type, payload] of [
    ["user:ada@example.invalid", "user", { id: ADA, displayName: "Ada Admin" }],
    ["group:Finance", "group", { id: GROUP, displayName: "Finance" }],
  ] as const) {
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, 'h', 'tier2', 'scoped', 'full', '{}')`,
      [snapshot.id, key, type, payload],
    );
  }
  await client.query(
    `INSERT INTO audit_change_fact (tenant_ref, source_event_id, occurred_at, target_type, target_id, operation, activity, actor_kind, actor_id)
     VALUES ($1, 'entra:r1:0', $2, 'Group', $3, 'update', 'Add member to group', 'user', $4)`,
    [ref, hoursAgo(5), GROUP, ADA],
  );
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("the feed API lists every change as one row and groups it as asked", async () => {
  const response = await feedRoute(new Request("http://localhost/api/changes/feed?by=person", { headers: headers(reader, ["read"]) }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.by, "person");
  assert.equal(body.total, 1);
  assert.equal(body.rows[0].object.name, "Finance");
  assert.equal(body.rows[0].typeName, "Group");
  assert.equal(body.rows[0].person.name, "Ada Admin");
  assert.deepEqual(body.groups.map((group: { label: string; count: number; rowIds: string[] }) => [group.label, group.count, group.rowIds]), [["Ada Admin", 1, ["audit:entra:r1:0"]]]);
});

test("the feed API refuses an unknown grouping, and readers limited to part of the company", async () => {
  const bad = await feedRoute(new Request("http://localhost/api/changes/feed?by=colour", { headers: headers(reader, ["read"]) }));
  assert.equal(bad.status, 400);
  const scoped = await feedRoute(new Request("http://localhost/api/changes/feed", { headers: headers(reader, [], ["read:CREOS"]) }));
  assert.equal(scoped.status, 403);
  const nobody = await feedRoute(new Request("http://localhost/api/changes/feed", { headers: headers(reader, []) }));
  assert.equal(nobody.status, 403);
});

test("with names hidden the feed API sends code names only", async () => {
  await setAnonymity(client, { tenantRef: ref, enabled: true, actor: "admin@example.invalid" });
  try {
    const body = await (await feedRoute(new Request("http://localhost/api/changes/feed", { headers: headers(reader, ["read"]) }))).json();
    assert.match(body.rows[0].person.name, /^Person [A-Z2-9]{4}$/);
    assert.ok(!JSON.stringify(body).includes("Ada Admin"));
  } finally {
    await setAnonymity(client, { tenantRef: ref, enabled: false, actor: "admin@example.invalid" });
  }
});

const row = (overrides: Partial<FeedRow>): FeedRow => ({
  id: "audit:x", source: "audit", occurredAt: "2026-10-28T10:00:00.000Z", day: "2026-10-28", type: "group", typeName: "Group",
  service: "Entra", priority: "normal", priorityReason: null, object: { key: GROUP, name: "Finance", status: "found" },
  change: "modified", activity: null, person: null, ...overrides,
});

test("page helpers: names never fall back to ids, days read as words, groupings default to day", () => {
  assert.equal(feedObjectName(row({ object: { key: GROUP, name: null, status: "unknown" }, typeName: "Conditional Access policy" })), "Unnamed Conditional Access policy");
  assert.equal(feedPersonName(row({})), "Not known");
  assert.equal(feedPersonName(row({ person: { kind: "servicePrincipal", id: ADA, name: null } })), "Unnamed app");
  assert.equal(feedDayLabel("2026-10-29", "2026-10-29T12:00:00Z"), "Today");
  assert.equal(feedDayLabel("2026-10-28", "2026-10-29T12:00:00Z"), "Yesterday");
  assert.match(feedDayLabel("2026-10-20", "2026-10-29T12:00:00Z"), /20 Oct 2026/);
  assert.equal(readFeedGrouping("service"), "service");
  assert.equal(readFeedGrouping("nonsense"), "day");
  assert.equal(readFeedGrouping(null), "day");
});

test("page helpers: CSV rows carry names, not ids, and the summary puts critical first", () => {
  const rows = [row({ id: "a", priority: "critical", person: { kind: "user", id: ADA, name: "Person K7Q2", pseudonym: true } }), row({ id: "b", object: { key: GROUP, name: null, status: "unknown" } })];
  const csv = feedCsv(rows);
  assert.ok(!csv.includes(GROUP));
  assert.ok(!csv.includes(ADA));
  assert.match(csv, /Person K7Q2/);
  assert.match(csv, /Unnamed group/);
  assert.deepEqual(feedSummary(rows), { text: "2 changes, 1 critical: look at those first.", tone: "urgent" });
  assert.deepEqual(feedSummary([]), { text: "No changes found in this period.", tone: "fine" });
  assert.deepEqual(feedGroups(rows, "priority").map((group) => group.key), ["critical", "normal"]);
});
