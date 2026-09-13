import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";

import { POST as restoreRoute } from "@/app/api/actions/restore/route";
import { POST as selectionPreviewRoute } from "@/app/api/actions/restore/selection/route";
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
let currentTenantRef: string;
let snapshotId: string;

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

  const tenantConfigDir = mkdtempSync(join(tmpdir(), "keel-portal-restore-test-"));
  writeFileSync(
    join(tenantConfigDir, "tenant.json"),
    JSON.stringify({ tenantId: "task-17-restore-portal-test" }),
  );
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(tenantConfigDir, "tenant.json");

  currentTenantRef = tenantRef();
  client = await database.connect();

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

const restorer = { principalId: "principal-restorer", capabilities: ["read", "restore"] };

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
      principalId: "principal-restorer",
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

test("a restore POST with a selection creates an approval request, never a job", async () => {
  const selection = ["conditionalAccessPolicy:Protect-Admins"];
  const response = await restoreRoute(
    post("/api/actions/restore", {
      ...restorer,
      body: {
        snapshotId,
        selection,
        collectorConfig: "/etc/keel/tenant-target.json",
        targetConfig: "/etc/keel/restorer-target.json",
        justification: "recovery rehearsal",
      },
    }),
  );

  assert.equal(response.status, 202, "restore requires approval and must create a request");
  const { approvalRequest } = await response.json();
  assert.equal(approvalRequest.status, "pending");
  assert.equal(approvalRequest.action, "restore");
  assert.equal(approvalRequest.requestedBy, "principal-restorer");
  // The request preserves the RAW selection — the closure is recomputed at execution.
  assert.deepEqual(approvalRequest.params, {
    snapshotId,
    selection,
    collectorConfig: "/etc/keel/tenant-target.json",
    targetConfig: "/etc/keel/restorer-target.json",
  });

  const { rows } = await client.query(`SELECT id FROM job WHERE kind = 'restore'`);
  assert.equal(rows.length, 0, "a restore request must never enqueue a job directly");
});
