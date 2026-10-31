import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { grantRole } from "../../engine/authz/administration.mjs";
import { loadBreakGlassReadiness } from "../../engine/safety/breakGlassReadiness.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { POST as breakglassRoute } from "@/app/api/actions/breakglass/route";
import { BREAKGLASS_ROUTE, breakglassCall } from "@/lib/breakglass-calls";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";

// Emergency access: the one route the page uses to change emergency accounts. Fixture
// database and fixture users only; it writes KEEL records, never the tenant.

type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<void> };
let database: { url: string; connect: () => Promise<Client>; cleanup: () => Promise<void> };
let client: Client;
let admin: string;
let viewer: string;
const BG1 = "b9000000-0000-4000-8000-000000000001";

before(async () => {
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  client = await database.connect();
  await client.query(schemaSql());
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-breakglass-test-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "breakglass-portal-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");

  const person = async (email: string, roles: string[]) => {
    const { rows } = await client.query("INSERT INTO principal (email) VALUES ($1) RETURNING id", [email]);
    const id = String(rows[0].id);
    for (const role of roles) await grantRole(client, { principalId: id, role, grantedBy: id, activeFrom: new Date(Date.now() - 60_000) as never });
    return id;
  };
  admin = await person("admin@contoso.example", ["admin", "viewer"]);
  viewer = await person("viewer@contoso.example", ["viewer"]);

  // A complete backup of accounts with one emergency account in it.
  const { rows: [snapshot] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest) VALUES ($1,'complete',now() - interval '1 hour',now() - interval '1 hour',$2) RETURNING id",
    [tenantRef(), { user: 1 }],
  );
  await client.query(
    `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
     VALUES ($1,'user:bg1@contoso.onmicrosoft.com','user',$2,'fixture','tier1','access-affecting','full','{}')`,
    [snapshot.id, { id: BG1, userPrincipalName: "bg1@contoso.onmicrosoft.com", displayName: "Emergency admin 1", accountEnabled: true, userType: "Member", onPremisesSyncEnabled: null }],
  );
});

after(async () => {
  await client.end();
  await database.cleanup();
});

function post(body: unknown, principalId: string, capabilities: string[]): Request {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set(PRINCIPAL_ID_HEADER, principalId);
  headers.set(CAPABILITIES_HEADER, capabilities.join(" "));
  return new Request(`http://localhost${BREAKGLASS_ROUTE}`, { method: "POST", headers, body: JSON.stringify(body) });
}
const call = (body: unknown, capabilities = ["read", "configuration"], principalId = admin) => breakglassRoute(post(body, principalId, capabilities));
const message = async (response: Response) => ((await response.json()) as { message?: string }).message;

test("changing emergency accounts needs configuration, checked again against current grants", async () => {
  assert.equal((await call({ op: "register", signInName: "bg1@contoso.onmicrosoft.com" }, ["read", "dispose-accept"])).status, 403);
  // The header says configuration, but the person's grants in the database do not.
  assert.equal((await call({ op: "register", signInName: "bg1@contoso.onmicrosoft.com" }, ["read", "configuration"], viewer)).status, 403);
  assert.equal((await call({ op: "nope" })).status, 400);
  const { rows } = await client.query("SELECT count(*)::int AS n FROM breakglass_account");
  assert.equal(rows[0].n, 0, "nothing was written");
});

test("an account is added by its sign-in name, found in the latest backup of accounts", async () => {
  const missing = await call({ op: "register", signInName: "nobody@contoso.onmicrosoft.com" });
  assert.equal(missing.status, 404);
  assert.match(String(await message(missing)), /latest backup of accounts/);

  const added = await call({ op: "register", signInName: "BG1@contoso.onmicrosoft.com", validationIntervalDays: 30 });
  assert.equal(added.status, 200);
  assert.deepEqual(await added.json(), { account: { accountId: BG1 } });
  const report = await loadBreakGlassReadiness(client, { tenantRef: tenantRef() });
  assert.equal(report.accounts.length, 1);
  assert.equal(report.accounts[0].displayName, "Emergency admin 1");
  assert.equal(report.accounts[0].validationIntervalDays, 30);

  const outOfRange = await call({ op: "register", accountId: BG1, label: "bg1@contoso.onmicrosoft.com", validationIntervalDays: 400 });
  assert.equal(outOfRange.status, 409);
  assert.equal(await message(outOfRange), "Pick a number of days in the allowed range.");
  const edited = await call({ op: "register", accountId: BG1, label: "bg1@contoso.onmicrosoft.com", validationIntervalDays: 60, rotationIntervalDays: 180 });
  assert.equal(edited.status, 200);
  const { rows } = await client.query("SELECT validation_interval_days, rotation_interval_days FROM breakglass_account WHERE account_id = $1", [BG1]);
  assert.deepEqual([rows[0].validation_interval_days, rows[0].rotation_interval_days], [60, 180]);
});

test("a test sign-in, a credential change and sign-in methods are recorded as evidence", async () => {
  const future = await call({ op: "record", accountId: BG1, kind: "validated", occurredAt: new Date(Date.now() + 86_400_000).toISOString() });
  assert.equal(future.status, 409);
  assert.equal(await message(future), "The time must be in the past.");
  const badMethod = await call({ op: "record", accountId: BG1, kind: "methods-attested", methods: ["magic-link"] });
  assert.equal(badMethod.status, 409);

  const at = new Date(Date.now() - 3_600_000).toISOString();
  const tested = await call({ op: "record", accountId: BG1, kind: "validated", occurredAt: at, note: "quarterly test" });
  assert.equal(tested.status, 200);
  assert.deepEqual(await tested.json(), { event: { kind: "validated", occurredAt: at } });
  assert.equal((await call({ op: "record", accountId: BG1, kind: "credential-rotated", occurredAt: at })).status, 200);
  assert.equal((await call({ op: "record", accountId: BG1, kind: "methods-attested", methods: ["fido2", "password"] })).status, 200);

  const { rows } = await client.query("SELECT kind, actor FROM evidence WHERE tenant_ref = $1 AND kind LIKE 'breakglass.%' ORDER BY seq", [tenantRef()]);
  assert.deepEqual(rows.map((row) => row.kind), ["breakglass.registered", "breakglass.registered", "breakglass.validated", "breakglass.credential-rotated", "breakglass.methods-attested"]);
  assert.ok(rows.every((row) => row.actor === admin));
  const report = await loadBreakGlassReadiness(client, { tenantRef: tenantRef() });
  assert.equal(report.accounts[0].dimensions.lastValidation.status, "pass");
});

test("retiring asks for a reason, then keeps the history", async () => {
  const noReason = await call({ op: "retire", accountId: BG1, reason: " " });
  assert.equal(noReason.status, 409);
  assert.equal(await message(noReason), "Write why. It is kept with the record.");
  // UI audit 31 Oct 2026, C1: a placeholder reason is not kept.
  const weak = await call({ op: "retire", accountId: BG1, reason: "x" });
  assert.equal(weak.status, 400);
  assert.equal(((await weak.json()) as { error?: string }).error, "weak_reason");
  assert.equal((await call({ op: "retire", accountId: BG1, reason: "Replaced by a new emergency account" })).status, 200);
  const gone = await call({ op: "record", accountId: BG1, kind: "validated" });
  assert.equal(gone.status, 409);
  assert.match(String(await message(gone)), /not an emergency account any more/);
  assert.equal((await loadBreakGlassReadiness(client, { tenantRef: tenantRef() })).accounts.length, 0);
  const { rows } = await client.query("SELECT count(*)::int AS n FROM breakglass_lifecycle_event WHERE account_id = $1", [BG1]);
  assert.equal(rows[0].n, 3, "its history stays");
});

test("the page's call posts the op to the route and turns a refusal into words", async () => {
  const seen: { url: string; body: unknown }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ error: "refused", message: "The time must be in the past." }, { status: 409 });
  }) as typeof fetch;
  try {
    const result = await breakglassCall("record", { accountId: BG1, kind: "validated", occurredAt: "2026-10-03T09:00:00.000Z" });
    assert.deepEqual(seen, [{ url: "/api/actions/breakglass", body: { op: "record", accountId: BG1, kind: "validated", occurredAt: "2026-10-03T09:00:00.000Z" } }]);
    assert.deepEqual(result, { ok: false, status: 409, reason: "The time must be in the past." });
  } finally {
    globalThis.fetch = real;
  }
});
