import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { grantRole } from "../../engine/authz/administration.mjs";
import { createFixtureAuditAdapter, ingestAudit, migrateAuditIngestion } from "../../engine/identity/auditIngest.mjs";
import { recordLineage } from "../../engine/store/resourceLineage.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";

import { askAlerts, askFormDefaults, askInputFrom, type ChangeRecord } from "@/lib/ask-view";
import { getAskData } from "@/lib/portal-data";
import { tenantRef } from "@/lib/runtime-config";

// Backlog D19: Ask answers "who changed it?" from Microsoft's audit log, as the Changes
// page does, and its "Or choose" pickers start from the question just answered.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const HOUR = 60 * 60 * 1000;
const GROUP = "55555555-5555-4555-8555-555555555555";
const ALICE = "aaaaaaaa-0000-4000-8000-00000000a11c";
const GROUP_KEY = "group:KEEL-RT-Ask who";
const SP_KEY = "sharepointSettings:tenant";
const CENTRAL = { central: true, entities: [] as string[] };

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
let ref: string;

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    for (const line of readFileSync("/etc/keel/db.env", "utf8").split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  client = await database.connect();
  await client.query(schemaSql());
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-ask-who-test-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "d19-ask-who-portal-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  ref = tenantRef();
  const { rows: [row] } = await client.query("INSERT INTO principal(email) VALUES ('collector@example.invalid') RETURNING id");
  const collector = String(row.id);
  await grantRole(client, { principalId: collector, role: "operator", grantedBy: "fixture", activeFrom: "2020-01-01Z" });
  await recordLineage(client, { tenantRef: ref, resourceType: "user", sourceId: ALICE, naturalKey: "user:Alice Admin", observedAt: new Date(Date.now() - 5 * HOUR) });

  // A backup three hours ago read both kinds completely; the backup five minutes ago saw
  // both changed. Times are relative to the run, so the test never rots.
  const digest = JSON.stringify({ group: { outcome: "complete" }, sharepointSettings: { outcome: "complete" } });
  const { rows: [earlier] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest) VALUES ($1, 'complete', now() - interval '3 hours', now() - interval '3 hours', $2::jsonb) RETURNING id",
    [ref, digest],
  );
  const { rows: [observed] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at, coverage_digest) VALUES ($1, 'complete', now() - interval '6 minutes', now() - interval '5 minutes', $2::jsonb) RETURNING id",
    [ref, digest],
  );
  const { rows: [baseline] } = await client.query("INSERT INTO baseline (tenant_ref, set_by, active) VALUES ($1, 'fixture', true) RETURNING id", [ref]);
  for (const [key, type, before, after] of [
    [GROUP_KEY, "group", { id: GROUP, description: "old" }, { id: GROUP, description: "new" }],
    [SP_KEY, "sharepointSettings", { sharingCapability: "disabled" }, { sharingCapability: "externalUserSharingOnly" }],
  ] as const) {
    const { rows: [version] } = await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4::jsonb, 'h-old', 'normal', 'access-affecting', 'full', '{}'::jsonb) RETURNING id`,
      [earlier.id, key, type, JSON.stringify(before)],
    );
    await client.query("INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id) VALUES ($1, $2, $3)", [baseline.id, key, version.id]);
    await client.query(
      `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, blast_radius, before_hash, after_hash, before_payload, after_payload)
       VALUES ($1, $2, $3, $4, $5, 'modified', 'access-affecting', 'h-old', 'h-new', $6::jsonb, $7::jsonb)`,
      [ref, baseline.id, observed.id, key, type, JSON.stringify(before), JSON.stringify(after)],
    );
  }

  // The Entra audit log, read for the last four hours, names Alice changing the group.
  await migrateAuditIngestion(client);
  const now = Date.now();
  const ingest = (source: "audit" | "sign-in", events: unknown[]) => ingestAudit(client, {
    tenantRef: ref, managedTenantRef: ref, requestedBy: collector, source, enabled: true,
    from: new Date(now - 4 * HOUR).toISOString(), until: new Date(now).toISOString(),
    adapter: createFixtureAuditAdapter({ tenantRef: ref, pages: [{ events, nextCursor: null }] as never[] }),
  });
  await ingest("audit", [{
    id: "evt-ask-1", occurredAt: new Date(now - 2 * HOUR).toISOString(),
    change: { targetType: "group", targetId: GROUP, operation: "Update", activity: "Update group", fields: ["description"], actorKind: "user", actorId: ALICE },
  }]);
  await ingest("sign-in", []);
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

const change = (records: unknown[], key: string) => (records as ChangeRecord[]).find((record) => record.naturalKey === key)!;

test("a question that asks who made a change is answered from the audit log", async () => {
  const data = await getAskData(CENTRAL, { question: "Who changed what today?" });
  const answer = data.answer!;
  assert.equal(answer.intent, "changes");
  assert.equal(answer.asksWho, true);
  assert.equal(answer.period, "today");
  assert.ok(!(answer.assumed ?? []).some((line) => /not who made/.test(line)), "Ask no longer says it cannot tell who");
  const group = change(answer.records, GROUP_KEY);
  assert.equal(group.who?.verdict, "exact");
  assert.equal(group.who?.label, "Confirmed");
  assert.equal(group.who?.text, "Alice Admin, confirmed by the Microsoft Entra audit log.");
  const sharepoint = change(answer.records, SP_KEY);
  assert.equal(sharepoint.who?.verdict, "unknown");
  assert.match(sharepoint.who?.text ?? "", /Purview audit log/);
  assert.match(sharepoint.who?.detail ?? "", /AuditLogsQuery\.Read\.All/);
  const who = askAlerts(answer).find((alert) => alert.key === "who")!;
  assert.equal(who.title, "Who made these changes: 1 confirmed, 0 likely, 1 not known");
  // The pickers start from the question: today, these two kinds, who ticked.
  const chosen = askFormDefaults(answer);
  assert.equal(chosen.intent, "changes");
  assert.equal(chosen.period, "today");
  assert.equal(chosen.who, true);
});

test("the form's who box asks the same, and a question without who looks nobody up", async () => {
  const plain = (await getAskData(CENTRAL, { question: "What changed today?" })).answer!;
  assert.equal(plain.asksWho, false);
  assert.ok(plain.records.every((record) => record.kind !== "change" || record.who === undefined));
  assert.equal(askAlerts(plain).some((alert) => alert.key === "who"), false);
  const form = (await getAskData(CENTRAL, askInputFrom({ intent: "changes", period: "today", who: "1" }))).answer!;
  assert.equal(form.asksWho, true);
  assert.equal(change(form.records, GROUP_KEY).who?.verdict, "exact");
});
