import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { createPolicy, deletePolicy, updatePolicy } from "../../engine/policy/evaluate.mjs";

import { changesRequestFrom, getActivityChanges } from "@/lib/activity-changes";
import { tenantRef } from "@/lib/runtime-config";

// The Activity panel's "What changed": the settings a backup, a roll back, a restore or
// a found change touched, each with its value before and after, ids read as names.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
const snaps: Record<string, string> = {};
const jobs: Record<string, string> = {};
const drifts: Record<string, string> = {};

const GROUP_ID = "0f0e0000-0000-4000-8000-0000000000aa";
const POLICY = { displayName: "KEEL-RT Block legacy auth", state: "enabled", conditions: { users: { excludeGroups: [] as string[] } } };
const FINANCE = { id: GROUP_ID, displayName: "KEEL-RT Finance approvers", securityEnabled: true };

async function snapshot(name: string, at: string, versions: [string, string, Record<string, unknown>][], coverage: Record<string, unknown> | null = null) {
  const { rows } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest) VALUES ($1, 'complete', $2, $2, $3) RETURNING id`,
    [tenantRef(), at, coverage ? JSON.stringify(coverage) : null],
  );
  snaps[name] = String(rows[0].id);
  for (const [naturalKey, resourceType, payload] of versions) {
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, $5, 'critical', 'access-affecting', 'full', '{}')`,
      [snaps[name], naturalKey, resourceType, JSON.stringify(payload), JSON.stringify(payload)],
    );
  }
}

async function job(name: string, kind: string, status: string, params: Record<string, unknown>, at: string, finished: string | null) {
  const { rows } = await client.query(
    `INSERT INTO job (kind, params, status, requested_by, created_at, started_at, finished_at) VALUES ($1, $2, $3, 'scheduler', $4, $4, $5) RETURNING id`,
    [kind, JSON.stringify(params), status, at, finished],
  );
  jobs[name] = String(rows[0].id);
}

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    for (const line of env.split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  const admin = await database.connect();
  try {
    await admin.query(schemaSql());
  } finally {
    await admin.end();
  }
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-activity-changes-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "activity-changes-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  client = await database.connect();

  await snapshot("first", "2026-09-30T02:00:30Z", [
    ["conditionalAccessPolicy:KEEL-RT Block legacy auth", "conditionalAccessPolicy", POLICY],
    ["group:KEEL-RT Finance approvers", "group", FINANCE],
    ["group:KEEL-RT Old team", "group", { displayName: "KEEL-RT Old team", description: "Closed project" }],
  ]);
  await snapshot("second", "2026-10-01T02:00:30Z", [
    ["conditionalAccessPolicy:KEEL-RT Block legacy auth", "conditionalAccessPolicy", { ...POLICY, state: "enabledForReportingButNotEnforced", conditions: { users: { excludeGroups: [GROUP_ID] } } }],
    ["group:KEEL-RT Finance approvers", "group", FINANCE],
    ["group:KEEL-RT Contractors", "group", { displayName: "KEEL-RT Contractors", securityEnabled: false }],
  ]);
  await job("first", "backup", "succeeded", { tier: "tier1" }, "2026-09-30T02:00:00Z", "2026-09-30T02:05:00Z");
  await job("second", "backup", "succeeded", { tier: "tier1" }, "2026-10-01T02:00:00Z", "2026-10-01T02:05:00Z");
  await job("failed", "backup", "failed", { tier: "tier1" }, "2026-10-01T03:00:00Z", "2026-10-01T03:01:00Z");
  // A restore of the first backup's policy, asked for after the second backup.
  await job("restore", "restore", "succeeded", { snapshotId: snaps.first, selection: ["conditionalAccessPolicy:KEEL-RT Block legacy auth"] }, "2026-10-01T09:00:00Z", "2026-10-01T09:01:00Z");

  const { rows: [baseline] } = await client.query(`INSERT INTO baseline (tenant_ref, set_by) VALUES ($1, 'tester') RETURNING id`, [tenantRef()]);
  const { rows: [drift] } = await client.query(
    `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, before_payload, after_payload, blast_radius)
     VALUES ($1, $2, $3, 'conditionalAccessPolicy:KEEL-RT Block legacy auth', 'conditionalAccessPolicy', 'modified', $4, $5, 'tenant-lockout') RETURNING id`,
    [tenantRef(), baseline.id, snaps.second, JSON.stringify(POLICY), JSON.stringify({ ...POLICY, state: "disabled" })],
  );
  drifts.policy = String(drift.id);
  await job("rollback", "remediate", "succeeded", { driftIds: [drifts.policy] }, "2026-10-01T10:00:00Z", "2026-10-01T10:02:00Z");
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("a backup shows each setting it found changed since the backup before it, with names for ids", async () => {
  const changes = await getActivityChanges({ job: jobs.second });
  assert.ok(changes);
  assert.equal(changes.basis, "backup");
  assert.deepEqual(changes.compare, { from: snaps.first, to: snaps.second });
  assert.equal(changes.total, 3);
  assert.deepEqual(changes.changes.map((change) => [change.name, change.change]), [
    ["KEEL-RT Old team", "removed"],
    ["KEEL-RT Block legacy auth", "changed"],
    ["KEEL-RT Contractors", "added"],
  ]);
  const policy = changes.changes[1];
  assert.deepEqual(policy.fields.map((field) => [field.path, field.before, field.after]), [
    ["conditions.users.excludeGroups", [], [GROUP_ID]],
    ["state", "enabled", "enabledForReportingButNotEnforced"],
  ]);
  assert.equal(changes.names[GROUP_ID], "KEEL-RT Finance approvers");
  assert.ok(changes.changes[0].fields.some((field) => field.path === "description" && field.before === "Closed project" && field.after === null));
});

test("the first backup has nothing to compare with, and a failed one says nothing", async () => {
  const first = await getActivityChanges({ job: jobs.first });
  assert.ok(first);
  assert.equal(first.changes.length, 0);
  assert.equal(first.compare, null);
  assert.equal(await getActivityChanges({ job: jobs.failed }), null);
});

test("a roll back reads as found, then put back; a found change reads approved, then found", async () => {
  const rollback = await getActivityChanges({ job: jobs.rollback });
  assert.ok(rollback);
  assert.deepEqual(rollback.sides, { before: "As found", after: "Put back to" });
  assert.deepEqual(rollback.changes[0].fields.map((field) => [field.path, field.before, field.after]), [["state", "disabled", "enabled"]]);
  const found = await getActivityChanges({ drift: drifts.policy });
  assert.ok(found);
  assert.deepEqual(found.changes[0].fields.map((field) => [field.path, field.before, field.after]), [["state", "enabled", "disabled"]]);
});

test("a restore compares the restored backup with the last backup before it", async () => {
  const restore = await getActivityChanges({ job: jobs.restore });
  assert.ok(restore);
  assert.equal(restore.basis, "restore");
  assert.deepEqual(restore.compare, { from: snaps.second, to: snaps.first });
  assert.deepEqual(restore.changes[0].fields.map((field) => [field.path, field.after]), [
    ["conditions.users.excludeGroups", []],
    ["state", "enabled"],
  ]);
});

test("a rule edit shows each rule setting before and after; a delete shows the rule as it was", async () => {
  const ref = tenantRef();
  const rule = await createPolicy(client, {
    tenantRef: ref, name: "KEEL-RT Alert on groups", resourceType: "group", blastRadius: null, naturalKeyGlob: null, changeType: null, action: "alert", maxBlastRadius: "cosmetic", runAsPrincipalId: null,
    maxActionsPerWindow: 50, windowSeconds: 3600, createdBy: "admin",
  }) as { id: string };
  await updatePolicy(client, {
    tenantRef: ref, policyId: rule.id, name: "KEEL-RT Alert on FIN users", resourceType: "user", naturalKeyGlob: "user:FIN-*",
    changeType: "modified", blastRadius: null, maxBlastRadius: "access-affecting", maxActionsPerWindow: null, windowSeconds: null, actor: "admin",
  });
  await deletePolicy(client, { tenantRef: ref, policyId: rule.id, deletedBy: "admin" });
  const { rows } = await client.query("SELECT seq::text AS seq FROM evidence WHERE tenant_ref = $1 AND kind = 'policy-change' ORDER BY seq", [ref]);
  const [editSeq, deleteSeq] = rows.map((row) => String(row.seq));

  const edited = await getActivityChanges({ record: editSeq });
  assert.equal(edited?.basis, "rule");
  assert.deepEqual(edited?.sides, { before: "Before", after: "After" });
  assert.equal(edited?.changes.length, 1);
  assert.equal(edited?.changes[0].name, "KEEL-RT Alert on FIN users");
  assert.equal(edited?.changes[0].change, "changed");
  assert.deepEqual(edited?.changes[0].fields, [
    { path: "Name", before: "KEEL-RT Alert on groups", after: "KEEL-RT Alert on FIN users" },
    { path: "Type of thing", before: "Group", after: "User" },
    { path: "Name like", before: "Any name", after: "FIN-*" },
    { path: "Change", before: "Any change", after: "Changed" },
    { path: "Most risky it may touch", before: "Low risk", after: "Affects access" },
    { path: "Limit", before: "50 an hour", after: "No limit" },
  ]);

  const deleted = await getActivityChanges({ record: deleteSeq });
  assert.equal(deleted?.changes[0].change, "removed");
  assert.equal(deleted?.sides.before, "When deleted");
  const fields = deleted?.changes[0].fields ?? [];
  assert.deepEqual(fields.slice(0, 3), [
    { path: "What it does", before: "Alert only", after: null },
    { path: "On or off", before: "On", after: null },
    { path: "Name", before: "KEEL-RT Alert on FIN users", after: null },
  ]);
  assert.ok(fields.every((field) => field.after === null), "a delete has no after side");

  // Only a rule change's own record, on this tenant, is read.
  const { rows: [other] } = await client.query("SELECT seq::text AS seq FROM evidence WHERE tenant_ref = $1 AND kind <> 'policy-change' ORDER BY seq LIMIT 1", [ref]);
  if (other) assert.equal(await getActivityChanges({ record: String(other.seq) }), null);
  assert.equal(await getActivityChanges({ record: "999999" }), null);
});

test("only a job id, a change id or an audit entry number is accepted", () => {
  assert.deepEqual(changesRequestFrom(new URLSearchParams("record=12")), { record: "12" });
  assert.equal(changesRequestFrom(new URLSearchParams("record=1e3")), null);
  assert.equal(changesRequestFrom(new URLSearchParams("record=-1")), null);
  assert.equal(changesRequestFrom(new URLSearchParams("job=nope")), null);
  assert.deepEqual(changesRequestFrom(new URLSearchParams(`drift=${GROUP_ID}`)), { drift: GROUP_ID });
});
