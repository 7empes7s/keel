import assert from "node:assert/strict";
import { test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { kindOfRecord } from "@/lib/activity-view";
import { contentEffectVerdict, type ContentEffectReviewView } from "@/lib/content-effect-review";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { DATA_SURFACES, guardedRead } from "@/lib/read";
import { guardedRestoreApprovalsRead, guardedRestoreApprovalsUpdate } from "@/lib/restore-approvals";
import { evidenceSentence, personLabel } from "@/lib/sentences";
import { HIGH_RISK_RESTORE_APPROVAL_RULES } from "@/lib/restore-approval-rules";
import { HIGH_RISK_RESTORE_APPROVAL_RULES as ENGINE_HIGH_RISK } from "../../engine/govern/restoreApprovalSettings.mjs";

// Restore approvals as a customer setting: anyone who can read sees how each service is
// set; only someone with `policies` changes it; each change is in the audit record.
const ADMIN = "00000000-0000-4000-8000-0000000000c1";
const VIEWER = "00000000-0000-4000-8000-0000000000d2";

function request(actor: string, capabilities: string[], body?: object) {
  return new Request("http://localhost/api/restore-approvals", {
    method: body ? "POST" : "GET",
    headers: { [PRINCIPAL_ID_HEADER]: actor, [CAPABILITIES_HEADER]: capabilities.join(" "), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("only someone who manages policies turns a service's restore approvals off or on; the change is recorded", async () => {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    await client.query(schemaSql());
    await client.query("INSERT INTO principal(id, email, display_name) VALUES ($1, 'ada@test.example', 'Ada Admin'), ($2, 'vic@test.example', 'Vic Viewer')", [ADMIN, VIEWER]);
    const deps = { connect: () => db.connect(), databaseUrl: () => db.url, tenantRef: () => "tenant-a" };
    const update = guardedRestoreApprovalsUpdate(deps);
    const read = guardedRead(DATA_SURFACES.restoreApprovalsApi, guardedRestoreApprovalsRead(deps));

    const before = await (await read(request(VIEWER, ["read"]))).json();
    assert.equal(before.settings.length, 8);
    assert.ok(before.settings.every((row: { approvalRequired: boolean }) => row.approvalRequired), "on for every service by default");
    assert.equal((await read(request(VIEWER, []))).status, 403);

    assert.equal((await update(request(VIEWER, ["read", "approve"], { service: "Purview", approvalRequired: false }))).status, 403);
    assert.equal((await update(request(ADMIN, ["policies"], { service: "Yammer", approvalRequired: false }))).status, 400);
    assert.equal((await update(request(ADMIN, ["policies"], { service: "Purview", approvalRequired: "off" }))).status, 400);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM restore_approval_setting")).rows[0].n, 0);

    const off = await update(request(ADMIN, ["policies"], { service: "Purview", approvalRequired: false }));
    assert.equal(off.status, 200);
    const body = await off.json();
    assert.equal(body.changed, true);
    const purview = body.settings.find((row: { service: string }) => row.service === "Purview");
    assert.equal(purview.approvalRequired, false);
    assert.equal(personLabel(purview.changedBy), "Ada Admin");

    // A kind of restore has its own setting, changed the same way and recorded too.
    assert.equal(before.rules.length, 6);
    assert.ok(before.rules.every((row: { approvalRequired: boolean }) => row.approvalRequired), "on for every kind of restore by default");
    assert.equal((await update(request(VIEWER, ["read", "approve"], { rule: "compliance-fix", approvalRequired: false }))).status, 403);
    assert.equal((await update(request(ADMIN, ["policies"], { rule: "not-a-kind", approvalRequired: false }))).status, 400);
    assert.equal((await update(request(ADMIN, ["policies"], { rule: "compliance-fix", service: "Purview", approvalRequired: false }))).status, 400);
    const ruleOff = await (await update(request(ADMIN, ["policies"], { rule: "content-restore", approvalRequired: false }))).json();
    assert.equal(ruleOff.changed, true);
    const content = ruleOff.rules.find((row: { rule: string }) => row.rule === "content-restore");
    assert.equal(content.approvalRequired, false);
    assert.equal(personLabel(content.changedBy), "Ada Admin");

    const after = await (await read(request(VIEWER, ["read"]))).json();
    assert.deepEqual(after.rules.filter((row: { approvalRequired: boolean }) => !row.approvalRequired).map((row: { rule: string }) => row.rule), ["content-restore"]);
    assert.deepEqual(after.settings.filter((row: { approvalRequired: boolean }) => !row.approvalRequired).map((row: { service: string }) => row.service), ["Purview"]);
    const { rows } = await client.query("SELECT actor, subject FROM evidence WHERE kind = 'restore-approval-setting' ORDER BY seq");
    assert.deepEqual(
      rows.map((row: { actor: string; subject: { service?: string; rule?: string; approvalRequired: boolean } }) => [row.actor, row.subject.service ?? row.subject.rule, row.subject.approvalRequired]),
      [[ADMIN, "Purview", false], [ADMIN, "content-restore", false]],
    );
  } finally {
    await client.end();
    await db.cleanup();
  }
});

test("a high-risk kind of restore turns off only with the risk warning confirmed; the portal and engine agree on which", async () => {
  assert.deepEqual([...HIGH_RISK_RESTORE_APPROVAL_RULES], [...ENGINE_HIGH_RISK]);
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    await client.query(schemaSql());
    await client.query("INSERT INTO principal(id, email, display_name) VALUES ($1, 'ada@test.example', 'Ada Admin')", [ADMIN]);
    const deps = { connect: () => db.connect(), databaseUrl: () => db.url, tenantRef: () => "tenant-a" };
    const update = guardedRestoreApprovalsUpdate(deps);
    for (const rule of HIGH_RISK_RESTORE_APPROVAL_RULES) {
      assert.equal((await update(request(ADMIN, ["policies"], { rule, approvalRequired: false }))).status, 400, rule);
      assert.equal((await update(request(ADMIN, ["policies"], { rule, approvalRequired: false, riskAcknowledged: "yes" }))).status, 400, rule);
    }
    assert.equal((await client.query("SELECT count(*)::int AS n FROM restore_approval_rule")).rows[0].n, 0);
    const off = await (await update(request(ADMIN, ["policies"], { rule: "other-tenant", approvalRequired: false, riskAcknowledged: true }))).json();
    assert.equal(off.rules.find((row: { rule: string }) => row.rule === "other-tenant").approvalRequired, false);
    // Back on needs no confirmation.
    assert.equal((await update(request(ADMIN, ["policies"], { rule: "other-tenant", approvalRequired: true }))).status, 200);
    const { rows } = await client.query("SELECT subject FROM evidence WHERE kind = 'restore-approval-setting' ORDER BY seq");
    assert.deepEqual(rows[0].subject, { rule: "other-tenant", approvalRequired: false, previous: true, highRisk: true, riskAcknowledged: true });
    assert.equal(
      evidenceSentence({ kind: "restore-approval-setting", actor: ADMIN, subject: rows[0].subject }, "Ada Admin"),
      "Ada Admin turned off restore approvals for restores into another tenant, so they no longer wait for a person. This is high risk; they confirmed the risk warning",
    );
  } finally {
    await client.end();
    await db.cleanup();
  }
});

test("the audit record says who turned a service's or a kind of restore's approvals on or off, under Approvals", () => {
  assert.equal(
    evidenceSentence({ kind: "restore-approval-setting", actor: ADMIN, subject: { service: "SharePoint", approvalRequired: false } }, "Ada Admin"),
    "Ada Admin turned off restore approvals for SharePoint and OneDrive, so its high-impact restore changes no longer wait for approval",
  );
  assert.equal(
    evidenceSentence({ kind: "restore-approval-setting", actor: ADMIN, subject: { service: "Entra", approvalRequired: true } }, "Ada Admin"),
    "Ada Admin turned on restore approvals for Entra ID",
  );
  assert.equal(
    evidenceSentence({ kind: "restore-approval-setting", actor: ADMIN, subject: { rule: "content-restore", approvalRequired: false } }, "Ada Admin"),
    "Ada Admin turned off restore approvals for mail, file and Teams restores, so they no longer wait for a person",
  );
  assert.equal(
    evidenceSentence({ kind: "restore-approval-setting", actor: ADMIN, subject: { rule: "turn-on-conditional-access", approvalRequired: true } }, "Ada Admin"),
    "Ada Admin turned on restore approvals for turning a Conditional Access policy on",
  );
  assert.equal(kindOfRecord("restore-approval-setting"), "approval");
});

test("a content-effect review with approvals off for its services says no second approval is needed", () => {
  const base: ContentEffectReviewView = {
    artifactId: "a", status: "completed", resources: 1, createdAt: null, requestedByName: "Ada Admin", viewerIsRequester: false,
    effects: [{ naturalKey: "retentionLabel:x", resourceType: "retentionLabel", field: "retentionDuration", effect: "retention-reducing", before: 2555, after: 30, disclosure: "d" }] as ContentEffectReviewView["effects"],
    effectsDigest: "x", approvals: [], approvalRequired: true, approvalWaivedFor: [], names: {},
  };
  assert.match(contentEffectVerdict(base), /cannot run until you approve/);
  assert.equal(
    contentEffectVerdict({ ...base, approvalRequired: false, approvalWaivedFor: ["Purview", "SharePoint"] }),
    "Restore approvals are turned off for Purview and SharePoint and OneDrive, so these content changes are made with the restore. No second approval is needed.",
  );
});
