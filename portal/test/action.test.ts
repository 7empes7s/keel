import "./next-async-storage";
import { visibleNavLinks } from "@/components/nav-links";
import { GET as listPoliciesRoute, POST as createPolicyRoute } from "@/app/api/policies/route";
import { GET as showPolicyRoute } from "@/app/api/policies/[id]/route";
import { POST as enablePolicyRoute } from "@/app/api/policies/[id]/enabled/route";
import { POST as clearPauseRoute } from "@/app/api/policies/[id]/clear-pause/route";
import { POST as editPolicyRoute } from "@/app/api/policies/[id]/edit/route";
import { POST as deletePolicyRoute } from "@/app/api/policies/[id]/delete/route";
import { POST as activationPreviewRoute } from "@/app/api/policies/[id]/activation-preview/route";
import { POST as activatePolicyRoute } from "@/app/api/policies/[id]/activate/route";
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
import { detectWorkloadDrift } from "../../engine/govern/workloadDrift.mjs";

import { POST as baselineActivateRoute } from "@/app/api/actions/baseline/activate/route";
import { POST as baselineRoute } from "@/app/api/actions/baseline/route";
import { POST as backupRoute } from "@/app/api/actions/backup/route";
import { POST as collectRoute } from "@/app/api/actions/collect/route";
import { POST as contentCollectRoute } from "@/app/api/actions/content-collect/route";
import { POST as discoverRoute } from "@/app/api/actions/discover/route";
import { POST as workloadCollectRoute } from "@/app/api/actions/workload-collect/route";
import { POST as disposeRoute } from "@/app/api/actions/dispose/route";
import { POST as remediateRoute } from "@/app/api/actions/remediate/route";
import { GET as showJobRoute } from "@/app/api/jobs/[id]/route";
import { GET as listJobsRoute } from "@/app/api/jobs/route";
import { CreateWizard } from "@/components/baselines/create-wizard";
import {
  ATTEMPT_EVIDENCE_KIND,
  IDEMPOTENCY_KEY_HEADER,
} from "@/lib/action";
import { AUTHENTICATED_EMAIL_HEADER } from "@/lib/cloudflare-access";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";
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

const RESTORER = "1b2a4a00-0000-4000-8000-0000000000a1";
const OPERATOR = "1b2a4a00-0000-4000-8000-0000000000a2";

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
    const schema = schemaSql();
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
  // Gap B11: a request's requester must resolve to an enabled principal, as the
  // portal's own principal ids always do.
  await client.query(
    `INSERT INTO principal (id, email) VALUES ($1, 'restorer@action.test'), ($2, 'operator@action.test')`,
    [RESTORER, OPERATOR],
  );
  // Task-76: the portal starts a collection only once the read grants are confirmed.
  // These routes test the action API itself, so the tenant has already collected once.
  await client.query(
    "INSERT INTO snapshot (tenant_ref, status, completed_at) VALUES ($1, 'complete', now())",
    [tenantRef()],
  );
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
  // Run now on the Schedules page.
  { name: "discover", post: discoverRoute, capability: "collect", requiresApproval: false },
  { name: "workload-collect", post: workloadCollectRoute, capability: "collect", requiresApproval: false },
  { name: "content-collect", post: contentCollectRoute, capability: "collect", requiresApproval: false },
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
function renderCreateWizard() {
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
      return { parentRenderTree: { data: { bfcacheId: 0 } } };
    },
    useMemo<T>(create: () => T) { return create(); },
  };

  return {
    render(): FormElement {
      hookIndex = 0;
      contextIndex = 0;
      return CreateWizard({
        completedSnapshotsExist: true,
        disabled: false,
        today: "2026-09-10",
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
        principalId: RESTORER,
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
    assert.equal(approvalRequest.requestedBy, RESTORER);
    assert.equal(approvalRequest.justification, "change ticket 42");
    assert.deepEqual(approvalRequest.params, { target: "group:alpha" });
  }
  assert.equal(await jobCount(), 0, "a request must never enqueue a job directly");

  const { rows } = await client.query(
    `SELECT * FROM approval_request WHERE requested_by = $1`,
    [RESTORER],
  );
  assert.equal(
    rows.length,
    approvalRoutes.length,
    "exactly one pending request per requiresApproval route",
  );
});

test("a permitted caller enqueues exactly one job with the right kind and params", async () => {
  const operator = {
    principalId: OPERATOR,
    capabilities: ["collect", "backup", "baseline-create", "dispose-accept"],
  };

  const collected = await collectRoute(
    postAction("/api/actions/collect", { ...operator, body: { tier: "tier1" } }),
  );
  assert.equal(collected.status, 202);
  const { job: collectJob } = await collected.json();
  assert.equal(collectJob.kind, "collect");
  assert.deepEqual(collectJob.params, { tier: "tier1" });
  assert.equal(collectJob.requestedBy, OPERATOR);
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

test("Run now on Schedules enqueues one read-only job of the schedule's own kind", async () => {
  const operator = { principalId: OPERATOR, capabilities: ["collect"] };
  for (const [kind, route] of [["discover", discoverRoute], ["workload-collect", workloadCollectRoute], ["content-collect", contentCollectRoute]] as const) {
    const response = await route(postAction(`/api/actions/${kind}`, { ...operator, body: {} }));
    assert.equal(response.status, 202, kind);
    const { job } = await response.json();
    assert.equal(job.kind, kind);
    assert.deepEqual(job.params, {});
    assert.equal(job.requestedBy, OPERATOR);
    assert.equal((await jobRows(kind)).length, 1, `exactly one ${kind} job`);
  }
});

test("Run now refuses request-chosen file paths and enqueues nothing", async () => {
  const operator = { principalId: OPERATOR, capabilities: ["collect"] };
  const bodies = [{ config: "/etc/shadow" }, { scope: "/root/.ssh/id_rsa" }, { reader: "/etc/keel/../passwd" }, { tenantRef: "sha256:x" }];
  for (const [kind, route] of [["discover", discoverRoute], ["workload-collect", workloadCollectRoute], ["content-collect", contentCollectRoute]] as const) {
    const before = (await jobRows(kind)).length;
    for (const body of bodies) {
      const response = await route(postAction(`/api/actions/${kind}`, { ...operator, body }));
      assert.equal(response.status, 400, `${kind} ${JSON.stringify(body)}`);
    }
    assert.equal((await jobRows(kind)).length, before, `no ${kind} job from a refused body`);
  }
});

test("collect and backup take only a tier, never a config path (issue #411)", async () => {
  const operator = { principalId: OPERATOR, capabilities: ["collect", "backup"] };
  const bodies = [
    { config: "/etc/keel/content.key" },
    { tier: "tier1", config: "/etc/keel/tenant.json" },
    { tier: "tier1", scope: "/etc/keel/gh.env" },
  ];
  for (const [kind, route] of [["collect", collectRoute], ["backup", backupRoute]] as const) {
    const before = (await jobRows(kind)).length;
    for (const body of bodies) {
      const response = await route(postAction(`/api/actions/${kind}`, { ...operator, body }));
      assert.equal(response.status, 400, `${kind} ${JSON.stringify(body)}`);
    }
    assert.equal((await jobRows(kind)).length, before, `no ${kind} job from a refused body`);
  }
});

test("the guided create sends the chosen backup through the baseline action", async () => {
  const form = renderCreateWizard();
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

    const hasText = (children: unknown, text: string): boolean =>
      children === text || (Array.isArray(children) && children.includes(text));
    const clickButton = (text: string) => {
      const button = findFormElement(form.render(), (element) => element.type === "button" && hasText(element.props.children, text));
      assert.ok(button, `the wizard exposes its ${text} button`);
      (button.props.onClick as () => void)();
    };

    // Step 1: start from an earlier backup and pick it.
    const source = findFormElement(form.render(), (element) => element.props.label === "Start from");
    assert.ok(source, "the wizard asks where to start from");
    (source.props.onChange as (value: string) => void)("earlier");
    const picker = findFormElement(form.render(), (element) => element.props.label === "Backup");
    assert.ok(picker, "the wizard exposes its backup picker");
    (picker.props.onChange as (value: string) => void)("snapshot-selected");
    clickButton("Next");

    // Step 2: name it.
    const label = findFormElement(
      form.render(),
      (element) => element.type === "input" && element.props.placeholder === "e.g. After the October audit",
    );
    assert.ok(label, "the wizard exposes its name input");
    (label.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "selected recovery point" },
    });
    clickButton("Next");

    // Step 3: check, then create.
    clickButton("Create approved setup");

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
      principalId: OPERATOR,
      capabilities: ["baseline-create"],
      body: { baselineId, justification: "recovery rehearsal" },
    }),
  );

  assert.equal(response.status, 202);
  const { approvalRequest } = await response.json();
  assert.equal(approvalRequest.status, "pending");
  assert.equal(approvalRequest.action, "baseline-activate");
  assert.equal(approvalRequest.requestedBy, OPERATOR);
  assert.deepEqual(approvalRequest.params, { baselineId });
  assert.equal(
    (await jobRows("baseline-activate")).length,
    0,
    "activation must never enqueue a job directly",
  );
});

test("a replayed request with the same idempotency key does not enqueue twice", async () => {
  const replay = {
    principalId: OPERATOR,
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
    `SELECT id FROM job WHERE kind = 'backup' AND idempotency_key = $1`,
    [`client:${OPERATOR}:backup:backup-replay-1`],
  );
  assert.equal(rows.length, 1, "the replay must not create a second job row");
});

test("a caller's idempotency key cannot claim a scheduler or install-run job key", async () => {
  for (const rawKey of [
    "schedule:1b2a4a00-0000-4000-8000-00000000b001:2026-10-28T02:00:00.000Z",
    "install-run:sha256:tenant:tier1:2026-10-28",
  ]) {
    const response = await backupRoute(postAction("/api/actions/backup", {
      principalId: OPERATOR, capabilities: ["backup"], idempotencyKey: rawKey, body: { tier: "tier1" },
    }));
    assert.equal(response.status, 202);
    const { rows } = await client.query(`SELECT id FROM job WHERE idempotency_key = $1`, [rawKey]);
    assert.equal(rows.length, 0, `no caller job may hold ${rawKey.split(":")[0]}: keys`);
  }
});

test("an over-long idempotency key is refused before anything is queued", async () => {
  const { rows: before } = await client.query(`SELECT id FROM job`);
  const response = await backupRoute(postAction("/api/actions/backup", {
    principalId: OPERATOR, capabilities: ["backup"], idempotencyKey: "k".repeat(201), body: { tier: "tier1" },
  }));
  assert.equal(response.status, 400);
  const { rows: after } = await client.query(`SELECT id FROM job`);
  assert.equal(after.length, before.length);
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
        row.actor === OPERATOR &&
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
        row.actor === OPERATOR && row.subject.action === "baseline-activate",
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
      principalId: OPERATOR,
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
        job.kind === "collect" && job.requestedBy === OPERATOR,
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
      principalId: OPERATOR,
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
  assert.equal(job.requestedBy, OPERATOR);
});


test("Task 36: non-admin roles cannot see or change policies, including read-only writes", async () => {
  for (const capabilities of [["read"], ["collect", "backup", "baseline-create", "dispose-accept"], ["approve"], ["restore", "remediate", "rollback"], []]) {
    for (const [handler, path, method] of [
      [listPoliciesRoute, "/api/policies", "GET"],
      [showPolicyRoute, `/api/policies/${randomUUID()}`, "GET"],
      [createPolicyRoute, "/api/policies", "POST"],
      [enablePolicyRoute, `/api/policies/${randomUUID()}/enabled`, "POST"],
      [clearPauseRoute, `/api/policies/${randomUUID()}/clear-pause`, "POST"],
      [editPolicyRoute, `/api/policies/${randomUUID()}/edit`, "POST"],
      [deletePolicyRoute, `/api/policies/${randomUUID()}/delete`, "POST"],
      [activationPreviewRoute, `/api/policies/${randomUUID()}/activation-preview`, "POST"],
      [activatePolicyRoute, `/api/policies/${randomUUID()}/activate`, "POST"],
    ] as const) {
      const response = await handler(routeRequest(path, method, { principalId: "non-admin", capabilities, ...(method === "POST" ? { body: { enabled: true } } : {}) }));
      assert.equal(response.status, 403, `${capabilities}: ${path}`);
      assert.deepEqual(await response.json(), { error: "forbidden" });
    }
  }
});

test("Automatic rules: edit saves the whole rule, delete hides it and keeps its row", async () => {
  const options = { principalId: "admin", capabilities: ["policies"] };
  const created = await createPolicyRoute(postAction("/api/policies", { ...options, body: {
    name: "Edit me", action: "alert", maxBlastRadius: "cosmetic", resourceType: "group", maxActionsPerWindow: 50, windowSeconds: 3600,
  } }));
  assert.equal(created.status, 201);
  const { policy } = await created.json();
  assert.equal(policy.max_actions_per_window, 50, "the 50 the form shows is the limit saved");
  const edit = (body: Record<string, unknown>) => editPolicyRoute(postAction(`/api/policies/${policy.id}/edit`, { ...options, body }));
  assert.equal((await edit({ name: "", maxBlastRadius: "cosmetic" })).status, 400);
  assert.equal((await edit({ name: "x", maxBlastRadius: "cosmetic", maxActionsPerWindow: 5 })).status, 400, "a limit needs its window");
  assert.equal((await edit({ name: "x", maxBlastRadius: "cosmetic", changeType: "renamed" })).status, 400);
  assert.equal((await edit({ name: "x", maxBlastRadius: "cosmetic", maxActionsPerWindow: 2 ** 40, windowSeconds: 3600 })).status, 400, "a database refusal is not reported as a deleted rule");
  const saved = await edit({ name: "Edited", maxBlastRadius: "access-affecting", resourceType: "user", changeType: "removed", maxActionsPerWindow: 20, windowSeconds: 3600 });
  assert.equal(saved.status, 200);
  const after = (await saved.json()).policy;
  assert.equal(after.name, "Edited");
  assert.equal(after.resource_type, "user");
  assert.equal(after.change_type, "removed");
  assert.equal(after.max_blast_radius, "access-affecting");
  assert.equal(after.max_actions_per_window, 20);
  assert.equal(after.action, "alert");
  const missing = await editPolicyRoute(postAction(`/api/policies/${randomUUID()}/edit`, { ...options, body: { name: "x", maxBlastRadius: "cosmetic" } }));
  assert.equal(missing.status, 404);

  const removed = await deletePolicyRoute(postAction(`/api/policies/${policy.id}/delete`, options));
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { deleted: { id: policy.id, name: "Edited" } });
  assert.equal((await showPolicyRoute(getJobs(`/api/policies/${policy.id}`, options))).status, 404);
  const listed = await (await listPoliciesRoute(getJobs("/api/policies", options))).json();
  assert.ok(!listed.policies.some((p: { id: string }) => p.id === policy.id));
  assert.equal((await deletePolicyRoute(postAction(`/api/policies/${policy.id}/delete`, options))).status, 404);
  assert.equal((await edit({ name: "x", maxBlastRadius: "cosmetic" })).status, 404, "a deleted rule cannot be edited");
  assert.equal((await enablePolicyRoute(postAction(`/api/policies/${policy.id}/enabled`, { ...options, body: { enabled: true } }))).status, 404);
  const { rows } = await client.query("SELECT enabled, deleted_by FROM policy WHERE id = $1", [policy.id]);
  assert.deepEqual(rows[0], { enabled: false, deleted_by: "admin" });
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
  // Roadmap task-92: automatic roll back is turned on only from a current activation preview.
  const direct = await update(true);
  assert.equal(direct.status, 409);
  assert.deepEqual(await direct.json(), { error: "activation_preview_required" });
  const createdOn = await createPolicyRoute(postAction("/api/policies", { ...options, body: {
    name: "Task 92 automation", action: "auto_remediate", maxBlastRadius: "cosmetic", runAsPrincipalId: runAs, enabled: true,
  } }));
  assert.equal(createdOn.status, 409, "an automatic policy cannot be created already on");
  const previewed = await activationPreviewRoute(postAction(`/api/policies/${policy.id}/activation-preview`, options));
  assert.equal(previewed.status, 201);
  const { preview } = await previewed.json();
  assert.equal(preview.verdict, "ready");
  assert.equal(preview.requestedBy, "admin");
  assert.deepEqual(preview.outcomes, { queued: 0, rolledBack: 0, failed: 0 });
  const foreign = await activatePolicyRoute(postAction(`/api/policies/${policy.id}/activate`, { ...options, body: { previewId: randomUUID() } }));
  assert.equal(foreign.status, 409);
  assert.equal((await foreign.json()).error, "preview-not-found");
  const activated = await activatePolicyRoute(postAction(`/api/policies/${policy.id}/activate`, { ...options, body: { previewId: preview.id } }));
  assert.equal(activated.status, 200);
  assert.equal((await activated.json()).policy.enabled, true);
  const reused = await activatePolicyRoute(postAction(`/api/policies/${policy.id}/activate`, { ...options, body: { previewId: preview.id } }));
  assert.equal(reused.status, 409);
  assert.equal((await reused.json()).error, "preview-used");
  const enabled = await listPoliciesRoute(getJobs("/api/policies?enabled=true", options));
  assert.ok((await enabled.json()).policies.some((p: { id: string }) => p.id === policy.id));
});

test("notification routes enforce configuration while viewers can read recent deliveries", async () => {
  const { GET: channels, POST: createChannel } = await import("@/app/api/channels/route");
  const { GET: subscriptions, POST: createSubscription } = await import("@/app/api/subscriptions/route");
  const { GET: deliveries } = await import("@/app/api/deliveries/route");
  const { POST: disable } = await import("@/app/api/channels/[id]/disable/route");
  const { POST: enable } = await import("@/app/api/channels/[id]/enable/route");
  const { POST: sendTest } = await import("@/app/api/channels/[id]/test/route");
  const { DELETE: remove, PATCH: change } = await import("@/app/api/subscriptions/[id]/route");
  const { GET: escalations, POST: createEscalation } = await import("@/app/api/escalation-rules/route");
  const { POST: escalationOff } = await import("@/app/api/escalation-rules/[id]/disable/route");
  const { POST: escalationOn } = await import("@/app/api/escalation-rules/[id]/enable/route");
  const { grantRole } = await import("../../engine/authz/administration.mjs");
  // The test send and escalation rules are authorised by the engine against the
  // principal table too, so this admin is a real, backdated admin grant.
  const NOTIFIER = "1b2a4a00-0000-4000-8000-0000000000a7";
  await client.query("INSERT INTO principal (id, email, display_name) VALUES ($1, 'notifier@action.test', 'Dana Notifier')", [NOTIFIER]);
  await grantRole(client, { principalId: NOTIFIER, role: "admin", grantedBy: NOTIFIER, activeFrom: new Date(Date.now() - 60_000).toISOString() });
  const admin = { principalId: NOTIFIER, capabilities: ["read", "configuration"] };
  const channelBody = { kind: "webhook", config: { url: "https://example.com/hook" } };
  for (const capabilities of [["read"], ["read", "collect"], ["policies"], []]) {
    const actor = { principalId: "notification-viewer", capabilities };
    assert.equal((await createChannel(routeRequest("/api/channels", "POST", { ...actor, body: channelBody }))).status, 403);
    assert.equal((await createSubscription(routeRequest("/api/subscriptions", "POST", { ...actor, body: { channelId: randomUUID(), eventGlob: "*", minSeverity: "notice" } }))).status, 403);
    assert.equal((await channels(routeRequest("/api/channels", "GET", actor))).status, 403);
    assert.equal((await subscriptions(routeRequest("/api/subscriptions", "GET", actor))).status, 403);
    assert.equal((await disable(routeRequest(`/api/channels/${randomUUID()}/disable`, "POST", actor))).status, 403);
    assert.equal((await enable(routeRequest(`/api/channels/${randomUUID()}/enable`, "POST", actor))).status, 403);
    assert.equal((await sendTest(routeRequest(`/api/channels/${randomUUID()}/test`, "POST", actor))).status, 403);
    assert.equal((await remove(routeRequest(`/api/subscriptions/${randomUUID()}`, "DELETE", actor))).status, 403);
    assert.equal((await change(routeRequest(`/api/subscriptions/${randomUUID()}`, "PATCH", { ...actor, body: { channelId: randomUUID(), eventGlob: "*", minSeverity: "notice" } }))).status, 403);
    assert.equal((await escalations(routeRequest("/api/escalation-rules", "GET", actor))).status, 403);
    assert.equal((await createEscalation(routeRequest("/api/escalation-rules", "POST", { ...actor, body: { channelId: randomUUID(), minSeverity: "critical", ackWithinMs: 1_800_000 } }))).status, 403);
    assert.equal((await escalationOff(routeRequest(`/api/escalation-rules/${randomUUID()}/disable`, "POST", actor))).status, 403);
  }
  const invalid = await createChannel(routeRequest("/api/channels", "POST", { ...admin, body: { kind: "fax" } }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "channel.kind must be one of webhook, email, teams, slack, pagerduty, sms" });
  const noProvider = await createChannel(routeRequest("/api/channels", "POST", { ...admin, body: { kind: "sms", config: {} } }));
  assert.equal(noProvider.status, 400);
  assert.deepEqual(await noProvider.json(), { error: "provider is required (supported: twilio)" });
  const created = await createChannel(routeRequest("/api/channels", "POST", { ...admin, body: channelBody }));
  assert.equal(created.status, 201);
  const { channel } = await created.json();
  assert.equal(channel.kind, "webhook");
  assert.equal(channel.enabled, true);
  const subscribed = await createSubscription(routeRequest("/api/subscriptions", "POST", { ...admin, body: { channelId: channel.id, eventGlob: "alert.opened", minSeverity: "warning" } }));
  assert.equal(subscribed.status, 201);
  const { subscription } = await subscribed.json();
  assert.ok((await (await channels(routeRequest("/api/channels", "GET", admin))).json()).channels.some((row: { id: string }) => row.id === channel.id));
  assert.ok((await (await subscriptions(routeRequest("/api/subscriptions", "GET", admin))).json()).subscriptions.some((row: { id: string }) => row.id === subscription.id));

  // Editing a rule sends the whole rule; a half-valid body changes nothing.
  assert.equal((await change(routeRequest(`/api/subscriptions/${subscription.id}`, "PATCH", { ...admin, body: { channelId: channel.id, eventGlob: "*" } }))).status, 400);
  const changed = await change(routeRequest(`/api/subscriptions/${subscription.id}`, "PATCH", { ...admin, body: { channelId: channel.id, eventGlob: "*", minSeverity: "critical" } }));
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).subscription.min_severity, "critical");
  assert.equal((await change(routeRequest(`/api/subscriptions/${randomUUID()}`, "PATCH", { ...admin, body: { channelId: channel.id, eventGlob: "*", minSeverity: "critical" } }))).status, 404);

  await client.query(`INSERT INTO delivery (event, channel_id, requested_by, status, attempts, last_error, created_at)
    VALUES ($1,$2,$3,'retrying',2,'transport timeout',now()), ($4,$2,$3,'delivered',1,NULL,now() - interval '1 hour')`,
    [{ kind: "alert.opened", severity: "critical", resourceKey: "group:Finance approvers" }, channel.id, NOTIFIER, { kind: "alert.opened", severity: "warning", resourceKey: "group:Old project team" }]);
  const response = await deliveries(routeRequest(`/api/deliveries?channelId=${channel.id}&limit=1`, "GET", { principalId: "viewer", capabilities: ["read"] }));
  assert.equal(response.status, 200);
  const history = await response.json();
  assert.equal(history.deliveries.length, 1);
  assert.equal(history.deliveries[0].event.resourceKey, "group:Finance approvers");
  assert.ok(history.deliveries[0].created_at, "a delivery carries when it was queued");
  // The Failed tile filters by status through the route.
  const retrying = await (await deliveries(routeRequest(`/api/deliveries?channelId=${channel.id}&status=retrying`, "GET", { principalId: "viewer", capabilities: ["read"] }))).json();
  assert.deepEqual(retrying.deliveries.map((row: { status: string }) => row.status), ["retrying"]);
  assert.equal((await deliveries(routeRequest(`/api/deliveries?status=lost`, "GET", { principalId: "viewer", capabilities: ["read"] }))).status, 400);

  // "Send test" queues one notice-level test delivery and its notify job, nothing else.
  const tested = await sendTest(routeRequest(`/api/channels/${channel.id}/test`, "POST", admin));
  assert.equal(tested.status, 202);
  const { delivery: testDelivery } = await tested.json();
  assert.equal(testDelivery.event.kind, "test");
  assert.equal(testDelivery.event.severity, "notice");
  assert.equal(testDelivery.channel_id, channel.id);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM job WHERE params->>'deliveryId' = $1", [testDelivery.id])).rows[0].n, 1);
  assert.equal((await sendTest(routeRequest(`/api/channels/${randomUUID()}/test`, "POST", admin))).status, 404);

  // Escalation rules: list, add, turn off and back on, with the owner's name joined in.
  const noneYet = await escalations(routeRequest("/api/escalation-rules", "GET", admin));
  assert.equal(noneYet.status, 200);
  assert.deepEqual((await noneYet.json()).escalationRules, []);
  assert.equal((await createEscalation(routeRequest("/api/escalation-rules", "POST", { ...admin, body: { channelId: channel.id, minSeverity: "critical", ackWithinMs: 5 } }))).status, 400, "a wait under a minute is refused");
  const escalated = await createEscalation(routeRequest("/api/escalation-rules", "POST", { ...admin, body: { channelId: channel.id, minSeverity: "critical", ackWithinMs: 30 * 60_000, ownerPrincipalId: NOTIFIER } }));
  assert.equal(escalated.status, 201);
  const { escalationRule } = await escalated.json();
  assert.equal(escalationRule.ack_within_ms, 30 * 60_000);
  assert.equal(escalationRule.created_by, NOTIFIER);
  const listed = (await (await escalations(routeRequest("/api/escalation-rules", "GET", admin))).json()).escalationRules;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].owner_name, "Dana Notifier");
  assert.equal(listed[0].channel_kind, "webhook");
  assert.equal((await escalationOff(routeRequest(`/api/escalation-rules/${escalationRule.id}/disable`, "POST", admin))).status, 200);
  assert.equal((await client.query("SELECT enabled FROM alert_escalation_rule WHERE id = $1", [escalationRule.id])).rows[0].enabled, false);
  assert.equal((await escalationOn(routeRequest(`/api/escalation-rules/${escalationRule.id}/enable`, "POST", admin))).status, 200);
  assert.equal((await client.query("SELECT enabled FROM alert_escalation_rule WHERE id = $1", [escalationRule.id])).rows[0].enabled, true);
  assert.equal((await escalationOff(routeRequest(`/api/escalation-rules/${randomUUID()}/disable`, "POST", admin))).status, 404);

  // The page body: a viewer sees Sent only; an admin sees the controls; ids stay in the record.
  const { renderNotificationsAt } = await import("./render-notifications");
  const all = (await (await deliveries(routeRequest(`/api/deliveries?channelId=${channel.id}`, "GET", { principalId: "viewer", capabilities: ["read"] }))).json()).deliveries;
  const viewer = await renderNotificationsAt("", { canConfiguration: false, channels: [], subscriptions: [], deliveries: all, now: new Date().toISOString() });
  for (const absent of ["Add channel", "Send test", "Turn off", "Add rule"]) assert.ok(!viewer.includes(absent), `viewer never sees ${absent}`);
  assert.ok(viewer.includes("Test alert"));
  assert.ok(viewer.includes("Finance approvers (group)"));
  const controls = await renderNotificationsAt("", { canConfiguration: true, channels: [channel], subscriptions: [{ ...subscription, min_severity: "critical", event_glob: "*" }], escalationRules: listed, deliveries: all, now: new Date().toISOString() });
  for (const label of ["Add channel", "Send test", "Turn off", "Web address example.com"]) assert.ok(controls.includes(label), label);
  const rules = await renderNotificationsAt("tab=rules", { canConfiguration: true, channels: [channel], subscriptions: [{ ...subscription, min_severity: "critical", event_glob: "*" }], escalationRules: listed, deliveries: all, now: new Date().toISOString() });
  for (const label of ["Add rule", "All alerts", "Critical only", "Delete", "When nobody responds", "A critical alert not acknowledged in 30 minutes", "Owner Dana Notifier"]) assert.ok(rules.includes(label), label);
  const visible = rules.replace(/<details[\s\S]*?<\/details>/g, "").replace(/<[^>]+>/g, " ");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(visible), "no id outside Technical details");
  for (const canRead of [true, false]) {
    assert.equal(visibleNavLinks({ canRead }).some((link) => link.href === "/notifications"), canRead);
  }

  const { default: NotificationsPage } = await import("@/app/notifications/page");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  const renderPage = async (principalId: string, capabilities: string) => {
    const page = await workAsyncStorage.run({ route: "/notifications", forceStatic: false, dynamicShouldError: false } as never, () =>
      workUnitAsyncStorage.run({
        type: "request", phase: "render",
        headers: new Headers([[PRINCIPAL_ID_HEADER, principalId], [CAPABILITIES_HEADER, capabilities]]),
        implicitTags: [], url: { pathname: "/notifications", search: "" }, rootParams: {},
        resumeDataCache: null, isHmrRefresh: false, fallbackParams: null,
      } as never, () => NotificationsPage()));
    return renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: {} as React.ContextType<typeof AppRouterContext> },
      React.createElement(PathnameContext.Provider, { value: "/notifications" },
        React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams("") as unknown as React.ContextType<typeof SearchParamsContext> }, page))));
  };
  const pageHtml = await renderPage("viewer", "read");
  assert.ok(pageHtml.includes("Finance approvers (group)"));
  assert.ok(pageHtml.includes("Old project team (group)"));
  assert.ok(pageHtml.indexOf("Finance approvers (group)") < pageHtml.indexOf("Old project team (group)"), "newest first");
  assert.ok(!pageHtml.includes("Add channel"));
  const adminHtml = await renderPage(NOTIFIER, "read configuration");
  assert.ok(adminHtml.includes("status-pill"), "the admin sees the status pill");
  assert.ok(adminHtml.includes("Web address example.com"));

  assert.equal((await disable(routeRequest(`/api/channels/${channel.id}/disable`, "POST", admin))).status, 200);
  assert.equal((await client.query("SELECT enabled FROM channel WHERE id = $1", [channel.id])).rows[0].enabled, false);
  assert.equal((await sendTest(routeRequest(`/api/channels/${channel.id}/test`, "POST", admin))).status, 409, "no test to a channel that is off");
  assert.equal((await enable(routeRequest(`/api/channels/${channel.id}/enable`, "POST", admin))).status, 200);
  assert.equal((await client.query("SELECT enabled FROM channel WHERE id = $1", [channel.id])).rows[0].enabled, true);
  assert.equal((await remove(routeRequest(`/api/subscriptions/${subscription.id}`, "DELETE", admin))).status, 200);
  assert.equal((await client.query("SELECT id FROM subscription WHERE id = $1", [subscription.id])).rows.length, 0);
});


// A service setting change (Exchange, SharePoint, Teams, ...) is accepted into that
// service's approved setup through the same dispose action, with a reason; it has no
// ignore, and a change id from another tenant or a malformed body is refused.
test("dispose accepts a service setting change into its service's approved setup", async () => {
  const tenant = tenantRef();
  const read = async (at: string, state: string) => {
    const { rows: [collection] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, created_at)
       VALUES ($1, 'exchange-mail-flow', 'complete', $2, $2, $2) RETURNING id`,
      [tenant, at],
    );
    await client.query(
      "INSERT INTO workload_observation (collection_id, resource_key, fields) VALUES ($1, 'transport-rule:KEEL-RT-accept', $2)",
      [collection.id, { identity: "KEEL-RT-accept", kind: "transportRule", Name: "KEEL-RT-accept", State: state }],
    );
    await detectWorkloadDrift(client, { collectionId: collection.id, hysteresis: undefined });
    return String(collection.id);
  };
  await read("2026-10-12T02:00:00Z", "Disabled");
  const changed = await read("2026-10-13T02:00:00Z", "Enabled");
  const { rows: [change] } = await client.query("SELECT id FROM workload_drift WHERE collection_id = $1", [changed]);
  const operator = { principalId: OPERATOR, capabilities: ["dispose-accept"] };
  const post = (body: Record<string, unknown>) => disposeRoute(postAction("/api/actions/dispose", { ...operator, body }));

  for (const body of [
    { serviceChangeId: change.id, action: "ignore", reason: "later", expiresAt: "2026-12-01T00:00:00Z" },
    { serviceChangeId: change.id, driftId: change.id, action: "accept", reason: "both" },
    { serviceChangeId: change.id, action: "accept", reason: " " },
  ]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.equal((await post({ serviceChangeId: randomUUID(), action: "accept", reason: "unknown" })).status, 400);

  const accepted = await post({ serviceChangeId: change.id, action: "accept", reason: "Planned in change 42" });
  assert.equal(accepted.status, 200);
  const { rows: [approved] } = await client.query(
    "SELECT * FROM workload_approved WHERE tenant_ref = $1 AND resource_key = 'transport-rule:KEEL-RT-accept'", [tenant],
  );
  assert.equal((approved.fields as { State?: string }).State, "Enabled");
  assert.equal(String(approved.collection_id), changed);
  assert.equal(approved.approved_by, OPERATOR);
  assert.equal(approved.reason, "Planned in change 42");
});
