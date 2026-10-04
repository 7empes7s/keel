import "./next-async-storage";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { GET as listRoute, POST as createRoute } from "@/app/api/change-intents/route";
import { POST as revokeRoute } from "@/app/api/change-intents/[id]/revoke/route";
import { intentStateSentence } from "@/components/change-intent";
import { changeIntentsVerdict, type ChangeIntent } from "@/lib/change-intents-view";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";

// Roadmap task-93: the approved emergency change routes. Approving, revoking and reading
// require a central approve grant; the engine re-checks the approver and refuses an
// owner approving their own change.

interface TestClient { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> }
let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
const APPROVER = randomUUID();
const OWNER = randomUUID();
let driftId = "";

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    for (const line of readFileSync("/etc/keel/db.env", "utf8").split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = await createIsolatedTestDatabase(import.meta.url) as typeof database;
  client = await database.connect();
  await client.query(readFileSync(new URL("../../engine/store/schema.sql", import.meta.url), "utf8"));
  const directory = mkdtempSync(join(tmpdir(), "keel-portal-change-intent-"));
  writeFileSync(join(directory, "tenant.json"), JSON.stringify({ tenantId: "task-93-change-intent-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(directory, "tenant.json");

  await client.query(
    `INSERT INTO principal (id, email, display_name) VALUES ($1, 'approver@example.com', 'Amara Okafor'), ($2, 'oncall@example.com', 'On-call engineer')`,
    [APPROVER, OWNER],
  );
  await client.query("INSERT INTO role_grant (principal_id, role, granted_by) VALUES ($1, 'approver', 'test'), ($2, 'operator', 'test')", [APPROVER, OWNER]);
  const { rows: [snapshot] } = await client.query("INSERT INTO snapshot (tenant_ref, status, completed_at) VALUES ($1, 'complete', now()) RETURNING id", [tenantRef()]);
  const { rows: [baseline] } = await client.query("INSERT INTO baseline (tenant_ref, set_by) VALUES ($1, 'test') RETURNING id", [tenantRef()]);
  const { rows: [drift] } = await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, before_payload, after_payload, blast_radius)
     VALUES ($1, $2, $3, 'group:Finance', 'group', 'modified', $4, $5, 'cosmetic') RETURNING id`,
    [tenantRef(), baseline.id, snapshot.id, { displayName: "Finance", visibility: "Private" }, { displayName: "Finance", visibility: "Public" }],
  );
  driftId = String(drift.id);
});

after(async () => {
  await client.end();
  await database.cleanup();
});

function request(path: string, method: string, principalId: string | null, capabilities: string[], body?: unknown): Request {
  const headers = new Headers();
  if (principalId) headers.set(PRINCIPAL_ID_HEADER, principalId);
  headers.set(CAPABILITIES_HEADER, capabilities.join(" "));
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test("only a central approver can read, approve or revoke emergency changes", async () => {
  for (const capabilities of [["read"], ["policies", "remediate", "dispose-accept"], []]) {
    assert.equal((await listRoute(request("/api/change-intents", "GET", OWNER, capabilities))).status, 403, `${capabilities}: list`);
    assert.equal((await createRoute(request("/api/change-intents", "POST", OWNER, capabilities, { driftId, fields: ["visibility"], ownerPrincipalId: APPROVER, windowHours: 4, reason: "x" }))).status, 403, `${capabilities}: approve`);
    assert.equal((await revokeRoute(request(`/api/change-intents/${randomUUID()}/revoke`, "POST", OWNER, capabilities, { reason: "x" }))).status, 403, `${capabilities}: revoke`);
  }
  assert.equal((await listRoute(request("/api/change-intents", "GET", null, ["approve"]))).status, 403, "no principal, no read");
  // The header claims approve, but the engine re-checks the person's current grant.
  const claimed = await createRoute(request("/api/change-intents", "POST", OWNER, ["approve"], { driftId, fields: ["visibility"], ownerPrincipalId: APPROVER, windowHours: 4, reason: "self" }));
  assert.equal(claimed.status, 403);
  assert.equal((await claimed.json()).error, "approver-not-authorized");
});

test("an approver approves a change field by field, sees it in force, and revokes it", async () => {
  const approve = (body: Record<string, unknown>) => createRoute(request("/api/change-intents", "POST", APPROVER, ["approve"], body));
  const self = await approve({ driftId, fields: ["visibility"], ownerPrincipalId: APPROVER, windowHours: 4, reason: "self-approval" });
  assert.equal(self.status, 409);
  assert.equal((await self.json()).error, "owner-is-approver");
  assert.equal((await approve({ driftId, fields: ["visibility"], ownerPrincipalId: OWNER, windowHours: 5, reason: "not an offered window" })).status, 400);
  assert.equal((await approve({ driftId, fields: ["displayName"], ownerPrincipalId: OWNER, windowHours: 4, reason: "unchanged field" })).status, 409);

  const created = await approve({ driftId, fields: ["visibility"], ownerPrincipalId: OWNER, windowHours: 4, externalChangeId: "CHG0031337", reason: "INC-4410" });
  assert.equal(created.status, 201);
  const { intent } = await created.json() as { intent: ChangeIntent };
  assert.equal(intent.owner.name, "On-call engineer");
  assert.equal(intent.approver.name, "Amara Okafor");
  assert.equal(new Date(intent.windowEnd).valueOf() - new Date(intent.windowStart).valueOf(), 4 * 3_600_000);

  const listed = await listRoute(request("/api/change-intents", "GET", APPROVER, ["approve"]));
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), "no-store");
  const data = await listed.json() as { intents: ChangeIntent[]; changes: { driftId: string; transitions: { field: string }[] }[]; people: { name: string }[]; generatedAt: string };
  assert.deepEqual(data.intents.map((entry) => [entry.id, entry.state]), [[intent.id, "active"]]);
  assert.deepEqual(data.changes.map((change) => [change.driftId, change.transitions.map((transition) => transition.field)]), [[driftId, ["visibility"]]]);
  assert.deepEqual(data.people.map((person) => person.name), ["Amara Okafor", "On-call engineer"]);
  const verdict = changeIntentsVerdict(data.intents, data.generatedAt);
  assert.equal(verdict.tone, "attention");
  assert.equal(verdict.text, "One emergency change is approved right now; KEEL will not roll it back. The next approval ends in 4 hours.");
  assert.match(intentStateSentence(data.intents[0], data.generatedAt), /^KEEL will not roll back the visibility change until .+ \(in 4 hours\)\.$/);

  assert.equal((await revokeRoute(request(`/api/change-intents/${intent.id}/revoke`, "POST", APPROVER, ["approve"], {}))).status, 400, "a reason is required");
  const revoked = await revokeRoute(request(`/api/change-intents/${intent.id}/revoke`, "POST", APPROVER, ["approve"], { reason: "emergency over" }));
  assert.equal(revoked.status, 200);
  const body = await revoked.json() as { intent: ChangeIntent; settlement: { currentState: string } };
  assert.equal(body.intent.revokeReason, "emergency over");
  assert.equal(body.settlement.currentState, "unknown", "no baseline resources to compare with: nothing is rolled back");
  assert.equal((await revokeRoute(request(`/api/change-intents/${intent.id}/revoke`, "POST", APPROVER, ["approve"], { reason: "again" }))).status, 409);
  assert.equal((await revokeRoute(request(`/api/change-intents/${randomUUID()}/revoke`, "POST", APPROVER, ["approve"], { reason: "missing" }))).status, 404);
  const after = await (await listRoute(request("/api/change-intents", "GET", APPROVER, ["approve"]))).json() as { intents: ChangeIntent[]; generatedAt: string };
  assert.equal(after.intents[0].state, "revoked");
  assert.equal(changeIntentsVerdict(after.intents, after.generatedAt).text, "No emergency change is approved right now. KEEL rolls changes back as its policies say.");
  assert.match(intentStateSentence(after.intents[0], after.generatedAt), /^Revoked just now by Amara Okafor: emergency over\.$/);
});

test("the emergency change surfaces are closed around the approve guard", () => {
  const app = fileURLToPath(new URL("../app/", import.meta.url));
  const page = readFileSync(join(app, "emergency-changes", "page.tsx"), "utf8");
  assert.ok(page.indexOf("await requireChangeIntentAccess()") < page.indexOf("await connection()"), "the page guards before it connects");
  const routes = readFileSync(join(app, "api", "change-intents", "route.ts"), "utf8");
  assert.match(routes, /export const GET = guardedChangeIntentList\(\)/);
  assert.match(routes, /export const POST = guardedChangeIntentCreate\(\)/);
  assert.match(readFileSync(join(app, "api", "change-intents", "[id]", "revoke", "route.ts"), "utf8"), /export const POST = guardedChangeIntentRevoke\(\)/);
  const lib = readFileSync(new URL("../lib/change-intents.ts", import.meta.url), "utf8");
  for (const action of ["change-intents:list", "change-intents:approve", "change-intents:revoke"]) {
    assert.match(lib, new RegExp(`action: "${action}", capability: "approve"`));
  }
});
