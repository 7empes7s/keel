import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { POST as completionRoute } from "@/app/api/actions/restore/completion/route";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

// UI audit 31 Oct 2026, C1: "Mark verified" kept "TEST-UX-001" and blank references as
// proof that a manual restore step was done. The route refuses them before any write.
// Fixture database only; nothing here reaches a tenant.

type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<void> };
let database: { url: string; connect: () => Promise<Client>; cleanup: () => Promise<void> };
let client: Client;
let actor: string;

before(async () => {
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  client = await database.connect();
  await client.query(schemaSql());
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-completion-test-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "completion-portal-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  const { rows } = await client.query("INSERT INTO principal (email) VALUES ('restorer@contoso.example') RETURNING id");
  actor = String(rows[0].id);
});

after(async () => {
  await client.end();
  await database.cleanup();
});

function post(body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json", "idempotency-key": crypto.randomUUID() });
  headers.set(PRINCIPAL_ID_HEADER, actor);
  headers.set(CAPABILITIES_HEADER, "read restore");
  return new Request("http://localhost/api/actions/restore/completion", { method: "POST", headers, body: JSON.stringify(body) });
}

test("a placeholder or blank evidence reference is refused before anything is written", async () => {
  const itemId = crypto.randomUUID();
  for (const [type, reference] of [["ticket", "TEST-UX-001"], ["ticket", ""], ["ticket", "   "], ["link", "done"], ["attestation", "yes"]]) {
    const response = await completionRoute(post({ itemId, action: "complete", evidence: { type, reference } }));
    assert.equal(response.status, 400, `${type} "${reference}"`);
    assert.equal(((await response.json()) as { error?: string }).error, "weak_evidence");
  }
  const reopen = await completionRoute(post({ itemId, action: "reopen", reason: "x" }));
  assert.equal(reopen.status, 400);
  assert.equal(((await reopen.json()) as { error?: string }).error, "weak_reason");
});

test("a pasted secret gets the engine's secret refusal, not a format hint", async () => {
  const response = await completionRoute(post({ itemId: crypto.randomUUID(), action: "complete", evidence: { type: "ticket", reference: "-----BEGIN PRIVATE KEY----- secret" } }));
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error?: string }).error, "invalid_evidence");
});

test("a real ticket number reaches the completion check", async () => {
  // The item does not exist, so the engine answers; the reference itself was accepted.
  const response = await completionRoute(post({ itemId: crypto.randomUUID(), action: "complete", evidence: { type: "ticket", reference: "CHG-5120" } }));
  assert.notEqual(((await response.json().catch(() => ({}))) as { error?: string }).error, "weak_evidence");
});
