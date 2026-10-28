// Security audit run 2: findings 10 (denied requests flood the evidence chain) and 11 (one
// person can fill the job queue).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { capabilityForJobKind } from "../../engine/authz/jobCapabilities.mjs";
import { PORTAL_QUEUED_JOBS_PER_PRINCIPAL } from "../../engine/jobs/queue.mjs";
import { ATTEMPT_EVIDENCE_KIND, guarded, guardedAction } from "@/lib/action";
import { createDenialThrottle } from "@/lib/denial-throttle";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

interface Client {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
interface Database { url: string; connect(): Promise<Client>; cleanup(): Promise<void> }

const TENANT = "denied-evidence-throttle-test";
let database: Database;
let client: Client;

before(async () => {
  database = (await createIsolatedTestDatabase(import.meta.url)) as Database;
  client = await database.connect();
  await client.query(schemaSql());
});

after(async () => {
  await client.end();
  await database.cleanup();
});

function deps(now: () => number) {
  return {
    databaseUrl: () => database.url,
    connect: () => database.connect(),
    tenantRef: () => TENANT,
    denialThrottle: createDenialThrottle({ windowMs: 60_000, now }),
  };
}

function request(headers: Record<string, string> = {}, body: unknown = {}) {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function deniedRows(action: string) {
  const { rows } = await client.query(
    `SELECT actor, subject FROM evidence
      WHERE tenant_ref = $1 AND kind = $2 AND subject->>'action' = $3 ORDER BY seq`,
    [TENANT, ATTEMPT_EVIDENCE_KIND, action],
  );
  return rows as { actor: string; subject: Record<string, unknown> }[];
}

test("the throttle records the first of a kind, counts repeats, and folds the count into the next record", () => {
  let clock = 0;
  const throttle = createDenialThrottle({ windowMs: 1000, now: () => clock });
  assert.equal(throttle.admit("a"), 0);
  assert.equal(throttle.admit("a"), null);
  assert.equal(throttle.admit("a"), null);
  assert.equal(throttle.admit("b"), 0, "another actor or reason is its own kind");
  clock = 1000;
  assert.equal(throttle.admit("a"), 2);
  assert.equal(throttle.admit("a"), null);
});

test("a denial whose record failed is let through again, with its repeats kept", () => {
  const throttle = createDenialThrottle({ windowMs: 1000, now: () => 0 });
  assert.equal(throttle.admit("a"), 0);
  assert.equal(throttle.admit("a"), null);
  throttle.forget("a", 0);
  assert.equal(throttle.admit("a"), 1, "the next denial is recorded and carries the one repeat");
});

test("the throttle stays bounded and never skips the first denial of a new kind", () => {
  const clock = 0;
  const throttle = createDenialThrottle({ windowMs: 1000, maxTracked: 3, now: () => clock });
  for (let index = 0; index < 10; index++) assert.equal(throttle.admit(`k${index}`), 0);
});

test("a burst of identical denied requests writes one record, and the next window carries the count", async () => {
  let clock = 1_000_000;
  const route = guarded({ action: "throttle-burst", capability: "collect" }, async () => Response.json({}), deps(() => clock));
  const denied = { [PRINCIPAL_ID_HEADER]: "principal-flood", [CAPABILITIES_HEADER]: "read" };
  for (let index = 0; index < 25; index++) {
    const response = await route(request(denied));
    assert.equal(response.status, 403, "every denied request is still refused");
  }
  let rows = await deniedRows("throttle-burst");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].subject, { action: "throttle-burst", decision: "denied", reason: "capability" });

  // An unauthenticated caller is a different kind of denial: it is recorded at once.
  assert.equal((await route(request())).status, 403);
  rows = await deniedRows("throttle-burst");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].actor, "unauthenticated");

  clock += 60_000;
  assert.equal((await route(request(denied))).status, 403);
  rows = await deniedRows("throttle-burst");
  assert.equal(rows.length, 3);
  assert.equal(rows[2].subject.repeatedDenials, 24);
});

test("one person cannot queue more than the cap; a replay at the cap returns the existing job", async () => {
  const capability = capabilityForJobKind("drift-detect");
  assert.ok(capability);
  const route = guardedAction({ action: "drift-detect", jobKind: "drift-detect", requiresApproval: false, acceptsParams: false }, deps(() => 0));
  const person = { [PRINCIPAL_ID_HEADER]: "principal-busy", [CAPABILITIES_HEADER]: capability };
  for (let index = 0; index < PORTAL_QUEUED_JOBS_PER_PRINCIPAL; index++) {
    assert.equal((await route(request({ ...person, "idempotency-key": `busy-${index}` }))).status, 202);
  }
  const full = await route(request(person));
  assert.equal(full.status, 429);
  const body = await full.json();
  assert.equal(body.error, "queue_full");
  assert.match(body.message, /waiting to run/);

  const replay = await route(request({ ...person, "idempotency-key": "busy-0" }));
  assert.equal(replay.status, 202, "a retried request still gets its job back");

  const other = { [PRINCIPAL_ID_HEADER]: "principal-other", [CAPABILITIES_HEADER]: capability };
  assert.equal((await route(request(other))).status, 202, "the cap is per person");

  const { rows } = await client.query("SELECT count(*)::int AS n FROM job WHERE requested_by = 'principal-busy'");
  assert.equal(rows[0].n, PORTAL_QUEUED_JOBS_PER_PRINCIPAL);
});
