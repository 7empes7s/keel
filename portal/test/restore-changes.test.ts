import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { getRestoreChanges, type RestoreChange } from "@/lib/restore-changes";
import { backupAge, backupForDay, changeLine, lastRestoreTile, partialWords, plainType, restoreVerdict, whoWords } from "@/lib/restore-view";
import { tenantRef } from "@/lib/runtime-config";
import type { JobRecord } from "@/lib/portal-jobs";

// The Restore page's "Changed recently": what differs between the chosen backup and
// the newest one, in words, with ids kept off the screen.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
const snaps: Record<string, string> = {};

const GROUP_ID = "0f0e0000-0000-4000-8000-0000000000aa";

// A fourth entry stores that hash instead of the payload's, as a backup hashed under older rules.
async function snapshot(name: string, at: string, versions: [string, string, Record<string, unknown>, string?][]) {
  const { rows } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', $2, $2) RETURNING id`,
    [tenantRef(), at],
  );
  snaps[name] = String(rows[0].id);
  for (const [naturalKey, resourceType, payload, hash] of versions) {
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, $5, 'critical', 'access-affecting', 'full', '{}')`,
      [snaps[name], naturalKey, resourceType, JSON.stringify(payload), hash ?? JSON.stringify(payload)],
    );
  }
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
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-restore-changes-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "restore-changes-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  client = await database.connect();

  const policy = { displayName: "Block legacy auth", state: "enabled", conditions: { users: { excludeGroups: [] as string[] } } };
  const finance = { displayName: "Finance", visibility: "Private" };
  const office = { displayName: "Branch offices", isTrusted: true };
  // Hashed under older rules in the first backup; the same content in the second; changed in the newest.
  const sales = { displayName: "KEEL-RT-Sales", visibility: "Private" };
  await snapshot("first", "2026-09-30T06:00:00Z", [
    ["conditionalAccessPolicy:Block legacy auth", "conditionalAccessPolicy", policy],
    ["group:Finance", "group", finance],
    ["group:KEEL-RT-Sales", "group", sales, "old-rule-hash"],
    ["namedLocation:Branch offices", "namedLocation", office],
    ["namedLocation:HQ", "namedLocation", { displayName: "HQ", isTrusted: true }],
  ]);
  // The policy changes here; the location is deleted here.
  await snapshot("second", "2026-10-01T06:00:00Z", [
    ["conditionalAccessPolicy:Block legacy auth", "conditionalAccessPolicy", { ...policy, state: "enabledForReportingButNotEnforced", conditions: { users: { excludeGroups: [GROUP_ID] } } }],
    ["group:Finance", "group", finance],
    ["group:KEEL-RT-Sales", "group", sales],
    ["namedLocation:HQ", "namedLocation", { displayName: "HQ", isTrusted: true }],
  ]);
  // The newest: the group changes; this backup did not read named locations at all
  // except HQ, which is enough to know Branch offices is gone.
  await snapshot("newest", "2026-10-02T06:00:00Z", [
    ["conditionalAccessPolicy:Block legacy auth", "conditionalAccessPolicy", { ...policy, state: "enabledForReportingButNotEnforced", conditions: { users: { excludeGroups: [GROUP_ID] } } }],
    ["group:Finance", "group", { ...finance, visibility: "Public" }],
    ["group:KEEL-RT-Sales", "group", { ...sales, visibility: "Public" }],
    ["namedLocation:HQ", "namedLocation", { displayName: "HQ", isTrusted: true }],
  ]);
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("changes since an older backup: what, when, newest first, and no ids in the words", async () => {
  const data = await getRestoreChanges(snaps.first);
  assert.equal(data.newest?.id, snaps.newest);
  assert.equal(data.earlier, null);
  assert.deepEqual(data.changes.map((change) => [change.naturalKey, change.kind]), [
    ["group:Finance", "changed"],
    ["group:KEEL-RT-Sales", "changed"],
    ["conditionalAccessPolicy:Block legacy auth", "changed"],
    ["namedLocation:Branch offices", "deleted"],
  ]);
  const [group, sales, policy, office] = data.changes;
  // The second backup holds the same content under a newer hash: it still matches.
  assert.equal(sales.seenAt, "2026-10-02T06:00:00.000Z");
  assert.equal(sales.sameUntil, "2026-10-01T06:00:00.000Z");
  assert.equal(group.seenAt, "2026-10-02T06:00:00.000Z");
  assert.equal(group.sameUntil, "2026-10-01T06:00:00.000Z");
  assert.deepEqual(group.fields, [{ path: "visibility", before: "Private", after: "Public" }]);
  assert.equal(policy.seenAt, "2026-10-01T06:00:00.000Z");
  assert.equal(policy.sameUntil, "2026-09-30T06:00:00.000Z");
  assert.deepEqual(policy.fields.find((field) => field.path === "conditions.users.excludeGroups"), { path: "conditions.users.excludeGroups", before: "none", after: "1 setting" });
  assert.equal(policy.service, "Entra");
  assert.equal(office.seenAt, "2026-10-01T06:00:00.000Z");
  assert.equal(group.who, null);
  assert.doesNotMatch(JSON.stringify(data.changes.map((change) => change.fields)), /0f0e0000/);
});

test("the newest backup lists nothing, and counts what changed just before it", async () => {
  const data = await getRestoreChanges(snaps.newest);
  assert.deepEqual(data.changes, []);
  assert.deepEqual(data.earlier, { id: snaps.second, takenAt: "2026-10-01T06:00:00.000Z", count: 2 });
});

test("a backup of another tenant or an unknown one compares with nothing", async () => {
  const data = await getRestoreChanges("00000000-0000-4000-8000-000000000000");
  assert.deepEqual(data.changes, []);
  assert.equal(data.earlier, null);
});

const change = (extra: Partial<RestoreChange>): RestoreChange => ({
  naturalKey: "conditionalAccessPolicy:Block legacy auth", resourceType: "conditionalAccessPolicy", service: "Entra", kind: "changed",
  seenAt: "2026-10-02T09:12:00Z", sameUntil: "2026-10-01T06:09:00Z", fields: [{ path: "state", before: "on", after: "report only" }], fieldCount: 3, who: null, ...extra,
});

test("restore words: verdict, change line, who, plain type, age", () => {
  assert.equal(changeLine(change({})), "State: on → report only, and 2 more");
  assert.equal(changeLine(change({ kind: "deleted", fields: [], fieldCount: 0 })), "Deleted after this backup. Undo brings it back.");
  assert.equal(whoWords(change({})), "Who: not in the audit log");
  assert.equal(whoWords(change({ who: { names: ["Amara Okafor"], certain: true } })), "By Amara Okafor");
  assert.equal(whoWords(change({ who: { names: ["Lee Chen", "Sam Ortiz", "an app"], certain: false } })), "Probably Lee Chen, Sam Ortiz and others");
  assert.equal(plainType("conditionalAccessPolicy"), "Sign-in rule");
  assert.equal(plainType("group"), "Group");
  assert.equal(backupAge("2026-09-30T06:08:00Z", "2026-10-02T09:40:00Z"), "2 days old");
  assert.equal(backupAge("2026-10-02T06:08:00Z", "2026-10-02T09:40:00Z"), "Taken 3 hours ago");
  // UI audit D13: a backup from a moment ago says so, never just its clock time.
  assert.equal(backupAge("2026-10-31T17:37:00Z", "2026-10-31T17:41:00Z"), "Taken 4 minutes ago");
  assert.equal(backupAge("2026-10-01T22:00:00Z", "2026-10-02T09:40:00Z"), "Taken 11 hours ago");
  assert.equal(backupAge("2026-10-01T06:00:00Z", "2026-10-02T09:40:00Z"), "Taken yesterday");
  assert.equal(partialWords({ typesRead: 12, typesSkipped: 168 }), "Partial backup: 12 of 180 types");
  assert.equal(partialWords({ typesRead: 180, typesSkipped: 0 }), null);
  assert.equal(partialWords({}), null);
  const changes = { newest: null, changes: [change({})], more: 2, earlier: null };
  assert.deepEqual(restoreVerdict({ chosen: "2026-09-30T06:08:00Z", isNewest: false, changes }), { text: "3 settings changed since the backup of Wed, 30 Sept 2026. Undo the ones nobody expected.", tone: "attention" });
  assert.equal(restoreVerdict({ chosen: "2026-10-02T06:08:00Z", isNewest: true, changes: { ...changes, changes: [], more: 0, earlier: { id: "x", takenAt: null, count: 1 } } }).text, "1 setting changed just before your newest backup. Pick an earlier day to undo them.");
  const same = restoreVerdict({ chosen: "2026-10-02T06:08:00Z", isNewest: true, changes: { ...changes, changes: [], more: 0 } });
  assert.equal(same.tone, "good");
  // "Nothing has changed" names the backup's time and says why Changes can still list changes.
  assert.equal(same.text, "Nothing has changed since the backup of Fri, 2 Oct 2026, 06:08 UTC. Choose anything you want to put back.");
  assert.match(same.detail ?? "", /Changes page compares with your approved setup/);
  const partial = restoreVerdict({ chosen: "2026-10-02T06:08:00Z", isNewest: true, changes: { ...changes, changes: [], more: 0 }, partial: "Partial backup: 12 of 180 types" });
  assert.match(partial.detail ?? "", /^Partial backup: 12 of 180 types, so only those types are compared\./);
  assert.ok(same.text.split(/\s+/).length <= 25, same.text);
  for (const verdict of [restoreVerdict({ chosen: null, isNewest: false, changes: null }), restoreVerdict({ chosen: "2026-09-30T06:08:00Z", isNewest: false, changes })]) {
    assert.ok(verdict.text.split(/\s+/).length <= 25, verdict.text);
  }
});

test("a day without a backup takes the one before it; the last restore tile links its job", () => {
  const snapshots = [
    { id: "b", startedAt: "2026-10-01T06:00:00Z", completedAt: "2026-10-01T06:09:00Z", resourceCount: 1 },
    { id: "a2", startedAt: "2026-09-30T18:00:00Z", completedAt: "2026-09-30T18:07:00Z", resourceCount: 1 },
    { id: "a1", startedAt: "2026-09-30T06:00:00Z", completedAt: "2026-09-30T06:08:00Z", resourceCount: 1 },
  ];
  assert.deepEqual(backupForDay(snapshots, "2026-09-30"), { snapshot: snapshots[1], exact: true });
  assert.deepEqual(backupForDay(snapshots, "2026-10-05"), { snapshot: snapshots[0], exact: false });
  assert.deepEqual(backupForDay(snapshots, "2026-09-01"), { snapshot: snapshots[2], exact: false });
  const jobs = [
    { id: "j2", kind: "backup", status: "succeeded" },
    { id: "j1", kind: "restore", status: "failed", params: { mode: "enforce" }, finishedAt: "2026-10-02T09:00:00Z" },
  ] as unknown as JobRecord[];
  assert.deepEqual(lastRestoreTile(jobs, "2026-10-02T09:40:00Z"), { label: "Restore failed", detail: "Failed 40 minutes ago.", href: "/jobs/j1", tone: "urgent" });
  assert.equal(lastRestoreTile([], "2026-10-02T09:40:00Z"), null);
});
