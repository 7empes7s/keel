import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { getBaselinesData, getComplianceData } from "@/lib/portal-data";

// Operator queue Q308: a loader that sends two queries at once on one connection makes
// pg warn "Calling client.query() when the client is already executing a query" (and
// pg 9 will refuse). pg runs them one at a time anyway, so each loader now reads one
// after another. This counts the most queries running at once on any one connection.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;

const running = new WeakMap<object, number>();
let mostAtOnce = 0;
const originalQuery = pg.Client.prototype.query;

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
  const dir = mkdtempSync(join(tmpdir(), "keel-loader-one-connection-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "loader-one-connection-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");

  pg.Client.prototype.query = function countedQuery(this: pg.Client, ...args: unknown[]) {
    const now = (running.get(this) ?? 0) + 1;
    running.set(this, now);
    mostAtOnce = Math.max(mostAtOnce, now);
    const answer = (originalQuery as (...rest: unknown[]) => unknown).apply(this, args);
    const done = () => { running.set(this, (running.get(this) ?? 1) - 1); };
    if (answer && typeof (answer as Promise<unknown>).then === "function") (answer as Promise<unknown>).then(done, done);
    else done();
    return answer;
  } as typeof pg.Client.prototype.query;
});

after(async () => {
  pg.Client.prototype.query = originalQuery;
  await client?.end();
  await database?.cleanup();
});

test("the Compliance loader reads one query at a time on its connection", async () => {
  mostAtOnce = 0;
  const data = await getComplianceData();
  assert.deepEqual(data.findings, []);
  assert.equal(mostAtOnce, 1, "queries overlapped on one connection");
});

test("the Approved setups loader reads one query at a time on its connection", async () => {
  mostAtOnce = 0;
  const data = await getBaselinesData();
  assert.deepEqual(data.baselines, []);
  assert.equal(mostAtOnce, 1, "queries overlapped on one connection");
});
