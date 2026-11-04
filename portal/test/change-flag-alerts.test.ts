import assert from "node:assert/strict";
import { test } from "node:test";
import { flagFixture } from "../../engine/test/changeFlagFixture.mjs";
import { syncChangeFlags } from "../../engine/notify/changeFlags.mjs";
import { grantRole } from "../../engine/authz/administration.mjs";
import { setAnonymity } from "../../engine/insights/anonymity.mjs";
import { guardedFlagSettingsRead, guardedFlagSettingsUpdate } from "@/lib/change-flag-settings";
import { guardedAlertAction, guardedAlertInbox } from "@/lib/alerts";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

function request(path: string, actor: string, capabilities: string[], body?: object) {
  return new Request(`http://localhost${path}`, { method: body ? "POST" : "GET", headers: {
    [PRINCIPAL_ID_HEADER]: actor, [CAPABILITIES_HEADER]: capabilities.join(" "), ...(body ? { "content-type": "application/json" } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

test("settings require policies in the guard and engine; review requires dispose-accept and records the reviewer", async (t) => {
  const f = await flagFixture(import.meta.url);
  t.after(() => f.close());
  const deps = { connect: () => f.database.connect(), databaseUrl: () => f.database.url, tenantRef: () => f.tenantRef };
  const read = guardedFlagSettingsRead(deps);
  const update = guardedFlagSettingsUpdate(deps);
  const respond = guardedAlertAction(deps);
  assert.equal((await read(request("/api/change-flag-settings", f.actor, []))).status, 403);
  const settings = await (await read(request("/api/change-flag-settings", f.actor, ["read"]))).json();
  assert.ok(settings.settings.every((setting: { enabled: boolean }) => setting.enabled));
  assert.equal((await update(request("/api/change-flag-settings", f.actor, ["read"], { key: "ca-turned-off", enabled: false }))).status, 403);
  const { rows: [viewer] } = await f.client.query("INSERT INTO principal(email) VALUES ('viewer@test.example') RETURNING id");
  await grantRole(f.client, { principalId: viewer.id, role: "viewer", grantedBy: f.actor, activeFrom: new Date(Date.now() - 86400_000).toISOString() });
  // Forged capability headers cannot pass the engine's current grants check.
  assert.equal((await update(request("/api/change-flag-settings", viewer.id, ["policies"], { key: "ca-turned-off", enabled: false }))).status, 403);
  assert.equal((await update(request("/api/change-flag-settings", f.actor, ["policies"], { key: "unknown", enabled: false }))).status, 400);
  assert.equal((await update(request("/api/change-flag-settings", f.actor, ["policies"], { key: "ca-turned-off", enabled: false }))).status, 200);
  assert.equal((await f.client.query("SELECT actor FROM evidence WHERE kind='alert-action'")).rows[0].actor, f.actor);
  const id = await f.audit();
  const [opened] = await syncChangeFlags(f.client, { tenantRef: f.tenantRef, source: "audit", ids: [id] });
  const body = { alertId: opened.alert.id, action: "resolve", note: "Reviewed with the policy owner" };
  assert.equal((await respond(request("/api/actions/alerts", viewer.id, ["read"], body))).status, 403);
  assert.equal((await respond(request("/api/actions/alerts", viewer.id, ["dispose-accept"], body))).status, 403);
  await setAnonymity(f.client, { tenantRef: f.tenantRef, enabled: true, actor: f.actor });
  const inbox = await (await guardedAlertInbox(deps)(request("/api/alerts", f.actor, ["read"])) ).json();
  assert.match(inbox.alerts[0].flags[0].person.name, /^Person /);
  assert.equal(inbox.alerts[0].name, "Require MFA for admins");
  assert.doesNotMatch(JSON.stringify(inbox.alerts[0].flags), /Ada Admin/);
  assert.equal((await respond(request("/api/actions/alerts", f.actor, ["dispose-accept"], body))).status, 200);
  const { rows: [review] } = await f.client.query("SELECT actor,subject FROM evidence WHERE kind='alert-action' AND subject->>'action'='reviewed'");
  assert.equal(review.actor, f.actor);
  assert.equal(review.subject.note, body.note);
});
