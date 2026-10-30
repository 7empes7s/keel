import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";

import { getRestoreWorkloads } from "@/lib/restore-workloads";
import {
  WORKLOAD_ORDER,
  groupWorkloadsByService,
  hasBackupData,
  workloadBackupLine,
  workloadRestoreBadge,
} from "@/lib/restore-workloads-view";
import { WORKLOADS } from "../../engine/collect/workloadContract.mjs";
import { tenantRef } from "@/lib/runtime-config";
import { serviceOrder } from "@/lib/services";

// The Restore page lists every Microsoft 365 service KEEL backs up, not only the
// Entra ID and Intune settings in the tenant snapshot.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;

async function collection(workload: string, outcome: string, at: string, keys: string[], digest: Record<string, unknown> = {}) {
  const { rows } = await client.query(
    `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest, created_at)
     VALUES ($1, $2, $3, $4, $4, $5, $4) RETURNING id`,
    [tenantRef(), workload, outcome, at, JSON.stringify(digest)],
  );
  for (const key of keys) {
    await client.query(`INSERT INTO workload_observation (collection_id, resource_key) VALUES ($1, $2)`, [rows[0].id, key]);
  }
  return String(rows[0].id);
}

before(async () => {
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  const admin = await database.connect();
  try {
    await admin.query(schemaSql());
  } finally {
    await admin.end();
  }
  const dir = mkdtempSync(join(tmpdir(), "keel-portal-restore-workloads-"));
  writeFileSync(join(dir, "tenant.json"), JSON.stringify({ tenantId: "restore-workloads-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = join(dir, "tenant.json");
  client = await database.connect();

  await collection("exchange-mail-flow", "complete", "2026-10-02T06:00:00Z", ["rule:KEEL-RT-a", "rule:KEEL-RT-b", "connector:KEEL-RT-c"]);
  // The newest run failed: the backup shown is the one before, with a warning.
  await collection("teams-org-policies", "complete", "2026-10-01T06:00:00Z", ["policy:KEEL-RT-meeting"]);
  await collection("teams-org-policies", "failed", "2026-10-02T05:00:00Z", [], { reasons: ["timeout"] });
  await collection("power-platform-settings", "disabled", "2026-10-02T06:00:00Z", [], { reasons: ["not live-qualified"] });
  // Another tenant's backup never shows here.
  await client.query(
    `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to) VALUES ('someone-else', 'purview-labels', 'complete', now(), now())`,
  );
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("every workload is listed under its service, with its newest backup", async () => {
  const workloads = await getRestoreWorkloads();
  const services = new Set(workloads.map((workload) => workload.service));
  for (const service of ["Exchange", "SharePoint", "Teams", "Purview", "Power Platform"]) assert.ok(services.has(service), `${service} is missing`);

  const mailFlow = workloads.find((workload) => workload.workload === "exchange-mail-flow")!;
  assert.equal(mailFlow.name, "Exchange mail flow and protection");
  assert.equal(mailFlow.backup?.items, 3);
  assert.equal(mailFlow.lastRun, null);
  assert.ok(mailFlow.writes.length > 0, "mail flow rules can be put back");
  assert.deepEqual(workloadBackupLine(mailFlow, "2026-10-02T09:00:00Z"), { tone: "fine", text: "Backed up 3 hours ago · 3 items" });
  assert.equal(hasBackupData(mailFlow), true);

  const teams = workloads.find((workload) => workload.workload === "teams-org-policies")!;
  assert.equal(teams.backup?.items, 1);
  assert.equal(teams.lastRun?.outcome, "failed");
  assert.equal(workloadBackupLine(teams, "2026-10-02T09:00:00Z").tone, "soon");
  assert.match(workloadBackupLine(teams, "2026-10-02T09:00:00Z").text, /newest backup failed/);
  assert.equal(hasBackupData(teams), true);
  // A failed run with no backup before it is still shown, so the failure is visible.
  assert.equal(hasBackupData({ backup: null, lastRun: teams.lastRun }), true);

  const power = workloads.find((workload) => workload.workload === "power-platform-settings")!;
  assert.equal(power.backup, null);
  // Not switched on and never backed up: the page leaves it out.
  assert.equal(hasBackupData(power), false);
  assert.match(workloadBackupLine(power, "2026-10-02T09:00:00Z").text, /^Not switched on for this tenant yet/);

  const labels = workloads.find((workload) => workload.workload === "purview-labels")!;
  assert.equal(labels.backup, null, "another tenant's backup is not shown");
  assert.equal(workloadBackupLine(labels, "2026-10-02T09:00:00Z").text, "Not backed up yet");
  assert.equal(hasBackupData(labels), false);
});

test("services follow the portal's order and no stored code reaches the words", async () => {
  const groups = groupWorkloadsByService(await getRestoreWorkloads(), serviceOrder);
  assert.deepEqual(groups.map((group) => group.service), ["Exchange", "SharePoint", "Teams", "Power Platform", "Purview"]);
  const onedrive = groups.find((group) => group.service === "SharePoint")!.workloads.map((workload) => workload.name);
  assert.ok(onedrive.includes("OneDrive settings"));
  for (const group of groups) {
    for (const workload of group.workloads) {
      assert.notEqual(workload.name, workload.workload, `${workload.workload} reads as a code`);
      assert.doesNotMatch(workload.name, /^[a-z]+(-[a-z]+)+$/, `${workload.workload} reads as a code`);
    }
  }
});

test("every kind KEEL backs up on its own has a place in its service's order", async () => {
  assert.deepEqual([...WORKLOAD_ORDER].sort(), [...WORKLOADS].sort());
  const groups = groupWorkloadsByService(await getRestoreWorkloads(), serviceOrder);
  const exchange = groups.find((group) => group.service === "Exchange")!.workloads.map((workload) => workload.workload);
  // Mailboxes first, then groups, roles, the mail flow and protection policies, sharing
  // and client access, and organization-wide settings last.
  assert.deepEqual(exchange, [
    "exchange-mailbox-settings", "exchange-recipients", "exchange-distribution-groups", "exchange-role-groups",
    "exchange-mail-flow", "exchange-org-access", "exchange-extended", "exchange-org-defaults",
  ]);
  for (const group of groups) {
    const order = group.workloads.map((workload) => WORKLOAD_ORDER.indexOf(workload.workload));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `${group.service} is out of order`);
  }
});

test("each kind says how it is put back, even with nothing backed up", async () => {
  const workloads = await getRestoreWorkloads();
  const find = (id: string) => workloads.find((workload) => workload.workload === id)!;
  assert.deepEqual(workloadRestoreBadge(find("exchange-mail-flow")), { tone: "fine", text: "Can be put back here" });
  assert.deepEqual(workloadRestoreBadge(find("purview-labels")), { tone: "muted", text: "Nothing to put back yet" });
  const backup = { collectionId: "c", takenAt: null, items: 1, partial: false };
  assert.deepEqual(workloadRestoreBadge({ ...find("power-platform-settings"), backup }), { tone: "soon", text: "By hand only" });
  assert.deepEqual(workloadRestoreBadge({ ...find("sharepoint-site-settings"), backup }), { tone: "soon", text: "Not from this page yet" });
});
