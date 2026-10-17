import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { getRestoreResources } from "@/lib/portal-data";
import { itemName, nameBook, plainLabel } from "@/lib/restore-view";
import { holdsObjectId } from "@/lib/object-ids";
import { tenantRef } from "@/lib/runtime-config";

// The Restore page names every saved setting by the name the backup holds, never by
// the Graph object id many types are stored under.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
let snapshotId = "";

const SCRIPT_ID = "5b1c2d3e-0000-4000-8000-00000000c0de";
// Graph's real shape for an app consent grant id: 43 base64url characters, not a GUID.
const GRANT_ID = "l5eW7x0ga0-WDOntXzHateQDNpSH5-lPk9HjD3Sarjk";
const NAMED_GRANT_ID = "Qm9vdHN0cmFwR3JhbnQ0Mk1pY3Jvc29mdEdyYXBoX2E";
const HR_APP_ID = "1fec8e78-bce4-4aaf-ab1b-5451cc387264";
const HR_SP_ID = "6a0b0000-0000-4000-8000-0000000000a1";
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
const GRAPH_SP_ID = "6a0b0000-0000-4000-8000-0000000000b1";
const PARTNER_TENANT = "11111111-2222-4333-8444-555555555555";

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
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-restore-names-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "restore-names-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  client = await database.connect();

  const { rows } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', $2, $2) RETURNING id`,
    [tenantRef(), "2026-10-02T06:00:00Z"],
  );
  snapshotId = String(rows[0].id);
  const versions: [string, string, Record<string, unknown>][] = [
    [SCRIPT_ID, "deviceManagementScript", { id: SCRIPT_ID, displayName: "Set time zone" }],
    [GRANT_ID, "oauth2PermissionGrant", { id: GRANT_ID, scope: "User.Read" }],
    [NAMED_GRANT_ID, "oauth2PermissionGrant", { id: NAMED_GRANT_ID, clientId: HR_SP_ID, resourceId: GRAPH_SP_ID, consentType: "AllPrincipals", scope: "User.Read" }],
    [HR_APP_ID, "servicePrincipal", { id: HR_SP_ID, appId: HR_APP_ID, displayName: "Contoso HR" }],
    [GRAPH_APP_ID, "servicePrincipal", { id: GRAPH_SP_ID, appId: GRAPH_APP_ID, displayName: "Microsoft Graph" }],
    [PARTNER_TENANT, "crossTenantAccessPolicyPartner", { tenantId: PARTNER_TENANT }],
    ["group:Finance", "group", { displayName: "Finance" }],
    ["user:ada@contoso.example", "user", { displayName: "Ada Lovelace", userPrincipalName: "ada@contoso.example" }],
    ["organizationalBranding", "organizationalBranding", { id: "0" }],
  ];
  for (const [naturalKey, resourceType, payload] of versions) {
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, $5, 'critical', 'access-affecting', 'full', '{}')`,
      [snapshotId, naturalKey, resourceType, JSON.stringify(payload), JSON.stringify(payload)],
    );
  }
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("the resources of a backup carry the name the backup holds", async () => {
  const data = await getRestoreResources(snapshotId);
  const byKey = new Map(data.resources.map((resource) => [resource.naturalKey, resource.name]));
  assert.equal(byKey.get(SCRIPT_ID), "Set time zone");
  assert.equal(byKey.get("user:ada@contoso.example"), "Ada Lovelace");
  assert.equal(byKey.get(GRANT_ID), null);
  assert.equal(byKey.get(NAMED_GRANT_ID), "Contoso HR to Microsoft Graph");
  assert.equal(byKey.get(HR_APP_ID), "Contoso HR");
  assert.equal(byKey.get(PARTNER_TENANT), null);
});

test("no setting on the Restore page is named by an object id", async () => {
  const { resources } = await getRestoreResources(snapshotId);
  const names = nameBook(resources);
  const labels = resources.map((resource) => itemName(resource.naturalKey, names));
  assert.deepEqual(new Map(resources.map((resource, index) => [resource.naturalKey, labels[index]])), new Map([
    [PARTNER_TENANT, "Unnamed cross-tenant access partner"],
    [SCRIPT_ID, "Set time zone"],
    [GRAPH_APP_ID, "Microsoft Graph"],
    [HR_APP_ID, "Contoso HR"],
    [NAMED_GRANT_ID, "Contoso HR to Microsoft Graph"],
    [GRANT_ID, "Unnamed app consent"],
    ["group:Finance", "Finance"],
    ["organizationalBranding", "Company branding"],
    ["user:ada@contoso.example", "Ada Lovelace"],
  ]));
  for (const resource of resources) {
    const shown = `${itemName(resource.naturalKey, names)} ${plainLabel(resource.naturalKey, names)}`;
    assert.equal(holdsObjectId(shown), false, `${resource.naturalKey}: ${shown}`);
  }
  assert.match(plainLabel(SCRIPT_ID, names), /^Set time zone \(.+\)$/);
});

test("without a name book, a key that is only an id still never shows", () => {
  assert.equal(itemName("group:Finance"), "Finance");
  assert.equal(plainLabel("namedLocation:HQ"), "HQ (trusted location)");
  assert.equal(itemName(SCRIPT_ID), "Unnamed setting");
  assert.equal(plainLabel(SCRIPT_ID), "Unnamed setting");
  assert.equal(plainLabel(GRANT_ID), "Unnamed setting");
  assert.equal(holdsObjectId(plainLabel(`roleAssignment:unknown:${GRANT_ID}@user:ada@/`)), false);
});
