import assert from "node:assert/strict";
import { test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { guardedAnonymityRead, guardedAnonymityUpdate } from "@/lib/anonymity";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { DATA_SURFACES, guardedRead } from "@/lib/read";
import { evidenceSentence, personLabel } from "@/lib/sentences";
import { kindOfRecord } from "@/lib/activity-view";

// "Hide people's names" (Track A3): only an admin changes it, every change is in the
// audit record, and anyone who can read sees whether it is on.
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const VIEWER = "00000000-0000-4000-8000-0000000000b2";

function request(actor: string, capabilities: string[], body?: object) {
  return new Request("http://localhost/api/anonymity", {
    method: body ? "POST" : "GET",
    headers: { [PRINCIPAL_ID_HEADER]: actor, [CAPABILITIES_HEADER]: capabilities.join(" "), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("only an admin turns names off or on; each change is in the audit record and the setting reads back with a code name", async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    await client.query(schemaSql());
    await client.query("INSERT INTO principal(id, email, display_name) VALUES ($1, 'ada@test.example', 'Ada Admin'), ($2, 'vic@test.example', 'Vic Viewer')", [ADMIN, VIEWER]);
    const deps = { connect: () => db.connect(), databaseUrl: () => db.url, tenantRef: () => "tenant-a" };
    const update = guardedAnonymityUpdate(deps);
    const read = guardedRead(DATA_SURFACES.anonymityApi, guardedAnonymityRead(deps));

    // A viewer can read the setting but not change it, in either direction.
    assert.equal((await update(request(VIEWER, ["read"], { enabled: true }))).status, 403);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM people_anonymity")).rows[0].n, 0);
    const before = await (await read(request(VIEWER, ["read"]))).json();
    assert.deepEqual(before.setting, { enabled: false, changedAt: null, changedBy: null });
    assert.equal((await read(request(VIEWER, []))).status, 403);
    assert.equal((await update(request(ADMIN, ["users"], { enabled: "yes" }))).status, 400);

    const on = await update(request(ADMIN, ["users"], { enabled: true }));
    assert.equal(on.status, 200);
    const body = await on.json();
    assert.equal(body.changed, true);
    assert.equal(body.setting.enabled, true);
    // Who changed it is shown the way the setting says: a code name, no email.
    assert.match(personLabel(body.setting.changedBy), /^Person [A-HJ-NP-Z2-9]{4}$/);
    assert.equal(body.setting.changedBy.email, null);
    assert.ok(!JSON.stringify(body).includes("Ada"), "no real name in the answer");

    // A viewer cannot turn it off; an admin can, and both changes are recorded.
    assert.equal((await update(request(VIEWER, ["read"], { enabled: false }))).status, 403);
    assert.equal((await update(request(ADMIN, ["users"], { enabled: false }))).status, 200);
    const { rows } = await client.query("SELECT kind, actor, subject FROM evidence WHERE kind = 'people-anonymity' ORDER BY seq");
    assert.deepEqual(rows.map((row: { actor: string; subject: { enabled: boolean } }) => [row.actor, row.subject.enabled]), [[ADMIN, true], [ADMIN, false]]);
    const after = await (await read(request(VIEWER, ["read"]))).json();
    assert.equal(after.setting.enabled, false);
    assert.equal(personLabel(after.setting.changedBy), "Ada Admin");
  } finally {
    await client.end();
    await db.cleanup();
  }
});

test("the audit record says who turned names on or off, in Activity's Other kind", () => {
  assert.equal(evidenceSentence({ kind: "people-anonymity", actor: ADMIN, subject: { enabled: true } }, "Person K7Q2"), 'Person K7Q2 turned on "Hide people\'s names"');
  assert.equal(evidenceSentence({ kind: "people-anonymity", actor: ADMIN, subject: { enabled: false } }, "Ada Admin"), 'Ada Admin turned off "Hide people\'s names", so names show again');
  assert.equal(kindOfRecord("people-anonymity"), "other");
});
