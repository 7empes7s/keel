import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { ActivityTimeline, mergeActivity } from "@/components/activity-timeline";
import { JobTable } from "@/components/job-table";
import { asPerson, entrySubjectKey } from "@/lib/activity-names";
import { normalizeJob } from "@/lib/action";
import { jobErrorLine } from "@/lib/job-names";
import { nameChanges, withSavedChangeNames } from "@/lib/saved-names";
import { EMPTY_REFERENCES, type EngineRef, evidenceSentence, jobName } from "@/lib/sentences";

// Activity and the job lists name people and objects, never by an email address, a
// system code or an object id; those stay in Technical details.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const TENANT = "activity-names-test";
const GROUP_ID = "5d1c0000-0000-4000-8000-0000000000f1";
const GROUP_KEY = `group:${GROUP_ID}`;
const PERSON_ID = "8c1e0000-0000-4000-8000-0000000000a1";
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NOW = "2026-10-02T10:00:00Z";
// What a reader sees: the text outside Technical details, without markup.
const text = (html: string) => html.replace(/<details[\s\S]*?<\/details>/g, "").replace(/<[^>]*>/g, "").replaceAll("&#x27;", "'");

const person = (overrides: Partial<EngineRef> = {}): EngineRef => ({
  kind: "person", id: PERSON_ID, name: "maro.defili@contoso.example", email: "maro.defili@contoso.example", readable: true, system: false, ...overrides,
});
const change = (naturalKey: string) => ({ kind: "change", id: "d9200000-0000-4000-8000-000000000001", name: null, readable: true, naturalKey, resourceType: "group" });

function rollback(naturalKey: string, requester: EngineRef = person()) {
  return normalizeJob({
    id: "a1000000-0000-4000-8000-000000000001", kind: "remediate", status: "failed", params: { driftIds: ["d9200000-0000-4000-8000-000000000001"] },
    error: `Graph 404 on /groups/${GROUP_ID}\n  at write`, requested_by: PERSON_ID, created_at: "2026-10-02T09:00:00Z", finished_at: "2026-10-02T09:01:00Z",
    references: { ...EMPTY_REFERENCES, people: { requested_by: requester }, changes: [change(naturalKey)] },
  });
}

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
  const payload = { id: GROUP_ID, displayName: "Finance approvers" };
  await client.query(
    `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
     VALUES ($1, $2, 'group', $3, $4, 'critical', 'access-affecting', 'full', '{}')`,
    [rows[0].id, GROUP_KEY, JSON.stringify(payload), JSON.stringify(payload)],
  );
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("a roll back job is named by the saved name of its change, never its id", async () => {
  const [named] = await withSavedChangeNames(client, TENANT, [rollback(GROUP_KEY)]);
  assert.equal(jobName(named), "Roll back of 1 change, including Finance approvers (group)");
  // No saved name: the count alone, never the id.
  const [unnamed] = await withSavedChangeNames(client, "another-tenant", [rollback(GROUP_KEY)]);
  assert.equal(jobName(unnamed), "Roll back of 1 change");
  assert.equal(jobName(nameChanges(rollback("group:Finance"), {})), "Roll back of 1 change, including Finance (group)");
});

test("a failed name lookup leaves the jobs as they were", async () => {
  const broken = { query: async () => { throw new Error("database down"); } };
  const jobs = [rollback(GROUP_KEY)];
  const original = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await withSavedChangeNames(broken, TENANT, jobs), jobs);
  } finally {
    console.error = original;
  }
});

test("the job table names who asked by name and hides ids in the failed line", () => {
  const html = renderToStaticMarkup(createElement(JobTable, { headingId: "h", jobs: [rollback("group:Finance")], title: "Jobs", now: NOW }));
  const visible = text(html);
  assert.ok(visible.includes("asked by Maro Defili"), visible);
  assert.ok(!visible.includes("@"), "no email outside Technical details");
  assert.ok(!GUID.test(visible), "no id outside Technical details");
  assert.ok(visible.includes("It stopped with an error"));
  assert.ok(html.includes(`Graph 404 on /groups/${GROUP_ID}`), "the full error stays in Technical details");
  const system = renderToStaticMarkup(createElement(JobTable, {
    headingId: "h", jobs: [rollback("group:Finance", person({ id: "scheduler", name: "scheduler", email: null, system: true }))], title: "", now: NOW,
  }));
  assert.ok(text(system).includes("asked by Keel's scheduler"), system);
});

test("a failed line keeps a plain error and drops the error class", () => {
  assert.equal(jobErrorLine("TypeError: Graph 429: throttled\n at x"), "Graph 429: throttled");
  assert.equal(jobErrorLine(`not found: ${GROUP_ID}`), "It stopped with an error. Open the job to see what went wrong.");
  assert.equal(jobErrorLine(""), "It stopped with an error. Open the job to see what went wrong.");
});

test("audit entries name the actor and the object, never an email, code or id", () => {
  const entries = [
    { seq: "3", occurred_at: "2026-10-02T09:30:00Z", kind: "approval-decision", actor: PERSON_ID, subject: { decision: "approve" } },
    { seq: "2", occurred_at: "2026-10-02T09:20:00Z", kind: "policy-evaluation", actor: "policy-automation", subject: { naturalKey: GROUP_KEY, matched: true } },
    { seq: "1", occurred_at: "2026-10-02T09:10:00Z", kind: "approval-request", actor: "7c6d5e4f-0000-4000-8000-0000000000aa", subject: { action: "backup" } },
  ];
  const people = {
    [PERSON_ID]: person(),
    "policy-automation": { kind: "person", id: "policy-automation", name: "policy-automation", email: null, readable: true, system: true },
    "7c6d5e4f-0000-4000-8000-0000000000aa": { kind: "person", id: "7c6d5e4f-0000-4000-8000-0000000000aa", name: null, email: null, readable: false, system: false },
  };
  const names = { [GROUP_KEY]: { name: "Finance approvers", resourceType: "group" } };
  const html = renderToStaticMarkup(createElement(ActivityTimeline, { items: mergeActivity([], entries), people, names, now: NOW }));
  const visible = text(html);
  assert.ok(visible.includes("Maro Defili approved a request"), visible);
  assert.ok(visible.includes("Policies checked a change to Finance approvers (group), and one applied"), visible);
  assert.ok(visible.includes("An account that no longer exists asked for approval"), visible);
  assert.ok(!visible.includes("@") && !GUID.test(visible), visible);
  // Without a saved name the object is named in general words.
  assert.equal(evidenceSentence(entries[1], "Keel", {}), "Policies checked a change to Unnamed group, and one applied");
  // A lookup that failed leaves the actor as "Someone", never the stored value.
  const unresolved = renderToStaticMarkup(createElement(ActivityTimeline, { items: mergeActivity([], entries.slice(0, 1)), people: {}, now: NOW }));
  assert.ok(text(unresolved).includes("Someone approved a request"));
});

test("an actor recorded by email is a person, and entry subjects give their key", () => {
  const byEmail = asPerson({ kind: "person", id: "ops@contoso.example", name: "ops@contoso.example", readable: true, system: true });
  assert.equal(byEmail.system, false);
  assert.equal(byEmail.email, "ops@contoso.example");
  assert.equal(asPerson({ kind: "person", id: "scheduler", name: "scheduler", readable: true, system: true }).system, true);
  assert.equal(entrySubjectKey({ naturalKey: GROUP_KEY }), GROUP_KEY);
  assert.equal(entrySubjectKey(null), null);
});
