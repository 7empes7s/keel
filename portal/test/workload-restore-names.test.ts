import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";
import { schemaSql } from "../../engine/store/loadSchema.mjs";
import { createDryRunArtifact } from "../../engine/restore/dryRunArtifact.mjs";
import { resolveRowReferences } from "../../engine/govern/references.mjs";

import { PAGE_RESTORE_WORKLOADS } from "@/lib/restore-workloads-view";
import { approvalSentence, jobName, workloadSubject, type RowReferences } from "@/lib/sentences";

// A restore of another Microsoft 365 service (Exchange, Teams, Purview...) is named by
// its service and what was chosen, never as "0 selected resources from the snapshot of
// an unknown time": it has no Entra snapshot and no selection.

interface TestClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const TENANT = "workload-restore-names-test";
const BACKUP_AT = "2026-10-20T09:15:00.000Z";
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BROKEN = /unknown time|0 selected|no longer readable|snapshot/i;

let database: { url: string; connect(): Promise<TestClient>; cleanup(): Promise<void> };
let client: TestClient;

function dryRun(workloadRestore: Record<string, unknown>) {
  return { kind: "restore", status: "succeeded", params: { workloadRestore, artifactId: randomUUID() } };
}

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    for (const line of env.split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }
  database = (await createIsolatedTestDatabase(import.meta.url)) as typeof database;
  const admin = await database.connect();
  try {
    await admin.query(schemaSql());
  } finally {
    await admin.end();
  }
  client = await database.connect();
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

test("a workload restore dry run names its service and what was chosen", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ workload: "exchange-mail-flow", collectionId: randomUUID(), targets: ["transportRule:Block", "transportRule:Tag", "connector:In"] },
      "Dry run of a restore of Exchange mail flow (3 chosen settings)"],
    [{ workload: "purview-labels", collectionId: randomUUID(), targets: ["label:Secret"] },
      "Dry run of a restore of Purview sensitivity labels (1 chosen setting)"],
    [{ workload: "teams-org-policies", collectionId: randomUUID(), targets: ["meetingPolicy:Global", "messagingPolicy:Global"] },
      "Dry run of a restore of Teams policies (2 chosen settings)"],
    [{ workload: "exchange-mailbox-settings", collectionId: randomUUID(), mailbox: randomUUID(), includeOrganization: true, allowTenantWide: true },
      "Dry run of a restore of Exchange mailbox settings for one mailbox and the organization-wide settings"],
    [{ workload: "exchange-mailbox-settings", collectionId: randomUUID(), mailbox: randomUUID() },
      "Dry run of a restore of Exchange mailbox settings for one mailbox"],
    [{ workload: "teams-settings", collectionId: randomUUID(), teamId: randomUUID() },
      "Dry run of a restore of Teams settings for one team"],
  ];
  for (const [request, expected] of cases) {
    const name = jobName(dryRun(request));
    assert.equal(name, expected);
    assert.doesNotMatch(name, GUID);
  }
});

test("every service the Restore page starts a restore for gets its service in the job name", () => {
  for (const workload of PAGE_RESTORE_WORKLOADS) {
    const name = jobName(dryRun({ workload, collectionId: randomUUID(), targets: ["one"] }));
    assert.doesNotMatch(name, BROKEN, name);
    assert.match(name, /Exchange|Teams|Purview|SharePoint|OneDrive/, name);
  }
  assert.equal(workloadSubject("purview-retention-dlp"), "Purview retention and data loss prevention");
  assert.equal(workloadSubject("exchange-extended"), "Exchange organization settings");
  assert.equal(workloadSubject("sharepoint-site-permissions"), "SharePoint site permissions");
  assert.equal(workloadSubject("power-platform-settings"), "Power Platform settings");
});

test("a compliance fix dry run is named as a fix, not a restore of 0 resources", () => {
  const name = jobName({ kind: "restore", status: "queued", params: { complianceFix: { controlId: "1.1.1", naturalKey: "group:Finance" }, artifactId: randomUUID() } });
  assert.equal(name, "Dry run of a fix for a failing compliance check on Finance (group)");
  const byId = jobName({ kind: "restore", status: "queued", params: { complianceFix: { controlId: "1.1.1", naturalKey: randomUUID() }, artifactId: randomUUID() } });
  assert.doesNotMatch(byId, GUID);
  assert.doesNotMatch(byId, BROKEN);
});

test("an approved workload restore, its approval and its undo name the service and the backup time", async () => {
  const artifact = (await createDryRunArtifact(client, {
    id: randomUUID(), tenantRef: TENANT, snapshotId: null,
    selection: ["transportRule:Block"], closureKeys: ["transportRule:Block", "connector:In"],
    targetTenantId: "tenant", collectorConfigPath: "workload:exchange-mail-flow", targetConfigPath: "workload:exchange-mail-flow",
    reconciliationResources: null, waves: [], patches: [], guardRefusals: [], results: {},
    currentStateFingerprint: "f", digest: "d", status: "completed", requestedBy: "tester",
    workloadRestore: { workload: "exchange-mail-flow", targets: ["transportRule:Block"], source: { collectionId: randomUUID(), observedTo: BACKUP_AT, outcome: "complete" } },
  } as never)) as { id: string };

  const [enforce, undo, approval] = (await resolveRowReferences(client, {
    tenantRef: TENANT,
    rows: [
      { kind: "restore", status: "running", params: { mode: "enforce", artifactId: artifact.id, snapshotId: null } },
      { kind: "restore", status: "queued", params: { compensates: artifact.id, artifactId: randomUUID() } },
      { action: "restore", params: { artifactId: artifact.id } },
    ],
  })) as { kind?: string; action?: string; status?: string; params: unknown; references: RowReferences }[];

  assert.equal(enforce.references.plan?.readable, true);
  assert.equal(enforce.references.plan?.workload, "exchange-mail-flow");
  const enforceName = jobName(enforce as never);
  assert.match(enforceName, /^Restore of Exchange mail flow \(2 settings\) from the backup of 20 Oct 2026/);
  assert.doesNotMatch(enforceName, BROKEN);
  const undoName = jobName(undo as never);
  assert.match(undoName, /^Dry run of an undo of the restore of Exchange mail flow \(2 settings\) from the backup of 20 Oct 2026/);
  const sentence = approvalSentence(approval as never);
  assert.match(sentence, /^Restore Exchange mail flow \(2 settings\) from the backup of 20 Oct 2026/);
  assert.doesNotMatch(sentence, /no longer readable/);
});

test("a snapshot restore keeps its name", () => {
  const name = jobName({
    kind: "restore", status: "succeeded", params: { snapshotId: randomUUID(), selection: ["group:Finance", "group:HR"], artifactId: randomUUID() },
    references: { people: {}, baseline: null, plan: null, undoes: null, changes: [], snapshot: { kind: "snapshot", id: "s", name: null, readable: true, takenAt: BACKUP_AT } },
  });
  assert.match(name, /^Dry run of a restore of 2 selected settings from the backup of 20 Oct 2026/);
});
