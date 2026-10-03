import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { grantRole } from "../../engine/authz/administration.mjs";
import { captureApprovalScope } from "../../engine/authz/entityScope.mjs";
import { requestApproval } from "../../engine/govern/approvals.mjs";
import { createFixtureCmdbAdapter } from "../../engine/identity/adapters/cmdb.mjs";
import { resolveOwnership } from "../../engine/identity/ownership.mjs";
import { recordLineage } from "../../engine/store/resourceLineage.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";

import { GET as driftRoute } from "@/app/api/drift/route";
import { GET as approvalsRoute } from "@/app/api/approvals/route";
import { POST as approveRoute } from "@/app/api/approvals/[id]/approve/route";
import {
  CAPABILITIES_HEADER,
  ENTITY_CAPABILITIES_HEADER,
  PRINCIPAL_ID_HEADER,
  entityScopeFrom,
} from "@/lib/principal";
import { DATA_SURFACES, readAccess } from "@/lib/read";
import { grantSentence } from "@/components/principal-details";
import { tenantRef } from "@/lib/runtime-config";

// Roadmap task-90, portal boundary: the read guard admits an entity-scoped reader only
// on surfaces whose loader filters rows in SQL, the drift loader returns only that
// entity's rows and counts, and the approval inbox and decision route apply the
// engine's scope. Identity headers are set as proxy.ts would set them.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const HOUR = 60 * 60 * 1000;
const CREOS_GROUP = "11111111-1111-1111-1111-111111111111";
const ENOVOS_GROUP = "22222222-2222-2222-2222-222222222222";
const CREOS_KEY = "group:Grid Operations Admins";
const ENOVOS_KEY = "group:Retail Billing Admins";

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
let ref: string;
const people: Record<string, string> = {};
const requests: Record<string, string> = {};

function headers(principalId: string, central: string[], entity: string[] = []): Headers {
  const result = new Headers({ "content-type": "application/json" });
  result.set(PRINCIPAL_ID_HEADER, principalId);
  result.set(CAPABILITIES_HEADER, central.join(" "));
  result.set(ENTITY_CAPABILITIES_HEADER, entity.join(" "));
  return result;
}

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    for (const line of readFileSync("/etc/keel/db.env", "utf8").split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  client = await database.connect();
  await client.query(readFileSync(new URL("../../engine/store/schema.sql", import.meta.url), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-scope-test-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "task-90-scope-portal-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  ref = tenantRef();

  for (const [name, grants] of Object.entries({
    collector: [["operator", null]],
    requester: [["restorer", null]],
    creosApprover: [["approver", "CREOS"]],
    enovosApprover: [["approver", "ENOVOS"]],
  } as Record<string, [string, string | null][]>)) {
    const { rows: [row] } = await client.query("INSERT INTO principal(email) VALUES ($1) RETURNING id", [`${name}@example.invalid`]);
    people[name] = String(row.id);
    for (const [role, entityCode] of grants) {
      await grantRole(client, { principalId: people[name], role, grantedBy: "fixture", activeFrom: "2020-01-01Z", entityCode });
    }
  }

  const observedAt = new Date(Date.now() - HOUR);
  await recordLineage(client, { tenantRef: ref, resourceType: "group", sourceId: CREOS_GROUP, naturalKey: CREOS_KEY, observedAt });
  await recordLineage(client, { tenantRef: ref, resourceType: "group", sourceId: ENOVOS_GROUP, naturalKey: ENOVOS_KEY, observedAt });
  const adapter = createFixtureCmdbAdapter({
    tenantRef: ref,
    records: [
      { resourceType: "group", sourceId: CREOS_GROUP, recordRef: "CI-1111", owners: ["Creos Luxembourg S.A."] },
      { resourceType: "group", sourceId: ENOVOS_GROUP, recordRef: "CI-2222", owners: ["Enovos Luxembourg S.A."] },
    ] as never[], // the fixture adapter's JSDoc-less default types its records as never[]
  });
  const config = {
    entities: {
      CREOS: { cmdbValues: ["Creos Luxembourg S.A."], codePrefixes: ["CRE"] },
      ENOVOS: { cmdbValues: ["Enovos Luxembourg S.A."], codePrefixes: ["ENO"] },
    },
  };
  for (const sourceId of [CREOS_GROUP, ENOVOS_GROUP]) {
    await resolveOwnership(client, {
      tenantRef: ref, managedTenantRef: ref, requestedBy: people.collector, resourceType: "group", sourceId, adapter, config,
    });
  }

  // An active baseline holding both groups, and open drift on both.
  const { rows: [snapshot] } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, completed_at) VALUES ($1, 'complete', now()) RETURNING id", [ref],
  );
  const { rows: [baseline] } = await client.query(
    "INSERT INTO baseline (tenant_ref, set_by, active) VALUES ($1, 'fixture', true) RETURNING id", [ref],
  );
  for (const key of [CREOS_KEY, ENOVOS_KEY]) {
    const { rows: [version] } = await client.query(
      `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, 'group', '{}'::jsonb, 'h-' || $2, 'normal', 'access-affecting', 'full', '{}'::jsonb) RETURNING id`,
      [snapshot.id, key],
    );
    await client.query("INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id) VALUES ($1, $2, $3)", [baseline.id, key, version.id]);
    await client.query(
      `INSERT INTO drift (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, blast_radius)
       VALUES ($1, $2, $3, $4, 'group', 'modified', 'access-affecting')`,
      [ref, baseline.id, snapshot.id, key],
    );
  }

  for (const [name, key] of [["creos", CREOS_KEY], ["enovos", ENOVOS_KEY]] as const) {
    const entityScope = await captureApprovalScope(client, { tenantRef: ref, resources: [{ resourceType: "group", naturalKey: key }] });
    const request = (await requestApproval(client, {
      tenantRef: ref, action: "remediate", params: {}, requestedBy: people.requester, entityScope,
    })) as { id: string };
    requests[name] = request.id;
  }
});

after(async () => {
  await client.end();
  await database.cleanup();
});

test("the read guard admits an entity-only reader only on entity-scoped surfaces", () => {
  const entityOnly = headers("p", [], ["read:CREOS", "approve:ENOVOS", "read:bad", "read:creos"]);
  assert.deepEqual(entityScopeFrom(entityOnly, "read"), { central: false, entities: ["CREOS"] }, "malformed tokens grant nothing");
  assert.deepEqual(readAccess(entityOnly, DATA_SURFACES.driftApi)?.scope, { central: false, entities: ["CREOS"] });
  assert.equal(readAccess(entityOnly, DATA_SURFACES.dashboardApi), null, "an unfiltered surface refuses entity-only readers");
  assert.equal(readAccess(entityOnly, DATA_SURFACES.coveragePage), null);
  assert.equal(readAccess(headers("p", [], []), DATA_SURFACES.driftApi), null);
  assert.deepEqual(readAccess(headers("p", ["read"], ["read:CREOS"]), DATA_SURFACES.dashboardApi)?.scope, { central: true, entities: [] });
  const grant = { id: "g", role: "viewer", active_from: "2026-09-01T00:00:00Z", active_until: null };
  assert.equal(grantSentence({ ...grant, scope: "entity:CREOS" }, "2026-10-03T00:00:00Z"), "Viewer for CREOS resources only since 1 Sept 2026");
  assert.equal(grantSentence({ ...grant, scope: "*" }, "2026-10-03T00:00:00Z"), "Viewer since 1 Sept 2026");
});

test("the drift API returns only the reader's entity, and its counts say so", async () => {
  const central = await (await driftRoute(new Request("http://localhost/api/drift", { headers: headers(people.collector, ["read"]) }))).json();
  assert.deepEqual(central.items.map((item: { naturalKey: string }) => item.naturalKey).sort(), [CREOS_KEY, ENOVOS_KEY].sort());
  assert.equal(central.baseline.resourceCount, 2);
  assert.equal(central.scope, undefined);

  const response = await driftRoute(new Request("http://localhost/api/drift", { headers: headers(people.creosApprover, [], ["read:CREOS"]) }));
  assert.equal(response.status, 200);
  const scoped = await response.json();
  assert.deepEqual(scoped.items.map((item: { naturalKey: string }) => item.naturalKey), [CREOS_KEY]);
  assert.equal(scoped.baseline.resourceCount, 1, "the baseline count does not include another entity's resources");
  assert.deepEqual(scoped.scope, { central: false, entities: ["CREOS"] });
  assert.ok(!JSON.stringify(scoped).includes("Retail Billing"));
});

test("the approval inbox and decision route apply the approver's entity scope", async () => {
  const inbox = async (h: Headers) => (await (await approvalsRoute(new Request("http://localhost/api/approvals", { headers: h }))).json()) as { pending: { id: string }[] };
  assert.deepEqual((await inbox(headers(people.creosApprover, [], ["approve:CREOS"]))).pending.map((row) => row.id), [requests.creos]);
  assert.equal((await approvalsRoute(new Request("http://localhost/api/approvals", { headers: headers(people.creosApprover, [], ["read:CREOS"]) }))).status, 403);

  const decide = (id: string, who: string, entity: string[]) => approveRoute(new Request(`http://localhost/api/approvals/${id}/approve`, {
    method: "POST", headers: headers(who, [], entity), body: "{}",
  }));
  const refused = await decide(requests.creos, people.enovosApprover, ["approve:ENOVOS"]);
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "forbidden", handoff: "central" }, "a handoff, naming neither entity nor resource");
  assert.equal((await decide(requests.creos, people.enovosApprover, [])).status, 403, "no approve anywhere is refused at the guard");
  assert.equal((await decide(requests.creos, people.creosApprover, ["approve:CREOS"])).status, 202);
});
