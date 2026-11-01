import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import pg from "pg";

import { grantRole } from "../../engine/authz/administration.mjs";
import { createFixtureAuditAdapter, ingestAudit, migrateAuditIngestion } from "../../engine/identity/auditIngest.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { getDriftData } from "@/lib/portal-data";
import { tenantRef } from "@/lib/runtime-config";

// Backlog 41 (operator queue Q305): the Changes and Baselines reader ran 1,850 queries
// per page on live, because who made each change, who owns it and where its roll back
// goes were each read once per change. The reader now reads them for all changes at
// once, so the number of queries stays the same however many changes are open (39 in
// this fixture; before, 66 for 3 changes and 547 for 40).

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const HOUR = 60 * 60 * 1000;
/** The most queries one Changes read may run, whatever the number of open changes. */
const MAX_QUERIES = 45;

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
let ref: string;
let baselineId: string;
let baselineSnapshot: string;
let observedSnapshot: string;
let collector: string;
let made = 0;

const groupId = (index: number) => `5e170000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const ownerId = (index: number) => `0a0e0000-0000-4000-8000-${String(index).padStart(12, "0")}`;

/** Open changes on `count` more groups: each has a lineage, an owner (two entities, in
 * turn) and an owner id that the backups name. */
async function addChanges(count: number): Promise<void> {
  const start = made;
  made += count;
  for (let index = start; index < made; index += 1) {
    const key = `group:KEEL-RT-Count ${index}`;
    const { rows: [lineage] } = await client.query(
      "INSERT INTO resource_lineage (tenant_ref, resource_type, source_id) VALUES ($1, 'group', $2) RETURNING id", [ref, groupId(index)],
    );
    await client.query("INSERT INTO resource_lineage_alias (lineage_id, natural_key, valid_from) VALUES ($1, $2, now() - interval '30 days')", [lineage.id, key]);
    await client.query(
      `INSERT INTO resource_ownership_evidence (tenant_ref, lineage_id, state, entity_code, source, reason, observed_at, expires_at, recorded_by)
       VALUES ($1, $2, 'owned', $3, 'cmdb', 'fixture', now() - interval '1 day', now() + interval '30 days', 'test')`,
      [ref, lineage.id, index % 2 ? "CREOS" : "ENOVOS"],
    );
    const { rows: [version] } = await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, 'group', $3::jsonb, 'h-' || $2, 'normal', 'access-affecting', 'full', '{}'::jsonb) RETURNING id`,
      [baselineSnapshot, key, JSON.stringify({ id: groupId(index), description: "old" })],
    );
    await client.query("INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id) VALUES ($1, $2, $3)", [baselineId, key, version.id]);
    // The person the change points to, as the collection that saw the change saved them.
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, 'user', $3::jsonb, 'u-' || $2, 'normal', 'contained', 'full', '{}'::jsonb)`,
      [observedSnapshot, `user:KEEL-RT-Owner ${index}`, JSON.stringify({ id: ownerId(index), displayName: `KEEL-RT-Owner ${index}` })],
    );
    await client.query(
      `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, blast_radius, before_payload, after_payload)
       VALUES ($1, $2, $3, $4, 'group', 'modified', 'access-affecting', $5::jsonb, $6::jsonb)`,
      [ref, baselineId, observedSnapshot, key,
        JSON.stringify({ id: groupId(index), description: "old" }),
        JSON.stringify({ id: groupId(index), description: "new", owner: ownerId(index) })],
    );
  }
}

/** The audit log names every fixture group's change, and no account signed in nearby. */
async function ingestEvents(count: number): Promise<void> {
  const now = Date.now();
  const events = Array.from({ length: count }, (_, index) => ({
    id: `evt-${index}`, occurredAt: new Date(now - 2 * HOUR).toISOString(),
    change: { targetType: "group", targetId: groupId(index), operation: "Update", activity: "Update group", fields: ["description"], actorKind: "user", actorId: ownerId(index) },
  }));
  for (const [source, list] of [["audit", events], ["sign-in", []]] as const) {
    await ingestAudit(client, {
      tenantRef: ref, managedTenantRef: ref, requestedBy: collector, source, enabled: true,
      from: new Date(now - 4 * HOUR).toISOString(), until: new Date(now).toISOString(),
      adapter: createFixtureAuditAdapter({ tenantRef: ref, pages: [{ events: list, nextCursor: null }] as never[] }),
    });
  }
}

/** The queries one call to getDriftData runs, counted on the portal's own connections. */
async function countedRead() {
  const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = proto.query;
  let queries = 0;
  proto.query = function counted(this: unknown, ...args: unknown[]) {
    // A connection the pool opens anew runs "SET jit = off" first; that is not a read.
    const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? "";
    if (!/^\s*SET\b/i.test(text)) queries += 1;
    return original.apply(this, args);
  };
  try {
    const data = await getDriftData();
    return { data, queries };
  } finally {
    proto.query = original;
  }
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
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-query-count-test-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "backlog-41-query-count-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  ref = tenantRef();

  for (const [name, role, entityCode] of [["collector", "operator", null], ["central", "approver", null], ["creos", "approver", "CREOS"], ["enovos", "approver", "ENOVOS"]] as const) {
    const { rows: [row] } = await client.query("INSERT INTO principal(email) VALUES ($1) RETURNING id", [`${name}@example.invalid`]);
    if (name === "collector") collector = String(row.id);
    await grantRole(client, { principalId: String(row.id), role, grantedBy: "fixture", activeFrom: "2020-01-01Z", entityCode });
  }
  await migrateAuditIngestion(client);
  ({ rows: [{ id: baselineSnapshot }] } = (await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', now() - interval '3 hours', now() - interval '3 hours') RETURNING id", [ref],
  )) as { rows: { id: string }[] });
  ({ rows: [{ id: observedSnapshot }] } = (await client.query(
    "INSERT INTO snapshot (tenant_ref, status, completed_at) VALUES ($1, 'complete', now() - interval '5 minutes') RETURNING id", [ref],
  )) as { rows: { id: string }[] });
  ({ rows: [{ id: baselineId }] } = (await client.query(
    "INSERT INTO baseline (tenant_ref, set_by, active) VALUES ($1, 'fixture', true) RETURNING id", [ref],
  )) as { rows: { id: string }[] });
});

after(async () => {
  await client.end();
  await database.cleanup();
});

test("the Changes read runs the same few queries for 3 open changes as for 40", async () => {
  await ingestEvents(40);
  await addChanges(3);
  await getDriftData(); // opens the pooled connection, so its setup is not counted
  const few = await countedRead();
  assert.equal(few.data.items.length, 3);

  await addChanges(37);
  const many = await countedRead();
  assert.equal(many.data.items.length, 40);
  assert.equal(many.queries, few.queries, `${few.queries} queries for 3 changes, ${many.queries} for 40`);
  assert.ok(many.queries <= MAX_QUERIES, `${many.queries} queries, at most ${MAX_QUERIES} expected`);

  // The batched reads still answer for every change: who made it, from the audit record
  // naming it; where its roll back goes, from its owner; and the person it points to.
  for (const item of many.data.items) {
    const index = Number(item.naturalKey.split(" ").pop());
    assert.equal(item.attribution?.verdict, "exact", `${item.naturalKey} ${item.attribution?.reason}`);
    assert.deepEqual(item.attribution?.actors.map((actor) => actor.id), [ownerId(index)], item.naturalKey);
    assert.equal(item.attribution?.route?.route, "entity", item.naturalKey);
    assert.equal(item.attribution?.route?.entityCode, index % 2 ? "CREOS" : "ENOVOS", item.naturalKey);
    assert.equal(item.attribution?.route?.approverCount, 1, item.naturalKey);
    assert.equal(item.refNames?.[ownerId(index)], `KEEL-RT-Owner ${index}`, item.naturalKey);
  }
});
