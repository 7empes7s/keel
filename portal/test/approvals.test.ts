import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  APPROVAL_DECISION_EVIDENCE_KIND,
  APPROVAL_REQUEST_EVIDENCE_KIND,
} from "../../engine/govern/approvals.mjs";
import { verifyChain } from "../../engine/govern/evidence.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";

import { POST as restoreRoute } from "@/app/api/actions/restore/route";
import { POST as approveRoute } from "@/app/api/approvals/[id]/approve/route";
import { POST as rejectRoute } from "@/app/api/approvals/[id]/reject/route";
import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/cloudflare-access";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";

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

  const tenantConfigDir = mkdtempSync(join(tmpdir(), "keel-portal-approvals-test-"));
  writeFileSync(
    join(tenantConfigDir, "tenant.json"),
    JSON.stringify({ tenantId: "task-14-approvals-test" }),
  );

  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(tenantConfigDir, "tenant.json");

  client = await database.connect();
});

after(async () => {
  await client.end();
  await database.cleanup();
});

interface RequestOptions {
  principalId?: string;
  capabilities?: string[];
  email?: string;
  body?: unknown;
}

function post(path: string, options: RequestOptions = {}): Request {
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

  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }

  return new Request(`http://localhost${path}`, { method: "POST", headers, body });
}

async function createRestoreRequest(): Promise<string> {
  const response = await restoreRoute(
    post("/api/actions/restore", {
      principalId: "principal-restorer",
      capabilities: ["restore"],
      body: { target: "group:alpha", justification: "change ticket 7" },
    }),
  );
  assert.equal(response.status, 202, "requesting restore must create a request");
  const { approvalRequest } = await response.json();
  assert.equal(approvalRequest.status, "pending");
  return approvalRequest.id as string;
}

async function requestRow(id: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query(
    `SELECT * FROM approval_request WHERE id = $1`,
    [id],
  );
  assert.ok(rows[0], `approval request ${id} must exist`);
  return rows[0];
}

async function jobCount(): Promise<number> {
  const { rows } = await client.query(`SELECT count(*)::int AS count FROM job`);
  return Number(rows[0].count);
}

const approver = {
  principalId: "principal-approver",
  capabilities: ["approve"],
};

test("approval by a different principal holding approver mints exactly one job", async () => {
  const id = await createRestoreRequest();
  const jobsBefore = await jobCount();

  const response = await approveRoute(
    post(`/api/approvals/${id}/approve`, approver),
  );
  assert.equal(response.status, 202);
  const { job } = await response.json();
  assert.equal(job.kind, "restore");
  assert.deepEqual(job.params, { target: "group:alpha" });
  assert.equal(job.requestedBy, "principal-restorer");
  assert.equal(job.status, "queued");

  const decided = await requestRow(id);
  assert.equal(decided.status, "approved");
  assert.equal(decided.decided_by, "principal-approver");
  assert.ok(decided.decided_at, "the decision is timestamped");
  assert.equal(await jobCount(), jobsBefore + 1, "approval mints exactly one job");

  const again = await approveRoute(
    post(`/api/approvals/${id}/approve`, approver),
  );
  assert.equal(again.status, 409, "a decided request cannot be approved again");
  assert.equal(
    await jobCount(),
    jobsBefore + 1,
    "a repeated approval mints no second job",
  );
});

test("approval by a principal without the approver capability is refused", async () => {
  const id = await createRestoreRequest();
  const jobsBefore = await jobCount();

  const response = await approveRoute(
    post(`/api/approvals/${id}/approve`, {
      principalId: "principal-viewer",
      capabilities: ["read"],
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "forbidden" });

  assert.equal((await requestRow(id)).status, "pending");
  assert.equal(await jobCount(), jobsBefore, "a refused approval mints no job");
});

test("self-approval is refused server-side", async () => {
  const id = await createRestoreRequest();
  const jobsBefore = await jobCount();

  const response = await approveRoute(
    post(`/api/approvals/${id}/approve`, {
      principalId: "principal-restorer",
      capabilities: ["restore", "approve"],
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "forbidden" });

  assert.equal(
    (await requestRow(id)).status,
    "pending",
    "a refused self-approval leaves the request pending",
  );
  assert.equal(await jobCount(), jobsBefore, "a refused self-approval mints no job");
});

test("an expired request cannot be approved", async () => {
  const id = await createRestoreRequest();
  const jobsBefore = await jobCount();
  await client.query(
    `UPDATE approval_request SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [id],
  );

  const response = await approveRoute(
    post(`/api/approvals/${id}/approve`, approver),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "conflict" });

  assert.equal(
    (await requestRow(id)).status,
    "expired",
    "an expired request expires closed",
  );
  assert.equal(await jobCount(), jobsBefore, "an expired request mints no job");
});

test("rejecting closes the request and mints nothing", async () => {
  const id = await createRestoreRequest();
  const jobsBefore = await jobCount();

  const response = await rejectRoute(
    post(`/api/approvals/${id}/reject`, {
      ...approver,
      body: { reason: "out of change window" },
    }),
  );
  assert.equal(response.status, 200);
  const { approvalRequest } = await response.json();
  assert.equal(approvalRequest.status, "rejected");
  assert.equal(approvalRequest.decidedBy, "principal-approver");
  assert.equal(approvalRequest.reason, "out of change window");

  assert.equal(await jobCount(), jobsBefore, "a rejection mints no job");

  const approveAfterReject = await approveRoute(
    post(`/api/approvals/${id}/approve`, approver),
  );
  assert.equal(
    approveAfterReject.status,
    409,
    "a rejected request cannot be approved later",
  );
  assert.equal(await jobCount(), jobsBefore);
});

test("unauthenticated callers and unknown requests get no detail", async () => {
  const id = await createRestoreRequest();
  const jobsBefore = await jobCount();

  const anonymousApprove = await approveRoute(
    post(`/api/approvals/${id}/approve`),
  );
  assert.equal(anonymousApprove.status, 403);
  assert.deepEqual(await anonymousApprove.json(), { error: "forbidden" });

  const anonymousReject = await rejectRoute(post(`/api/approvals/${id}/reject`));
  assert.equal(anonymousReject.status, 403);

  const missingApprove = await approveRoute(
    post(`/api/approvals/${randomUUID()}/approve`, approver),
  );
  assert.equal(missingApprove.status, 404);
  assert.deepEqual(await missingApprove.json(), { error: "not_found" });

  const missingReject = await rejectRoute(
    post(`/api/approvals/${randomUUID()}/reject`, { ...approver, body: {} }),
  );
  assert.equal(missingReject.status, 404);

  const malformed = await approveRoute(
    post("/api/approvals/not-a-uuid/approve", approver),
  );
  assert.equal(malformed.status, 404);

  assert.equal((await requestRow(id)).status, "pending");
  assert.equal(await jobCount(), jobsBefore);
});

test("the evidence chain contains both the request and the decision", async () => {
  const id = await createRestoreRequest();
  const approved = await approveRoute(
    post(`/api/approvals/${id}/approve`, approver),
  );
  assert.equal(approved.status, 202);
  const { job } = await approved.json();

  const { rows } = (await client.query(
    `SELECT kind, subject, actor FROM evidence
     WHERE kind IN ($1, $2)
     ORDER BY seq`,
    [APPROVAL_REQUEST_EVIDENCE_KIND, APPROVAL_DECISION_EVIDENCE_KIND],
  )) as unknown as {
    rows: {
      kind: string;
      actor: string;
      subject: { requestId?: string; decision?: string; jobId?: string };
    }[];
  };

  assert.ok(
    rows.some(
      (row) =>
        row.kind === APPROVAL_REQUEST_EVIDENCE_KIND
        && row.subject.requestId === id
        && row.actor === "principal-restorer",
    ),
    "the evidence chain must contain the request",
  );
  assert.ok(
    rows.some(
      (row) =>
        row.kind === APPROVAL_DECISION_EVIDENCE_KIND
        && row.subject.requestId === id
        && row.subject.decision === "approved"
        && row.subject.jobId === job.id
        && row.actor === "principal-approver",
    ),
    "the evidence chain must contain the decision",
  );

  assert.deepEqual(await verifyChain(client, { tenantRef: tenantRef() }), {
    ok: true,
  });
});
