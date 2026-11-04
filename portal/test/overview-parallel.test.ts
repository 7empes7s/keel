import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { appendEvidence } from "../../engine/govern/evidence.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { getDashboardData, getMenuStatusData } from "@/lib/portal-data";
import { tenantRef } from "@/lib/runtime-config";

// Old PR #711: the Overview ran about twenty reads one after another on one connection,
// so a load cost the sum of all of them. It now runs them in four groups at the same
// time, each on its own pooled connection, so one slow read no longer holds up the rest.
// The menu's background poll reads the same groups on a single connection.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
let ref: string;

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
  const dir = mkdtempSync(join(tmpdir(), "keel-overview-parallel-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "overview-parallel-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  ref = tenantRef();
  for (const step of [1, 2]) {
    await appendEvidence(client, { tenantRef: ref, kind: "test.step", subject: { step }, actor: "overview-test", eventSink: () => true });
  }
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

function portalPool(): pg.Pool {
  const pools = (globalThis as { __keelPortalPools?: Map<string, pg.Pool> }).__keelPortalPools;
  const pool = pools?.get(database.url);
  assert.ok(pool, "the Overview reads through the portal's shared pool");
  return pool;
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Holds the audit record's head row, so only the audit record check waits. */
async function holdAuditRecord(): Promise<() => Promise<void>> {
  const blocker = await database.connect();
  await blocker.query("BEGIN");
  await blocker.query("LOCK TABLE evidence_head IN ACCESS EXCLUSIVE MODE");
  return async () => {
    await blocker.query("COMMIT");
    await blocker.end();
  };
}

test("the Overview's other reads finish while one read is held up", async () => {
  const unheld = await getDashboardData();
  const pool = portalPool();
  await until(() => pool.idleCount === pool.totalCount, "the first load to return its connections");

  const release = await holdAuditRecord();
  let settled = false;
  const load = getDashboardData().finally(() => { settled = true; });
  try {
    // Read one after another, nothing else could finish while the audit check waits.
    // At the same time, the other groups finish and hand their connections back.
    await until(() => pool.totalCount >= 4 && pool.totalCount - pool.idleCount === 1, "the other reads to finish");
    assert.equal(settled, false, "the Overview still waits for the held-up read");
  } finally {
    await release();
  }
  const data = await load;
  assert.equal(data.evidence.ok, true, "the held-up read still lands in the Overview");
  assert.equal(data.evidence.chainLength, 2);
  // Same figures as a load nothing held up.
  const { generatedAt: _a, ...held } = data;
  const { generatedAt: _b, ...free } = unheld;
  assert.deepEqual(held, free);
});

test("the menu's figures are read on one connection, and match the Overview", async () => {
  const pool = portalPool();
  await until(() => pool.idleCount === pool.totalCount, "earlier loads to return their connections");
  const release = await holdAuditRecord();
  let settled = false;
  const read = getMenuStatusData().finally(() => { settled = true; });
  try {
    await until(() => pool.totalCount - pool.idleCount === 1, "the menu read to start");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(pool.totalCount - pool.idleCount, 1, "the menu's poll holds a single connection");
    assert.equal(settled, false);
  } finally {
    await release();
  }
  const menu = await read;
  const overview = await getDashboardData();
  for (const key of ["headline", "coverage", "openDriftByBlastRadius", "openDriftTotal", "evidence", "waiting", "alerts"] as const) {
    assert.deepEqual(menu[key], overview[key], `${key} matches the Overview`);
  }
});

test("a failed read fails the Overview and every connection goes back to the pool", async () => {
  const pool = portalPool();
  await client.query("ALTER TABLE evidence_head RENAME TO evidence_head_moved");
  try {
    await assert.rejects(getDashboardData());
  } finally {
    await client.query("ALTER TABLE evidence_head_moved RENAME TO evidence_head");
  }
  await until(() => pool.idleCount === pool.totalCount, "every connection to come back");
  const data = await getDashboardData();
  assert.equal(data.evidence.ok, true, "the next load works");
});

test("the menu and the Overview both read the request-cached approvals count, never their own", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  for (const file of ["../app/layout.tsx", "../app/page.tsx"]) {
    const source = read(file);
    assert.match(source, /pendingApprovalCount[,)(]/, `${file} uses the shared count`);
    assert.doesNotMatch(source, /getPendingApprovalCount/, `${file} does not count on its own`);
  }
  assert.match(read("../lib/pending-approvals.ts"), /cache\(/, "the count is kept for the request");
});
