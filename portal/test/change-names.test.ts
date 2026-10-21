import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";

import { changeLabel, changeName, valueWords } from "@/lib/changes-view";
import { getDriftData } from "@/lib/portal-data";
import { tenantRef } from "@/lib/runtime-config";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

// The Changes page names every change and every object a change points to; an object
// id never shows outside Technical details.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

interface IsolatedDatabase {
  url: string;
  connect(): Promise<TestClient>;
  cleanup(): Promise<void>;
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SCRIPT_ID = "5c3e9f1a-0b7d-4e21-9a4c-2f6d8e1b0a11";
const GROUP_ID = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const MISSING_ID = "00000000-1111-4222-8333-444444444444";
const ROLE_TEMPLATE_ID = "62e90394-69f5-4237-9190-012177145e10";
// An app consent grant id is an opaque 43-character token, not a GUID.
const GRANT_ID = "Qm9vdHN0cmFwR3JhbnQ0Mk1pY3Jvc29mdEdyYXBoX2E";
const UNKNOWN_GRANT_ID = "l5eW7x0ga0-WDOntXzHateQDNpSH5-lPk9HjD3Sarjk";
const HR_SP_ID = "7d1c0000-0000-4000-8000-0000000000a1";
const GRAPH_SP_ID = "7d1c0000-0000-4000-8000-0000000000a2";

let database: IsolatedDatabase;
let client: TestClient;
let ref: string;

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    for (const line of env.split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = (await createIsolatedTestDatabase(import.meta.url)) as IsolatedDatabase;
  const admin = await database.connect();
  try {
    await admin.query(schemaSql());
  } finally {
    await admin.end();
  }
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-change-names-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "change-names-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  ref = tenantRef();
  client = await database.connect();
});

after(async () => {
  await client.end();
  await database.cleanup();
});

async function version(snapshot: string, naturalKey: string, type: string, payload: unknown) {
  await client.query(
    `INSERT INTO resource_version
       (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
     VALUES ($1, $2, $3, $4, 'hash-' || $2, 'normal', 'access-affecting', 'full', '{}'::jsonb)`,
    [snapshot, naturalKey, type, payload],
  );
}

test("the Changes data names each change and the objects its settings point to", async () => {
  const { rows: [baseline] } = await client.query(
    `INSERT INTO baseline (tenant_ref, set_by, active) VALUES ($1, 'test-operator', true) RETURNING id`, [ref],
  );
  const { rows: [snapshot] } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, completed_at) VALUES ($1, 'complete', now()) RETURNING id`, [ref],
  );
  const observed = String(snapshot.id);
  // The referenced group and role, as the collection that saw the change read them.
  await version(observed, `group:Finance approvers`, "group", { id: GROUP_ID, displayName: "Finance approvers" });
  await version(observed, ROLE_TEMPLATE_ID, "directoryRoleTemplate", { id: ROLE_TEMPLATE_ID, displayName: "Global Administrator" });
  // An app consent carries no name: it is named from the apps it links.
  await version(observed, GRANT_ID, "oauth2PermissionGrant", { id: GRANT_ID, clientId: HR_SP_ID, resourceId: GRAPH_SP_ID, consentType: "AllPrincipals", scope: "User.Read" });
  await version(observed, "servicePrincipal:Contoso HR", "servicePrincipal", { id: HR_SP_ID, displayName: "Contoso HR" });
  await version(observed, "servicePrincipal:Microsoft Graph", "servicePrincipal", { id: GRAPH_SP_ID, displayName: "Microsoft Graph" });

  const policyBefore = { displayName: "Block legacy auth", conditions: { users: { excludeGroups: [GROUP_ID], excludeRoles: [] } } };
  const policyAfter = { displayName: "Block legacy auth", conditions: { users: { excludeGroups: [GROUP_ID, MISSING_ID], excludeRoles: [ROLE_TEMPLATE_ID] } } };
  const changes = [
    { key: "conditionalAccessPolicy:Block legacy auth", type: "conditionalAccessPolicy", kind: "modified", before: policyBefore, after: policyAfter },
    // A type stored under its id: the name comes from the saved copy.
    { key: SCRIPT_ID, type: "deviceManagementScript", kind: "added", before: null, after: { id: SCRIPT_ID, displayName: "Set time zone" } },
    // A key that embeds ids and a copy with no name.
    { key: `roleAssignment:unknown:${ROLE_TEMPLATE_ID}@unknown:${MISSING_ID}@/`, type: "roleAssignment", kind: "removed", before: { roleDefinitionId: ROLE_TEMPLATE_ID, principalId: MISSING_ID }, after: null },
    // A field value that points to an app consent by its grant id.
    { key: "accessReviewScheduleDefinition:Consent review", type: "accessReviewScheduleDefinition", kind: "modified", before: { displayName: "Consent review", reviewed: UNKNOWN_GRANT_ID }, after: { displayName: "Consent review", reviewed: GRANT_ID, note: `Covers ${GRANT_ID} and ${UNKNOWN_GRANT_ID}` } },
  ];
  for (const change of changes) {
    await client.query(
      `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
                          before_hash, after_hash, before_payload, after_payload, blast_radius)
       VALUES ($1, $2, $3, $4, $5, $6, 'b', 'a', $7, $8, 'access-affecting')`,
      [ref, baseline.id, observed, change.key, change.type, change.kind, change.before, change.after],
    );
  }

  const data = await getDriftData();
  const byKey = new Map(data.items.map((item) => [item.naturalKey, item]));

  const policy = byKey.get(changes[0].key)!;
  assert.equal(changeName(policy), "Block legacy auth");
  assert.equal(policy.refNames?.[GROUP_ID], "Finance approvers");
  assert.equal(policy.refNames?.[ROLE_TEMPLATE_ID], "Global Administrator");
  assert.equal(policy.refNames?.[MISSING_ID], undefined);
  const groups = valueWords(policyAfter.conditions.users.excludeGroups, policy.refNames);
  assert.equal(groups, "Finance approvers, 1 other object KEEL has no name for");
  assert.equal(valueWords(policyAfter.conditions.users.excludeRoles, policy.refNames), "Global Administrator");

  const script = byKey.get(SCRIPT_ID)!;
  assert.equal(changeName(script), "Set time zone");
  assert.doesNotMatch(changeLabel(script), GUID);

  const assignment = byKey.get(changes[2].key)!;
  const name = changeName(assignment);
  assert.doesNotMatch(name, GUID);
  assert.match(name, /^Unnamed /);
  assert.doesNotMatch(changeLabel(assignment), GUID);

  const review = byKey.get(changes[3].key)!;
  const reviewAfter = changes[3].after as { reviewed: string; note: string };
  assert.equal(review.refNames?.[GRANT_ID.toLowerCase()], "Contoso HR to Microsoft Graph");
  assert.equal(valueWords(reviewAfter.reviewed, review.refNames), "Contoso HR to Microsoft Graph");
  assert.equal(valueWords(UNKNOWN_GRANT_ID, review.refNames), "an object KEEL has no name for");
  assert.equal(valueWords(reviewAfter.note, review.refNames), "Covers Contoso HR to Microsoft Graph and (unnamed object)");
});

test("names fall back to words, never to an id", () => {
  assert.equal(changeName({ naturalKey: SCRIPT_ID, resourceType: "deviceManagementScript" }), changeName({ naturalKey: SCRIPT_ID, resourceType: "deviceManagementScript", name: null }));
  assert.match(changeName({ naturalKey: SCRIPT_ID, resourceType: "deviceManagementScript" }), /^Unnamed /);
  assert.doesNotMatch(changeName({ naturalKey: SCRIPT_ID, resourceType: SCRIPT_ID }), GUID);
  assert.equal(changeName({ naturalKey: "group:Finance", resourceType: "group" }), "Finance");
  assert.equal(changeName({ naturalKey: "group:Finance", resourceType: "group", name: "Finance team" }), "Finance team");
  assert.equal(valueWords(MISSING_ID, {}), "an object KEEL has no name for");
  assert.equal(valueWords([MISSING_ID, MISSING_ID.replace("0000", "0001")], {}), "2 objects KEEL has no name for");
  assert.equal(valueWords(["All"], {}), "All");
  assert.equal(valueWords([GRANT_ID, UNKNOWN_GRANT_ID], {}), "2 objects KEEL has no name for");
  assert.equal(valueWords(`Job AD2AADProvisioning.0123456789abcdef0123456789abcdef.fedcba9876543210fedcba9876543210`, {}), "Job AD2AADProvisioning.(unnamed object).(unnamed object)");
  // Without a name book the words are as before.
  assert.equal(valueWords(["a", "b"]), "a, b");
});

test("a list or object value reads as its first settings, not a pointer to Technical details", () => {
  assert.equal(valueWords([{ appId: "x", scope: "Sites.Read.All" }]), "App id: x; Scope: Sites.Read.All");
  assert.equal(valueWords({ a: 1, b: { c: true, d: [1, 2] }, e: "x", f: null }), "A: 1; B › c: yes; B › d: 1, 2; and 2 more");
  assert.ok(!valueWords([{ a: 1 }, { a: 2 }]).includes("Technical details"));
});
