import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { getDriftData, getRestoreResources } from "@/lib/portal-data";
import { tenantRef } from "@/lib/runtime-config";

// Conditional Access rules are rated by what each rule does, on the Restore page and on
// changes, even for rows stored with the old fixed "could lock out admins" rating.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
let snapshotId = "";

const SHAREPOINT = "00000003-0000-0ff1-ce00-000000000000";
const rule = (name: string, extra: Record<string, unknown>) => ({
  displayName: name,
  state: "enabled",
  conditions: { users: { includeUsers: ["All"] }, applications: { includeApplications: ["All"] } },
  grantControls: null,
  sessionControls: null,
  ...extra,
});
const SHAREPOINT_RULE = rule("[SharePoint admin center]Use app-enforced Restrictions for browser access", {
  conditions: { users: { includeUsers: ["All"] }, applications: { includeApplications: [SHAREPOINT] } },
  sessionControls: { applicationEnforcedRestrictions: { isEnabled: true } },
});
const BLOCK_ALL = rule("KEEL-RT-block-all", { grantControls: { operator: "OR", builtInControls: ["block"] } });
const BLOCK_ALL_OFF = { ...BLOCK_ALL, displayName: "KEEL-RT-block-all-off", state: "disabled" };

before(async () => {
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  const admin = await database.connect();
  try {
    await admin.query(schemaSql());
  } finally {
    await admin.end();
  }
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-rule-risk-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "rule-risk-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  client = await database.connect();

  const { rows } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', $2, $2) RETURNING id`,
    [tenantRef(), "2026-10-22T06:00:00Z"],
  );
  snapshotId = String(rows[0].id);
  const versions: [string, string, Record<string, unknown>][] = [
    ["conditionalAccessPolicy:sharepoint", "conditionalAccessPolicy", SHAREPOINT_RULE],
    ["conditionalAccessPolicy:block-all", "conditionalAccessPolicy", BLOCK_ALL],
    ["conditionalAccessPolicy:block-all-off", "conditionalAccessPolicy", BLOCK_ALL_OFF],
    ["namedLocation:Office", "namedLocation", { displayName: "Office" }],
  ];
  for (const [naturalKey, resourceType, payload] of versions) {
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, $5, 'tier1', 'tenant-lockout', 'full', '{}')`,
      [snapshotId, naturalKey, resourceType, JSON.stringify(payload), naturalKey],
    );
  }

  const { rows: [baseline] } = await client.query(
    `INSERT INTO baseline (tenant_ref, set_by) VALUES ($1, 'test') RETURNING id`,
    [tenantRef()],
  );
  const changes: [string, Record<string, unknown> | null, Record<string, unknown> | null][] = [
    ["conditionalAccessPolicy:sharepoint", SHAREPOINT_RULE, { ...SHAREPOINT_RULE, displayName: "renamed" }],
    ["conditionalAccessPolicy:block-all-off", BLOCK_ALL, BLOCK_ALL_OFF],
    ["conditionalAccessPolicy:new-off", null, { ...SHAREPOINT_RULE, state: "disabled" }],
  ];
  for (const [naturalKey, beforePayload, afterPayload] of changes) {
    await client.query(
      `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, before_hash, after_hash, before_payload, after_payload, blast_radius)
       VALUES ($1, $2, $3, $4, 'conditionalAccessPolicy', $5, $6, 'after', $7, $8, 'tenant-lockout')`,
      [tenantRef(), baseline.id, snapshotId, naturalKey, beforePayload ? "modified" : "added", beforePayload ? "before" : null,
        beforePayload ? JSON.stringify(beforePayload) : null, JSON.stringify(afterPayload)],
    );
  }
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("each Conditional Access rule on the Restore page is rated by what it does", async () => {
  const { resources } = await getRestoreResources(snapshotId);
  const rating = new Map(resources.map((resource) => [resource.naturalKey, resource.blastRadius]));
  assert.equal(rating.get("conditionalAccessPolicy:sharepoint"), "access-affecting");
  assert.equal(rating.get("conditionalAccessPolicy:block-all"), "tenant-lockout");
  assert.equal(rating.get("conditionalAccessPolicy:block-all-off"), "access-affecting");
  // Other types keep their type rating.
  assert.equal(rating.get("namedLocation:Office"), "tenant-lockout");
});

test("each change to a Conditional Access rule takes the stricter side", async () => {
  const data = await getDriftData();
  const rating = new Map(data.items.map((item) => [item.naturalKey, item.blastRadius]));
  assert.equal(rating.get("conditionalAccessPolicy:sharepoint"), "access-affecting");
  // Turning a block-all rule off is rated as lockout: putting it back turns it on.
  assert.equal(rating.get("conditionalAccessPolicy:block-all-off"), "tenant-lockout");
  assert.equal(rating.get("conditionalAccessPolicy:new-off"), "cosmetic");
});
