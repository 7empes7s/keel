import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { grantRole } from "../../engine/authz/administration.mjs";
import { permissionsSummary } from "../../engine/content/sharepointSites.mjs";
import { createFixtureCmdbAdapter } from "../../engine/identity/adapters/cmdb.mjs";
import { resolveOwnership } from "../../engine/identity/ownership.mjs";
import { recordLineage } from "../../engine/store/resourceLineage.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { GET as feedRoute } from "@/app/api/changes/feed/route";
import { getChangeFeed } from "@/lib/change-feed";
import { feedCsv, feedGroups, feedScopeNote, isFlagged, type ChangeFeedData, type FeedRow } from "@/lib/change-feed-view";
import { changesByService, insightsVerdict, topPeople, whereToStart } from "@/lib/insights-view";
import { getDriftData } from "@/lib/portal-data";
import { CAPABILITIES_HEADER, ENTITY_CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER, type EntityScope } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";

// Issue #981: an admin scoped to some entities reads Insights and Every change built from
// the approved-setup (drift) rows their entities own, filtered in the feed's SQL with the
// same entity filter as Open changes. Service reads, content backups and the audit log are
// tenant-wide and left out; objects and people outside the reader's entities are never
// named. Two entities (CREOS and ENOVOS) each own settings that changed; the fixture also
// holds a service read, a content backup and audit rows.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

// Every time is relative to the run, so the test never rots (lessons 2026-10-04, 2026-10-08).
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

const ADA = "a0a00000-0000-4000-8000-0000000000a1"; // a CREOS account
const BOB = "b0b00000-0000-4000-8000-0000000000b2"; // an ENOVOS account
const CREOS_POLICY = "ca000000-0000-4000-8000-0000000000c1";
const CREOS_GROUP = "11111111-1111-4111-8111-111111111111";
const ENOVOS_POLICY = "ca000000-0000-4000-8000-0000000000e1";
const ENOVOS_GROUP = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
// A CREOS-owned membership that adds someone to ENOVOS's role-assignable group.
const MEMBERSHIP_KEY = `edge:groupMembership:${ENOVOS_GROUP}:${MEMBER}`;
const SITE = "contoso.sharepoint.com,00000001-0000-4000-8000-000000000001,00000101-0000-4000-8000-000000000101";

// Names outside CREOS: none may reach a CREOS reader.
const NOT_CREOS = ["Retail sign-in policy", "Retail Billing Admins", "Bob Builder", "bob@example.invalid", "Finance site", "Sharing settings"];

const RESOURCES = [
  { type: "conditionalAccessPolicy", id: CREOS_POLICY, key: `conditionalAccessPolicy:${CREOS_POLICY}`, name: "Grid sign-in policy", owner: "Creos Luxembourg S.A." },
  { type: "group", id: CREOS_GROUP, key: "group:Grid Field Crew", name: "Grid Field Crew", owner: "Creos Luxembourg S.A." },
  { type: "groupMembership", id: `${ENOVOS_GROUP}:${MEMBER}`, key: MEMBERSHIP_KEY, name: null, owner: "Creos Luxembourg S.A." },
  { type: "conditionalAccessPolicy", id: ENOVOS_POLICY, key: `conditionalAccessPolicy:${ENOVOS_POLICY}`, name: "Retail sign-in policy", owner: "Enovos Luxembourg S.A." },
  { type: "group", id: ENOVOS_GROUP, key: "group:Retail Billing Admins", name: "Retail Billing Admins", owner: "Enovos Luxembourg S.A." },
  { type: "user", id: ADA, key: "user:ada@example.invalid", name: "Ada Admin", owner: "Creos Luxembourg S.A." },
  { type: "user", id: BOB, key: "user:bob@example.invalid", name: "Bob Builder", owner: "Enovos Luxembourg S.A." },
] as const;

const CREOS: EntityScope = { central: false, entities: ["CREOS"] };
const ENOVOS: EntityScope = { central: false, entities: ["ENOVOS"] };

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
let reader: string;

function headers(principalId: string, central: string[], entity: string[] = []): Headers {
  const result = new Headers();
  result.set(PRINCIPAL_ID_HEADER, principalId);
  result.set(CAPABILITIES_HEADER, central.join(" "));
  result.set(ENTITY_CAPABILITIES_HEADER, entity.join(" "));
  return result;
}

const permissions = (everyoneEdit: boolean) => ({
  groups: [{ id: 3, title: "Owners", members: [{ id: 7, title: "Owner", loginName: "i:0#.f|membership|owner@example.invalid", principalType: 1 }] }],
  siteCollectionAdmins: [],
  roleAssignments: [
    { principalId: 3, member: { id: 3, title: "Owners", principalType: 8 }, roles: [{ name: "Full Control" }] },
    ...(everyoneEdit ? [{ principalId: 5, member: { id: 5, title: "Everyone except external users", loginName: "c:0-.f|rolemanager|spo-grid-all-users/11111111-2222-4333-8444-555555555555", principalType: 4 }, roles: [{ name: "Edit" }] }] : []),
  ],
});

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
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-feed-scope-test-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "issue-981-feed-scope-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  const ref = tenantRef();

  const { rows: [row] } = await client.query("INSERT INTO principal(email) VALUES ('scoped-reader@example.invalid') RETURNING id");
  reader = String(row.id);
  await grantRole(client, { principalId: reader, role: "viewer", grantedBy: "fixture", activeFrom: "2020-01-01Z" });
  const { rows: [operator] } = await client.query("INSERT INTO principal(email) VALUES ('collector@example.invalid') RETURNING id");
  await grantRole(client, { principalId: String(operator.id), role: "operator", grantedBy: "fixture", activeFrom: "2020-01-01Z" });

  // Who owns what, from the CMDB, as task 89 resolves it.
  for (const resource of RESOURCES) {
    await recordLineage(client, { tenantRef: ref, resourceType: resource.type, sourceId: resource.id, naturalKey: resource.key, observedAt: hoursAgo(60) });
  }
  const adapter = createFixtureCmdbAdapter({
    tenantRef: ref,
    records: RESOURCES.map((resource, index) => ({ resourceType: resource.type, sourceId: resource.id, recordRef: `CI-${index}`, owners: [resource.owner] })) as never[],
  });
  const config = {
    entities: {
      CREOS: { cmdbValues: ["Creos Luxembourg S.A."], codePrefixes: ["CRE"] },
      ENOVOS: { cmdbValues: ["Enovos Luxembourg S.A."], codePrefixes: ["ENO"] },
    },
  };
  for (const resource of RESOURCES) {
    await resolveOwnership(client, { tenantRef: ref, managedTenantRef: ref, requestedBy: String(operator.id), resourceType: resource.type, sourceId: resource.id, adapter, config });
  }

  // Two backups: the one before and the one that found the changes.
  const snapshot = async (startedAt: Date) => String((await client.query(
    "INSERT INTO snapshot (tenant_ref, started_at, completed_at, status) VALUES ($1, $2, $2::timestamptz + interval '10 minutes', 'complete') RETURNING id",
    [ref, startedAt],
  )).rows[0].id);
  await snapshot(hoursAgo(50));
  const found = await snapshot(hoursAgo(10));
  for (const resource of RESOURCES) {
    if (resource.type === "groupMembership") continue;
    const payload = resource.type === "group" && resource.id === ENOVOS_GROUP
      ? { id: resource.id, displayName: resource.name, isAssignableToRole: true }
      : { id: resource.id, displayName: resource.name };
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, 'h', 'tier2', 'scoped', 'full', '{}')`,
      [found, resource.key, resource.type, payload],
    );
  }
  const { rows: [baseline] } = await client.query(
    "INSERT INTO baseline (tenant_ref, set_at, set_by, active) VALUES ($1, $2, 'fixture', true) RETURNING id", [ref, hoursAgo(100)],
  );
  const drift = (key: string, type: string, change: string, before: unknown, after: unknown) => client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, before_hash, after_hash, before_payload, after_payload, blast_radius, detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'h1', 'h2', $7, $8, 'scoped', $9)`,
    [ref, baseline.id, found, key, type, change, before, after, hoursAgo(9)],
  );
  const policy = (id: string, name: string, state: string) => ({ id, displayName: name, state });
  // CREOS: a policy turned off (flagged), a group changed, and a membership added to
  // ENOVOS's role-assignable group (flagged, and its flag names that group to central only).
  await drift(`conditionalAccessPolicy:${CREOS_POLICY}`, "conditionalAccessPolicy", "modified", policy(CREOS_POLICY, "Grid sign-in policy", "enabled"), policy(CREOS_POLICY, "Grid sign-in policy", "disabled"));
  await drift("group:Grid Field Crew", "group", "modified", { id: CREOS_GROUP, displayName: "Grid Field Crew" }, { id: CREOS_GROUP, displayName: "Grid Field Crew" });
  await drift(MEMBERSHIP_KEY, "groupMembership", "added", null, {});
  // ENOVOS: a policy turned off and a group changed.
  await drift(`conditionalAccessPolicy:${ENOVOS_POLICY}`, "conditionalAccessPolicy", "modified", policy(ENOVOS_POLICY, "Retail sign-in policy", "enabled"), policy(ENOVOS_POLICY, "Retail sign-in policy", "disabled"));
  await drift("group:Retail Billing Admins", "group", "modified", { id: ENOVOS_GROUP, displayName: "Retail Billing Admins" }, { id: ENOVOS_GROUP, displayName: "Retail Billing Admins" });

  // The audit log: Ada (CREOS) turned off the CREOS policy; Bob (ENOVOS) changed the CREOS
  // group and both ENOVOS settings. These are also audit rows of their own.
  const audit = (id: string, target: string, targetType: string, actor: string) => client.query(
    `INSERT INTO audit_change_fact (tenant_ref, source_event_id, occurred_at, target_type, target_id, operation, activity, actor_kind, actor_id)
     VALUES ($1, $2, $3, $4, $5, 'update', 'Update', 'user', $6)`,
    [ref, id, hoursAgo(20), targetType, target, actor],
  );
  await audit("entra:a1:0", CREOS_POLICY, "Policy", ADA);
  await audit("entra:a2:0", CREOS_GROUP, "Group", BOB);
  await audit("entra:a3:0", ENOVOS_POLICY, "Policy", BOB);
  await audit("entra:a4:0", ENOVOS_GROUP, "Group", BOB);

  // A service read: SharePoint sharing settings changed between two reads.
  const read = async (to: Date) => String((await client.query(
    "INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to) VALUES ($1, 'sharepoint-tenant-settings', 'complete', $2, $2) RETURNING id",
    [ref, to],
  )).rows[0].id);
  const previous = await read(hoursAgo(26));
  const current = await read(hoursAgo(2));
  await client.query("INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, 'tenant', '{}')", [previous]);
  await client.query("INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, 'tenant', '{}')", [current]);
  await client.query(
    "INSERT INTO workload_drift (tenant_ref, workload, collection_id, previous_collection_id, resource_key, change_type, fields, blast_radius) VALUES ($1, 'sharepoint-tenant-settings', $2, $3, 'tenant', 'modified', '[]', 'scoped')",
    [ref, current, previous],
  );

  // A content backup: a site opened to everyone between two backups.
  for (const [version, everyone, at] of [["v1", false, hoursAgo(30)], ["v2", true, hoursAgo(6)]] as const) {
    await client.query(
      `INSERT INTO content_item (tenant_ref, workload, container, item_key, version, metadata, sha256, bytes, chunks, key_id, created_at)
       VALUES ($1, 'sharepoint-sites', $2, 'site/permissions', $3, $4, $5, 10, '[]', 'k1', $6)`,
      [ref, `site:${SITE}`, version, { summary: permissionsSummary(permissions(everyone)), siteName: "Finance site" }, version === "v1" ? "1".repeat(64) : "2".repeat(64), at],
    );
  }
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

const names = (rows: FeedRow[]) => rows.map((row) => row.object.name).sort();

test("a central reader still gets every source, and every name", async () => {
  const feed = await getChangeFeed({ days: 7 });
  assert.equal(feed.scope, undefined);
  assert.deepEqual([...new Set(feed.rows.map((row) => row.source))].sort(), ["audit", "backup", "drift", "service"]);
  assert.equal(feed.rows.filter((row) => row.source === "drift").length, 5);
  const membership = feed.rows.find((row) => row.object.key === MEMBERSHIP_KEY)!;
  assert.match(membership.flags?.[0]?.sentence ?? "", /Retail Billing Admins/);
  const group = feed.rows.find((row) => row.source === "drift" && row.object.name === "Grid Field Crew")!;
  assert.equal(group.person?.name, "Bob Builder");
});

test("the page loader gives an entity reader only their entity's drift rows, and names nothing outside it", async () => {
  const feed = await getChangeFeed({ days: 7, scope: CREOS });
  assert.deepEqual(feed.scope, { central: false, entities: ["CREOS"] });
  assert.ok(feed.rows.every((row) => row.source === "drift"), "no service, content or audit rows");
  assert.deepEqual(names(feed.rows), [null, "Grid Field Crew", "Grid sign-in policy"].sort());
  assert.ok(feed.rows.some((row) => row.object.key === MEMBERSHIP_KEY));

  // Ada is a CREOS account, so she is named; Bob is not, so the change he made has no name.
  const policy = feed.rows.find((row) => row.object.name === "Grid sign-in policy")!;
  assert.equal(policy.person?.name, "Ada Admin");
  const group = feed.rows.find((row) => row.object.name === "Grid Field Crew")!;
  assert.equal(group.person, null);
  // The membership's flag does not name ENOVOS's group.
  const membership = feed.rows.find((row) => row.object.key === MEMBERSHIP_KEY)!;
  assert.equal(membership.flags?.[0]?.key, "role-group-member-added");
  assert.doesNotMatch(membership.flags?.[0]?.sentence ?? "", /Retail/);

  const text = JSON.stringify(feed);
  for (const name of NOT_CREOS) assert.ok(!text.includes(name), `${name} must not reach a CREOS reader`);

  // ENOVOS sees its own two, and nothing of CREOS.
  const other = await getChangeFeed({ days: 7, scope: ENOVOS });
  assert.deepEqual(names(other.rows), ["Retail Billing Admins", "Retail sign-in policy"]);
  for (const name of ["Grid sign-in policy", "Grid Field Crew", "Ada Admin"]) assert.ok(!JSON.stringify(other).includes(name), name);
});

test("the verdict, where to start, groups and people come from the reader's rows only", async () => {
  const feed: ChangeFeedData = await getChangeFeed({ days: 7, scope: CREOS });
  // Two flagged (the policy turned off, the role-group membership), three in all.
  assert.equal(feed.rows.filter(isFlagged).length, 2);
  assert.deepEqual(insightsVerdict(feed, "7"), { text: "3 changes in the last 7 days; 2 need a look.", tone: "urgent" });
  const start = whereToStart(feed.rows, "7", feed.generatedAt);
  assert.equal(start.flagged.length, 2);
  assert.ok(start.flagged.every((item) => !NOT_CREOS.some((name) => item.sentence.includes(name))));
  assert.equal(changesByService(feed.rows, "7").reduce((sum, bar) => sum + bar.count, 0), 3);
  assert.equal(feedGroups(feed.rows, "day").reduce((sum, group) => sum + group.count, 0), 3);
  assert.deepEqual(topPeople(feed.rows).map((person) => [person.name, person.count]), [["Ada Admin", 1]]);
  assert.equal(
    feedScopeNote(feed.scope),
    "You see changes to settings owned by CREOS only. A central administrator reviews tenant-wide changes (service settings, sites and the audit log).",
  );
});

test("the CSV export holds only the reader's rows", async () => {
  const feed = await getChangeFeed({ days: 7, scope: CREOS });
  const csv = feedCsv(feed.rows);
  assert.equal(csv.trim().split("\n").length, 1 + 3);
  assert.match(csv, /Grid sign-in policy/);
  for (const name of NOT_CREOS) assert.ok(!csv.includes(name), name);
});

test("the feed API admits an entity reader, sends only their rows and says what is left out", async () => {
  const response = await feedRoute(new Request("http://localhost/api/changes/feed?days=7&by=service", { headers: headers(reader, [], ["read:CREOS"]) }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 3);
  assert.ok(body.rows.every((row: FeedRow) => row.source === "drift"));
  assert.deepEqual(body.scope, { central: false, entities: ["CREOS"] });
  assert.match(body.scopeNote, /^You see changes to settings owned by CREOS only\./);
  assert.equal(body.groups.reduce((sum: number, group: { count: number }) => sum + group.count, 0), 3);
  const text = JSON.stringify(body);
  for (const name of NOT_CREOS) assert.ok(!text.includes(name), name);

  // A central reader's answer is unchanged: every source, no scope note.
  const central = await (await feedRoute(new Request("http://localhost/api/changes/feed?days=7", { headers: headers(reader, ["read"]) }))).json();
  assert.equal(central.scopeNote, null);
  assert.equal(central.scope, undefined);
  assert.ok(central.total > 3);

  // No read capability at all is still refused.
  const nobody = await feedRoute(new Request("http://localhost/api/changes/feed", { headers: headers(reader, []) }));
  assert.equal(nobody.status, 403);
});

test("Open changes and Every change count the same changes for the same entity reader", async () => {
  for (const scope of [CREOS, ENOVOS]) {
    const [open, feed] = await Promise.all([getDriftData(scope), getChangeFeed({ days: 30, scope })]);
    assert.equal(open.items.length, feed.rows.length, scope.entities.join());
    assert.deepEqual(
      open.items.map((item) => item.naturalKey).sort(),
      feed.rows.map((row) => row.object.key).sort(),
      scope.entities.join(),
    );
  }
});

test("a change opened by its id (#978) stays inside the reader's entities", async () => {
  const id = async (key: string) => `drift:${(await client.query("SELECT id FROM drift WHERE natural_key = $1", [key])).rows[0].id}`;
  const creos = await id(`conditionalAccessPolicy:${CREOS_POLICY}`);
  const enovos = await id(`conditionalAccessPolicy:${ENOVOS_POLICY}`);
  assert.deepEqual((await getChangeFeed({ changeId: creos, scope: CREOS })).rows.map((row) => row.id), [creos]);
  const other = await getChangeFeed({ changeId: enovos, scope: CREOS });
  assert.deepEqual(other.rows, []);
  assert.ok(!JSON.stringify(other).includes("Retail"));
  // Tenant-wide rows by id are not read for an entity reader either.
  const service = String((await client.query("SELECT id FROM workload_drift LIMIT 1")).rows[0].id);
  assert.deepEqual((await getChangeFeed({ changeId: `service:${service}`, scope: CREOS })).rows, []);
  assert.equal((await getChangeFeed({ changeId: `service:${service}` })).rows.length, 1);
});
