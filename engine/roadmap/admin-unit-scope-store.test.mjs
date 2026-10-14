/**
 * Gap register D2, live finding (Q46 part D): an eligibility scoped to an
 * administrative unit restores after its snapshot has been through Postgres.
 *
 * The fixture tests in admin-role-fidelity.test.mjs hand applyWave the
 * references canonicalization returns in memory. The live restore reads them
 * back from resource_reference, which stores field, symbol and required only,
 * so the scope's path prefix was lost and the restore refused the scope as
 * unnamed. This test goes through the real store: canonicalize, insert as
 * collectSnapshot does, read back, build the restore candidates and apply.
 * Microsoft Graph is the in-memory fake only; no tenant is read or written.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

import { fakeGraph } from '../../tools/qualification/operations.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { eligibilityScopeRefusal } from '../restore/adminRoleOperations.mjs';
import { restoreCandidates } from '../restore/dryRunArtifact.mjs';
import {
  completeSnapshot, createSnapshot, getReferences, getResourceVersions, insertReferences, insertResourceVersion,
} from '../store/db.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const NOW = new Date('2026-10-14T00:00:00Z');
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
const CARLA = '4f1c2b3a-0d9e-4c8b-a7f6-1e2d3c4b5a69';
const SOURCE_UNIT = 'a1b2c3d4-0000-4000-8000-00000000a001';
const TARGET_UNIT = 'b2c3d4e5-0000-4000-8000-00000000b002';
const SCHEDULES = '/roleManagement/directory/roleEligibilitySchedules';

const unit = { id: SOURCE_UNIT, displayName: 'EU Region', description: 'Europe', visibility: null };
const unitScoped = {
  id: 'schedule-old', principalId: CARLA, roleDefinitionId: GLOBAL_ADMIN, directoryScopeId: `/administrativeUnits/${SOURCE_UNIT}`,
  appScopeId: null, memberType: 'Direct', status: 'Provisioned', createdUsing: 'request-old',
  scheduleInfo: { startDateTime: '2026-06-01T00:00:00Z', expiration: { type: 'afterDateTime', endDateTime: '2027-06-01T00:00:00Z' } },
};
const directoryWide = { ...unitScoped, id: 'schedule-wide', directoryScopeId: '/' };

const database = await createIsolatedTestDatabase(import.meta.url);
let client;
let stored;

before(async () => {
  client = await database.connect();
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  const canonical = canonicalizeAll([['administrativeUnit', [unit]], ['roleEligibilitySchedule', [unitScoped, directoryWide]]]);
  const snapshotId = await createSnapshot(client, { tenantRef: 'sha256:admin-unit-scope-store-test' });
  // The same writes collectSnapshot makes for every canonical resource.
  for (const resource of canonical) {
    const versionId = await insertResourceVersion(client, {
      snapshotId, resource: { ...resource, fidelity: resource.provenance.fidelity },
    });
    await insertReferences(client, { fromVersion: versionId, references: resource.references });
  }
  await completeSnapshot(client, { id: snapshotId, status: 'complete', coverageDigest: {} });
  stored = {
    versions: await getResourceVersions(client, { snapshotId }),
    references: await getReferences(client, { snapshotId }),
  };
});

after(async () => {
  await client?.end();
  await database.cleanup();
});

const candidate = (naturalKeyPart) => restoreCandidates(stored.versions, stored.references)
  .find((resource) => resource.resourceType === 'roleEligibilitySchedule' && resource.payload.id === naturalKeyPart);

test('the store keeps no prefix; the restore candidate gets the scope prefix back from the stored payload', () => {
  const row = stored.references.find((ref) => ref.field_path === 'directoryScopeId');
  assert.equal(row.to_symbol, 'administrativeUnit:EU Region');
  assert.equal('prefix' in row, false, 'resource_reference has no prefix column; the fix must not depend on one');

  const scoped = candidate('schedule-old');
  const scope = scoped.references.find((ref) => ref.field === 'directoryScopeId');
  assert.deepEqual(scope, { field: 'directoryScopeId', symbol: 'administrativeUnit:EU Region', required: true, prefix: '/administrativeUnits/' });
  assert.equal(eligibilityScopeRefusal(scoped.payload.directoryScopeId, scoped.references), null);
  // Only a scope path gets a prefix: every other stored reference is unchanged.
  for (const ref of scoped.references.filter((entry) => entry.field !== 'directoryScopeId')) assert.equal('prefix' in ref, false);
  assert.equal(candidate('schedule-wide').references.some((ref) => ref.field === 'directoryScopeId'), false);
});

test('read back from the store, an admin-unit eligibility restores into the target unit of the same name', async () => {
  const scoped = candidate('schedule-old');
  const references = scoped.references.filter((ref) => ref.field === 'directoryScopeId');
  const graph = fakeGraph();
  const bodies = [];
  const write = graph.write.bind(graph);
  graph.write = async (version, path, request) => {
    bodies.push({ path, body: request.body });
    return write(version, path, request);
  };
  const result = await applyWave(graph, governor, [{ ...scoped, verb: 'create', references }], {
    targetTenant: 'fixture', mode: 'enforce', now: () => NOW,
    existingTargetIds: new Map([['administrativeUnit:EU Region', TARGET_UNIT]]),
  });
  assert.deepEqual(result.failed, []);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].body.directoryScopeId, `/administrativeUnits/${TARGET_UNIT}`);
  assert.equal(graph.objects.get(`${SCHEDULES}/${result.applied[0].targetId}`).directoryScopeId, `/administrativeUnits/${TARGET_UNIT}`);
});
