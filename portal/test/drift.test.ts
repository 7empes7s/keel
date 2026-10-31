import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";

import { POST as disposeRoute } from "@/app/api/actions/dispose/route";
import { POST as remediateRoute } from "@/app/api/actions/remediate/route";
import { POST as approveRoute } from "@/app/api/approvals/[id]/approve/route";
import { driftActionControls, remediationParams } from "@/lib/drift-actions";
import { setupStatus } from "@/lib/baselines-view";
import { openChangeCount } from "@/lib/changes-view";
import { getDashboardData, getDriftData } from "@/lib/portal-data";
import { getServiceChanges } from "@/lib/service-changes";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";
import { detectWorkloadDrift } from "../../engine/govern/workloadDrift.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

// Global constraint 6: the isolated schema is created only from KEEL_DB_TEST_URL.
// KEEL_DB_URL below is a process-local route override pointing at that isolated test
// schema, never at the production URL.
interface TestClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

interface IsolatedDatabase {
  url: string;
  connect(): Promise<TestClient>;
  cleanup(): Promise<void>;
}

let database: IsolatedDatabase;
let client: TestClient;
let activeBaselineId: string;
let currentTenantRef: string;

// Gap B11: a request's requester must resolve to an enabled principal, as the portal's
// own principal ids always do.
const RESTORER = "1b2a4a00-0000-4000-8000-0000000000d1";
const RESTORER_BULK = "1b2a4a00-0000-4000-8000-0000000000d2";

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
    const schema = schemaSql();
    await admin.query(schema);
  } finally {
    await admin.end();
  }

  const tenantConfigDir = mkdtempSync(join(tmpdir(), "keel-portal-drift-test-"));
  writeFileSync(
    join(tenantConfigDir, "tenant.json"),
    JSON.stringify({ tenantId: "task-15-drift-portal-test" }),
  );
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(tenantConfigDir, "tenant.json");

  currentTenantRef = tenantRef();
  client = await database.connect();
  await client.query(
    `INSERT INTO principal (id, email) VALUES ($1, 'restorer@drift.test'), ($2, 'bulk@drift.test')`,
    [RESTORER, RESTORER_BULK],
  );
  const { rows } = await client.query(
    `INSERT INTO baseline (tenant_ref, set_by, active)
     VALUES ($1, 'test-operator', true)
     RETURNING id`,
    [currentTenantRef],
  );
  activeBaselineId = String(rows[0].id);
});

after(async () => {
  await client.end();
  await database.cleanup();
});

function post(
  path: string,
  options: { principalId: string; capabilities: string[]; body: unknown },
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set(PRINCIPAL_ID_HEADER, options.principalId);
  headers.set(CAPABILITIES_HEADER, options.capabilities.join(" "));
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body),
  });
}

async function createSnapshot(): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, completed_at)
     VALUES ($1, 'complete', now())
     RETURNING id`,
    [currentTenantRef],
  );
  return String(rows[0].id);
}

async function createModifiedDrift(label: string): Promise<{
  id: string;
  naturalKey: string;
  before: Record<string, string>;
  after: Record<string, string>;
}> {
  const naturalKey = `group:task-15-${label}-${randomUUID()}`;
  const before = { displayName: `${label} baseline`, description: "before" };
  const after = { displayName: `${label} observed`, description: "after" };
  const baselineSnapshot = await createSnapshot();
  const observedSnapshot = await createSnapshot();
  const { rows: baselineVersionRows } = await client.query(
    `INSERT INTO resource_version
       (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality,
        blast_radius, fidelity, provenance)
     VALUES ($1, $2, 'group', $3, 'baseline-hash-' || $2, 'normal',
             'access-affecting', 'full', '{}'::jsonb)
     RETURNING id`,
    [baselineSnapshot, naturalKey, before],
  );
  await client.query(
    `INSERT INTO baseline_resource (baseline_id, natural_key, resource_version_id)
     VALUES ($1, $2, $3)`,
    [activeBaselineId, naturalKey, String(baselineVersionRows[0].id)],
  );
  await client.query(
    `INSERT INTO resource_version
       (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality,
        blast_radius, fidelity, provenance)
     VALUES ($1, $2, 'group', $3, 'observed-hash-' || $2, 'normal',
             'access-affecting', 'full', '{}'::jsonb)`,
    [observedSnapshot, naturalKey, after],
  );
  const { rows } = await client.query(
    `INSERT INTO drift
       (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
        before_hash, after_hash, before_payload, after_payload, blast_radius)
     VALUES ($1, $2, $3, $4, 'group', 'modified', 'baseline-hash', 'observed-hash',
             $5, $6, 'access-affecting')
     RETURNING id`,
    [currentTenantRef, activeBaselineId, observedSnapshot, naturalKey, before, after],
  );
  return { id: String(rows[0].id), naturalKey, before, after };
}

async function jobCount(): Promise<number> {
  const { rows } = await client.query(`SELECT count(*)::int AS count FROM job`);
  return Number(rows[0].count);
}

test("a viewer sees drift without action controls and is refused by the action API", async () => {
  const drift = await createModifiedDrift("viewer");
  const data = await getDriftData();
  const record = data.items.find((item) => item.id === drift.id);

  assert.deepEqual(record?.before, drift.before);
  assert.deepEqual(record?.after, drift.after);
  assert.deepEqual(driftActionControls(["read"]), {
    canDispose: false,
    canRemediate: false,
  });

  const viewer = { principalId: "principal-viewer", capabilities: ["read"] };
  const disposition = await disposeRoute(
    post("/api/actions/dispose", {
      ...viewer,
      body: { driftId: drift.id, action: "accept", reason: "viewer attempt" },
    }),
  );
  assert.equal(disposition.status, 403);
  assert.deepEqual(await disposition.json(), { error: "forbidden" });

  const remediation = await remediateRoute(
    post("/api/actions/remediate", {
      ...viewer,
      body: { driftIds: [drift.id], justification: "viewer attempt" },
    }),
  );
  assert.equal(remediation.status, 403);
  assert.deepEqual(await remediation.json(), { error: "forbidden" });
});

test("an operator can accept a selected deviation", async () => {
  const drift = await createModifiedDrift("accept");
  const response = await disposeRoute(
    post("/api/actions/dispose", {
      principalId: "principal-operator",
      capabilities: ["dispose-accept"],
      body: {
        driftId: drift.id,
        action: "accept",
        reason: "Reviewed against the approved change record",
      },
    }),
  );

  assert.equal(response.status, 200);
  const { rows } = await client.query(
    `SELECT action, actor, reason FROM disposition WHERE drift_id = $1`,
    [drift.id],
  );
  assert.deepEqual(rows, [{
    action: "accept",
    actor: "principal-operator",
    reason: "Reviewed against the approved change record",
  }]);
});

// Security audit run 2, finding 3: a change to sign-in (here a Conditional Access policy)
// is never accepted or ignored by one person, and an ignore always ends within 90 days.
test("accepting or ignoring a sign-in change goes to a second person", async () => {
  const drift = await createModifiedDrift("sign-in");
  await client.query(
    `UPDATE drift SET resource_type = 'conditionalAccessPolicy', blast_radius = 'tenant-lockout' WHERE id = $1`,
    [drift.id],
  );
  const operator = { principalId: RESTORER, capabilities: ["dispose-accept"] };
  const jobsBefore = await jobCount();

  const forever = await disposeRoute(post("/api/actions/dispose", {
    ...operator, body: { driftId: drift.id, action: "ignore", reason: "noise", expiresAt: "infinity" },
  }));
  assert.equal(forever.status, 400);
  assert.match((await forever.json()).message, /real date/);
  const tooLong = await disposeRoute(post("/api/actions/dispose", {
    ...operator, body: { driftId: drift.id, action: "ignore", reason: "noise", expiresAt: new Date(Date.now() + 91 * 86_400_000).toISOString() },
  }));
  assert.equal(tooLong.status, 400);
  assert.match((await tooLong.json()).message, /at most 90 days/);

  const response = await disposeRoute(post("/api/actions/dispose", {
    ...operator, body: { driftId: drift.id, action: "accept", reason: "turned off on purpose" },
  }));
  assert.equal(response.status, 202);
  const { approvalRequest } = await response.json();
  assert.equal(approvalRequest.action, "dispose");
  assert.equal(approvalRequest.status, "pending");
  assert.deepEqual(approvalRequest.params, { driftIds: [drift.id], action: "accept", reason: "turned off on purpose" });
  const decided = async () => (await client.query(`SELECT count(*)::int AS count FROM disposition WHERE drift_id = $1`, [drift.id])).rows[0].count;
  assert.equal(await decided(), 0, "nothing is decided before a second person approves");
  assert.equal(await jobCount(), jobsBefore);

  const self = await approveRoute(post(`/api/approvals/${approvalRequest.id}/approve`, {
    principalId: RESTORER, capabilities: ["approve", "dispose-accept"], body: {},
  }));
  assert.notEqual(self.status, 202, "the person who asked cannot approve it");
  const approved = await approveRoute(post(`/api/approvals/${approvalRequest.id}/approve`, {
    principalId: "principal-approver", capabilities: ["approve"], body: {},
  }));
  assert.equal(approved.status, 202);
  const { job } = await approved.json();
  const { rows: [row] } = await client.query(`SELECT kind, requested_by, params FROM job WHERE id = $1`, [job.id]);
  assert.deepEqual(row, { kind: "dispose", requested_by: RESTORER, params: approvalRequest.params });
});

test("remediate creates an approval request and never a job", async () => {
  const drift = await createModifiedDrift("approval");
  const jobsBefore = await jobCount();
  const response = await remediateRoute(
    post("/api/actions/remediate", {
      principalId: RESTORER,
      capabilities: ["remediate"],
      body: { driftIds: [drift.id], justification: "Restore the approved baseline" },
    }),
  );

  assert.equal(response.status, 202);
  const { approvalRequest } = await response.json();
  assert.equal(approvalRequest.status, "pending");
  assert.deepEqual(approvalRequest.params, { driftIds: [drift.id] });
  assert.equal(await jobCount(), jobsBefore, "remediation must not enqueue before approval");
});

test("bulk remediation enqueues exactly the selected drift IDs", async () => {
  const first = await createModifiedDrift("bulk-first");
  const middle = await createModifiedDrift("bulk-middle");
  const last = await createModifiedDrift("bulk-last");
  const selectedDriftIds = [first.id, last.id];
  const visibleDriftIds = [first.id, middle.id, last.id];
  const response = await remediateRoute(
    post("/api/actions/remediate", {
      principalId: RESTORER_BULK,
      capabilities: ["remediate"],
      body: remediationParams({
        selectedDriftIds,
        visibleDriftIds,
        justification: "Restore only the selected deviations",
      }),
    }),
  );

  assert.equal(response.status, 202);
  const { approvalRequest } = await response.json();
  const approved = await approveRoute(
    post(`/api/approvals/${approvalRequest.id}/approve`, {
      principalId: "principal-approver",
      capabilities: ["approve"],
      body: {},
    }),
  );
  assert.equal(approved.status, 202);
  const { job } = await approved.json();
  const { rows } = await client.query(`SELECT params FROM job WHERE id = $1`, [job.id]);
  assert.deepEqual(
    rows[0].params,
    { driftIds: selectedDriftIds },
    "the job must cover the explicit selection, not every visible row",
  );
});

test("a change seen by several detect runs is one change, shown as its newest record", async () => {
  // Every drift-detect run records a row for each difference it still sees. Reading every
  // open row loaded the same change once per run: 77k rows for 815 changes on live, which
  // ran the portal out of memory.
  const first = await createModifiedDrift("repeat");
  const repeats: string[] = [];
  for (let run = 1; run <= 3; run += 1) {
    const observed = await createSnapshot();
    const { rows } = await client.query(
      `INSERT INTO drift
         (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
          before_hash, after_hash, before_payload, after_payload, blast_radius, detected_at)
       VALUES ($1, $2, $3, $4, 'group', 'modified', 'baseline-hash', 'observed-hash',
               $5, $6, 'access-affecting', now() + make_interval(secs => $7))
       RETURNING id`,
      [currentTenantRef, activeBaselineId, observed, first.naturalKey, first.before, { ...first.after, run: String(run) }, run],
    );
    repeats.push(String(rows[0].id));
  }

  const data = await getDriftData();
  const shown = data.items.filter((item) => item.naturalKey === first.naturalKey);
  assert.deepEqual(shown.map((item) => item.id), [repeats[2]], "only the newest record of the change");
  assert.equal((shown[0].after as Record<string, unknown> | null)?.run, "3");

  const dashboard = await getDashboardData();
  const keys = new Set(data.items.map((item) => item.naturalKey));
  assert.equal(dashboard.openDriftTotal, keys.size, "the dashboard counts changes, not detect runs");

  // Settling the newest record settles the change; older records do not resurface.
  await client.query(
    `INSERT INTO disposition (drift_id, action, actor, reason) VALUES ($1, 'accept', 'test', 'expected')`,
    [repeats[2]],
  );
  const after = await getDriftData();
  assert.equal(after.items.some((item) => item.naturalKey === first.naturalKey), false);
});

test("the Overview counts open service setting changes beside the approved-setup changes", async () => {
  const before = await getDashboardData();
  const mailFlow = async (at: Date, state: string) => {
    const { rows: [collection] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
       VALUES ($1, 'exchange-mail-flow', 'complete', $2, $2, $2) RETURNING id`,
      [currentTenantRef, at],
    );
    await client.query(
      `INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, 'transport-rule:KEEL-RT-overview', $2)`,
      [collection.id, { identity: "KEEL-RT-overview", kind: "transportRule", Name: "KEEL-RT-overview", State: state }],
    );
    await detectWorkloadDrift(client, { collectionId: collection.id, hysteresis: undefined });
  };
  const now = Date.now();
  await mailFlow(new Date(now - 2 * 3_600_000), "Disabled");
  await mailFlow(new Date(now - 3_600_000), "Enabled");

  const after = await getDashboardData();
  assert.equal(after.openDriftTotal, before.openDriftTotal + 1, "the mail flow rule change counts");
  // The same number the Changes and Approved setup pages show (openChangeCount).
  const [drift, service] = await Promise.all([getDriftData(), getServiceChanges()]);
  assert.equal(after.openDriftTotal, openChangeCount(drift.items.length, service.total));
  assert.equal(setupStatus(drift.baseline, [...drift.items, ...service.items], after.openDriftTotal).label, `${after.openDriftTotal} ${after.openDriftTotal === 1 ? "change" : "changes"} to review`);
  const accessAffecting = (data: typeof after) => data.openDriftByBlastRadius.find((item) => item.blastRadius === "access-affecting")?.count ?? 0;
  assert.equal(accessAffecting(after), accessAffecting(before) + 1);
});

// PR #435 follow-up: a changed Intune script reaches read views as its size and a
// fingerprint, never its text (scripts often hold passwords).
test("a changed script shows as changed without its text", async () => {
  const secret = Buffer.from('$password = "KEEL-RT-not-a-real-secret"', "utf8").toString("base64");
  const naturalKey = `deviceManagementScript:KEEL-RT-${randomUUID()}`;
  const observedSnapshot = await createSnapshot();
  const { rows } = await client.query(
    `INSERT INTO drift
       (tenant_ref, baseline_id, observed_snapshot, natural_key, resource_type, change_type,
        before_hash, after_hash, before_payload, after_payload, blast_radius)
     VALUES ($1, $2, $3, $4, 'deviceManagementScript', 'modified', 'baseline-hash', 'observed-hash',
             $5, $6, 'access-affecting')
     RETURNING id`,
    [currentTenantRef, activeBaselineId, observedSnapshot, naturalKey,
      { displayName: "KEEL-RT-script", scriptContent: Buffer.from("Write-Output 1").toString("base64") },
      { displayName: "KEEL-RT-script", scriptContent: secret }],
  );
  const data = await getDriftData();
  const record = data.items.find((item) => item.id === String(rows[0].id));
  assert.ok(record, "the change is listed");
  const shown = JSON.stringify(record);
  assert.ok(!shown.includes(secret) && !shown.includes("not-a-real-secret"), "no script text reaches the page");
  assert.match(String((record.after as Record<string, unknown>).scriptContent), /^Script text hidden \(/);
  assert.notEqual((record.before as Record<string, unknown>).scriptContent, (record.after as Record<string, unknown>).scriptContent);
});
