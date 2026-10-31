import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  APPROVAL_DECISION_EVIDENCE_KIND,
  APPROVAL_REQUEST_EVIDENCE_KIND,
  PromotionRefusedError,
  approveRequest,
  requestApproval,
} from "../../engine/govern/approvals.mjs";
import { verifyChain } from "../../engine/govern/evidence.mjs";
import { createDryRunArtifact } from "../../engine/restore/dryRunArtifact.mjs";
import { contentEffectsDigest } from "../../engine/safety/contentEffects.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";

import { POST as restoreRoute } from "@/app/api/actions/restore/route";
import { GET as inboxRoute } from "@/app/api/approvals/route";
import { POST as approveRoute } from "@/app/api/approvals/[id]/approve/route";
import { POST as rejectRoute } from "@/app/api/approvals/[id]/reject/route";
import { decideRequest } from "@/lib/approval-decision";
import { getApprovalInboxData, getPendingApprovalCount, guardedApprovalInbox } from "@/lib/approval-inbox";
import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/cloudflare-access";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";

import { renderApprovalInboxAt } from "./render-approval-inbox";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

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

// Gap B11: a request's requester must resolve to an enabled principal, as the portal's
// own principal ids always do.
const RESTORER = "1b2a4a00-0000-4000-8000-00000000f5a6";

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
    const schema = schemaSql();
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
  await client.query(
    `INSERT INTO principal (id, email, display_name) VALUES ($1, 'restorer@approvals.test', 'Rita Restorer')`,
    [RESTORER],
  );
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

function get(path: string, options: RequestOptions = {}): Request {
  const headers = new Headers();
  if (options.principalId !== undefined) {
    headers.set(PRINCIPAL_ID_HEADER, options.principalId);
  }
  if (options.capabilities !== undefined) {
    headers.set(CAPABILITIES_HEADER, options.capabilities.join(" "));
  }
  return new Request(`http://localhost${path}`, { method: "GET", headers });
}

async function createRestoreRequest({ plannedWith = "portal" }: { plannedWith?: "portal" | "cli" } = {}): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, completed_at)
     VALUES ($1, 'complete', now())
     RETURNING id`,
    [tenantRef()],
  );
  const artifact = await createDryRunArtifact(client, {
    id: randomUUID(),
    tenantRef: tenantRef(),
    snapshotId: String(rows[0].id),
    selection: ["group:alpha"],
    closureKeys: ["group:alpha"],
    targetTenantId: "task-14-approval-target",
    collectorConfigPath: "/fixtures/collector.json",
    targetConfigPath: "/fixtures/restorer.json",
    reconciliationResources: null,
    waves: [["group:alpha"]],
    patches: [],
    guardRefusals: [],
    results: {
      applied: [{ naturalKey: "group:alpha", targetId: null }],
      skipped: [], failed: [], notRemediable: [],
    },
    currentStateFingerprint: `fingerprint-${randomUUID()}`,
    digest: `digest-${randomUUID()}`,
    status: "completed",
    requestedBy: RESTORER,
  });
  // The portal plans every dry run through a worker job, so its promotion is carried
  // out by the worker (gap B11: an artifact without one was planned with the CLI).
  if (plannedWith === "portal") {
    await client.query(
      `INSERT INTO job (kind, params, requested_by) VALUES ('restore', $1, $2)`,
      [{ snapshotId: String(rows[0].id), selection: ["group:alpha"], artifactId: artifact.id }, RESTORER],
    );
  }
  const response = await restoreRoute(
    post("/api/actions/restore", {
      principalId: RESTORER,
      capabilities: ["restore"],
      body: { artifactId: artifact.id, justification: "change ticket 7" },
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

interface ApprovalReadSurface {
  source: string;
  content: string;
}

function approvalReadSurfaces(
  directory: string,
  prefix: string,
): ApprovalReadSurface[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const source = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return approvalReadSurfaces(path, source);

    const content = readFileSync(path, "utf8");
    const isPage = entry.name === "page.tsx";
    const isGetRoute = entry.name === "route.ts"
      && /export\s+(?:async\s+)?(?:function|const)\s+GET\b/.test(content);
    return isPage || isGetRoute ? [{ source, content }] : [];
  });
}

test("the approval inbox declares approve guards on every read surface", () => {
  const appDirectory = fileURLToPath(new URL("../app/", import.meta.url));
  const surfaces = [
    ...approvalReadSurfaces(join(appDirectory, "approvals"), "approvals"),
    ...approvalReadSurfaces(join(appDirectory, "api", "approvals"), "api/approvals"),
  ].sort((left, right) => left.source.localeCompare(right.source));

  assert.deepEqual(
    surfaces.map((surface) => surface.source),
    ["api/approvals/route.ts", "approvals/content-effects/[id]/page.tsx", "approvals/page.tsx"],
    "approval read surfaces are closed around the approve capability",
  );

  for (const surface of surfaces) {
    // Q45: the content-effects page admits tenant-wide approvers only, the audience of
    // the content-effect approval route.
    const guard = surface.source === "approvals/content-effects/[id]/page.tsx"
      ? "await requireContentEffectReviewAccess()"
      : surface.source.endsWith("page.tsx")
        ? "requireApprovalInboxAccess"
        : "guardedApprovalInbox(";
    assert.ok(
      surface.content.includes(guard),
      `${surface.source} must declare the approve-only inbox guard`,
    );
  }
});

test("an approver can list and decide another principal's request", async () => {
  const id = await createRestoreRequest();

  const listed = await inboxRoute(get("/api/approvals", approver));
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), "no-store");
  const inbox = await listed.json();
  const request = inbox.pending.find(
    (candidate: { id: string }) => candidate.id === id,
  );
  assert.deepEqual(request, {
    id,
    action: "restore",
    params: { artifactId: request.params.artifactId },
    requestedBy: RESTORER,
    justification: "change ticket 7",
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    reason: null,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    executor: "worker",
    references: request.references,
    requiredApprovals: 1,
    signoffs: [],
    preview: request.preview,
  });
  // Task-130: the request arrives with what it concerns resolved to names.
  assert.equal(request.references.plan.id, request.params.artifactId);
  assert.equal(request.references.plan.readable, true);
  assert.equal(request.references.people.requested_by.name, "Rita Restorer");

  const decided = await approveRoute(
    post(`/api/approvals/${id}/approve`, approver),
  );
  assert.equal(decided.status, 202);
  const history = await inboxRoute(get("/api/approvals", approver));
  const afterDecision = await history.json();
  assert.equal(
    afterDecision.history.find((candidate: { id: string }) => candidate.id === id)
      .status,
    "approved",
  );
});

test("an approved restore whose content effects still need approval waits for a decision", async () => {
  const id = await createRestoreRequest();
  const { rows } = await client.query(`SELECT params->>'artifactId' AS artifact_id FROM approval_request WHERE id = $1`, [id]);
  const artifactId = String(rows[0].artifact_id);
  const effects = [{
    naturalKey: "groupLifecyclePolicy:default", resourceType: "groupLifecyclePolicy", field: "groupLifetimeInDays",
    effect: "retention-reducing", before: 400, after: 365,
  }];
  await client.query(`UPDATE restore_dry_run SET content_effects = $2 WHERE id = $1`, [artifactId, JSON.stringify(effects)]);
  const central = { central: true, entities: [] };
  const countBefore = await getPendingApprovalCount(central);

  // The restore itself is approved, as in the field: it leaves the request list but its
  // content effects still need their own approval, so it must stay in the waiting list.
  assert.equal((await approveRoute(post(`/api/approvals/${id}/approve`, approver))).status, 202);
  const waiting = await (await inboxRoute(get("/api/approvals", approver))).json();
  const listed = waiting.awaitingContentEffects.find((candidate: { id: string }) => candidate.id === id);
  assert.ok(listed, "the approved restore is listed as waiting on its content effects");
  assert.equal(listed.status, "approved");
  assert.equal(listed.references.plan.contentEffects, 1);
  assert.equal(waiting.history.some((candidate: { id: string }) => candidate.id === id), false, "not filed as decided");
  assert.equal(await getPendingApprovalCount(central), countBefore, "the waiting count still includes it");

  // The page lists it as waiting and, opened in place, shows the way to approve the effects.
  const now = "2026-10-14T13:00:00.000Z";
  const listHtml = await renderApprovalInboxAt("", { pending: [], awaitingContentEffects: [listed], history: [], now });
  assert.match(listHtml, /1 request is waiting for you/);
  assert.match(listHtml, /waiting on content changes/);
  assert.doesNotMatch(listHtml, /Nothing is waiting/);
  const openHtml = await renderApprovalInboxAt(`open=${id}`, { pending: [], awaitingContentEffects: [listed], history: [], now });
  assert.match(openHtml, new RegExp(`href="/approvals/content-effects/${artifactId}"`));
  // And it leads back to the restore run itself.
  assert.ok(listed.references.plan.dryRunJobId, "the portal-planned dry run has its job");
  assert.match(openHtml, new RegExp(`href="/jobs/${listed.references.plan.dryRunJobId}"`));

  // Only tenant-wide approvers can approve content effects, so only they see it.
  const entityApprover = { central: false, entities: ["SALES"] };
  assert.deepEqual((await getApprovalInboxData(entityApprover)).awaitingContentEffects, []);

  // Once someone other than the requester approves exactly these effects, it is decided.
  await client.query(
    `INSERT INTO content_effect_approval (tenant_ref, artifact_id, effects_digest, approved_by, justification)
     VALUES ($1, $2, $3, 'principal-approver', 'reviewed')`,
    [tenantRef(), artifactId, contentEffectsDigest(effects)],
  );
  const decided = await (await inboxRoute(get("/api/approvals", approver))).json();
  assert.equal(decided.awaitingContentEffects.some((candidate: { id: string }) => candidate.id === id), false);
  const filed = decided.history.find((candidate: { id: string }) => candidate.id === id);
  assert.ok(filed);
  // Once decided, the restore run stays one link away from the decided list.
  const historyHtml = await renderApprovalInboxAt(`show=decided&open=${id}`, { pending: [], history: [filed], now });
  assert.match(historyHtml, new RegExp(`href="/jobs/${filed.references.plan.dryRunJobId}"`));
  assert.equal(await getPendingApprovalCount(central), countBefore - 1);
});

test("viewers and unregistered principals are refused before an approval loader runs", async () => {
  let loaderRuns = 0;
  const route = guardedApprovalInbox(async () => {
    loaderRuns += 1;
    return Response.json({ loaded: true });
  });

  for (const caller of [
    { principalId: "principal-viewer", capabilities: ["read"] },
    { principalId: "unregistered-principal", capabilities: [] },
  ]) {
    const inboxResponse = await inboxRoute(get("/api/approvals", caller));
    assert.equal(inboxResponse.status, 403);
    assert.equal(inboxResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await inboxResponse.json(), { error: "forbidden" });

    const response = await route(get("/api/approvals", caller));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "forbidden" });
  }
  assert.equal(loaderRuns, 0, "a refusal must happen before the loader or database");
});

test("a self-authored request is visible but cannot be approved", async () => {
  const id = await createRestoreRequest();
  const jobsBefore = await jobCount();
  const selfApprover = {
    principalId: RESTORER,
    capabilities: ["restore", "approve"],
  };

  const listed = await inboxRoute(get("/api/approvals", selfApprover));
  const inbox = await listed.json();
  assert.ok(inbox.pending.some((candidate: { id: string }) => candidate.id === id));

  const decision = await approveRoute(
    post(`/api/approvals/${id}/approve`, selfApprover),
  );
  assert.equal(decision.status, 403);
  assert.equal(await jobCount(), jobsBefore, "self approval cannot mint a job");
});

test("an expired inbox row is history and cannot mint a job", async () => {
  const id = await createRestoreRequest();
  const jobsBefore = await jobCount();
  await client.query(
    `UPDATE approval_request SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [id],
  );

  const listed = await inboxRoute(get("/api/approvals", approver));
  const inbox = await listed.json();
  assert.equal(
    inbox.history.find((candidate: { id: string }) => candidate.id === id).status,
    "expired",
  );
  assert.equal(
    inbox.pending.some((candidate: { id: string }) => candidate.id === id),
    false,
  );

  const decision = await approveRoute(
    post(`/api/approvals/${id}/approve`, approver),
  );
  assert.equal(decision.status, 409);
  assert.equal(await jobCount(), jobsBefore, "an expired request cannot mint a job");
});

test("rejection sends the exact request id and reason", async () => {
  const id = await createRestoreRequest();
  const rejection = await rejectRoute(
    post(`/api/approvals/${id}/reject`, {
      ...approver,
      body: { reason: "outside the approved change window" },
    }),
  );
  assert.equal(rejection.status, 200);
  const row = await requestRow(id);
  assert.equal(row.id, id);
  assert.equal(row.reason, "outside the approved change window");
});

test("rejection requires an operator-visible reason", async () => {
  const id = await createRestoreRequest();
  const response = await rejectRoute(
    post(`/api/approvals/${id}/reject`, approver),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_request" });
  assert.equal((await requestRow(id)).status, "pending");
});

// UI audit 31 Oct 2026, C1: "BECAUSE" was kept as a rejection reason.
test("a placeholder rejection reason is refused in plain words", async () => {
  const id = await createRestoreRequest();
  for (const reason of ["BECAUSE", "x", "test"]) {
    const response = await rejectRoute(
      post(`/api/approvals/${id}/reject`, { ...approver, body: { reason } }),
    );
    assert.equal(response.status, 400, reason);
    const body = await response.json();
    assert.equal(body.error, "weak_reason");
    assert.match(body.message, /real words|a little more/);
  }
  assert.equal((await requestRow(id)).status, "pending");
});

test("approval controls submit each listed request id and its rejection reason", async () => {
  // The page's buttons all go through decideRequest, so the browser-control-to-route
  // boundary is one function: the id and the rejection reason reach the right route.
  const originalFetch = globalThis.fetch;
  const requests: {
    url: string;
    method: string | undefined;
    contentType: string | null;
    body: unknown;
  }[] = [];

  try {
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        contentType: new Headers(init?.headers).get("content-type"),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify({ job: { id: "job-1" } }), { status: 202, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const approved = await decideRequest("00000000-0000-4000-8000-000000000101", "approve");
    assert.deepEqual(approved, { ok: true, status: 202, payload: { job: { id: "job-1" } } });
    const rejected = await decideRequest("00000000-0000-4000-8000-000000000202", "reject", "outside the approved change window");
    assert.equal(rejected.ok, true);

    assert.deepEqual(requests, [
      {
        url: "/api/approvals/00000000-0000-4000-8000-000000000101/approve",
        method: "POST",
        contentType: null,
        body: undefined,
      },
      {
        url: "/api/approvals/00000000-0000-4000-8000-000000000202/reject",
        method: "POST",
        contentType: "application/json",
        body: { reason: "outside the approved change window" },
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decided approval history is newest-first", async () => {
  const olderId = await createRestoreRequest();
  await rejectRoute(
    post(`/api/approvals/${olderId}/reject`, {
      ...approver,
      body: { reason: "older decision" },
    }),
  );
  const newerId = await createRestoreRequest();
  await rejectRoute(
    post(`/api/approvals/${newerId}/reject`, {
      ...approver,
      body: { reason: "newer decision" },
    }),
  );

  const listed = await inboxRoute(get("/api/approvals", approver));
  const inbox = await listed.json();
  const ids = inbox.history.map((request: { id: string }) => request.id);
  assert.ok(ids.indexOf(newerId) < ids.indexOf(olderId));
});

test("approval by a different principal holding approver mints exactly one job", async () => {
  const id = await createRestoreRequest();
  const jobsBefore = await jobCount();

  const response = await approveRoute(
    post(`/api/approvals/${id}/approve`, approver),
  );
  assert.equal(response.status, 202);
  const { job } = await response.json();
  assert.equal(job.kind, "restore");
  assert.equal(typeof job.params.artifactId, "string");
  assert.equal(job.requestedBy, RESTORER);
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

test("gap B11: approving a dry run planned with the CLI queues no worker restore", async () => {
  const id = await createRestoreRequest({ plannedWith: "cli" });
  assert.equal((await requestRow(id)).executor, "cli");
  const jobsBefore = await jobCount();

  const listed = await inboxRoute(get("/api/approvals", approver));
  const inbox = await listed.json();
  assert.equal(inbox.pending.find((candidate: { id: string }) => candidate.id === id).executor, "cli");

  const response = await approveRoute(post(`/api/approvals/${id}/approve`, approver));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { job: null, signoffs: 1, requiredApprovals: 1 });
  assert.equal((await requestRow(id)).status, "approved");
  assert.equal(await jobCount(), jobsBefore, "a CLI-executed approval queues no second, worker-run restore");
});

test("gap B11: a requester that is not an enabled principal cannot ask for a restore", async () => {
  const { rows } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, completed_at) VALUES ($1, 'complete', now()) RETURNING id`,
    [tenantRef()],
  );
  const artifact = await createDryRunArtifact(client, {
    id: randomUUID(), tenantRef: tenantRef(), snapshotId: String(rows[0].id),
    selection: ["group:alpha"], closureKeys: ["group:alpha"], targetTenantId: "task-14-approval-target",
    collectorConfigPath: "/fixtures/collector.json", targetConfigPath: "/fixtures/restorer.json",
    reconciliationResources: null, waves: [["group:alpha"]], patches: [], guardRefusals: [],
    results: { applied: [{ naturalKey: "group:alpha", targetId: null }], skipped: [], failed: [], notRemediable: [] },
    currentStateFingerprint: `fingerprint-${randomUUID()}`, digest: `digest-${randomUUID()}`,
    status: "completed", requestedBy: "unknown",
  });
  const { rows: before } = await client.query(`SELECT count(*)::int AS count FROM approval_request`);
  const response = await restoreRoute(
    post("/api/actions/restore", {
      principalId: "unknown",
      capabilities: ["restore"],
      body: { artifactId: artifact.id },
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "forbidden" });
  const { rows: after } = await client.query(`SELECT count(*)::int AS count FROM approval_request`);
  assert.equal(after[0].count, before[0].count, "no request is created");
});

test("approveRequest refuses a completed dry-run artifact belonging to another tenant", async () => {
  const localId = await createRestoreRequest();
  const localRequest = await requestRow(localId);
  const foreignTenantRef = `sha256:foreign-${randomUUID()}`;
  // Bypass the confirmation route deliberately: the approval engine must enforce
  // tenant scope even when a stored request references another tenant's artifact.
  const foreignRequest = await requestApproval(client, {
    tenantRef: foreignTenantRef,
    action: "restore",
    params: localRequest.params,
    requestedBy: RESTORER,
    justification: "cross-tenant artifact regression",
  });
  const { rows: jobsBefore } = await client.query("SELECT id FROM job ORDER BY id");

  await assert.rejects(
    approveRequest(client, {
      tenantRef: foreignTenantRef,
      id: foreignRequest.id,
      decidedBy: "principal-approver",
    }),
    (error: unknown) => error instanceof PromotionRefusedError,
  );
  const refused = await requestRow(foreignRequest.id);
  assert.equal(refused.status, "pending");
  assert.equal(refused.decided_by, null);
  const { rows: jobsAfter } = await client.query("SELECT id FROM job ORDER BY id");
  assert.deepEqual(jobsAfter, jobsBefore, "a cross-tenant artifact reference must mint no job");

  const response = await approveRoute(post(`/api/approvals/${localId}/approve`, approver));
  assert.equal(response.status, 202, "the same artifact remains promotable in its own tenant");
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
      principalId: RESTORER,
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
        && row.actor === RESTORER,
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
