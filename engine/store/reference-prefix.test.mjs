/**
 * Issue #195: a PIM eligibility scoped to an administrative unit failed its
 * dry run with "unresolvable scope … an administrative unit the snapshot cannot
 * name". Canonicalization gives the scope reference a prefix
 * ("/administrativeUnits/"), but resource_reference had no column for it, so a
 * reference read back from a stored snapshot never carried it and
 * eligibilityScopeRefusal could never pass.
 *
 * Exercises the stored path a live restore takes: canonicalize, persist as
 * engine/collect/snapshot.mjs does, read back with getReferences and plan with
 * restoreCandidates (as cli/keel-restore.mjs does). Fixtures only; no tenant.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { eligibilityScopeRefusal } from '../restore/adminRoleOperations.mjs';
import { restoreCandidates } from '../restore/dryRunArtifact.mjs';
import {
  completeSnapshot, createSnapshot, getReferences, getResourceVersions, insertReferences, insertResourceVersion,
} from './db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const UNIT_ID = 'a1b2c3d4-0000-4000-8000-00000000a001';
const SCOPE = `/administrativeUnits/${UNIT_ID}`;
const unit = { id: UNIT_ID, displayName: 'KEEL-RT-148-unit', description: 'fixture', visibility: null };
const eligibility = {
  id: 'schedule-1', principalId: '4f1c2b3a-0d9e-4c8b-a7f6-1e2d3c4b5a69', roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10',
  directoryScopeId: SCOPE, appScopeId: null, memberType: 'Direct', status: 'Provisioned', createdUsing: 'request-1',
  scheduleInfo: { startDateTime: '2026-06-01T00:00:00Z', expiration: { type: 'afterDateTime', endDateTime: '2027-06-01T00:00:00Z' } },
};

async function withDatabase(fn) {
  const database = await createIsolatedTestDatabase(import.meta.url);
  const client = await database.connect();
  try {
    await client.query(SCHEMA);
    await client.query(SCHEMA); // the schema stays idempotent with the new column
    return await fn(client);
  } finally {
    await client.end();
    await database.cleanup();
  }
}

/** Persists the canonical fixture the way collectSnapshot does; returns the stored eligibility candidate. */
async function storedEligibility(client, { dropPrefix = false } = {}) {
  const canonical = canonicalizeAll([['administrativeUnit', [unit]], ['roleEligibilitySchedule', [eligibility]]]);
  const snapshotId = await createSnapshot(client, { tenantRef: 'sha256:issue-195' });
  for (const resource of canonical) {
    const versionId = await insertResourceVersion(client, { snapshotId, resource: { ...resource, fidelity: resource.provenance.fidelity } });
    await insertReferences(client, { fromVersion: versionId, references: resource.references });
  }
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  // A row stored before the prefix column existed reads back with prefix NULL.
  if (dropPrefix) await client.query('UPDATE resource_reference SET prefix = NULL');
  const candidates = restoreCandidates(
    await getResourceVersions(client, { snapshotId }),
    await getReferences(client, { snapshotId }),
  );
  return candidates.find((candidate) => candidate.resourceType === 'roleEligibilitySchedule');
}

test('#195: an administrative-unit scope read back from a stored snapshot keeps its prefix and is not refused', async () => {
  await withDatabase(async (client) => {
    const candidate = await storedEligibility(client);
    const scopeRef = candidate.references.find((ref) => ref.field === 'directoryScopeId');
    assert.equal(scopeRef.symbol, 'administrativeUnit:KEEL-RT-148-unit');
    assert.equal(scopeRef.prefix, '/administrativeUnits/');
    assert.equal(eligibilityScopeRefusal(candidate.payload.directoryScopeId, candidate.references), null);
  });
});

test('#195: a stored reference without a prefix (written before the column) is still refused, never misresolved', async () => {
  await withDatabase(async (client) => {
    const candidate = await storedEligibility(client, { dropPrefix: true });
    const scopeRef = candidate.references.find((ref) => ref.field === 'directoryScopeId');
    assert.equal('prefix' in scopeRef, false);
    assert.match(eligibilityScopeRefusal(candidate.payload.directoryScopeId, candidate.references), /^unresolvable scope: /);
  });
});

test('#195: references with no prefix store NULL and read back without a prefix key', async () => {
  await withDatabase(async (client) => {
    const candidate = await storedEligibility(client);
    const others = candidate.references.filter((ref) => ref.field !== 'directoryScopeId');
    for (const ref of others) assert.equal('prefix' in ref, false);
    const { rows } = await client.query(`SELECT field_path, prefix FROM resource_reference ORDER BY field_path`);
    for (const row of rows) assert.equal(row.prefix, row.field_path === 'directoryScopeId' ? '/administrativeUnits/' : null);
  });
});
