import assert from "node:assert/strict";
import { test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { isSelfApproved, kindOfRecord } from "@/lib/activity-view";
import { guardedApprovalModeRead, guardedApprovalModeUpdate } from "@/lib/approval-mode";
import { contentEffectVerdict, type ContentEffectReviewView } from "@/lib/content-effect-review";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { DATA_SURFACES, guardedRead } from "@/lib/read";
import { evidenceSentence, personLabel } from "@/lib/sentences";

// Approval mode: anyone who can read sees it; only someone with `policies` changes it;
// switching to solo needs the risk confirmed; each change is in the audit record.
const ADMIN = "00000000-0000-4000-8000-0000000000c1";
const VIEWER = "00000000-0000-4000-8000-0000000000d2";

function request(actor: string, capabilities: string[], body?: object) {
  return new Request("http://localhost/api/approval-mode", {
    method: body ? "POST" : "GET",
    headers: { [PRINCIPAL_ID_HEADER]: actor, [CAPABILITIES_HEADER]: capabilities.join(" "), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("only someone who manages policies changes the approval mode; solo needs the risk confirmed; the change is recorded", async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    await client.query(schemaSql());
    await client.query("INSERT INTO principal(id, email, display_name) VALUES ($1, 'ada@test.example', 'Ada Admin'), ($2, 'vic@test.example', 'Vic Viewer')", [ADMIN, VIEWER]);
    const deps = { connect: () => db.connect(), databaseUrl: () => db.url, tenantRef: () => "tenant-a" };
    const update = guardedApprovalModeUpdate(deps);
    const read = guardedRead(DATA_SURFACES.approvalModeApi, guardedApprovalModeRead(deps));

    const before = await (await read(request(VIEWER, ["read"]))).json();
    assert.equal(before.mode, "two-person", "two people by default");
    assert.equal(before.changedBy, null);
    assert.equal((await read(request(VIEWER, []))).status, 403);

    assert.equal((await update(request(VIEWER, ["read", "approve"], { mode: "solo", riskAcknowledged: true }))).status, 403);
    assert.equal((await update(request(ADMIN, ["policies"], { mode: "alone", riskAcknowledged: true }))).status, 400);
    assert.equal((await update(request(ADMIN, ["policies"], { mode: "solo" }))).status, 400, "solo needs the risk confirmed");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM approval_mode")).rows[0].n, 0);

    const solo = await update(request(ADMIN, ["policies"], { mode: "solo", riskAcknowledged: true }));
    assert.equal(solo.status, 200);
    const body = await solo.json();
    assert.equal(body.changed, true);
    assert.equal(body.mode, "solo");
    assert.equal(personLabel(body.changedBy), "Ada Admin");
    assert.equal((await (await read(request(VIEWER, ["read"]))).json()).mode, "solo");

    const back = await (await update(request(ADMIN, ["policies"], { mode: "two-person" }))).json();
    assert.equal(back.mode, "two-person");

    const { rows } = await client.query("SELECT kind, subject FROM evidence WHERE tenant_ref = 'tenant-a' AND kind = 'approval-mode' ORDER BY seq");
    assert.deepEqual(rows.map((row: { subject: unknown }) => row.subject), [
      { mode: "solo", previous: "two-person", riskAcknowledged: true },
      { mode: "two-person", previous: "solo" },
    ]);
    const entry = { kind: "approval-mode", subject: rows[0].subject } as never;
    assert.equal(kindOfRecord("approval-mode"), "approval");
    assert.match(evidenceSentence(entry, "Ada Admin"), /switched approval mode to Solo/);
  } finally {
    await client.end();
    await db.cleanup();
  }
});

test("Activity marks a self-approved decision, and its sentence says so", () => {
  const decision = { kind: "approval-decision", subject: { action: "restore", decision: "approved", selfApproved: true, approvalMode: "solo" } } as never;
  assert.equal(isSelfApproved(decision), true);
  assert.match(evidenceSentence(decision, "Ada Admin"), /they asked for themselves \(self-approved/);
  assert.equal(isSelfApproved({ kind: "approval-decision", subject: { action: "restore", decision: "approved" } } as never), false);
  assert.equal(isSelfApproved(null), false);
});

test("the content-change review lets the person who asked approve only in solo mode", () => {
  const review = {
    artifactId: "a", status: "completed", resources: 1, createdAt: null, requestedByName: "Ada", viewerIsRequester: true,
    effects: [{ naturalKey: "k", field: "f", effect: "retention-reducing" }], effectsDigest: "d", approvals: [],
    approvalRequired: true, approvalWaivedFor: [], names: {},
  } as unknown as ContentEffectReviewView;
  assert.match(contentEffectVerdict(review), /someone else must approve/);
  assert.match(contentEffectVerdict({ ...review, selfApprovalAllowed: true }), /Approval mode is Solo/);
});
