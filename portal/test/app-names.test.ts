import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { derivedName, referencedIds } from "@/lib/app-names";
import { changeLabel } from "@/lib/changes-view";
import { holdsObjectId, namedSubject } from "@/lib/job-names";
import { resourceLabel } from "@/lib/presentation";
import { idNames, savedNames } from "@/lib/saved-names";

// App registrations, enterprise apps, app consent, app permissions, owners and
// provisioning jobs read by name on every page, never by an id. Fixtures use the id
// shapes Graph really returns (lessons/fixture-id-shapes.md): an app consent grant id
// is a 43-character base64url token and a provisioning job id carries two 32-hex runs,
// neither of which is a GUID.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const TENANT = "app-names-test";
const HR_APP_ID = "1fec8e78-bce4-4aaf-ab1b-5451cc387264";
const HR_SP_ID = "6a0b0000-0000-4000-8000-0000000000a1";
const HR_APP_OBJECT_ID = "6a0b0000-0000-4000-8000-0000000000a2";
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
const GRAPH_SP_ID = "6a0b0000-0000-4000-8000-0000000000b1";
const ROLE_ID = "df021288-bdef-4463-88db-98f22de89214";
const USER_ID = "6a0b0000-0000-4000-8000-0000000000c1";
const GRANT_ID = "l5eW7x0ga0-WDOntXzHateQDNpSH5-lPk9HjD3Sarjk";
const SYNC_JOB_ID = "AD2AADProvisioning.6f3c2b1a9d8e4f7081726354a5b6c7d8.0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const ROLE_GRANT_KEY = `edge:appRoleGrant:${HR_SP_ID}:${GRAPH_SP_ID}:${ROLE_ID}`;
const OWNER_KEY = `edge:appOwner:${HR_APP_OBJECT_ID}:${USER_ID}`;

const ROWS: { key: string; type: string; payload: Record<string, unknown> }[] = [
  { key: HR_APP_ID, type: "servicePrincipal", payload: { id: HR_SP_ID, appId: HR_APP_ID, displayName: "Contoso HR" } },
  { key: GRAPH_APP_ID, type: "servicePrincipal", payload: {
    id: GRAPH_SP_ID, appId: GRAPH_APP_ID, displayName: "Microsoft Graph",
    appRoles: [{ id: ROLE_ID, value: "User.Read.All", displayName: "Read all users' full profiles" }],
  } },
  { key: `app:${HR_APP_ID}`, type: "application", payload: { id: HR_APP_OBJECT_ID, appId: HR_APP_ID, displayName: "Contoso HR (registration)" } },
  { key: "ada@contoso.example", type: "user", payload: { id: USER_ID, displayName: "Ada Lovelace" } },
  { key: GRANT_ID, type: "oauth2PermissionGrant", payload: {
    id: GRANT_ID, clientId: HR_SP_ID, resourceId: GRAPH_SP_ID, consentType: "Principal", principalId: USER_ID, scope: "User.Read",
  } },
  { key: SYNC_JOB_ID, type: "synchronizationJob", payload: { id: SYNC_JOB_ID, templateId: "AD2AADProvisioning", servicePrincipalId: HR_SP_ID } },
];

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;

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
  client = await database.connect();
  const { rows } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', $2, $2) RETURNING id",
    [TENANT, "2026-10-01T06:00:00Z"],
  );
  for (const row of ROWS) {
    await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, $5, 'critical', 'access-affecting', 'full', '{}')`,
      [rows[0].id, row.key, row.type, JSON.stringify(row.payload), JSON.stringify(row.payload)],
    );
  }
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("the id check catches every Graph id shape, not only GUIDs, and leaves names alone", () => {
  for (const id of [HR_APP_ID, GRANT_ID, SYNC_JOB_ID, "xqQg5FS2LkCp935s-FIFm2QAFkHM", `Grant ${GRANT_ID} (app consent)`]) {
    assert.equal(holdsObjectId(id), true, id);
  }
  for (const name of ["Contoso HR", "Microsoft Graph", "WindowsDefenderATP2024", "contoso-human-resources-provisioning-app", "Office 365 E5", "User.Read.All"]) {
    assert.equal(holdsObjectId(name), false, name);
  }
});

test("a label made from a key alone never prints the key, or prints it twice", () => {
  assert.equal(resourceLabel(HR_APP_ID), "Unnamed setting");
  assert.equal(resourceLabel(GRANT_ID), "Unnamed setting");
  assert.equal(resourceLabel(HR_APP_ID, "Contoso HR"), "Contoso HR");
  assert.equal(resourceLabel(ROLE_GRANT_KEY), "Unnamed app permission");
  assert.equal(resourceLabel("conditionalAccessPolicy:Block legacy auth"), "Block legacy auth (Conditional Access policy)");
  assert.equal(resourceLabel(`group:${USER_ID}`), "Unnamed group");
  assert.equal(resourceLabel("organizationalBranding"), "Company branding");
  assert.equal(namedSubject(GRANT_ID, {}, "oauth2PermissionGrant"), "Unnamed app consent");
  assert.equal(namedSubject(SYNC_JOB_ID, {}, "synchronizationJob"), "Unnamed provisioning job");
  assert.equal(namedSubject(ROLE_GRANT_KEY), "Unnamed app permission");
});

test("app settings with no name of their own are named from what they point to", () => {
  const names = {
    ids: { [HR_SP_ID]: "Contoso HR", [GRAPH_SP_ID]: "Microsoft Graph", [USER_ID]: "Ada Lovelace", [HR_APP_OBJECT_ID]: "Contoso HR", [HR_APP_ID]: "Contoso HR" },
    roles: { [ROLE_ID]: "User.Read.All" },
  };
  const grant = ROWS.find((row) => row.type === "oauth2PermissionGrant")!.payload;
  assert.equal(derivedName("oauth2PermissionGrant", GRANT_ID, grant, names), "Contoso HR to Microsoft Graph for Ada Lovelace");
  assert.equal(derivedName("oauth2PermissionGrant", GRANT_ID, { ...grant, consentType: "AllPrincipals" }, names), "Contoso HR to Microsoft Graph");
  assert.equal(derivedName("oauth2PermissionGrant", GRANT_ID, { ...grant, clientId: "6a0b0000-0000-4000-8000-0000000000ff" }, names),
    "an app Keel does not back up to Microsoft Graph for Ada Lovelace");
  assert.equal(derivedName("appRoleGrant", ROLE_GRANT_KEY, null, names), "Contoso HR can use Microsoft Graph: User.Read.All");
  assert.equal(derivedName("applicationOwnership", OWNER_KEY, null, names), "Ada Lovelace as owner of Contoso HR");
  assert.equal(derivedName("synchronizationJob", SYNC_JOB_ID, { servicePrincipalId: HR_SP_ID }, names), "Contoso HR provisioning");
  assert.equal(derivedName("sharepointSiteAppGrant", `sharepoint:site-app-grant:site-1:${HR_APP_ID}`, { applications: [{ id: HR_APP_ID }] }, names), "Contoso HR");
  assert.equal(derivedName("oauth2PermissionGrant", GRANT_ID, grant, { ids: {}, roles: {} }), null);
  assert.equal(derivedName("group", `group:${USER_ID}`, {}, names), null);
  assert.deepEqual(referencedIds("appRoleGrant", ROLE_GRANT_KEY), { ids: [HR_SP_ID, GRAPH_SP_ID], roles: [ROLE_ID] });
});

test("saved names come from the newest backup for every app type, with no id in any label", async () => {
  const keys = [HR_APP_ID, `app:${HR_APP_ID}`, GRANT_ID, SYNC_JOB_ID, ROLE_GRANT_KEY, OWNER_KEY];
  const names = await savedNames(client, TENANT, keys);
  const labels = Object.fromEntries(keys.map((key) => [key, namedSubject(key, names)]));
  assert.equal(labels[HR_APP_ID], "Contoso HR (enterprise app)");
  assert.equal(labels[`app:${HR_APP_ID}`], "Contoso HR (registration) (app registration)");
  assert.equal(labels[GRANT_ID], "Contoso HR to Microsoft Graph for Ada Lovelace (app consent)");
  assert.equal(labels[SYNC_JOB_ID], "Contoso HR provisioning (provisioning job)");
  assert.equal(labels[ROLE_GRANT_KEY], "Contoso HR can use Microsoft Graph: User.Read.All (app permission)");
  assert.equal(labels[OWNER_KEY], "Ada Lovelace as owner of Contoso HR (registration) (app registration owner)");
  for (const label of Object.values(labels)) assert.equal(holdsObjectId(label), false, label);
});

test("the Changes list names a grant from its saved copy", async () => {
  const lookup = await idNames(client, TENANT, [HR_SP_ID, GRAPH_SP_ID, USER_ID]);
  const grant = ROWS.find((row) => row.type === "oauth2PermissionGrant")!.payload;
  const name = derivedName("oauth2PermissionGrant", GRANT_ID, grant, lookup);
  const label = changeLabel({ naturalKey: GRANT_ID, resourceType: "oauth2PermissionGrant", name });
  assert.equal(label, "Contoso HR to Microsoft Graph for Ada Lovelace (app consent)");
  // With no saved copy to read, the label is a plain stand-in, never the grant id.
  assert.equal(changeLabel({ naturalKey: GRANT_ID, resourceType: "oauth2PermissionGrant", name: null }), "Unnamed app consent");
});

test("another tenant's backup names nothing", async () => {
  const names = await savedNames(client, "another-tenant", [GRANT_ID, ROLE_GRANT_KEY]);
  assert.equal(namedSubject(GRANT_ID, names, "oauth2PermissionGrant"), "Unnamed app consent");
  assert.equal(namedSubject(ROLE_GRANT_KEY, names), "Unnamed app permission");
});
