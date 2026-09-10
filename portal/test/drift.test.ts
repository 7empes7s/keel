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
import { getDriftData } from "@/lib/portal-data";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";

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
    const schema = readFileSync(
      new URL("../../engine/store/schema.sql", import.meta.url),
      "utf8",
    );
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

test("remediate creates an approval request and never a job", async () => {
  const drift = await createModifiedDrift("approval");
  const jobsBefore = await jobCount();
  const response = await remediateRoute(
    post("/api/actions/remediate", {
      principalId: "principal-restorer",
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
      principalId: "principal-restorer-bulk",
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
