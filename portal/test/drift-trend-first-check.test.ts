import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { driftTrendFor } from "@/lib/portal-data";

// UI audit E2: the Overview trend jumped from 0 to 981 on the day a new approved setup
// was approved, because its first check lists everything that already differed. The
// trend now counts each change once, on the day it was first found, and returns that
// first check apart. Dates are relative to the run (shared rule: time in tests).

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
interface IsolatedDatabase { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> }

let database: IsolatedDatabase;
let client: TestClient;
const REF = "drift-trend-test";
const DAY = 86_400_000;
const NOW = new Date(Math.floor(Date.now() / DAY) * DAY + 12 * 3_600_000);
const at = (daysAgo: number, minutes = 0) => new Date(NOW.getTime() - daysAgo * DAY + minutes * 60_000);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    for (const line of env.split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = (await createIsolatedTestDatabase(import.meta.url)) as IsolatedDatabase;
  client = await database.connect();
  await client.query(schemaSql());
});

after(async () => {
  await client.end();
  await database.cleanup();
});

async function baseline(setAt: Date): Promise<string> {
  const { rows: [row] } = await client.query(
    "INSERT INTO baseline (tenant_ref, set_by, active, set_at) VALUES ($1, 'test-operator', false, $2) RETURNING id", [REF, setAt],
  );
  return String(row.id);
}

async function snapshot(completedAt: Date): Promise<string> {
  const { rows: [row] } = await client.query("INSERT INTO snapshot (tenant_ref, status, completed_at) VALUES ($1, 'complete', $2) RETURNING id", [REF, completedAt]);
  return String(row.id);
}

async function drift(baselineId: string, observed: string, key: string, detectedAt: Date, afterHash = "a") {
  await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
                        before_hash, after_hash, before_payload, after_payload, blast_radius, detected_at)
     VALUES ($1, $2, $3, $4, 'group', 'modified', 'b', $6, '{}'::jsonb, '{}'::jsonb, 'access-affecting', $5)`,
    [REF, baselineId, observed, key, detectedAt, afterHash],
  );
}

test("the first check after a new approved setup is kept apart; later changes count once, on the day first found", async () => {
  const id = await baseline(at(2));
  // The first backup after the approval: 6 settings already differ. Rows are written
  // over more than 15 minutes, as a large first check is.
  const first = await snapshot(at(2, 15));
  for (let index = 0; index < 6; index += 1) await drift(id, first, `group:old-${index}`, at(2, 20 + index * 10));
  // A real change found a day later, and the same difference re-recorded today: counted once.
  const yesterday = await snapshot(at(1, -5));
  const today = await snapshot(at(0, -65));
  await drift(id, yesterday, "group:new-1", at(1));
  await drift(id, today, "group:new-1", at(0, -60));
  // A first-check setting re-recorded unchanged today: not new.
  await drift(id, today, "group:old-1", at(0, -60));
  // A first-check setting changed again today (a new value): a new change.
  await drift(id, today, "group:old-0", at(0, -60), "a2");
  // Another real change today.
  await drift(id, today, "group:new-2", at(0, -30));

  const trend = await driftTrendFor(client as never, REF, id, NOW);
  const point = (date: Date) => trend.find((entry) => entry.day === dayOf(date));
  assert.deepEqual(point(at(2)), { day: dayOf(at(2)), count: 0, firstCheck: 6 });
  assert.deepEqual(point(at(1)), { day: dayOf(at(1)), count: 1 });
  assert.deepEqual(point(at(0)), { day: dayOf(at(0)), count: 2 });
  assert.equal(trend.reduce((sum, entry) => sum + entry.count, 0), 3);
});

test("when the first backup after the approval finds nothing, a change soon after is an ordinary change", async () => {
  const id = await baseline(at(10));
  // The first comparison finds no difference, so it writes no drift row.
  await snapshot(at(10, 30));
  const later = await snapshot(at(9, -200));
  await drift(id, later, "group:late", at(9, -195));
  const trend = await driftTrendFor(client as never, REF, id, NOW);
  assert.deepEqual(trend.find((entry) => entry.day === dayOf(at(9, -195))), { day: dayOf(at(9, -195)), count: 1 });
  assert.equal(trend.some((entry) => entry.firstCheck), false);
});
