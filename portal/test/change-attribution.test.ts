import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { grantRole } from "../../engine/authz/administration.mjs";
import { createFixtureAuditAdapter, ingestAudit, migrateAuditIngestion } from "../../engine/identity/auditIngest.mjs";
import { createFixtureCmdbAdapter } from "../../engine/identity/adapters/cmdb.mjs";
import { resolveOwnership } from "../../engine/identity/ownership.mjs";
import { recordLineage } from "../../engine/store/resourceLineage.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";

import { attributionNextStep, attributionSentence, attributionSummary, attributionWhen, routeSentence } from "@/components/change-attribution";
import { getDriftData } from "@/lib/portal-data";
import { tenantRef } from "@/lib/runtime-config";
import type { ChangeAttribution, DriftRecord } from "@/lib/types";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

// Roadmap task-91, portal boundary: the Changes reader attributes each open change from
// the audit evidence task 88 ingested, routes its roll back from current ownership, and
// withholds an actor's identity from a reader outside that actor's entity.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const HOUR = 60 * 60 * 1000;
const CREOS_GROUP = "11111111-1111-4111-8111-111111111111";
const ENOVOS_GROUP = "22222222-2222-4222-8222-222222222222";
const ALICE = "aaaaaaaa-0000-4000-8000-00000000a11c";
const CREOS_KEY = "group:Grid Operations Admins";
const ENOVOS_KEY = "group:Retail Billing Admins";

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
let ref: string;
let collector: string;

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
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-attribution-test-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "task-91-attribution-portal-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  ref = tenantRef();

  const people: Record<string, string> = {};
  for (const [name, role, entityCode] of [["collector", "operator", null], ["central", "approver", null], ["creosApprover", "approver", "CREOS"]] as const) {
    const { rows: [row] } = await client.query("INSERT INTO principal(email) VALUES ($1) RETURNING id", [`${name}@example.invalid`]);
    people[name] = String(row.id);
    await grantRole(client, { principalId: people[name], role, grantedBy: "fixture", activeFrom: "2020-01-01Z", entityCode });
  }
  collector = people.collector;

  const observedAt = new Date(Date.now() - 5 * HOUR);
  await recordLineage(client, { tenantRef: ref, resourceType: "group", sourceId: CREOS_GROUP, naturalKey: CREOS_KEY, observedAt });
  await recordLineage(client, { tenantRef: ref, resourceType: "group", sourceId: ENOVOS_GROUP, naturalKey: ENOVOS_KEY, observedAt });
  await recordLineage(client, { tenantRef: ref, resourceType: "user", sourceId: ALICE, naturalKey: "user:Alice Admin", observedAt });
  const adapter = createFixtureCmdbAdapter({
    tenantRef: ref,
    records: [
      { resourceType: "group", sourceId: CREOS_GROUP, recordRef: "CI-1111", owners: ["Creos Luxembourg S.A."] },
      { resourceType: "group", sourceId: ENOVOS_GROUP, recordRef: "CI-2222", owners: ["Enovos Luxembourg S.A."] },
    ] as never[],
  });
  const config = {
    entities: {
      CREOS: { cmdbValues: ["Creos Luxembourg S.A."], codePrefixes: ["CRE"] },
      ENOVOS: { cmdbValues: ["Enovos Luxembourg S.A."], codePrefixes: ["ENO"] },
    },
  };
  for (const sourceId of [CREOS_GROUP, ENOVOS_GROUP]) {
    await resolveOwnership(client, { tenantRef: ref, managedTenantRef: ref, requestedBy: collector, resourceType: "group", sourceId, adapter, config });
  }

  // The baseline was captured three hours ago; the latest collection saw both groups changed.
  const { rows: [baselineSnapshot] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', now() - interval '3 hours', now() - interval '3 hours') RETURNING id", [ref],
  );
  const { rows: [observed] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, completed_at) VALUES ($1, 'complete', now() - interval '5 minutes') RETURNING id", [ref],
  );
  const { rows: [baseline] } = await client.query("INSERT INTO baseline (tenant_ref, set_by, active) VALUES ($1, 'fixture', true) RETURNING id", [ref]);
  for (const key of [CREOS_KEY, ENOVOS_KEY]) {
    const { rows: [version] } = await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, 'group', '{}'::jsonb, 'h-' || $2, 'normal', 'access-affecting', 'full', '{}'::jsonb) RETURNING id`,
      [baselineSnapshot.id, key],
    );
    await client.query("INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id) VALUES ($1, $2, $3)", [baseline.id, key, version.id]);
    await client.query(
      `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, blast_radius, before_payload, after_payload)
       VALUES ($1, $2, $3, $4, 'group', 'modified', 'access-affecting', '{"description":"old"}', '{"description":"new"}')`,
      [ref, baseline.id, observed.id, key],
    );
  }
});

after(async () => {
  await client.end();
  await database.cleanup();
});

const byKey = (items: DriftRecord[], key: string) => items.find((item) => item.naturalKey === key)!.attribution as ChangeAttribution;

test("without an audit log the reader says unknown, and still routes the roll back", async () => {
  const data = await getDriftData();
  const creos = byKey(data.items, CREOS_KEY);
  assert.equal(creos.verdict, "unknown");
  assert.equal(creos.reason, "audit-log-not-configured");
  assert.equal(attributionSentence(creos), "Keel does not read this tenant's audit log, so it cannot say who made this change.");
  assert.deepEqual(creos.route && [creos.route.route, creos.route.entityCode, creos.route.approverCount], ["entity", "CREOS", 1]);
  assert.equal(routeSentence(creos.route!), "A roll back goes to CREOS approvers (1 person).");
  const enovos = byKey(data.items, ENOVOS_KEY);
  assert.deepEqual(enovos.route && [enovos.route.route, enovos.route.reason], ["central", "no-entity-approver"]);
  assert.equal(routeSentence(enovos.route!), "A roll back goes to a central approver (1 person), because its owner has no approver.");
});

test("an audit entry naming the resource is exact; an entity reader is not told who an outside account is", async () => {
  await migrateAuditIngestion(client);
  const now = Date.now();
  const ingest = (source: "audit" | "sign-in", events: unknown[]) => ingestAudit(client, {
    tenantRef: ref, managedTenantRef: ref, requestedBy: collector, source, enabled: true,
    from: new Date(now - 4 * HOUR).toISOString(), until: new Date(now).toISOString(),
    adapter: createFixtureAuditAdapter({ tenantRef: ref, pages: [{ events, nextCursor: null }] as never[] }),
  });
  const result = await ingest("audit", [{
    id: "evt-1", occurredAt: new Date(now - 2 * HOUR).toISOString(),
    change: { targetType: "group", targetId: CREOS_GROUP, operation: "Update", activity: "Update group", fields: ["description"], actorKind: "user", actorId: ALICE },
  }]);
  assert.equal((result as { status: string }).status, "complete");
  await ingest("sign-in", []);

  const central = await getDriftData();
  const creos = byKey(central.items, CREOS_KEY);
  assert.equal(creos.verdict, "exact");
  assert.deepEqual(creos.actors, [{ kind: "user", id: ALICE, name: "Alice Admin" }]);
  assert.equal(attributionSentence(creos), "Alice Admin made this change, according to the audit log.");
  assert.deepEqual(creos.evidence.map((entry) => entry.sourceEventId), ["evt-1"]);
  const enovos = byKey(central.items, ENOVOS_KEY);
  assert.deepEqual([enovos.verdict, enovos.reason], ["unknown", "no-audit-record-names-resource"]);

  const scoped = await getDriftData({ central: false, entities: ["CREOS"] });
  assert.deepEqual(scoped.items.map((item) => item.naturalKey), [CREOS_KEY]);
  const mine = byKey(scoped.items, CREOS_KEY);
  assert.equal(mine.verdict, "exact");
  assert.deepEqual(mine.actors, [{ kind: "user", id: null, name: null }]);
  assert.equal(attributionSentence(mine), "An account outside your entities made this change, according to the audit log.");
});

test("without lineage the saved copy's object id matches, the app is named from the backup, and other services say what to do", async () => {
  const CA = "33333333-3333-4333-8333-333333333333";
  const SYNC_APP = "44444444-4444-4444-8444-444444444444";
  const CA_KEY = "conditionalAccessPolicy:Block legacy sign-in";
  const SP_KEY = "sharepointSettings:tenant";
  const { rows: [baseline] } = await client.query("SELECT id FROM baseline WHERE tenant_ref = $1 AND active", [ref]);
  const { rows: [baselineSnapshot] } = await client.query(
    "SELECT id FROM snapshot WHERE tenant_ref = $1 ORDER BY started_at ASC LIMIT 1", [ref],
  );
  const { rows: [observed] } = await client.query(
    "SELECT observed_snapshot AS id FROM drift WHERE tenant_ref = $1 LIMIT 1", [ref],
  );
  // A backup an hour ago still held the approved version: the change came after it.
  const { rows: [previous] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', now() - interval '61 minutes', now() - interval '60 minutes') RETURNING id, completed_at", [ref],
  );
  const version = async (snapshotId: unknown, key: string, type: string, payload: unknown, hash: string) => (await client.query(
    `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'normal', 'access-affecting', 'full', '{}'::jsonb) RETURNING id`,
    [snapshotId, key, type, JSON.stringify(payload), hash],
  )).rows[0];
  const approved = await version(baselineSnapshot.id, CA_KEY, "conditionalAccessPolicy", { id: CA, state: "enabled" }, "h-ca-old");
  await version(previous.id, CA_KEY, "conditionalAccessPolicy", { id: CA, state: "enabled" }, "h-ca-old");
  await version(observed.id, "servicePrincipal:Contoso Sync", "servicePrincipal", { id: SYNC_APP, displayName: "Contoso Sync" }, "h-sp");
  const sharepoint = await version(baselineSnapshot.id, SP_KEY, "sharepointSettings", { sharingCapability: "disabled" }, "h-sp-old");
  for (const [key, row, type, hash, before, after] of [
    [CA_KEY, approved, "conditionalAccessPolicy", "h-ca-old", { id: CA, state: "enabled" }, { id: CA, state: "disabled" }],
    [SP_KEY, sharepoint, "sharepointSettings", "h-sp-old", { sharingCapability: "disabled" }, { sharingCapability: "externalUserSharingOnly" }],
  ] as const) {
    await client.query("INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id) VALUES ($1, $2, $3)", [baseline.id, key, (row as { id: string }).id]);
    await client.query(
      `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, blast_radius, before_hash, after_hash, before_payload, after_payload)
       VALUES ($1, $2, $3, $4, $5, 'modified', 'access-affecting', $6, 'h-new', $7::jsonb, $8::jsonb)`,
      [ref, baseline.id, observed.id, key, type, hash, JSON.stringify(before), JSON.stringify(after)],
    );
  }
  // Alice touched the policy two hours ago, before the backup that still held it; the
  // sync app changed it half an hour ago. Only the second is inside the change window.
  for (const [id, minutes, kind, actor] of [["entra:alice-ca:0", 120, "user", ALICE], ["entra:sync-ca:0", 30, "servicePrincipal", SYNC_APP]] as const) {
    await client.query(
      `INSERT INTO audit_change_fact (tenant_ref, source_event_id, occurred_at, target_type, target_id, operation, activity, fields, actor_kind, actor_id)
       VALUES ($1, $2, now() - $3 * interval '1 minute', 'policy', $4, 'update', 'Update conditional access policy', '{}', $5, $6)`,
      [ref, id, minutes, CA, kind, actor],
    );
  }

  const data = await getDriftData();
  const ca = byKey(data.items, CA_KEY);
  assert.equal(ca.window.from, (previous.completed_at as Date).toISOString(), "the window starts at the last backup that still held it");
  assert.deepEqual([ca.verdict, ca.reason, ca.source], ["exact", "audit-record-names-resource", "audit"]);
  assert.deepEqual(ca.actors, [{ kind: "servicePrincipal", id: SYNC_APP, name: "Contoso Sync" }]);
  assert.equal(ca.resourceObjectId, CA);
  assert.equal(attributionSentence(ca), "The app Contoso Sync made this change, according to the audit log.");
  assert.match(attributionWhen(ca).sentence, /^Changed .+, from the Microsoft Entra audit log\.$/);
  assert.equal(attributionNextStep(ca), null);
  assert.equal(attributionSummary(ca), "The app Contoso Sync, confirmed by the Microsoft Entra audit log.");

  const sp = byKey(data.items, SP_KEY);
  assert.deepEqual([sp.verdict, sp.reason, sp.source, sp.service], ["unknown", "audit-source-not-read", null, "SharePoint"]);
  assert.equal(attributionSentence(sp), "Microsoft keeps SharePoint's changes in the Purview audit log, which Keel does not read yet.");
  assert.match(attributionNextStep(sp) ?? "", /search the Purview audit log .* AuditLogsQuery\.Read\.All/);
  assert.match(attributionWhen(sp).sentence, /^Changed between .+ and .+, between two backups\.$/);
});
