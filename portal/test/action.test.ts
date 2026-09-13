import "./next-async-storage";
import { GET as listPoliciesRoute, POST as createPolicyRoute } from "@/app/api/policies/route";
import { GET as showPolicyRoute } from "@/app/api/policies/[id]/route";
import { POST as enablePolicyRoute } from "@/app/api/policies/[id]/enabled/route";
import { POST as clearPauseRoute } from "@/app/api/policies/[id]/clear-pause/route";
import { listPolicies } from "../../engine/policy/evaluate.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import React from "react";

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
import { BaselineCreateForm } from "@/components/baseline-create-form";
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

type FormElement = {
  type: unknown;
  props: Record<string, unknown>;
};

function findFormElement(
  node: unknown,
  predicate: (element: FormElement) => boolean,
): FormElement | undefined {
  if (!node || typeof node !== "object") return undefined;
  const element = node as FormElement;
  if (predicate(element)) return element;
  const children = element.props?.children;
  const candidates = Array.isArray(children) ? children : [children];
  for (const child of candidates) {
    const found = findFormElement(child, predicate);
    if (found) return found;
  }
  return undefined;
}

// This is a deliberately tiny browser-form harness: it renders the client component,
// drives its select/input/button handlers, and lets postAction make its normal fetch.
// The project does not carry a DOM test dependency; using React's hook dispatcher here
// keeps this assertion at the form-to-action boundary instead of duplicating the body
// object in an action-route test.
function renderBaselineCreateForm() {
  const internals = (React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: unknown;
  }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE as {
    H: unknown;
  };
  const originalDispatcher = internals.H;
  const state: unknown[] = [];
  let hookIndex = 0;
  let contextIndex = 0;

  internals.H = {
    useState<T>(initial: T | (() => T)) {
      const index = hookIndex++;
      if (!(index in state)) {
        state[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      return [state[index] as T, (next: T | ((previous: T) => T)) => {
        state[index] = typeof next === "function"
          ? (next as (previous: T) => T)(state[index] as T)
          : next;
      }];
    },
    useContext() {
      // useRouter reads AppRouterContext first and LayoutRouterContext second.
      if (contextIndex++ === 0) {
        return {
          back() {}, forward() {}, hmrRefresh() {}, prefetch() {}, push() {}, refresh() {}, replace() {},
        };
      }
      return { parentCacheNode: { bfcacheId: 0 } };
    },
    useMemo<T>(create: () => T) { return create(); },
  };

  return {
    render(): FormElement {
      hookIndex = 0;
      contextIndex = 0;
      return BaselineCreateForm({
        completedSnapshotsExist: true,
        disabled: false,
        snapshots: [
          {
            id: "snapshot-default", completedAt: null, startedAt: "2026-09-10T00:00:00.000Z", resourceCount: 2,
          },
          {
            id: "snapshot-selected", completedAt: null, startedAt: "2026-09-10T01:00:00.000Z", resourceCount: 3,
          },
        ],
      }) as unknown as FormElement;
    },
    restore() {
      internals.H = originalDispatcher;
    },
  };
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

test("BaselineCreateForm sends the selected snapshotId through the baseline action", async () => {
  const form = renderBaselineCreateForm();
  const originalFetch = globalThis.fetch;
  let actionRequest: Request | undefined;
  let actionResponse: Promise<Response> | undefined;
  let submittedBody: unknown;
  try {
    // This stands in for the authenticated edge: postAction supplies the browser request,
    // then the action receives the identity headers that Cloudflare Access adds in production.
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set(PRINCIPAL_ID_HEADER, "principal-baseline-form");
      headers.set(CAPABILITIES_HEADER, "baseline-create");
      submittedBody = JSON.parse(String(init?.body));
      actionRequest = new Request(`http://localhost${String(input)}`, {
        method: init?.method,
        headers,
        body: init?.body,
      });
      actionResponse = baselineRoute(actionRequest);
      return actionResponse;
    };

    let rendered = form.render();
    const select = findFormElement(rendered, (element) => element.type === "select");
    assert.ok(select, "the browser form exposes its snapshot selector");
    (select.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "snapshot-selected" },
    });

    rendered = form.render();
    const label = findFormElement(
      rendered,
      (element) => element.type === "input" && element.props.placeholder === "e.g. post-audit-2026-q3",
    );
    assert.ok(label, "the browser form exposes its baseline label input");
    (label.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "selected recovery point" },
    });

    rendered = form.render();
    const button = findFormElement(
      rendered,
      (element) => element.type === "button" && element.props.children === "Create baseline",
    );
    assert.ok(button, "the browser form exposes its submit button");
    (button.props.onClick as () => void)();

    // submit awaits postAction, whose fetch reaches the actual guarded action route above.
    assert.ok(actionResponse, "submitting the form makes an action request");
    await actionResponse;
    assert.ok(actionRequest, "submitting the form reaches the baseline action");
    assert.deepEqual(submittedBody, {
      snapshotId: "snapshot-selected",
      label: "selected recovery point",
    });

    const { rows } = await client.query(
      `SELECT params FROM job WHERE requested_by = 'principal-baseline-form'`,
    );
    assert.equal(rows.length, 1, "the action queues exactly one baseline-create job");
    assert.deepEqual(rows[0].params, {
      snapshotId: "snapshot-selected",
      label: "selected recovery point",
    });
  } finally {
    globalThis.fetch = originalFetch;
    form.restore();
  }
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


test("Task 36: non-admin roles cannot see or change policies, including read-only writes", async () => {
  for (const capabilities of [["read"], ["collect", "backup", "baseline-create", "dispose-accept"], ["approve"], ["restore", "remediate", "rollback"], []]) {
    for (const [handler, path, method] of [
      [listPoliciesRoute, "/api/policies", "GET"],
      [showPolicyRoute, `/api/policies/${randomUUID()}`, "GET"],
      [createPolicyRoute, "/api/policies", "POST"],
      [enablePolicyRoute, `/api/policies/${randomUUID()}/enabled`, "POST"],
      [clearPauseRoute, `/api/policies/${randomUUID()}/clear-pause`, "POST"],
    ] as const) {
      const response = await handler(routeRequest(path, method, { principalId: "non-admin", capabilities, ...(method === "POST" ? { body: { enabled: true } } : {}) }));
      assert.equal(response.status, 403, `${capabilities}: ${path}`);
      assert.deepEqual(await response.json(), { error: "forbidden" });
    }
  }
});

test("Task 36: actual policy routes reject revoked run-as on enable and clear, and retain live state", async () => {
  const runAs = randomUUID();
  await client.query("INSERT INTO principal (id, email) VALUES ($1, $2)", [runAs, `${runAs}@test.invalid`]);
  await client.query("INSERT INTO role_grant (principal_id, role, granted_by) VALUES ($1, 'restorer', 'test')", [runAs]);
  const options = { principalId: "admin", capabilities: ["policies"] };
  const created = await createPolicyRoute(postAction("/api/policies", { ...options, body: {
    name: "Task 36 automation", action: "auto_remediate", maxBlastRadius: "cosmetic",
    runAsPrincipalId: runAs, maxActionsPerWindow: 2, windowSeconds: 60,
  } }));
  assert.equal(created.status, 201);
  const { policy } = await created.json();
  assert.equal(policy.created_by, "admin");
  const update = (enabled: boolean) => enablePolicyRoute(postAction(`/api/policies/${policy.id}/enabled`, { ...options, body: { enabled } }));
  assert.equal((await update(false)).status, 200);
  await client.query("UPDATE policy SET paused_at = now(), run_as_repair_required = true WHERE id = $1", [policy.id]);
  await client.query("DELETE FROM role_grant WHERE principal_id = $1", [runAs]);
  assert.equal((await update(true)).status, 409);
  assert.equal((await clearPauseRoute(postAction(`/api/policies/${policy.id}/clear-pause`, options))).status, 409);
  const show = await showPolicyRoute(getJobs(`/api/policies/${policy.id}`, options));
  assert.equal(show.status, 200);
  const current = (await show.json()).policy;
  assert.equal(current.enabled, false);
  assert.equal(current.run_as_repair_required, true);
  assert.ok(current.paused_at);
  const listed = await listPoliciesRoute(getJobs("/api/policies?enabled=false", options));
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).policies.some((p: { id: string }) => p.id === policy.id));
  assert.ok(!(await listPolicies(client, { tenantRef: "other-tenant" })).some((p: { id: string }) => p.id === policy.id));
  await client.query("INSERT INTO role_grant (principal_id, role, granted_by) VALUES ($1, 'restorer', 'test')", [runAs]);
  const cleared = await clearPauseRoute(postAction(`/api/policies/${policy.id}/clear-pause`, options));
  assert.equal(cleared.status, 200);
  const repaired = (await cleared.json()).policy;
  assert.equal(repaired.enabled, false, "clear must not enable");
  assert.equal(repaired.paused_at, null);
  assert.equal(repaired.run_as_repair_required, false);
  assert.equal((await update(true)).status, 200);
  const enabled = await listPoliciesRoute(getJobs("/api/policies?enabled=true", options));
  assert.ok((await enabled.json()).policies.some((p: { id: string }) => p.id === policy.id));
});

test("notification routes enforce configuration while viewers can read recent deliveries", async () => {
  const { GET: channels, POST: createChannel } = await import("@/app/api/channels/route");
  const { GET: subscriptions, POST: createSubscription } = await import("@/app/api/subscriptions/route");
  const { GET: deliveries } = await import("@/app/api/deliveries/route");
  const { POST: disable } = await import("@/app/api/channels/[id]/disable/route");
  const { DELETE: remove } = await import("@/app/api/subscriptions/[id]/route");
  const admin = { principalId: "notification-admin", capabilities: ["read", "configuration"] };
  const channelBody = { kind: "webhook", config: { url: "https://example.com/hook" } };
  for (const capabilities of [["read"], ["read", "collect"], ["policies"], []]) {
    const actor = { principalId: "notification-viewer", capabilities };
    assert.equal((await createChannel(routeRequest("/api/channels", "POST", { ...actor, body: channelBody }))).status, 403);
    assert.equal((await createSubscription(routeRequest("/api/subscriptions", "POST", { ...actor, body: { channelId: randomUUID(), eventGlob: "*", minSeverity: "notice" } }))).status, 403);
    assert.equal((await channels(routeRequest("/api/channels", "GET", actor))).status, 403);
    assert.equal((await subscriptions(routeRequest("/api/subscriptions", "GET", actor))).status, 403);
    assert.equal((await disable(routeRequest(`/api/channels/${randomUUID()}/disable`, "POST", actor))).status, 403);
    assert.equal((await remove(routeRequest(`/api/subscriptions/${randomUUID()}`, "DELETE", actor))).status, 403);
  }
  const invalid = await createChannel(routeRequest("/api/channels", "POST", { ...admin, body: { kind: "sms" } }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "channel.kind must be webhook or email" });
  const created = await createChannel(routeRequest("/api/channels", "POST", { ...admin, body: channelBody }));
  assert.equal(created.status, 201);
  const { channel } = await created.json();
  assert.equal(channel.kind, "webhook");
  assert.equal(channel.enabled, true);
  const subscribed = await createSubscription(routeRequest("/api/subscriptions", "POST", { ...admin, body: { channelId: channel.id, eventGlob: "drift.*", minSeverity: "warning" } }));
  assert.equal(subscribed.status, 201);
  const { subscription } = await subscribed.json();
  assert.ok((await (await channels(routeRequest("/api/channels", "GET", admin))).json()).channels.some((row: { id: string }) => row.id === channel.id));
  assert.ok((await (await subscriptions(routeRequest("/api/subscriptions", "GET", admin))).json()).subscriptions.some((row: { id: string }) => row.id === subscription.id));
  await client.query(`INSERT INTO delivery (event, channel_id, requested_by, status, attempts, last_error, created_at)
    VALUES ($1,$2,$3,'retrying',2,'transport timeout',now()), ($4,$2,$3,'delivered',1,NULL,now() - interval '1 hour')`,
    [{ kind: "drift.latest", severity: "critical" }, channel.id, "notification-admin", { kind: "drift.older", severity: "warning" }]);
  const response = await deliveries(routeRequest(`/api/deliveries?channelId=${channel.id}&limit=1`, "GET", { principalId: "viewer", capabilities: ["read"] }));
  assert.equal(response.status, 200);
  const history = await response.json();
  assert.equal(history.deliveries.length, 1);
  assert.equal(history.deliveries[0].event.kind, "drift.latest");
  const { DeliveryTable, NotificationConsole } = await import("@/components/notification-console");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(DeliveryTable, { deliveries: history.deliveries }));
  for (const value of ["drift.latest", "critical", channel.id, "retrying", "transport timeout", "Next attempt"]) assert.ok(html.includes(value), value);
  assert.ok(!html.includes("drift.older"));
  // The real client component uses Next's router even when hiding the controls;
  // provide the same context Next installs at runtime.
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const hidden = renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: {} as React.ContextType<typeof AppRouterContext> },
    React.createElement(NotificationConsole, { canConfiguration: false, channels: [channel], subscriptions: [subscription] })));
  assert.equal(hidden, "");
  const controls = renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: {} as React.ContextType<typeof AppRouterContext> },
    React.createElement(NotificationConsole, { canConfiguration: true, channels: [channel], subscriptions: [subscription] })));
  for (const label of ["Create channel", "Disable channel", "Create subscription", "Delete subscription"]) assert.ok(controls.includes(label));
  const nav = readFileSync(new URL("../components/nav-links.tsx", import.meta.url), "utf8");
  assert.ok(nav.includes('link.href !== "/notifications" || canRead'));

  const { default: NotificationsPage } = await import("@/app/notifications/page");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  const page = await workAsyncStorage.run({ route: "/notifications", forceStatic: false, dynamicShouldError: false } as never, () =>
    workUnitAsyncStorage.run({
      type: "request", phase: "render",
      headers: new Headers([[PRINCIPAL_ID_HEADER, "viewer"], [CAPABILITIES_HEADER, "read"]]),
      implicitTags: [], url: { pathname: "/notifications", search: "" }, rootParams: {},
      resumeDataCache: null, isHmrRefresh: false, fallbackParams: null,
    } as never, () => NotificationsPage()));
  const pageHtml = renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: {} as React.ContextType<typeof AppRouterContext> }, page));
  assert.ok(pageHtml.includes("drift.latest"));
  assert.ok(pageHtml.includes("drift.older"));
  assert.ok(pageHtml.indexOf("drift.latest") < pageHtml.indexOf("drift.older"));
  assert.ok(!pageHtml.includes("Create channel"));
  assert.ok(!pageHtml.includes("Create subscription"));

  assert.equal((await disable(routeRequest(`/api/channels/${channel.id}/disable`, "POST", admin))).status, 200);
  assert.equal((await client.query("SELECT enabled FROM channel WHERE id = $1", [channel.id])).rows[0].enabled, false);
  assert.equal((await remove(routeRequest(`/api/subscriptions/${subscription.id}`, "DELETE", admin))).status, 200);
  assert.equal((await client.query("SELECT id FROM subscription WHERE id = $1", [subscription.id])).rows.length, 0);
});
