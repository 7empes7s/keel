import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { completeSnapshot, createSnapshot, insertResourceVersion } from "../../engine/store/db.mjs";
import { fullSuccessfulCoverageDigest } from "../../engine/test/fullSuccessfulCoverage.mjs";
import { createIsolatedTestDatabase } from "../../engine/test/dbTestHelper.mjs";

import {
  getRestoreSnapshotOptions,
  getSnapshotOptions,
  hasCompletedSnapshots,
} from "@/lib/portal-jobs";
import { tenantRef } from "@/lib/runtime-config";

let database: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
let client: Awaited<ReturnType<typeof database.connect>>;
let currentTenantRef: string;

before(async () => {
  if (!process.env.KEEL_DB_TEST_URL) {
    const env = readFileSync("/etc/keel/db.env", "utf8");
    for (const line of env.split("\n")) {
      const match = /^KEEL_DB_TEST_URL=(.*)$/.exec(line.trim());
      if (match) process.env.KEEL_DB_TEST_URL = match[1];
    }
  }

  database = await createIsolatedTestDatabase(import.meta.url);
  client = await database.connect();
  await client.query(
    readFileSync(new URL("../../engine/store/schema.sql", import.meta.url), "utf8"),
  );
  const tenantConfigDir = mkdtempSync(join(tmpdir(), "keel-baseline-sources-test-"));
  const tenantConfigPath = join(tenantConfigDir, "tenant.json");
  writeFileSync(tenantConfigPath, JSON.stringify({ tenantId: "baseline-sources-portal-test" }));
  process.env.KEEL_DB_URL = database.url;
  process.env.KEEL_TENANT_CONFIG_PATH = tenantConfigPath;
  currentTenantRef = tenantRef();
});

after(async () => {
  await client?.end();
  await database?.cleanup();
});

async function addGroup(snapshotId: string, naturalKey: string) {
  await insertResourceVersion(client, {
    snapshotId,
    resource: {
      naturalKey,
      resourceType: "group",
      payload: { displayName: naturalKey },
      payloadHash: naturalKey,
      criticality: "tier1",
      blastRadius: "access-affecting",
      fidelity: "full",
      provenance: { adapter: "fixture" },
    },
  });
}

async function createFullSnapshot(tenant: string) {
  const snapshotId = await createSnapshot(client, { tenantRef: tenant });
  await completeSnapshot(client, {
    id: snapshotId,
    status: "complete",
    coverageDigest: fullSuccessfulCoverageDigest(),
  });
  return snapshotId;
}

test("the portal offers only whole-estate baseline sources and retains tier backups for restore", async () => {
  const eligibleSnapshotId = await createFullSnapshot(currentTenantRef);
  await addGroup(eligibleSnapshotId, "group:eligible");

  const foreignSnapshotId = await createFullSnapshot("sha256:foreign-portal-source");
  await addGroup(foreignSnapshotId, "group:foreign");

  const tierFilteredSnapshotId = await createSnapshot(client, { tenantRef: currentTenantRef });
  await addGroup(tierFilteredSnapshotId, "group:tier1");
  await completeSnapshot(client, {
    id: tierFilteredSnapshotId,
    status: "complete",
    coverageDigest: { group: { outcome: "complete", itemCount: 1 } },
  });

  const failedCoverage = fullSuccessfulCoverageDigest();
  failedCoverage.user = { outcome: "failed", itemCount: null, error: "fixture denial" };
  const failedSnapshotId = await createSnapshot(client, { tenantRef: currentTenantRef });
  await completeSnapshot(client, {
    id: failedSnapshotId,
    status: "complete",
    coverageDigest: failedCoverage,
  });

  const missingCoverage = fullSuccessfulCoverageDigest();
  delete missingCoverage.user;
  const missingSnapshotId = await createSnapshot(client, { tenantRef: currentTenantRef });
  await completeSnapshot(client, {
    id: missingSnapshotId,
    status: "complete",
    coverageDigest: missingCoverage,
  });

  const baselineOptions = await getSnapshotOptions();
  assert.equal(await hasCompletedSnapshots(), true);
  assert.deepEqual(
    baselineOptions.map((snapshot) => snapshot.id),
    [eligibleSnapshotId],
  );

  const restoreOptions = await getRestoreSnapshotOptions();
  assert.ok(
    restoreOptions.some((snapshot) => snapshot.id === tierFilteredSnapshotId),
    "tier backups remain available for explicit restore work",
  );
  assert.equal(foreignSnapshotId === eligibleSnapshotId, false);
});
