import "./next-async-storage";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { GET as alertsRoute } from "@/app/api/alerts/route";
import type { AlertInboxData } from "@/lib/alerts-view";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";

// Re-test 2026-10-31: alerts acknowledged before the acknowledger became the owner still
// showed "No owner". The schema backfills them, and the inbox reads the acknowledger as
// the owner of any acknowledged alert that still has none.

interface TestClient { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> }
let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
let directory = "";
const ADA = randomUUID();
const RULE_OWNER = randomUUID();

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    for (const line of readFileSync("/etc/keel/db.env", "utf8").split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = await createIsolatedTestDatabase(import.meta.url) as typeof database;
  client = await database.connect();
  await client.query(schemaSql());
  directory = mkdtempSync(join(tmpdir(), "keel-alert-owner-backfill-"));
  writeFileSync(join(directory, "tenant.json"), JSON.stringify({ tenantId: "alert-owner-backfill-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(directory, "tenant.json");
  await client.query("INSERT INTO principal (id, email, display_name) VALUES ($1, 'ada@fixture.test', 'Ada Admin'), ($2, 'rule@fixture.test', 'Rule Owner')", [ADA, RULE_OWNER]);
  await client.query("INSERT INTO role_grant (principal_id, role, granted_by) VALUES ($1, 'viewer', 'test')", [ADA]);
});

after(async () => {
  await client.end();
  await database.cleanup();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function insertAlert(key: string, state: string, owner: string | null, acknowledgedBy: string | null): Promise<string> {
  const { rows: [row] } = await client.query(
    `INSERT INTO alert (tenant_ref, resource_key, control, condition, state, condition_active, severity, first_opened_at, occurrence_started_at,
                        last_firing_at, last_observed_at, last_event_id, owner_principal_id, acknowledged_by, acknowledged_at)
     VALUES ($1, $2, 'baseline', 'drift', $3, true, 'warning', now(), now(), now(), now(), $2, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [tenantRef(), key, state, owner, acknowledgedBy],
  );
  return String(row.id);
}

const inbox = async () => (await (await alertsRoute(new Request("http://localhost/api/alerts", {
  headers: { [PRINCIPAL_ID_HEADER]: ADA, [CAPABILITIES_HEADER]: "read" },
}))).json() as AlertInboxData).alerts;

test("an alert acknowledged before the deploy shows its acknowledger as owner, before and after the backfill", async () => {
  const old = await insertAlert("group:KEEL-RT-Old", "acknowledged", null, ADA);
  const ruled = await insertAlert("group:KEEL-RT-Ruled", "acknowledged", RULE_OWNER, ADA);
  const open = await insertAlert("group:KEEL-RT-Open", "open", null, null);
  const byTool = await insertAlert("group:KEEL-RT-Tool", "acknowledged", null, "cli:operator");

  // The read path, before the schema runs again.
  let alerts = await inbox();
  const owner = (id: string) => alerts.find((alert) => alert.id === id)?.owner?.name ?? null;
  assert.equal(owner(old), "Ada Admin");
  assert.equal(owner(ruled), "Rule Owner", "a stored owner is kept");
  assert.equal(owner(open), null);
  assert.equal(owner(byTool), null, "an acknowledger that is not a person owns nothing");

  // Re-applying the schema backfills the stored owner, and only where it is missing.
  await client.query(schemaSql());
  const stored = async (id: string) => (await client.query("SELECT owner_principal_id::text AS owner, owner_source FROM alert WHERE id = $1", [id])).rows[0];
  assert.deepEqual(await stored(old), { owner: ADA, owner_source: "acknowledged" });
  assert.deepEqual(await stored(ruled), { owner: RULE_OWNER, owner_source: "unassigned" });
  assert.deepEqual(await stored(open), { owner: null, owner_source: "unassigned" });
  assert.deepEqual(await stored(byTool), { owner: null, owner_source: "unassigned" });
  alerts = await inbox();
  assert.equal(owner(old), "Ada Admin");
});
