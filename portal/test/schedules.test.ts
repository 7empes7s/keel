import "./next-async-storage";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { GET, POST } from "@/app/api/schedules/route";
import SchedulesPage from "@/app/schedules/page";
import { ScheduleTable } from "@/components/schedule-table";
import { visibleNavLinks } from "@/components/nav-links";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import type { Schedule, SchedulesData } from "@/lib/schedules";

interface Client { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> }
interface Database { url: string; connect(): Promise<Client>; cleanup(): Promise<void> }
let database: Database;
let client: Client;
let configDir: string;
const tenantId = "task-44-local";
const tenant = `sha256:${createHash("sha256").update(tenantId).digest("hex").slice(0, 16)}`;
const admin = randomUUID();
const viewer = randomUUID();
const cadence = { every: "day", n: 1, atTime: "05:00" };
const failure = "429 Too Many Requests\nRetry-After: 120\n  rate-limit: Graph throttled this collection";
const deferral = "drift-detect deferred: collection snapshot has failed or missing per-type coverage; retry on next successful collect";
const ids: string[] = [];
let foreignId: string;
let failedJobId: string;
const originalUrl = process.env.KEEL_DB_URL;
const originalConfig = process.env.KEEL_TENANT_CONFIG_PATH;

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    process.env.KEEL_DB_TEST_URL = env.split("\n").find((line) => line.startsWith("KEEL_DB_TEST_URL="))?.slice("KEEL_DB_TEST_URL=".length);
  }
  database = await createIsolatedTestDatabase(import.meta.url) as Database;
  client = await database.connect();
  await client.query(readFileSync(new URL("../../engine/store/schema.sql", import.meta.url), "utf8"));
  configDir = mkdtempSync(join(tmpdir(), "keel-schedules-test-"));
  writeFileSync(join(configDir, "tenant.json"), JSON.stringify({ tenantId }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(configDir, "tenant.json");
  await client.query("INSERT INTO principal (id, email) VALUES ($1, 'admin@fixture.test'), ($2, 'viewer@fixture.test')", [admin, viewer]);
  await client.query("INSERT INTO role_grant (principal_id, role) VALUES ($1, 'admin'), ($2, 'viewer')", [admin, viewer]);
  for (const [kind, tier] of [["collect", "tier1"], ["collect", "tier2"], ["collect", "tier3"], ["prune", null], ["offsite", null]]) {
    const { rows } = await client.query(
      "INSERT INTO schedule (tenant_ref, job_kind, tier, cadence, next_due_at) VALUES ($1, $2, $3, $4, now() + interval '1 day') RETURNING id",
      [tenant, kind, tier, cadence],
    );
    ids.push(String(rows[0].id));
  }
  foreignId = String((await client.query(
    "INSERT INTO schedule (tenant_ref, job_kind, tier, cadence, next_due_at) VALUES ('foreign', 'collect', 'tier1', $1, now()) RETURNING id", [cadence],
  )).rows[0].id);
  failedJobId = String((await client.query(
    `INSERT INTO job (kind, status, params, requested_by, error, started_at, finished_at)
     VALUES ('collect', 'failed', $1, $2, $3, '2026-09-29T10:00:00Z', '2026-09-29T10:01:00Z') RETURNING id`,
    [{ tenantRef: tenant, tier: "tier1" }, admin, failure],
  )).rows[0].id);
  await client.query("UPDATE schedule SET last_job_id = $2 WHERE id = $1", [ids[0], failedJobId]);
  for (const [scope, retried, error] of [[tenant, false, deferral], [tenant, true, "drift-detect deferred: already retried"], ["foreign", false, "drift-detect deferred: foreign secret"]]) {
    await client.query("INSERT INTO job (kind, status, params, requested_by, error, result) VALUES ('drift-detect', 'failed', $1, $2, $3, $4)",
      [{ tenantRef: scope }, admin, error, retried ? { retriedByJobId: failedJobId } : {}]);
  }
});

after(async () => {
  await client?.end();
  await database?.cleanup();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  if (originalUrl === undefined) delete process.env.KEEL_DB_URL; else process.env.KEEL_DB_URL = originalUrl;
  if (originalConfig === undefined) delete process.env.KEEL_TENANT_CONFIG_PATH; else process.env.KEEL_TENANT_CONFIG_PATH = originalConfig;
});

function request(method = "GET", capabilities = "read", principal: string | null = viewer, body?: unknown) {
  const headers = new Headers({ [CAPABILITIES_HEADER]: capabilities });
  if (principal) headers.set(PRINCIPAL_ID_HEADER, principal);
  return new Request("http://localhost/api/schedules", { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function row(id = ids[0]) { return (await client.query("SELECT * FROM schedule WHERE id = $1", [id])).rows[0]; }
async function edit(changes: Record<string, unknown>, id = ids[0]) { return POST(request("POST", "configuration", admin, { id, ...changes })); }

test("schedule GET refuses unauthenticated and no-read requests before opening the loader", async () => {
  const saved = process.env.KEEL_DB_URL;
  process.env.KEEL_DB_URL = "postgres://invalid:invalid@127.0.0.1:1/never-connect";
  try {
    for (const req of [request("GET", "", null), request("GET", "read", null), request("GET", "configuration", admin)]) {
      const response = await GET(req);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "forbidden" });
    }
  } finally { process.env.KEEL_DB_URL = saved; }
});

test("read-only GET exposes exactly five local schedules, verbatim failures and unresolved local deferrals", async () => {
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json() as SchedulesData;
  assert.equal(data.schedules.length, 5);
  assert.deepEqual(new Set(data.schedules.map((s) => s.id)), new Set(ids));
  const failed = data.schedules.find((s) => s.id === ids[0])!;
  assert.equal(failed.last_error, failure);
  assert.equal(failed.last_run_at, "2026-09-29T10:00:00.000Z");
  assert.deepEqual(data.deferrals.map((d) => d.error), [deferral]);
  const html = renderToStaticMarkup(createElement(ScheduleTable, { ...data, canEdit: false }));
  assert.ok(html.includes(`<pre class="job-error job-payload">${failure}</pre>`));
  assert.ok(html.includes(deferral));
  assert.ok(html.includes(`href="/jobs/${failedJobId}"`));
  assert.ok(html.includes("Every 1 day at 05:00 UTC"));
  assert.ok(!html.includes("Edit collect"));
  assert.ok(!html.includes("foreign secret"));
});

test("read-only edits are denied before schedule lookup and are recorded as denied attempts", async () => {
  const before = await row();
  for (const req of [request("POST", "read", viewer, { id: ids[0], enabled: false }), request("POST", "configuration", null, { id: ids[0], enabled: false })]) {
    const response = await POST(req);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden" });
  }
  assert.deepEqual(await row(), before);
  const { rows } = await client.query("SELECT subject FROM evidence WHERE actor = $1 AND subject->>'action' = 'schedules:update'", [viewer]);
  assert.ok(rows.length);
  assert.ok(rows.every((r) => (r.subject as { decision: string }).decision === "denied"), "the wrapper must deny, not attempt a write that the engine later rejects");
});

test("configuration edits persist builder, cron and enabled state through the scheduler boundary", async () => {
  const jobsBefore = (await client.query("SELECT count(*) FROM job")).rows[0].count;
  for (const every of ["hour", "day", "week"]) {
    const response = await edit({ cadence: { every, n: 4, atTime: "17:30" }, cron_override: null, enabled: false });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    const saved = await row();
    assert.deepEqual(saved.cadence, { every, n: 4, atTime: "17:30" });
    assert.equal(saved.enabled, false);
    assert.ok(new Date(String(saved.next_due_at)).valueOf() > Date.now());
    assert.equal(saved.last_job_id, failedJobId);
  }
  assert.equal((await edit({ cron_override: "0 */4 * * *", enabled: true })).status, 200);
  assert.equal((await row()).cron_override, "0 */4 * * *");
  assert.equal((await edit({ cron_override: null })).status, 200);
  assert.equal((await row()).cron_override, null);
  assert.equal((await client.query("SELECT count(*) FROM job")).rows[0].count, jobsBefore, "saving cadence does not execute a job");
});

test("write route rejects malformed changes and minimum-gap violations without changing the schedule", async () => {
  for (const id of [ids[0], ids[3], ids[4]]) {
    for (const changes of [
      { cron_override: "0,5 * * * *" }, { cron_override: "55,5 23,0 * * *" },
      { cron_override: "* * * * *" }, { cadence: { every: "minute", n: 1 } },
      { cadence: { every: "day", n: 0 } }, { cadence: { every: "day", n: 1, atTime: "25:00" } },
      { cadence: { every: "constructor", n: 1 } }, { cadence: { every: "day", n: 1, unexpected: true } },
      { cadence: null }, { cron_override: 7 }, { cron_override: "not a cron" },
      { enabled: "false" }, { tenant_ref: "foreign" }, { job_kind: "backup" }, {},
    ]) {
      const before = await row(id);
      const response = await edit(changes, id);
      assert.equal(response.status, 400, JSON.stringify(changes));
      if (changes.cron_override === "0,5 * * * *") assert.match((await response.json()).error, /^schedule_minimum_interval:/);
      assert.deepEqual(await row(id), before);
    }
  }
});

test("write route refuses foreign and unknown ids; current engine authorization rejects revoked grants", async () => {
  const foreignBefore = await row(foreignId);
  for (const id of [foreignId, randomUUID(), "bad-id"]) assert.equal((await edit({ enabled: false }, id)).status, 404);
  assert.deepEqual(await row(foreignId), foreignBefore);
  const before = await row();
  await client.query("UPDATE role_grant SET active_until = now() - interval '1 second' WHERE principal_id = $1", [admin]);
  try {
    assert.equal((await edit({ enabled: false })).status, 403);
    assert.deepEqual(await row(), before);
  } finally { await client.query("UPDATE role_grant SET active_until = NULL WHERE principal_id = $1", [admin]); }
});

test("the actual schedules page gives viewers data and configuration principals edit controls", async () => {
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  for (const [capabilities, principal] of [["read", viewer], ["read configuration", admin]]) {
    const page = await workAsyncStorage.run({ route: "/schedules", forceStatic: false, dynamicShouldError: false } as never, () =>
      workUnitAsyncStorage.run({
        type: "request", phase: "render", headers: request("GET", capabilities, principal).headers,
        implicitTags: [], url: { pathname: "/schedules", search: "" }, rootParams: {},
        resumeDataCache: null, isHmrRefresh: false, fallbackParams: null,
      } as never, () => SchedulesPage()),
    );
    const table = (page.props.children as ReactElement<{ schedules: Schedule[]; canEdit: boolean }>[]).find((child) => child.type === ScheduleTable)!;
    assert.ok(table);
    assert.equal(table.props.canEdit, capabilities.includes("configuration"));
    assert.equal(table.props.schedules.length, 5);
    if (!table.props.canEdit) assert.ok(renderToStaticMarkup(page).includes(failure));
  }
});

test("Schedules primary navigation is visible exactly with read", () => {
  for (const canRead of [true, false]) {
    const link = visibleNavLinks({ canRead, canPolicies: true }).find((item) => item.href === "/schedules");
    assert.equal(Boolean(link), canRead);
    if (link) assert.equal(link.label, "Schedules");
  }
});
