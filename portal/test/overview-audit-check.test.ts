import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { appendEvidence } from "../../engine/govern/evidence.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { evidenceChainCache } from "@/lib/evidence-chain-cache";
import { getDashboardData } from "@/lib/portal-data";
import { tenantRef } from "@/lib/runtime-config";

// The Overview checks the audit record on every load (and the menu asks for the Overview
// every minute). It must hash only the records added since the last check, yet still
// catch a changed old record.

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
  const dir = mkdtempSync(join(tmpdir(), "keel-overview-audit-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "overview-audit-check-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  ref = tenantRef();
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

async function append(step: number) {
  await appendEvidence(client, { tenantRef: ref, kind: "test.step", subject: { step }, actor: "overview-test", eventSink: () => true });
}

test("the Overview's audit check reuses the verified records and still catches a change", async () => {
  for (const step of [1, 2, 3]) await append(step);
  const first = await getDashboardData();
  // No off-site copy in the test: the own chain is intact, so the record is "not checked".
  assert.deepEqual(first.evidence, { ok: true, chainLength: 3, check: "unchecked" });
  assert.equal(evidenceChainCache.has(ref), true, "the verified records are remembered");

  await append(4);
  const second = await getDashboardData();
  assert.deepEqual(second.evidence, { ok: true, chainLength: 4, check: "unchecked" });

  await client.query(
    `UPDATE evidence SET subject = '{"step": 99}'::jsonb WHERE seq = (SELECT min(seq) FROM evidence WHERE tenant_ref = $1)`,
    [ref],
  );
  const changed = await getDashboardData();
  assert.equal(changed.evidence.ok, false, "a changed old record fails the check");
  assert.equal(changed.evidence.check, "failed", "a missing off-site copy never hides a broken chain");
  assert.deepEqual(changed.alerts.filter((alert) => alert.key === "audit").map((alert) => [alert.severity, alert.title]),
    [["critical", "The audit record failed the check"]], "and raises the Urgent audit alert");
  assert.equal(evidenceChainCache.has(ref), false, "a broken result is never remembered");
});
