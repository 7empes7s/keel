import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { canonicalHash } from "../../engine/cir/canonicalHash.mjs";
import { applyWave } from "../../engine/restore/applyEngine.mjs";
import { runRemediate } from "../../cli/keel-remediate.mjs";
import { guardedAction, guardedApprovalDecision } from "@/lib/action";
import { remediationSelection } from "@/lib/remediation-preview";
import { DATA_SURFACES, guardedRead } from "@/lib/read";
import { POST } from "@/app/api/actions/remediate/selection/route";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

interface Client {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
interface Database { url: string; connect(): Promise<Client>; cleanup(): Promise<void> }
let database: Database;
let client: Client;
const config = { tenantId: "task-38-preview", clientId: "collector" };
const tenant = `sha256:${createHash("sha256").update(config.tenantId).digest("hex").slice(0, 16)}`;
const ids = new Map<string, string>();
const liveGroups = [
  { id: "synced-id", displayName: "Synced", mailNickname: "synced", description: "live drift", onPremisesSyncEnabled: true },
  { id: "excluded-id", displayName: "Excluded", mailNickname: "excluded" },
  { id: "lockout-id", displayName: "Lockout", mailNickname: "lockout" },
  { id: "ops-id", displayName: "Ops", mailNickname: "ops" },
];
const deletedGroups = [{ id: "deleted-id", displayName: "Deleted", mailNickname: "deleted", deletedDateTime: "2026-09-08T00:00:00Z" }];
const ca = { id: "ca-id", displayName: "Protect", conditions: { users: { excludeGroups: ["excluded-id"] } } };
const assignment = { id: "role-id", principalId: "break-glass-id", roleDefinitionId: "62e90394-69f5-4237-9190-012177145e10", directoryScopeId: "/" };
let collectorFailure = false;
let protectedPrincipal = true;
let writerConstructions = 0;
let writes = 0;
const tokens: string[] = [];
class Reader {
  async collect(_version: string, path: string) {
    if (collectorFailure) return { items: [], error: { status: 403 } };
    if (path.startsWith("/groups?")) return { items: liveGroups, error: null };
    if (path === "/directory/deletedItems/microsoft.graph.group") return { items: deletedGroups, error: null };
    if (path === "/identity/conditionalAccess/policies") return { items: [ca], error: null };
    if (path.startsWith("/roleManagement/directory/roleAssignments")) return { items: protectedPrincipal ? [assignment] : [], error: null };
    if (path === "/organization") return { items: [{ id: config.tenantId }], error: null };
    return { items: [], error: null };
  }
  async get() { return { ok: true, status: 200, body: { accountEnabled: true } }; }
}
class Writer {
  constructor() { writerConstructions += 1; }
  async write() { writes += 1; throw new Error("a refused resource reached the writer"); }
}
const engineDependencies = {
  GraphReader: Reader,
  GraphWriter: Writer,
  getToken: async ({ clientId }: { clientId: string }) => {
    tokens.push(clientId);
    return { accessToken: "test-token" };
  },
};
const deps = {
  connect: async () => database.connect(),
  databaseUrl: () => database.url,
  tenantRef: () => tenant,
};
const previewRoute = guardedRead(DATA_SURFACES.remediateSelectionApi, remediationSelection({
  ...deps, collectorConfig: () => config, engineDependencies,
}));
const enforceRoute = guardedAction({ action: "remediate", jobKind: "remediate", requiresApproval: true }, deps);
const approveRoute = guardedApprovalDecision("approve", deps);
function request(body: unknown, capabilities = ["read", "remediate"], path = "/api/actions/remediate/selection", principal = "operator") {
  return new Request(`http://localhost${path}`, { method: "POST", headers: {
    "content-type": "application/json",
    [PRINCIPAL_ID_HEADER]: principal,
    [CAPABILITIES_HEADER]: capabilities.join(" "),
  }, body: JSON.stringify(body) });
}
function selection(...names: string[]) { return { driftIds: names.map((name) => ids.get(name)) }; }

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    process.env.KEEL_DB_TEST_URL = /^KEEL_DB_TEST_URL=(.*)$/m.exec(env)?.[1];
  }
  database = await createIsolatedTestDatabase(import.meta.url) as Database;
  client = await database.connect();
  await client.query(readFileSync(new URL("../../engine/store/schema.sql", import.meta.url), "utf8"));
  const snapshot = (await client.query("INSERT INTO snapshot (tenant_ref, status) VALUES ($1, 'complete') RETURNING id", [tenant])).rows[0].id;
  const baseline = (await client.query("INSERT INTO baseline (tenant_ref, set_by) VALUES ($1, 'test') RETURNING id", [tenant])).rows[0].id;
  for (const [name, changeType, blastRadius] of [
    ["Synced", "modified", "access-affecting"],
    ["Excluded", "added", "access-affecting"],
    ["Lockout", "added", "tenant-lockout"],
    ["Ops", "modified", "access-affecting"],
    ["New", "removed", "access-affecting"],
    ["Deleted", "removed", "access-affecting"],
    ["Gone", "added", "access-affecting"],
  ]) {
    const payload = { displayName: name, mailNickname: name.toLowerCase() };
    if (changeType !== "added") {
      const version = (await client.query(`INSERT INTO resource_version
        (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
        VALUES ($1, $2, 'group', $3, $4, 'normal', $5, 'full', '{}') RETURNING id`,
      [snapshot, `group:${name.toLowerCase()}`, payload, canonicalHash(payload, "group"), blastRadius])).rows[0].id;
      await client.query("INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id) VALUES ($1,$2,$3)", [baseline, `group:${name.toLowerCase()}`, version]);
    }
    const drift = (await client.query(`INSERT INTO drift
      (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type, blast_radius)
      VALUES ($1,$2,$3,$4,'group',$5,$6) RETURNING id`, [tenant, baseline, snapshot, `group:${name.toLowerCase()}`, changeType, blastRadius])).rows[0].id;
    ids.set(name, String(drift));
  }
});
after(async () => { await client?.end(); await database?.cleanup(); });

test("preview requires both capabilities, including on the exported route", async () => {
  for (const capabilities of [[], ["read"], ["remediate"]]) {
    assert.equal((await previewRoute(request(selection("Synced"), capabilities))).status, 403);
  }
  assert.equal((await POST(request({}, ["remediate"]))).status, 403);
});

test("preview validates IDs and hides unknown or foreign drift before reading Graph", async () => {
  for (const driftIds of [[], ["invalid"], "invalid"]) {
    assert.equal((await previewRoute(request({ driftIds }))).status, 400);
  }
  const beforeTokens = tokens.length;
  assert.equal((await previewRoute(request({ driftIds: [randomUUID()] }))).status, 404);
  await client.query("UPDATE drift SET tenant_ref = 'foreign' WHERE id = $1", [ids.get("Synced")]);
  try { assert.equal((await previewRoute(request(selection("Synced")))).status, 404); }
  finally { await client.query("UPDATE drift SET tenant_ref = $1 WHERE id = $2", [tenant, ids.get("Synced")]); }
  assert.equal(tokens.length, beforeTokens);
});

async function state() {
  const tables = ["job", "approval_request", "evidence", "rollback_entry", "drift", "baseline", "baseline_resource", "resource_version"];
  const rows = [];
  for (const table of tables) rows.push((await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows);
  return rows;
}

test("preview plans current live verbs and waves with guard refusals, read-only and no job", async () => {
  const beforeState = await state();
  const beforeWriters = writerConstructions;
  tokens.length = 0;
  const beforeLive = JSON.stringify([liveGroups, deletedGroups, ca]);
  const response = await previewRoute(request(selection(...ids.keys())));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const preview = await response.json();
  assert.deepEqual(Object.fromEntries(preview.resources.map((r: { naturalKey: string; verb: string }) => [r.naturalKey, r.verb])), {
    "group:deleted": "restore-soft-deleted", "group:excluded": "delete", "group:gone": "noop",
    "group:lockout": "delete", "group:new": "create", "group:ops": "noop", "group:synced": "update",
  });
  assert.deepEqual(preview.waves, [["group:deleted", "group:gone", "group:new", "group:ops", "group:synced"]]);
  assert.deepEqual(preview.deletionWaves, [["group:excluded", "group:lockout"]]);
  assert.deepEqual(preview.guardRefusals.map((r: { naturalKey: string }) => r.naturalKey).sort(), ["group:excluded", "group:lockout", "group:synced"]);
  assert.match(preview.guardRefusals.find((r: { naturalKey: string }) => r.naturalKey === "group:synced").reason, /onPremisesSyncEnabled=true/);
  assert.deepEqual(await state(), beforeState, "preview must not enqueue, request approval, journal, record an attempt, or alter stored resources");
  assert.equal(writerConstructions, beforeWriters);
  assert.equal(writes, 0);
  assert.deepEqual(tokens, ["collector"], "no Restorer token may be requested");
  assert.equal(JSON.stringify([liveGroups, deletedGroups, ca]), beforeLive);
});

test("direct API promotion cannot bypass any refusal shown in preview", async () => {
  const body = selection("Synced", "Excluded", "Lockout");
  const previewResponse = await previewRoute(request(body));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.guardRefusals.length, 3);
  // No preview artifact, client-side guard decision or UI confirmation is sent.
  const response = await enforceRoute(request({ ...body, mode: "enforce", guardRefusals: [], justification: "direct API test" }));
  assert.equal(response.status, 202);
  const { approvalRequest } = await response.json();
  const approved = await approveRoute(request({}, ["approve"], `/api/approvals/${approvalRequest.id}/approve`, "different-approver"));
  assert.equal(approved.status, 202);
  const { job } = await approved.json();
  const skipped: unknown[] = [];
  // Task 8 reconciliation: an enforce run must first persist its immutable dry-run
  // artifact, and a dry run whose guards refused resources is itself 'refused' — so
  // the artifact-only promotion is refused before any write. The applyWave spy still
  // proves the real guards independently reproduced every preview refusal.
  await assert.rejects(runRemediate({
    driftIds: job.params.driftIds,
    mode: job.params.mode,
    collectorConfig: config,
    targetConfig: { ...config, clientId: "restorer" },
    targetConfigPath: "/fixtures/task-46-restorer.json",
    collectorConfigPath: "/fixtures/task-46-collector.json",
    requestedBy: "operator",
    readFile: (path: string) => JSON.stringify(
      path.includes("restorer") ? { ...config, clientId: "restorer" } : config,
    ),
    acceptDegradation: false,
    dbUrl: database.url,
    logger: { ...console, log() {} },
    dependencies: { ...engineDependencies, applyWave: async (...args: unknown[]) => {
      const result = await Reflect.apply(applyWave, undefined, args);
      skipped.push(...(result.skipped as unknown[]));
      return result;
    } },
  }), /restore promotion refused/);
  assert.deepEqual(skipped, preview.guardRefusals, "the real enforce guards must independently reproduce every preview refusal");
  assert.equal(writes, 0, "direct promotion must never write a refused resource");
});

test("missing safety evidence is a refusal; failed live collection is unavailable", async () => {
  protectedPrincipal = false;
  try {
    const response = await previewRoute(request(selection("Synced")));
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.match(preview.guardRefusals[0].reason, /requires at least one protected principal/);
  } finally { protectedPrincipal = true; }
  collectorFailure = true;
  try { assert.equal((await previewRoute(request(selection("Synced")))).status, 503); }
  finally { collectorFailure = false; }
});
