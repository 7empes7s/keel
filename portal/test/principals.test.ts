import "./next-async-storage";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ReactElement } from "react";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { capabilitiesForPrincipal } from "../../engine/authz/principals.mjs";
import { grantRole } from "../../engine/authz/administration.mjs";
import { guardedPrincipalCreate, guardedPrincipalList, guardedPrincipalWrite, type PrincipalView } from "@/lib/principals";
import { resolveIdentity, CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { DATA_SURFACES, guardedRead } from "@/lib/read";
import { renderInPeopleRoute, renderPeopleAt } from "./render-people";
import { schemaSql } from "../../engine/store/loadSchema.mjs";


const id = "00000000-0000-0000-0000-000000000001";
function request(op: string, actor: string, capabilities: string[], body?: object) {
  return new Request(`http://localhost/api/principals/${id}/${op}`, {
    method: body ? "POST" : "GET",
    headers: { [PRINCIPAL_ID_HEADER]: actor, [CAPABILITIES_HEADER]: capabilities.join(" ") },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("principal list and all writes refuse principals without users/roles", async () => {
  let writes = 0;
  const deps = { databaseUrl: () => "unused", tenantRef: () => "test", connect: async () => ({
    query: async (sql: string) => { if (/role_grant|UPDATE principal/.test(sql)) writes++; return { rows: [] }; }, end: async () => {},
  }) };
  for (const capabilities of [[], ["read", "collect"], ["admin"]]) {
    const response = await guardedRead(DATA_SURFACES.principalsApi, guardedPrincipalList(deps))(request("", id, capabilities));
    assert.equal(response.status, 403);
    for (const [op, surface] of [["grant", DATA_SURFACES.principalGrantApi], ["revoke", DATA_SURFACES.principalRevokeApi], ["disable", DATA_SURFACES.principalDisableApi], ["enable", DATA_SURFACES.principalEnableApi]] as const) {
      assert.equal((await guardedPrincipalWrite(op, surface, deps)(request(op, id, capabilities, {}))).status, 403);
    }
  }
  // Adding a person needs both users and roles: either alone is refused before any write.
  for (const capabilities of [["users"], ["roles"], ["read"]]) {
    const add = new Request("http://localhost/api/principals", { method: "POST", headers: { [PRINCIPAL_ID_HEADER]: id, [CAPABILITIES_HEADER]: capabilities.join(" ") }, body: JSON.stringify({ email: "new@test.example", role: "viewer" }) });
    assert.equal((await guardedPrincipalCreate(deps)(add)).status, 403);
  }
  assert.equal(writes, 0);
});

test("live portal requests see role writes immediately and display the engine capability answer", async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  const previous = process.env.KEEL_DB_URL;
  try {
    await client.query(schemaSql());
    await client.query("INSERT INTO principal(id,email) VALUES ($1,'portal@test')", [id]);
    process.env.KEEL_DB_URL = db.url;
    const deps = { connect: () => db.connect(), databaseUrl: () => db.url, tenantRef: () => "test" };
    const list = guardedRead(DATA_SURFACES.principalsApi, guardedPrincipalList(deps));
    const liveRequest = async () => { const identity = await resolveIdentity("portal@test"); return request("", identity.principalId!, identity.capabilities); };
    assert.equal((await list(await liveRequest())).status, 403);
    const grant = await guardedPrincipalWrite("grant", DATA_SURFACES.principalGrantApi, deps)(request("grant", id, ["roles"], { role: "admin" }));
    assert.equal(grant.status, 201);
    const grantId = (await grant.json()).result.id;
    const response = await list(await liveRequest());
    assert.equal(response.status, 200);
    const active = (await response.json()).principals[0] as PrincipalView;
    assert.deepEqual(active.capabilities, await capabilitiesForPrincipal(client, active));
    const lockout = await guardedPrincipalWrite("revoke", DATA_SURFACES.principalRevokeApi, deps)(request("revoke", id, ["roles"], { grantId }));
    assert.equal(lockout.status, 403);
    // The lockout says so, so the page can tell it from a missing permission.
    assert.deepEqual(await lockout.json(), { error: "last_admin" });
    // Disabling the last live admin is the same lockout: refused with 403.
    assert.equal((await guardedPrincipalWrite("disable", DATA_SURFACES.principalDisableApi, deps)(request("disable", id, ["users"], {}))).status, 403);
    // With a second live admin in place, the disable proceeds.
    const backupId = "00000000-0000-0000-0000-000000000002";
    await client.query("INSERT INTO principal(id,email) VALUES ($1,'backup@test')", [backupId]);
    await grantRole(client, { principalId: backupId, role: "admin", grantedBy: id });
    assert.equal((await guardedPrincipalWrite("disable", DATA_SURFACES.principalDisableApi, deps)(request("disable", id, ["users"], {}))).status, 200);
    // A separate authorized operator can still inspect a disabled identity.
    const disabledResponse = await list(request("", "other-admin", ["users"]));
    const disabled = (await disabledResponse.json()).principals.find((p: PrincipalView) => p.id === id) as PrincipalView;
    assert.ok(disabled.disabled_at);
    assert.equal(disabled.role_grants[0].active_until, null);
    assert.deepEqual(disabled.capabilities, await capabilitiesForPrincipal(client, disabled));
    assert.deepEqual(disabled.capabilities, []);
    const [pageModule, unitModule, workModule] = await Promise.all([
      import("../app/principals/page"),
      import("next/dist/server/app-render/work-unit-async-storage.external.js"),
      import("next/dist/server/app-render/work-async-storage.external.js"),
    ]);
    type Store = { run<T>(store: object, callback: () => T): T };
    const unit = (unitModule as { workUnitAsyncStorage: Store }).workUnitAsyncStorage;
    const work = (workModule as { workAsyncStorage: Store }).workAsyncStorage;
    const page = pageModule.default;
    const rendered = await work.run({ route: "/principals", forceStatic: false, dynamicShouldError: false }, () => unit.run({
      type: "request", phase: "render", headers: request("", "other-admin", ["users"]).headers,
      implicitTags: [], url: { pathname: "/principals", search: "" }, rootParams: {},
      resumeDataCache: null, isHmrRefresh: false, fallbackParams: null,
    }, () => page()));
    const pageMarkup = await renderInPeopleRoute(rendered as ReactElement);
    // Task-130: the engine's capability answer and the raw times live in the record layer.
    assert.ok(pageMarkup.includes(`effective capabilities</dt><dd><code>${(await capabilitiesForPrincipal(client, disabled)).join(", ") || "none"}</code>`));
    assert.ok(pageMarkup.includes(disabled.disabled_at));
    for (const view of [active, disabled]) {
      const markup = await renderPeopleAt("", { people: [view], canUsers: true, canRoles: true, now: new Date().toISOString() });
      const expected = await capabilitiesForPrincipal(client, view);
      // Active snapshot predates disable; use its captured engine answer for rendering.
      assert.ok(markup.includes(`effective capabilities</dt><dd><code>${view === active ? active.capabilities.join(", ") : expected.join(", ") || "none"}</code>`));
      assert.ok(markup.includes(view.role_grants[0].active_from));
    }
    assert.equal((await list(await liveRequest())).status, 403);
  } finally {
    if (previous === undefined) delete process.env.KEEL_DB_URL; else process.env.KEEL_DB_URL = previous;
    await client.end(); await db.cleanup();
  }
});

test("Add person creates a person with a first role; Enable again lets a disabled person back in", async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    await client.query(schemaSql());
    await client.query("INSERT INTO principal(id,email) VALUES ($1,'admin@test.example')", [id]);
    await grantRole(client, { principalId: id, role: "admin", grantedBy: id });
    const deps = { connect: () => db.connect(), databaseUrl: () => db.url, tenantRef: () => "test" };
    const add = (body: object) => guardedPrincipalCreate(deps)(new Request("http://localhost/api/principals", { method: "POST", headers: { [PRINCIPAL_ID_HEADER]: id, [CAPABILITIES_HEADER]: "users roles" }, body: JSON.stringify(body) }));
    const created = await add({ email: "lee.chen@test.example", displayName: "Lee Chen", role: "approver", reason: "Covers October" });
    assert.equal(created.status, 201);
    const person = (await created.json()).principal as PrincipalView;
    assert.equal(person.display_name, "Lee Chen");
    assert.deepEqual(person.capabilities, ["approve"]);
    assert.equal(person.role_grants[0].granted_by, id);
    assert.equal(person.role_grants[0].reason, "Covers October");
    assert.equal((await add({ email: "LEE.CHEN@test.example", role: "viewer" })).status, 409);
    assert.equal((await add({ email: "nobody", role: "viewer" })).status, 400);
    assert.equal((await add({ email: "x@test.example", role: 5 })).status, 400);
    // Disable, then enable through the guarded route: the approver role applies again.
    assert.equal((await guardedPrincipalWrite("disable", DATA_SURFACES.principalDisableApi, deps)(new Request(`http://localhost/api/principals/${person.id}/disable`, { method: "POST", headers: { [PRINCIPAL_ID_HEADER]: id, [CAPABILITIES_HEADER]: "users" }, body: "{}" }))).status, 200);
    const enabled = await guardedPrincipalWrite("enable", DATA_SURFACES.principalEnableApi, deps)(new Request(`http://localhost/api/principals/${person.id}/enable`, { method: "POST", headers: { [PRINCIPAL_ID_HEADER]: id, [CAPABILITIES_HEADER]: "users" }, body: "{}" }));
    assert.equal(enabled.status, 200);
    assert.deepEqual(await capabilitiesForPrincipal(client, { id: person.id, disabled_at: null }), ["approve"]);
    // Each write is recorded as an attempt in the evidence chain.
    const attempts = await client.query("SELECT subject->>'action' AS action FROM evidence WHERE kind = 'action-attempt' ORDER BY seq");
    assert.deepEqual(attempts.rows.map((row: { action: string }) => row.action).filter((action: string) => /create|enable/.test(action)), ["principals:create", "principals:create", "principals:create", "principals:create", "principals:enable"]);
  } finally {
    await client.end(); await db.cleanup();
  }
});
