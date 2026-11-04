import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { savedNames } from "@/lib/saved-names";

// The Alerts page names ~1,200 settings at once with savedNames. It used to read every
// saved version of each one: 9.2 s on live (operator queue Q307). It now reads each
// setting's newest backup first, and older ones only for a missing name.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const TENANT = "saved-names-speed";
const BACKUPS = 60;
let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;

// Backups are dated relative to the run, so the test never rots.
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

async function backup(tenant: string, at: string, resources: [string, string, Record<string, unknown>][]) {
  const { rows: [snapshot] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', $2, $2) RETURNING id",
    [tenant, at],
  );
  for (const [key, type, payload] of resources) {
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, 'h', 'critical', 'access-affecting', 'full', '{}')`,
      [snapshot.id, key, type, JSON.stringify(payload)],
    );
  }
}

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    for (const line of env.split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  client = await database.connect();
  await client.query(schemaSql());
  for (let i = BACKUPS; i >= 1; i -= 1) {
    const rows: [string, string, Record<string, unknown>][] = [
      ["group:Kept", "group", { displayName: i === 1 ? "Kept team" : "Kept team (old name)" }],
      // Named only in its oldest backups: the name comes from the newest one that has it.
      ["deviceManagementScript:lost", "deviceManagementScript", i > 50 ? { displayName: "Set time zone" } : { id: "lost" }],
    ];
    // Gone from the last 20 backups: still named from the newest backup that held it.
    if (i > 20) rows.push(["group:Gone", "group", { displayName: "Gone team" }]);
    // Saved only in every tenth backup (another backup tier).
    if (i % 10 === 0) rows.push(["user:Ada", "user", { displayName: i === 10 ? "Ada Lovelace" : "Ada" }]);
    await backup(TENANT, hoursAgo(i), rows);
  }
  // Another tenant's newer backup never names this tenant's settings.
  await backup("someone-else", hoursAgo(0), [["group:Kept", "group", { displayName: "Other tenant" }]]);
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("a setting kept in many backups is named from its newest backup, not by reading every version", async () => {
  const keys = ["group:Kept", "group:Gone", "user:Ada", "deviceManagementScript:lost", "group:Never"];
  // On live the tables are large, so the planner reads indexes; here they are small, so
  // seq scans are switched off to read the same plan. The read counters count the saved
  // versions read (rows read by a scan, rows fetched through each index), flushed before
  // each reading (engine/insights/names.test.mjs, lesson 2026-11-01).
  const versionsRead = async () => {
    await client.query("SELECT pg_stat_force_next_flush()");
    await client.query("SELECT pg_stat_clear_snapshot()");
    const { rows: [counts] } = await client.query(
      `SELECT pg_stat_get_tuples_fetched('resource_version'::regclass) + pg_stat_get_tuples_returned('resource_version'::regclass)
              + (SELECT coalesce(sum(pg_stat_get_tuples_fetched(indexrelid)), 0) FROM pg_index WHERE indrelid = 'resource_version'::regclass) AS n`);
    return Number(counts.n);
  };
  await client.query("ANALYZE resource_version, snapshot");
  await client.query("SET enable_seqscan = off");
  await client.query("SET stats_fetch_consistency = none");
  let names: Awaited<ReturnType<typeof savedNames>>;
  let read: number;
  try {
    const start = await versionsRead();
    names = await savedNames(client, TENANT, keys);
    read = await versionsRead() - start;
  } finally {
    await client.query("RESET enable_seqscan");
    await client.query("RESET stats_fetch_consistency");
  }
  // The old read sorted every version of every key: 200 here. Only the script, which lost
  // its name 50 backups ago, walks back through its older versions.
  assert.ok(read <= 80, `read ${read} saved versions for ${keys.length} keys kept in ${BACKUPS} backups`);

  assert.equal(names["group:Kept"].name, "Kept team");
  assert.equal(names["group:Gone"].name, "Gone team");
  assert.equal(names["user:Ada"].name, "Ada Lovelace");
  assert.equal(names["user:Ada"].resourceType, "user");
  assert.equal(names["deviceManagementScript:lost"].name, "Set time zone");
  assert.equal(names["group:Never"], undefined);
});

test("each tenant is named from its own backups only", async () => {
  const names = await savedNames(client, "someone-else", ["group:Kept", "group:Gone"]);
  assert.equal(names["group:Kept"].name, "Other tenant");
  assert.equal(names["group:Gone"], undefined, "another tenant's backups never name this one's settings");
});
