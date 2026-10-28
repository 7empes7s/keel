import { PORTAL_QUEUED_JOBS_PER_PRINCIPAL } from "../../engine/jobs/queue.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { PAGE_RESTORE_WORKLOADS as ENGINE_PAGE_RESTORE_WORKLOADS } from "../../engine/restore/workloads/restoreChoices.mjs";
import { JOB_HANDLERS } from "../../cli/keel-worker.mjs";

import { GET as choicesRoute } from "@/app/api/actions/restore/workload/route";
import { POST as workloadDryRunRoute } from "@/app/api/actions/restore/workload/dry-run/route";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { PAGE_RESTORE_WORKLOADS, choiceChangeWords, startsFromPage } from "@/lib/restore-workloads-view";
import { tenantRef } from "@/lib/runtime-config";

// Restore: starting a restore for Exchange, Teams and Purview from the page. The page
// reads one backup's objects, then starts a dry run of exactly the chosen ones; the
// approval is the same POST /api/actions/restore as every other restore.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;
let older: string;
let newest: string;
let otherTenant: string;

const RESTORER = "1b2a4a00-0000-4000-8000-0000000000d1";
const restorer = { principalId: RESTORER, capabilities: ["read", "restore"] };

async function collection(ref: string, at: string, rules: Record<string, Record<string, unknown>>) {
  const { rows } = await client.query(
    `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
     VALUES ($1, 'exchange-mail-flow', 'complete', $2, $2, $2) RETURNING id`,
    [ref, at],
  );
  for (const [id, fields] of Object.entries(rules)) {
    await client.query(
      `INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, $2, $3)`,
      [rows[0].id, `transportrule:${id}`, JSON.stringify({ identity: id, kind: "transportRule", Name: `KEEL-RT ${id}`, ...fields })],
    );
  }
  return String(rows[0].id);
}

function request(path: string, options: { principalId?: string; capabilities?: string[]; body?: unknown } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.principalId) headers.set(PRINCIPAL_ID_HEADER, options.principalId);
  if (options.capabilities) headers.set(CAPABILITIES_HEADER, options.capabilities.join(" "));
  return new Request(`http://localhost${path}`, options.body === undefined
    ? { headers }
    : { method: "POST", headers, body: JSON.stringify(options.body) });
}

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    try {
      const match = /^KEEL_DB_TEST_URL=(.*)$/m.exec(readFileSync("/etc/keel/db.env", "utf8"));
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    } catch { /* CI sets it */ }
  }
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  const admin = await database.connect();
  try {
    await admin.query(schemaSql());
  } finally {
    await admin.end();
  }
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-workload-start-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "restore-workload-start-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  client = await database.connect();
  await client.query(`INSERT INTO principal (id, email) VALUES ($1, 'restorer@workload.test')`, [RESTORER]);

  older = await collection(tenantRef(), "2026-10-01T06:00:00Z", { a: { Mode: "Enforce" }, b: { Mode: "Enforce" }, c: { Mode: "Enforce" } });
  newest = await collection(tenantRef(), "2026-10-02T06:00:00Z", { a: { Mode: "Audit" }, c: { Mode: "Enforce" } });
  otherTenant = await collection("someone-else", "2026-10-02T07:00:00Z", { z: { Mode: "Enforce" } });
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("the page and the engine agree on which services start from the page", () => {
  assert.deepEqual([...PAGE_RESTORE_WORKLOADS], [...ENGINE_PAGE_RESTORE_WORKLOADS]);
  const backup = { collectionId: "x", takenAt: null, items: 1, partial: false };
  assert.equal(startsFromPage({ workload: "exchange-mail-flow", writes: [{ verb: "Put back", name: "Mail flow rules", after: [] }], backup }), true);
  assert.equal(startsFromPage({ workload: "exchange-mail-flow", writes: [{ verb: "Put back", name: "Mail flow rules", after: [] }], backup: null }), false);
  assert.equal(startsFromPage({ workload: "sharepoint-site-settings", writes: [{ verb: "Put back", name: "SharePoint settings", after: [] }], backup }), false);
  assert.equal(choiceChangeWords({ change: "changed", tenantWide: true }), "Changed since this backup · Affects the whole tenant");
  assert.equal(choiceChangeWords({ change: null, tenantWide: false }), null);
});

test("choices need the restore capability and come from this tenant's backups", async () => {
  assert.equal((await choicesRoute(request("/api/actions/restore/workload?workload=exchange-mail-flow"))).status, 403);
  assert.equal((await choicesRoute(request("/api/actions/restore/workload?workload=exchange-mail-flow", { principalId: RESTORER, capabilities: ["read"] }))).status, 403);
  assert.equal((await choicesRoute(request("/api/actions/restore/workload?workload=sharepoint-site-settings", restorer))).status, 400);

  const latest = await choicesRoute(request("/api/actions/restore/workload?workload=exchange-mail-flow", restorer));
  assert.equal(latest.status, 200);
  const { choices } = await latest.json();
  assert.deepEqual(choices.backups.map((backup: { collectionId: string }) => backup.collectionId), [newest, older], "newest first, no other tenant's");
  assert.equal(choices.chosen.collectionId, newest);
  assert.deepEqual(choices.groups[0].items.map((item: { name: string; change: string | null }) => [item.name, item.change]), [["KEEL-RT a", null], ["KEEL-RT c", null]]);

  const earlier = await choicesRoute(request(`/api/actions/restore/workload?workload=exchange-mail-flow&collection=${older}`, restorer));
  const { choices: then } = await earlier.json();
  assert.deepEqual(then.groups[0].items.map((item: { name: string; change: string; restorable: boolean }) => [item.name, item.change, item.restorable]), [
    ["KEEL-RT a", "changed", true],
    ["KEEL-RT b", "deleted", false],
    ["KEEL-RT c", "same", true],
  ]);
  const foreign = await choicesRoute(request(`/api/actions/restore/workload?workload=exchange-mail-flow&collection=${otherTenant}`, restorer));
  assert.equal(foreign.status, 404, "another tenant's backup is not readable");
});

test("a dry run starts for exactly the chosen objects, and only as a dry run", async () => {
  const body = { workload: "exchange-mail-flow", collectionId: older, targets: ["transportrule:a", "transportrule:a"] };
  assert.equal((await workloadDryRunRoute(request("/api/actions/restore/workload/dry-run", { body }))).status, 403);

  for (const bad of [
    { ...body, mode: "enforce" },
    { ...body, collectorConfig: "/tmp/elsewhere.json" },
    { ...body, workload: "sharepoint-site-settings" },
    { ...body, targets: [] },
    { ...body, collectionId: otherTenant },
  ]) {
    const refused = await workloadDryRunRoute(request("/api/actions/restore/workload/dry-run", { ...restorer, body: bad }));
    assert.equal(refused.status, 400, `refused: ${JSON.stringify(bad)}`);
  }

  const response = await workloadDryRunRoute(request("/api/actions/restore/workload/dry-run", { ...restorer, body }));
  assert.equal(response.status, 202);
  const { runs } = await response.json();
  assert.equal(runs.length, 1, "a policy workload is one dry run");
  const [{ job, artifactId, target }] = runs;
  assert.equal(target, null);
  const { rows: [stored] } = await client.query("SELECT kind, params, requested_by FROM job WHERE id = $1", [job.id]);
  assert.equal(stored.kind, "restore");
  assert.deepEqual(stored.params, { workloadRestore: { workload: "exchange-mail-flow", collectionId: older, targets: ["transportrule:a"] }, artifactId });
  assert.deepEqual(
    JOB_HANDLERS.restore.argsFor(stored.params, { requested_by: stored.requested_by }),
    ["--workload", "exchange-mail-flow", "--collection", older, "--target", "transportrule:a", "--persist-artifact", artifactId, "--requested-by", RESTORER],
    "the worker runs exactly this dry run",
  );
});

test("several mailboxes start one dry run each; the organization goes with the first mailbox", async () => {
  const { rows: [run] } = await client.query(
    `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
     VALUES ($1, 'exchange-mailbox-settings', 'complete', $2, $2, $2) RETURNING id`,
    [tenantRef(), "2026-10-02T06:00:00Z"],
  );
  const mailboxes = String(run.id);
  for (const [key, fields] of [
    ["mailbox:keel-rt-a@x.test", { identity: "KEEL-RT-A@x.test", mailboxSettings: { timeZone: "UTC" } }],
    ["mailbox:keel-rt-b@x.test", { identity: "KEEL-RT-B@x.test", mailboxSettings: { timeZone: "UTC" } }],
    ["organization", { organization: { MailTipsLargeAudienceThreshold: 25 } }],
  ] as const) {
    await client.query(`INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, $2, $3)`, [mailboxes, key, JSON.stringify(fields)]);
  }

  const listed = await choicesRoute(request("/api/actions/restore/workload?workload=exchange-mailbox-settings", restorer));
  const { choices } = await listed.json();
  assert.deepEqual(choices.groups.map((group: { name: string; items: { name: string }[] }) => [group.name, group.items.map((item) => item.name)]), [
    ["Mailboxes", ["KEEL-RT-A@x.test", "KEEL-RT-B@x.test"]],
    ["Organization", ["Organization-wide Exchange settings"]],
  ]);

  const post = (targets: string[]) => workloadDryRunRoute(request("/api/actions/restore/workload/dry-run", {
    ...restorer, body: { workload: "exchange-mailbox-settings", collectionId: mailboxes, targets },
  }));
  assert.equal((await post(["organization"])).status, 400, "the organization needs a mailbox");
  assert.equal((await post(["transportrule:a"])).status, 400, "only mailboxes from this workload");

  const response = await post(["mailbox:keel-rt-a@x.test", "organization", "mailbox:keel-rt-b@x.test"]);
  assert.equal(response.status, 202);
  const { runs } = await response.json();
  assert.deepEqual(runs.map((entry: { target: string }) => entry.target), ["mailbox:keel-rt-a@x.test", "mailbox:keel-rt-b@x.test"]);
  const argv: unknown[] = [];
  for (const entry of runs) {
    const { rows: [stored] } = await client.query("SELECT params, requested_by FROM job WHERE id = $1", [entry.job.id]);
    const params = stored.params as { artifactId: string };
    assert.equal(params.artifactId, entry.artifactId);
    argv.push(JOB_HANDLERS.restore.argsFor(params, { requested_by: stored.requested_by }));
  }
  assert.deepEqual(argv, [
    ["--workload", "exchange-mailbox-settings", "--collection", mailboxes, "--mailbox", "keel-rt-a@x.test", "--include-organization",
      "--allow-tenant-wide-test-writes", "--persist-artifact", runs[0].artifactId, "--requested-by", RESTORER],
    ["--workload", "exchange-mailbox-settings", "--collection", mailboxes, "--mailbox", "keel-rt-b@x.test",
      "--persist-artifact", runs[1].artifactId, "--requested-by", RESTORER],
  ]);

  // Security audit run 2, finding 11: a request that would pass the queue cap part way
  // through queues none of its runs.
  const { rows: [{ n: waiting }] } = await client.query(
    "SELECT count(*)::int AS n FROM job WHERE requested_by = $1 AND status = 'queued'", [RESTORER]);
  for (let index = Number(waiting); index < PORTAL_QUEUED_JOBS_PER_PRINCIPAL - 1; index++) {
    await client.query("INSERT INTO job (kind, params, requested_by) VALUES ('collect', '{}', $1)", [RESTORER]);
  }
  const before = (await client.query("SELECT count(*)::int AS n FROM job", [])).rows[0].n;
  const full = await post(["mailbox:keel-rt-a@x.test", "mailbox:keel-rt-b@x.test"]);
  assert.equal(full.status, 429);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM job", [])).rows[0].n, before, "nothing was queued");
  await client.query("DELETE FROM job WHERE requested_by = $1 AND kind = 'collect'", [RESTORER]);
});

test("a team plan reads as its settings and one members table, in names", async () => {
  const { changeTables, targetWords } = await import("@/components/restore/workload-restore");
  const names = (key: string) => (key === "team:t-1" ? "KEEL-RT Falcon" : "a setting");
  const tables = changeTables([
    { naturalKey: "teams:t-1:settings", kind: "settings", changes: [{ field: "memberSettings.allowCreateUpdateChannels", before: false, after: true }] },
    { naturalKey: "teams:t-1:member:x|1", kind: "member-add", member: { displayName: "KEEL-RT Ana", roles: ["owner"] } },
    { naturalKey: "teams:t-1:member:x|2", kind: "member-update", member: { displayName: "KEEL-RT Bo", roles: [] }, before: ["owner"] },
    { naturalKey: "teams:t-1:member:x|3", kind: "member-remove", member: { displayName: "", roles: [] } },
  ], names);
  assert.deepEqual(tables.map((table) => [table.title, table.rows.length]), [["Team settings", 1], ["Members", 3]]);
  assert.deepEqual(tables[1].rows, [
    { field: "KEEL-RT Ana", before: "Not in the team", after: "Owner" },
    { field: "KEEL-RT Bo", before: "Owner", after: "Member" },
    { field: "A member without a name", before: "Member", after: "Removed from the team" },
  ]);
  assert.equal(targetWords("exchange:mailbox:keel-rt-a@x.test:retention", names), "Hold and retention");
  assert.equal(targetWords("teams:t-1:members", names), "Members");
  assert.equal(targetWords("team:t-1", names), "KEEL-RT Falcon");
});
