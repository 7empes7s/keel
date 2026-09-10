import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { APPROVAL_REQUEST_EVIDENCE_KIND } from "../../engine/govern/approvals.mjs";

import { POST as baselineActivateRoute } from "@/app/api/actions/baseline/activate/route";
import { POST as baselineRoute } from "@/app/api/actions/baseline/route";
import { POST as backupRoute } from "@/app/api/actions/backup/route";
import { POST as collectRoute } from "@/app/api/actions/collect/route";
import { POST as disposeRoute } from "@/app/api/actions/dispose/route";
import { POST as remediateRoute } from "@/app/api/actions/remediate/route";
import { POST as restoreRoute } from "@/app/api/actions/restore/route";
import { GET as showJobRoute } from "@/app/api/jobs/[id]/route";
import { GET as listJobsRoute } from "@/app/api/jobs/route";
import {
  ATTEMPT_EVIDENCE_KIND,
  IDEMPOTENCY_KEY_HEADER,
} from "@/lib/action";
import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/cloudflare-access";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";

// Global constraint 6: the test database only ever comes from KEEL_DB_TEST_URL, isolated
// into its own schema. The routes under test read KEEL_DB_URL via runtime-config, so the
// process-local override below points them at that isolated schema and nowhere else.
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

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    // This task's validate command (`npm test`) does not source /etc/keel/db.env,
    // so load the test database URL from it when the environment has not.
    const env = readFileSync("/etc/keel/db.env", "utf8");
    for (const line of env.split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) {
        process.env.KEEL_DB_TEST_URL = match[1];
      }
    }
  }

  database = (await createIsolatedTestDatabase(
    import.meta.url,
  )) as IsolatedDatabase;

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

  const tenantConfigDir = mkdtempSync(join(tmpdir(), "keel-portal-action-test-"));
  writeFileSync(
    join(tenantConfigDir, "tenant.json"),
    JSON.stringify({ tenantId: "task-13-action-api-test" }),
  );

  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(tenantConfigDir, "tenant.json");

  client = await database.connect();
});

after(async () => {
  await client.end();
  await database.cleanup();
});

type RouteHandler = (request: Request) => Promise<Response>;

interface RequestOptions {
  principalId?: string;
  capabilities?: string[];
  email?: string;
  idempotencyKey?: string;
  body?: unknown;
}

function routeRequest(
  path: string,
  method: string,
  options: RequestOptions = {},
): Request {
  const headers = new Headers();
  if (options.principalId !== undefined) {
    headers.set(PRINCIPAL_ID_HEADER, options.principalId);
  }
  if (options.capabilities !== undefined) {
    headers.set(CAPABILITIES_HEADER, options.capabilities.join(" "));
  }
  if (options.email !== undefined) {
    headers.set(AUTHENTICATED_EMAIL_HEADER, options.email);
  }
  if (options.idempotencyKey !== undefined) {
    headers.set(IDEMPOTENCY_KEY_HEADER, options.idempotencyKey);
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }

  return new Request(`http://localhost${path}`, { method, headers, body });
}

const postAction = (path: string, options: RequestOptions = {}): Request =>
  routeRequest(path, "POST", options);
const getJobs = (path: string, options: RequestOptions = {}): Request =>
  routeRequest(path, "GET", options);

const actionRoutes: {
  name: string;
  post: RouteHandler;
  capability: string;
  requiresApproval: boolean;
}[] = [
  { name: "collect", post: collectRoute, capability: "collect", requiresApproval: false },
  { name: "backup", post: backupRoute, capability: "backup", requiresApproval: false },
  {
    name: "baseline",
    post: baselineRoute,
    capability: "baseline-create",
    requiresApproval: false,
  },
  {
    name: "baseline/activate",
    post: baselineActivateRoute,
    capability: "baseline-create",
    requiresApproval: true,
  },
  { name: "dispose", post: disposeRoute, capability: "dispose-accept", requiresApproval: false },
  { name: "restore", post: restoreRoute, capability: "restore", requiresApproval: true },
  {
    name: "remediate",
    post: remediateRoute,
    capability: "remediate",
    requiresApproval: true,
  },
];

async function jobRows(kind: string): Promise<Record<string, unknown>[]> {
  const { rows } = await client.query(`SELECT * FROM job WHERE kind = $1`, [kind]);
  return rows;
}

async function jobCount(): Promise<number> {
  const { rows } = await client.query(
    `SELECT count(*)::int AS count FROM job`,
  );
  return Number(rows[0].count);
}

test("every action route refuses an unauthenticated caller with a detail-free 403", async () => {
  for (const route of actionRoutes) {
    const response = await route.post(postAction(`/api/actions/${route.name}`));

    assert.equal(
      response.status,
      403,
      `${route.name} must refuse an unauthenticated caller`,
    );
    assert.deepEqual(await response.json(), { error: "forbidden" });
  }
  assert.equal(await jobCount(), 0, "a refused request must not enqueue");
});

test("every action route refuses a principal lacking its capability", async () => {
  for (const route of actionRoutes) {
    const response = await route.post(
      postAction(`/api/actions/${route.name}`, {
        principalId: "principal-viewer",
        capabilities: ["read"],
      }),
    );

    assert.equal(
      response.status,
      403,
      `${route.name} must refuse a caller without ${route.capability}`,
    );
    assert.deepEqual(await response.json(), { error: "forbidden" });
  }
  assert.equal(await jobCount(), 0, "a refused request must not enqueue");
});

test("a route requiring approval creates an approval request and never a job", async () => {
  const approvalRoutes = actionRoutes.filter((candidate) => candidate.requiresApproval);
  for (const route of approvalRoutes) {
    const response = await route.post(
      postAction(`/api/actions/${route.name}`, {
        principalId: "principal-restorer",
        capabilities: [route.capability],
        body: { target: "group:alpha", justification: "change ticket 42" },
      }),
    );

    assert.equal(
      response.status,
      202,
      `${route.name} requires approval and must create a request`,
    );
    const { approvalRequest } = await response.json();
    assert.equal(approvalRequest.status, "pending");
    assert.equal(approvalRequest.requestedBy, "principal-restorer");
    assert.equal(approvalRequest.justification, "change ticket 42");
    assert.deepEqual(approvalRequest.params, { target: "group:alpha" });
  }
  assert.equal(await jobCount(), 0, "a request must never enqueue a job directly");

  const { rows } = await client.query(
    `SELECT * FROM approval_request WHERE requested_by = 'principal-restorer'`,
  );
  assert.equal(
    rows.length,
    approvalRoutes.length,
    "exactly one pending request per requiresApproval route",
  );
});

test("a permitted caller enqueues exactly one job with the right kind and params", async () => {
  const operator = {
    principalId: "principal-operator",
    capabilities: ["collect", "backup", "baseline-create", "dispose-accept"],
  };

  const collected = await collectRoute(
    postAction("/api/actions/collect", { ...operator, body: { tier: "tier1" } }),
  );
  assert.equal(collected.status, 202);
  const { job: collectJob } = await collected.json();
  assert.equal(collectJob.kind, "collect");
  assert.deepEqual(collectJob.params, { tier: "tier1" });
  assert.equal(collectJob.requestedBy, "principal-operator");
  assert.equal(collectJob.status, "queued");

  const collectRows = await jobRows("collect");
  assert.equal(collectRows.length, 1, "exactly one collect job must exist");
  assert.equal(String(collectRows[0].id), collectJob.id);

  const backedUp = await backupRoute(
    postAction("/api/actions/backup", { ...operator, body: { tier: "tier2" } }),
  );
  assert.equal(backedUp.status, 202);
  const { job: backupJob } = await backedUp.json();
  assert.equal(backupJob.kind, "backup");
  assert.deepEqual(backupJob.params, { tier: "tier2" });
  assert.equal((await jobRows("backup")).length, 1);

  const snapshotId = randomUUID();
  const baselined = await baselineRoute(
    postAction("/api/actions/baseline", {
      ...operator,
      body: { snapshotId, label: "golden" },
    }),
  );
  assert.equal(baselined.status, 202);
  const { job: baselineJob } = await baselined.json();
  assert.equal(baselineJob.kind, "baseline-create");
  assert.deepEqual(baselineJob.params, { snapshotId, label: "golden" });
  const baselineRows = await jobRows("baseline-create");
  assert.equal(baselineRows.length, 1, "exactly one baseline-create job must exist");
  assert.equal(
    String(baselineRows[0].params &&
      (baselineRows[0].params as Record<string, unknown>).snapshotId),
    snapshotId,
    "the job must carry the chosen snapshot",
  );
});

test("baseline activation requires approval — it creates a request, never a job", async () => {
  const baselineId = randomUUID();
  const response = await baselineActivateRoute(
    postAction("/api/actions/baseline/activate", {
      principalId: "principal-operator",
      capabilities: ["baseline-create"],
      body: { baselineId, justification: "recovery rehearsal" },
    }),
  );

  assert.equal(response.status, 202);
  const { approvalRequest } = await response.json();
  assert.equal(approvalRequest.status, "pending");
  assert.equal(approvalRequest.action, "baseline-activate");
  assert.equal(approvalRequest.requestedBy, "principal-operator");
  assert.deepEqual(approvalRequest.params, { baselineId });
  assert.equal(
    (await jobRows("baseline-activate")).length,
    0,
    "activation must never enqueue a job directly",
  );
});

test("a replayed request with the same idempotency key does not enqueue twice", async () => {
  const replay = {
    principalId: "principal-operator",
    capabilities: ["backup"],
    idempotencyKey: "backup-replay-1",
    body: { tier: "tier1" },
  };

  const first = await backupRoute(postAction("/api/actions/backup", replay));
  const repeated = await backupRoute(postAction("/api/actions/backup", replay));

  assert.equal(first.status, 202);
  assert.equal(repeated.status, 202);
  const { job: firstJob } = await first.json();
  const { job: repeatedJob } = await repeated.json();
  assert.equal(repeatedJob.id, firstJob.id);

  const { rows } = await client.query(
    `SELECT id FROM job WHERE kind = 'backup' AND idempotency_key = 'backup-replay-1'`,
  );
  assert.equal(rows.length, 1, "the replay must not create a second job row");
});

test("every denial and every recorded attempt lands in the evidence chain", async () => {
  const { rows } = (await client.query(
    `SELECT actor, subject FROM evidence WHERE kind = $1`,
    [ATTEMPT_EVIDENCE_KIND],
  )) as unknown as {
    rows: {
      actor: string;
      subject: { decision?: string; reason?: string; action?: string };
    }[];
  };
  const denied = rows.filter((row) => row.subject.decision === "denied");

  assert.ok(
    denied.some(
      (row) => row.actor === "unauthenticated" && row.subject.reason === "no-principal",
    ),
    "the unauthenticated denial must be recorded",
  );
  assert.ok(
    denied.some(
      (row) => row.actor === "principal-viewer" && row.subject.reason === "capability",
    ),
    "the missing-capability denial must be recorded",
  );
  assert.ok(
    rows.some(
      (row) =>
        row.actor === "principal-operator" &&
        row.subject.decision === "attempted" &&
        row.subject.action === "collect",
    ),
    "the permitted attempt must be recorded",
  );

  const { rows: requestRows } = (await client.query(
    `SELECT actor, subject FROM evidence WHERE kind = $1`,
    [APPROVAL_REQUEST_EVIDENCE_KIND],
  )) as unknown as {
    rows: { actor: string; subject: { action?: string } }[];
  };
  assert.ok(
    requestRows.some(
      (row) =>
        row.actor === "principal-restorer" && row.subject.action === "restore",
    ),
    "the approval request must be recorded",
  );
});

test("GET /api/jobs is gated at viewer and lists the enqueued jobs", async () => {
  const unauthenticated = await listJobsRoute(getJobs("/api/jobs"));
  assert.equal(unauthenticated.status, 403);
  assert.deepEqual(await unauthenticated.json(), { error: "forbidden" });

  const withoutRead = await listJobsRoute(
    getJobs("/api/jobs", {
      principalId: "principal-operator",
      capabilities: ["collect"],
    }),
  );
  assert.equal(withoutRead.status, 403, "an operator without read must be refused");

  const viewer = await listJobsRoute(
    getJobs("/api/jobs", {
      principalId: "principal-viewer",
      capabilities: ["read"],
    }),
  );
  assert.equal(viewer.status, 200);
  const body = await viewer.json();
  assert.ok(Array.isArray(body.jobs));
  assert.ok(
    body.jobs.some(
      (job: { kind: string; requestedBy: string }) =>
        job.kind === "collect" && job.requestedBy === "principal-operator",
    ),
    "the enqueued collect job must be listed",
  );
});

test("GET /api/jobs/[id] shows one job to a viewer and nothing to anyone else", async () => {
  const [collectJob] = await jobRows("collect");
  const id = String(collectJob.id);

  const unauthenticated = await showJobRoute(getJobs(`/api/jobs/${id}`));
  assert.equal(unauthenticated.status, 403);

  const withoutRead = await showJobRoute(
    getJobs(`/api/jobs/${id}`, {
      principalId: "principal-operator",
      capabilities: ["collect"],
    }),
  );
  assert.equal(withoutRead.status, 403);

  const viewer = {
    principalId: "principal-viewer",
    capabilities: ["read"],
  };

  const missing = await showJobRoute(getJobs(`/api/jobs/${randomUUID()}`, viewer));
  assert.equal(missing.status, 404);

  const malformed = await showJobRoute(getJobs("/api/jobs/not-a-uuid", viewer));
  assert.equal(malformed.status, 404);

  const found = await showJobRoute(getJobs(`/api/jobs/${id}`, viewer));
  assert.equal(found.status, 200);
  const { job } = await found.json();
  assert.equal(job.id, id);
  assert.equal(job.kind, "collect");
  assert.equal(job.requestedBy, "principal-operator");
});
