import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { createDryRunArtifact } from "../../engine/restore/dryRunArtifact.mjs";

import { POST as restoreRoute } from "@/app/api/actions/restore/route";
import { POST as compensateRoute } from "@/app/api/actions/restore/compensate/route";
import { POST as dryRunRoute } from "@/app/api/actions/restore/dry-run/route";
import { GET as dryRunArtifactRoute } from "@/app/api/actions/restore/dry-run/[id]/route";
import { POST as selectionPreviewRoute } from "@/app/api/actions/restore/selection/route";
import { CAPABILITIES_HEADER, PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { tenantRef } from "@/lib/runtime-config";
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
let currentTenantRef: string;
let snapshotId: string;

// Gap B11: a request's requester must resolve to an enabled principal, as the portal's
// own principal ids always do.
const RESTORER = "1b2a4a00-0000-4000-8000-0000000000c1";

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

  const tenantConfigDir = mkdtempSync(join(tmpdir(), "keel-portal-restore-test-"));
  writeFileSync(
    join(tenantConfigDir, "tenant.json"),
    JSON.stringify({ tenantId: "task-17-restore-portal-test" }),
  );
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(tenantConfigDir, "tenant.json");

  currentTenantRef = tenantRef();
  client = await database.connect();
  await client.query(`INSERT INTO principal (id, email) VALUES ($1, 'restorer@restore.test')`, [RESTORER]);

  // Fixture snapshot: a Conditional Access policy that excludes a group (§4.1's
  // motivating case), the referenced group, an AD-synced group, and an unrelated
  // group no selection should ever pull in.
  const { rows: snapshotRows } = await client.query(
    `INSERT INTO snapshot (tenant_ref, status, completed_at)
     VALUES ($1, 'complete', now())
     RETURNING id`,
    [currentTenantRef],
  );
  snapshotId = String(snapshotRows[0].id);

  const versions: [string, string, Record<string, unknown>][] = [
    ["conditionalAccessPolicy:Protect-Admins", "conditionalAccessPolicy", {
      displayName: "Protect Admins",
      state: "enabledForReportingButNotEnforced",
      conditions: { users: { excludeGroups: ["source-admins-id"] } },
    }],
    ["group:Admins", "group", { displayName: "Admins", mailNickname: "admins" }],
    ["group:Synced", "group", {
      displayName: "Synced", mailNickname: "synced", onPremisesSyncEnabled: true,
    }],
    ["group:Unrelated", "group", { displayName: "Unrelated", mailNickname: "unrelated" }],
  ];
  const versionIds = new Map<string, string>();
  for (const [naturalKey, resourceType, payload] of versions) {
    const { rows } = await client.query(
      `INSERT INTO resource_version
         (snapshot_id, natural_key, resource_type, payload, payload_hash, criticality, blast_radius, fidelity, provenance)
       VALUES ($1, $2, $3, $4, $5, 'critical', 'access-affecting', 'full', '{}')
       RETURNING id`,
      [snapshotId, naturalKey, resourceType, JSON.stringify(payload), `hash-${naturalKey}`],
    );
    versionIds.set(naturalKey, String(rows[0].id));
  }
  await client.query(
    `INSERT INTO resource_reference (from_version, field_path, to_symbol, required)
     VALUES ($1, 'conditions.users.excludeGroups[0]', 'group:Admins', true)`,
    [versionIds.get("conditionalAccessPolicy:Protect-Admins")],
  );
});

after(async () => {
  await client.end();
  await database.cleanup();
});

function post(
  path: string,
  options: { principalId?: string; capabilities?: string[]; body?: unknown } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.principalId !== undefined) {
    headers.set(PRINCIPAL_ID_HEADER, options.principalId);
  }
  if (options.capabilities !== undefined) {
    headers.set(CAPABILITIES_HEADER, options.capabilities.join(" "));
  }
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
}

function get(
  path: string,
  options: { principalId?: string; capabilities?: string[] } = {},
): Request {
  const headers = new Headers();
  if (options.principalId !== undefined) {
    headers.set(PRINCIPAL_ID_HEADER, options.principalId);
  }
  if (options.capabilities !== undefined) {
    headers.set(CAPABILITIES_HEADER, options.capabilities.join(" "));
  }
  return new Request(`http://localhost${path}`, { headers });
}

const restorer = { principalId: RESTORER, capabilities: ["read", "restore"] };

test("the selection preview refuses callers without read or restore", async () => {
  const unauthenticated = await selectionPreviewRoute(
    post("/api/actions/restore/selection", {
      body: { snapshotId, selected: ["conditionalAccessPolicy:Protect-Admins"] },
    }),
  );
  assert.equal(unauthenticated.status, 403);
  assert.deepEqual(await unauthenticated.json(), { error: "forbidden" });

  const withoutRead = await selectionPreviewRoute(
    post("/api/actions/restore/selection", {
      principalId: RESTORER,
      capabilities: ["restore"],
      body: { snapshotId, selected: ["conditionalAccessPolicy:Protect-Admins"] },
    }),
  );
  assert.equal(withoutRead.status, 403, "a principal without read must be refused");
  assert.deepEqual(await withoutRead.json(), { error: "forbidden" });

  const withoutCapability = await selectionPreviewRoute(
    post("/api/actions/restore/selection", {
      principalId: "principal-viewer",
      capabilities: ["read"],
      body: { snapshotId, selected: ["conditionalAccessPolicy:Protect-Admins"] },
    }),
  );
  assert.equal(withoutCapability.status, 403, "a principal without restore must be refused");
  assert.deepEqual(await withoutCapability.json(), { error: "forbidden" });
});

test("the preview returns the closure with per-addition reasons", async () => {
  const response = await selectionPreviewRoute(
    post("/api/actions/restore/selection", {
      ...restorer,
      body: { snapshotId, selected: ["conditionalAccessPolicy:Protect-Admins"] },
    }),
  );
  assert.equal(response.status, 200);
  const preview = await response.json();

  assert.deepEqual(preview.selected, ["conditionalAccessPolicy:Protect-Admins"]);
  assert.deepEqual(
    [...preview.closureKeys].sort(),
    ["conditionalAccessPolicy:Protect-Admins", "group:Admins"],
    "the closure pulls in the referenced group and nothing else",
  );
  assert.deepEqual(preview.added, [{
    naturalKey: "group:Admins",
    resourceType: "group",
    reasons: [{
      requiredBy: "conditionalAccessPolicy:Protect-Admins",
      field: "conditions.users.excludeGroups[0]",
    }],
  }], "the addition must name the requiring resource and the field path");
  assert.deepEqual(preview.missingRequirements, preview.added);
  assert.deepEqual(preview.guardRefusals, []);
  assert.ok(
    !preview.closureKeys.includes("group:Unrelated"),
    "an unselected, unreferenced resource must never enter the closure",
  );
});

test("the preview surfaces the synced-object guard refusal at selection time", async () => {
  const response = await selectionPreviewRoute(
    post("/api/actions/restore/selection", {
      ...restorer,
      body: { snapshotId, selected: ["group:Synced"] },
    }),
  );
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.guardRefusals.length, 1);
  assert.equal(preview.guardRefusals[0].naturalKey, "group:Synced");
  assert.match(preview.guardRefusals[0].reason, /onPremisesSyncEnabled=true/);
});

test("the preview reports a deselect that would break the closure", async () => {
  // Deselecting group:Admins while the policy stays selected must be reported as a
  // missing requirement, with the requirer and field as the refusal reason.
  const response = await selectionPreviewRoute(
    post("/api/actions/restore/selection", {
      ...restorer,
      body: { snapshotId, selected: ["conditionalAccessPolicy:Protect-Admins"] },
    }),
  );
  const preview = await response.json();
  assert.deepEqual(
    preview.missingRequirements.map((m: { naturalKey: string }) => m.naturalKey),
    ["group:Admins"],
  );
});

test("a direct restore enforce POST is refused before it creates an approval request or job", async () => {
  const selection = ["conditionalAccessPolicy:Protect-Admins"];
  const { rows: approvalsBefore } = await client.query(`SELECT id FROM approval_request WHERE action = 'restore'`);
  const { rows: jobsBefore } = await client.query(`SELECT id FROM job WHERE kind = 'restore'`);
  const response = await restoreRoute(
    post("/api/actions/restore", {
      ...restorer,
      body: {
        snapshotId,
        selection,
        collectorConfig: "/etc/keel/tenant-target.json",
        targetConfig: "/etc/keel/restorer.json",
        mode: "enforce",
        justification: "recovery rehearsal",
      },
    }),
  );

  assert.equal(response.status, 400, "a raw selection can never request enforce");
  const { rows: approvalsAfter } = await client.query(`SELECT id FROM approval_request WHERE action = 'restore'`);
  const { rows: jobsAfter } = await client.query(`SELECT id FROM job WHERE kind = 'restore'`);
  assert.equal(approvalsAfter.length, approvalsBefore.length);
  assert.equal(jobsAfter.length, jobsBefore.length);
});

test("a raw selection starts a dry run, then only its completed artifact can request approval", async () => {
  const selection = ["conditionalAccessPolicy:Protect-Admins"];
  // Roadmap task-131: credential config paths are server configuration. A request
  // that supplies one is refused before anything is enqueued; the job gets the server's.
  const { rows: jobsBefore } = await client.query(`SELECT id FROM job WHERE kind = 'restore'`);
  for (const supplied of [
    { collectorConfig: "/tmp/attacker-collector.json" },
    { targetConfig: "/tmp/attacker-restorer.json" },
  ]) {
    const refused = await dryRunRoute(
      post("/api/actions/restore/dry-run", { ...restorer, body: { snapshotId, selection, ...supplied } }),
    );
    assert.equal(refused.status, 400);
  }
  const { rows: jobsAfterRefusal } = await client.query(`SELECT id FROM job WHERE kind = 'restore'`);
  assert.equal(jobsAfterRefusal.length, jobsBefore.length);

  const dryRun = await dryRunRoute(
    post("/api/actions/restore/dry-run", {
      ...restorer,
      body: { snapshotId, selection },
    }),
  );
  assert.equal(dryRun.status, 202);
  const { job, artifactId } = await dryRun.json();
  assert.equal(job.kind, "restore");
  assert.equal(typeof artifactId, "string");
  assert.deepEqual(job.params, {
    snapshotId,
    selection,
    collectorConfig: "/etc/keel/tenant.json",
    targetConfig: "/etc/keel/restorer.json",
    artifactId,
  });

  await createDryRunArtifact(client, {
    id: artifactId,
    tenantRef: currentTenantRef,
    snapshotId,
    selection,
    closureKeys: ["conditionalAccessPolicy:Protect-Admins", "group:Admins"],
    targetTenantId: "target-tenant",
    collectorConfigPath: "/etc/keel/tenant-target.json",
    targetConfigPath: "/etc/keel/restorer.json",
    reconciliationResources: null,
    waves: [["group:Admins"], ["conditionalAccessPolicy:Protect-Admins"]],
    patches: [],
    guardRefusals: [],
    results: { applied: [{ naturalKey: "group:Admins" }], skipped: [], failed: [], notRemediable: [] },
    currentStateFingerprint: "fixture-fingerprint",
    digest: "fixture-digest",
    status: "completed",
    requestedBy: RESTORER,
  });

  const confirmed = await restoreRoute(
    post("/api/actions/restore", {
      ...restorer,
      body: { artifactId, justification: "recovery rehearsal" },
    }),
  );
  assert.equal(confirmed.status, 202);
  const { approvalRequest } = await confirmed.json();
  assert.equal(approvalRequest.status, "pending");
  assert.equal(approvalRequest.action, "restore");
  assert.deepEqual(approvalRequest.params, { artifactId });
  // Gap B11: a dry run planned in the portal is still carried out by the worker.
  assert.equal(approvalRequest.executor, "worker");
});

// Issue #411 follow-up: the worker refuses a settings path that is not a .json file
// under /etc/keel. A server whose environment moves either file elsewhere gets a plain
// answer before anything is queued, never a restore job that fails later.
test("a dry run is refused before queueing when a server settings path is outside /etc/keel", async () => {
  const selection = ["conditionalAccessPolicy:Protect-Admins"];
  for (const [variable, value] of [
    ["KEEL_RESTORER_CONFIG_PATH", "/srv/hidden-place/restorer.json"],
    ["KEEL_COLLECTOR_CONFIG_PATH", "/etc/keel/../hidden-place/tenant.json"],
    ["KEEL_COLLECTOR_CONFIG_PATH", "/etc/keel/gh.env"],
  ] as const) {
    const saved = process.env[variable];
    process.env[variable] = value;
    try {
      const { rows: before } = await client.query(`SELECT id FROM job WHERE kind = 'restore'`);
      const refused = await dryRunRoute(post("/api/actions/restore/dry-run", { ...restorer, body: { snapshotId, selection } }));
      assert.equal(refused.status, 503);
      const body = await refused.json();
      assert.deepEqual(body, {
        error: "restore_settings_path",
        message: `Keel's restore settings file must be a .json file in /etc/keel. Ask whoever runs the Keel server to fix ${variable}.`,
      });
      assert.ok(!JSON.stringify(body).includes("hidden-place"), "the path itself is never shown");
      const { rows: after } = await client.query(`SELECT id FROM job WHERE kind = 'restore'`);
      assert.equal(after.length, before.length, "nothing is queued");
    } finally {
      if (saved === undefined) delete process.env[variable];
      else process.env[variable] = saved;
    }
  }
});

// Plan task 8, step 2: confirmation renders the dry run's ACTUAL planned changes and
// refusals from the persisted artifact — never a client-side guess. This is the route
// portal/components/restore-selection.tsx polls to show the operator what promotion
// would do, so its response must carry the real per-resource results, not a summary.
test("the dry-run artifact route serves the full per-resource results the dry run persisted", async () => {
  const selection = ["group:Admins"];
  const artifactResults = {
    applied: [{ naturalKey: "group:Admins", targetId: null }],
    skipped: [{ naturalKey: "group:Synced", reason: "AD-synced" }],
    failed: [{ naturalKey: "group:Unrelated", error: "boom" }],
    notRemediable: [],
  };
  const artifact = await createDryRunArtifact(client, {
    id: "aaaaaaaa-0000-4000-8000-000000000042",
    tenantRef: currentTenantRef,
    snapshotId,
    selection,
    closureKeys: ["group:Admins"],
    targetTenantId: "target-tenant",
    collectorConfigPath: "/etc/keel/tenant-target.json",
    targetConfigPath: "/etc/keel/restorer.json",
    reconciliationResources: null,
    waves: [["group:Admins"]],
    patches: [],
    guardRefusals: [{ naturalKey: "group:Synced", reason: "AD-synced" }],
    results: artifactResults,
    currentStateFingerprint: "fixture-fingerprint",
    digest: "fixture-digest",
    status: "completed",
    requestedBy: RESTORER,
  });

  const unauthenticated = await dryRunArtifactRoute(
    get(`/api/actions/restore/dry-run/${artifact.id}`),
  );
  assert.equal(unauthenticated.status, 403);

  const response = await dryRunArtifactRoute(
    get(`/api/actions/restore/dry-run/${artifact.id}`, restorer),
  );
  assert.equal(response.status, 200);
  const { artifact: served } = await response.json();
  assert.deepEqual(
    served.results,
    artifactResults,
    "every per-resource result (applied, skipped, failed, notRemediable) must reach the caller",
  );
  assert.deepEqual(served.guardRefusals, [{ naturalKey: "group:Synced", reason: "AD-synced" }]);

  const notFound = await dryRunArtifactRoute(
    get("/api/actions/restore/dry-run/bbbbbbbb-0000-4000-8000-000000000099", restorer),
  );
  assert.equal(notFound.status, 404, "an unknown artifact id must not be distinguishable from another tenant's");
});

// The undo of a restore that created a policy which is assigned now: the person's
// choice to delete it with its assignments, or skip it, goes to the undo plan job.
test("planning an undo carries the person's delete-or-skip choices, and refuses anything else", async () => {
  const forward = await createDryRunArtifact(client, {
    id: "aaaaaaaa-0000-4000-8000-000000000077",
    tenantRef: currentTenantRef,
    snapshotId,
    selection: ["group:Admins"],
    closureKeys: ["group:Admins"],
    targetTenantId: "target-tenant",
    collectorConfigPath: "/etc/keel/tenant-target.json",
    targetConfigPath: "/etc/keel/restorer.json",
    reconciliationResources: null,
    waves: [["group:Admins"]],
    patches: [],
    guardRefusals: [],
    results: { applied: [], skipped: [], failed: [], notRemediable: [] },
    currentStateFingerprint: "fixture-fingerprint",
    digest: "fixture-digest",
    status: "completed",
    requestedBy: RESTORER,
  });
  const plan = (body: unknown, key: string) => compensateRoute(new Request("http://localhost/api/actions/restore/compensate", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", [PRINCIPAL_ID_HEADER]: restorer.principalId, [CAPABILITIES_HEADER]: restorer.capabilities.join(" "), "idempotency-key": key }),
    body: JSON.stringify(body),
  }));

  const plain = await plan({ restoreArtifactId: forward.id }, "undo-plain");
  assert.equal(plain.status, 202);
  const { job: plainJob, artifactId: plainId } = await plain.json();
  assert.deepEqual(plainJob.params, { compensates: forward.id, artifactId: plainId });

  const chosen = await plan({ restoreArtifactId: forward.id, undoChoices: { "deviceConfiguration:KEEL-RT-a": "delete", "configurationPolicy:KEEL-RT-b": "skip" } }, "undo-chosen");
  assert.equal(chosen.status, 202);
  const { job: chosenJob, artifactId: chosenId } = await chosen.json();
  assert.deepEqual(chosenJob.params, {
    compensates: forward.id, artifactId: chosenId, undoChoices: { "deviceConfiguration:KEEL-RT-a": "delete", "configurationPolicy:KEEL-RT-b": "skip" },
  });

  for (const [index, undoChoices] of [{ "deviceConfiguration:KEEL-RT-a": "remove" }, ["deviceConfiguration:KEEL-RT-a"], { "--enforce": "delete" }].entries()) {
    const refused = await plan({ restoreArtifactId: forward.id, undoChoices }, `undo-bad-${index}`);
    assert.equal(refused.status, 400, JSON.stringify(undoChoices));
  }
});
