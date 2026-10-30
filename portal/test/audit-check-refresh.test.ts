import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { appendEvidence } from "../../engine/govern/evidence.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { register } from "../instrumentation";
import { evidenceChainCache } from "@/lib/evidence-chain-cache";
import { refreshEvidenceChainOnce, stopEvidenceChainRefresh } from "@/lib/evidence-chain-refresh";
import { getDashboardData } from "@/lib/portal-data";
import { tenantRef } from "@/lib/runtime-config";

// The audit record's full check runs on a background timer started with the server, so
// page loads (the Overview, and the menu's poll of it) only check the stored records are
// unchanged and hash the new ones. No page load waits on a full walk.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

interface CacheEntry {
  tip: { count: string };
  fullAt: number;
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
  const dir = mkdtempSync(join(tmpdir(), "keel-audit-refresh-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "audit-check-refresh-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  ref = tenantRef();
});

after(async () => {
  stopEvidenceChainRefresh();
  await client?.end();
  await database?.cleanup();
});

async function append(step: number) {
  await appendEvidence(client, { tenantRef: ref, kind: "test.step", subject: { step }, actor: "refresh-test", eventSink: () => true });
}

test("the background check verifies the record, so the Overview never does the full walk", async () => {
  for (const step of [1, 2, 3]) await append(step);
  evidenceChainCache.clear();
  await refreshEvidenceChainOnce();
  const warmed = evidenceChainCache.get(ref) as CacheEntry;
  assert.equal(warmed.tip.count, "3", "the timer verified every record");

  await append(4);
  const overview = await getDashboardData();
  assert.deepEqual(overview.evidence, { ok: true, chainLength: 4 });
  const after = evidenceChainCache.get(ref) as CacheEntry;
  assert.equal(after.tip.count, "4", "the page load hashed only the new record");
  assert.equal(after.fullAt, warmed.fullAt, "and did not walk the whole record again");
});

test("the server start begins the background check once", async () => {
  evidenceChainCache.clear();
  const previous = process.env.NEXT_RUNTIME;
  process.env.NEXT_RUNTIME = "nodejs";
  try {
    await register();
    const state = (globalThis as { __keelEvidenceChainRefresh?: object }).__keelEvidenceChainRefresh;
    assert.ok(state, "the timer is running");
    await register();
    assert.equal((globalThis as { __keelEvidenceChainRefresh?: object }).__keelEvidenceChainRefresh, state, "a second start is ignored");
    for (let waited = 0; !evidenceChainCache.has(ref) && waited < 5_000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((evidenceChainCache.get(ref) as CacheEntry | undefined)?.tip.count, "4", "the first check runs at start, before any page load");
  } finally {
    stopEvidenceChainRefresh();
    if (previous === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = previous;
  }
});
