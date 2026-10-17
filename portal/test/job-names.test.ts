import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { CompensationPlanView, type CompensationPlan } from "@/components/compensation-panel";
import { ContentEffectList } from "@/components/content-effects";
import { CompletionChecklist } from "@/components/recovery-completion";
import { namedResource, namedSubject, type NamedKeys } from "@/lib/job-names";
import { keysToName, savedNames } from "@/lib/saved-names";
import { jobName } from "@/lib/sentences";

// A job's page names every setting by the name its backup holds, never by the Graph
// object id many types are stored under (follow-ups, undo plan, content effects).

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const TENANT = "job-names-test";
const SCRIPT_ID = "5b1c2d3e-0000-4000-8000-00000000c0de";
const USER_ID = "7c6d5e4f-0000-4000-8000-0000000000aa";
const GROUP_KEY = "group:Finance";
const NAMELESS_ID = "9a8b7c6d-0000-4000-8000-0000000000ff";
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;

async function snapshot(at: string, tenant = TENANT): Promise<string> {
  const { rows } = await client.query(
    "INSERT INTO snapshot (tenant_ref, status, started_at, completed_at) VALUES ($1, 'complete', $2, $2) RETURNING id",
    [tenant, at],
  );
  return String(rows[0].id);
}

async function version(snapshotId: string, naturalKey: string, resourceType: string, payload: Record<string, unknown>) {
  await client.query(
    `INSERT INTO resource_version (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
     VALUES ($1, $2, $3, $4, $5, 'critical', 'access-affecting', 'full', '{}')`,
    [snapshotId, naturalKey, resourceType, JSON.stringify(payload), JSON.stringify(payload)],
  );
}

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
  const older = await snapshot("2026-10-01T06:00:00Z");
  const newer = await snapshot("2026-10-02T06:00:00Z");
  const otherTenant = await snapshot("2026-10-03T06:00:00Z", "someone-else");
  await version(older, SCRIPT_ID, "deviceManagementScript", { id: SCRIPT_ID, displayName: "Old time zone script" });
  await version(newer, SCRIPT_ID, "deviceManagementScript", { id: SCRIPT_ID, displayName: "Set time zone" });
  await version(older, USER_ID, "user", { id: USER_ID, displayName: "Ada Lovelace" });
  await version(newer, USER_ID, "user", { id: USER_ID }); // the newest copy lost its name
  await version(newer, GROUP_KEY, "group", { displayName: "Finance" });
  await version(newer, NAMELESS_ID, "oauth2PermissionGrant", { id: NAMELESS_ID, scope: "User.Read" });
  await version(otherTenant, "group:Secret", "group", { displayName: "Other tenant" });
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("saved names come from the newest backup that holds one, for this tenant only", async () => {
  const names = await savedNames(client, TENANT, [SCRIPT_ID, `${GROUP_KEY}|member|${USER_ID}`, NAMELESS_ID, "group:Secret", null]);
  assert.deepEqual(names[SCRIPT_ID], { name: "Set time zone", resourceType: "deviceManagementScript" });
  assert.deepEqual(names[USER_ID], { name: "Ada Lovelace", resourceType: "user" });
  assert.deepEqual(names[GROUP_KEY], { name: "Finance", resourceType: "group" });
  assert.deepEqual(names[NAMELESS_ID], { name: null, resourceType: "oauth2PermissionGrant" });
  assert.equal(names["group:Secret"], undefined, "another tenant's backup is never read");
});

test("an edge is looked up by both of its ends", () => {
  assert.deepEqual(keysToName(["group:A|member|user:b", "group:A", "", undefined]), ["group:A", "user:b"]);
});

test("a key that is an id reads as its saved name, or as an unnamed setting", () => {
  const names: NamedKeys = {
    [SCRIPT_ID]: { name: "Set time zone", resourceType: "deviceManagementScript" },
    [NAMELESS_ID]: { name: null, resourceType: "oauth2PermissionGrant" },
    [USER_ID]: { name: "Ada Lovelace", resourceType: "user" },
  };
  assert.match(namedResource(SCRIPT_ID, names), /^Set time zone \(/);
  assert.match(namedResource(NAMELESS_ID, names), /^Unnamed /);
  assert.equal(namedResource(NAMELESS_ID), "Unnamed setting");
  assert.equal(namedResource("group:Finance"), "Finance (group)");
  assert.match(namedResource(`roleAssignment:unknown:${USER_ID}@x@/`), /^Unnamed /);
  assert.equal(namedSubject(`${GROUP_KEY}|member|${USER_ID}`, names), "Ada Lovelace (user) as member of Finance (group)");
  for (const text of [namedResource(NAMELESS_ID, names), namedSubject(`${GROUP_KEY}|member|${NAMELESS_ID}`, names)]) {
    assert.doesNotMatch(text, GUID);
  }
});

test("the follow-up checklist names the resource and keeps its key in Technical details", () => {
  const html = renderToStaticMarkup(createElement(CompletionChecklist, {
    canComplete: false,
    resources: [{
      naturalKey: SCRIPT_ID, resourceType: "deviceManagementScript", label: "Set time zone (device management script)",
      mechanism: "recreate", state: "configuration-restored",
      items: [{ id: "i1", kind: "integration", requirement: "newObjectId", description: "Update external references", owner: null, state: "pending", evidence: [], closedAt: null, reopenCount: 0 }],
    }],
  }));
  const [visible, record] = html.split('<details class="technical-details"');
  assert.match(visible, /Set time zone/);
  assert.doesNotMatch(visible, GUID);
  assert.match(record, new RegExp(SCRIPT_ID));
});

test("the undo plan and content effects name resources and edges, never ids", () => {
  const names: NamedKeys = {
    [SCRIPT_ID]: { name: "Set time zone", resourceType: "deviceManagementScript" },
    [USER_ID]: { name: "Ada Lovelace", resourceType: "user" },
    [GROUP_KEY]: { name: "Finance", resourceType: "group" },
    [NAMELESS_ID]: { name: null, resourceType: "oauth2PermissionGrant" },
  };
  const plan: CompensationPlan = {
    compensates: "11111111-2222-4333-8444-555555555555", atomic: false, statement: "",
    operations: [{ naturalKey: SCRIPT_ID, resourceType: "deviceManagementScript", verb: "update", undoes: "restore-update", revertedFields: ["displayName"] }],
    conflicts: [{ naturalKey: NAMELESS_ID, reason: "concurrent-change: scope changed after this restore" }],
    notApplied: [],
    manual: [{ naturalKey: `${GROUP_KEY}|member|${USER_ID}`, reason: "relationship edge: review by hand" }],
    irrecoverable: [{ naturalKey: SCRIPT_ID, effect: "content", field: "x", reason: `${SCRIPT_ID} lost content` }],
  };
  const html = renderToStaticMarkup(createElement(CompensationPlanView, { plan, names }));
  const visible = html.split('<details class="technical-details"')[0];
  assert.match(visible, /Set time zone/);
  assert.match(visible, /Ada Lovelace \(user\) as member of Finance \(group\)/);
  assert.doesNotMatch(visible, GUID);

  const effects = renderToStaticMarkup(createElement(ContentEffectList, {
    names,
    effects: [{ naturalKey: SCRIPT_ID, resourceType: "deviceManagementScript", field: "retention", effect: "retention-reducing", before: 1, after: 0, disclosure: "Content is lost." }],
  }));
  assert.match(effects, /Set time zone/);
  assert.doesNotMatch(effects, GUID);
});

test("a rollback job's heading never names a change by its id", () => {
  const base = { kind: "remediate", status: "succeeded", params: {} };
  const change = (naturalKey: string) => ({ kind: "change", id: "c", name: null, readable: true, naturalKey });
  const byId = jobName({ ...base, references: { changes: [change(SCRIPT_ID)] } as never });
  assert.equal(byId, "Roll back of 1 change");
  const byName = jobName({ ...base, references: { changes: [change("group:Finance")] } as never });
  assert.equal(byName, "Roll back of 1 change, including Finance (group)");
});
